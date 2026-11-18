#include "msp/LiveCorrection.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>

namespace msp {

namespace {

constexpr double kPi = 3.14159265358979323846;
// Largest |ratio - 1| at kLiveCorrectionMaxCents (2^(200/1200) - 1 = 0.1225), rounded up.
constexpr double kDriftBound = 0.125;

double clampFinite(double value, double low, double high, double fallback) {
    return std::isfinite(value) ? std::clamp(value, low, high) : fallback;
}

uint64_t packParams(const LiveCorrectionParams& p) {
    const auto rootBits = static_cast<uint64_t>(((p.root % 12) + 12) % 12);
    const auto scaleBits = static_cast<uint64_t>(std::clamp(static_cast<int>(p.scale), 0, kScaleTypeCount - 1));
    const auto maskBits = static_cast<uint64_t>(scaleMask(scaleTypeAt(static_cast<int>(scaleBits))) & 0xfffu);
    const auto retuneBits = static_cast<uint64_t>(std::llround(clampFinite(p.retuneMs, 0.0, kLiveRetuneMaxMs, 20.0) * 100.0));
    const auto strengthBits = static_cast<uint64_t>(std::llround(clampFinite(p.strength, 0.0, 1.0, 1.0) * 10000.0));
    return rootBits | (scaleBits << 4) | (maskBits << 7) | (retuneBits << 19) | (strengthBits << 34) | (1ull << 63);
}

LiveCorrectionParams unpackParams(uint64_t packed) {
    LiveCorrectionParams p;
    p.root = static_cast<int>(packed & 0xfu) % 12;
    p.scale = scaleTypeAt(static_cast<int>((packed >> 4) & 0x7u));
    p.retuneMs = static_cast<double>((packed >> 19) & 0x7fffu) / 100.0;
    p.strength = static_cast<double>((packed >> 34) & 0x3fffu) / 10000.0;
    return p;
}

double onePole(double timeMs, double rate) {
    return timeMs <= 0.0 ? 1.0 : 1.0 - std::exp(-1000.0 / (timeMs * rate));
}

bool inMask(int midi, int root, unsigned mask) {
    const int degree = (((midi - root) % 12) + 12) % 12;
    return ((mask >> degree) & 1u) != 0;
}

} // namespace

const char* liveAnalysisModeName(LiveAnalysisMode mode) {
    switch (mode) {
        case LiveAnalysisMode::inCallback: return "inCallback";
        case LiveAnalysisMode::worker: return "worker";
        case LiveAnalysisMode::manual: return "manual";
    }
    return "inCallback";
}

bool liveAnalysisModeFromName(const std::string& name, LiveAnalysisMode& mode) {
    if (name == "inCallback")
        mode = LiveAnalysisMode::inCallback;
    else if (name == "worker")
        mode = LiveAnalysisMode::worker;
    else
        return false;   // manual is for tests only
    return true;
}

std::string checkLiveCorrectionParams(const LiveCorrectionParams& p) {
    if (p.root < 0 || p.root > 11)
        return "The root must be a pitch class from C to B.";
    if (static_cast<int>(p.scale) < 0 || static_cast<int>(p.scale) >= kScaleTypeCount)
        return "Unknown scale.";
    if (!std::isfinite(p.retuneMs) || p.retuneMs < 0.0 || p.retuneMs > kLiveRetuneMaxMs)
        return "Retune speed must be between 0 and 200 ms.";
    if (!std::isfinite(p.strength) || p.strength < 0.0 || p.strength > 1.0)
        return "Strength must be between 0 and 100%.";
    return {};
}

std::string checkLiveCorrectionSettings(const LiveCorrectionSettings& s) {
    if (s.analysis != LiveAnalysisMode::inCallback && s.analysis != LiveAnalysisMode::worker && s.analysis != LiveAnalysisMode::manual)
        return "Unknown analysis placement.";
    if (s.input != LivePitchInput::left && s.input != LivePitchInput::right && s.input != LivePitchInput::mix)
        return "The analysis input must be input1, input2 or mix.";
    if (!std::isfinite(s.workerMarginMs) || s.workerMarginMs < 0.0 || s.workerMarginMs > kLiveMaxWorkerMarginMs)
        return "The worker margin must be between 0 and 200 ms.";
    return {};
}

unsigned scaleMask(ScaleType scale) {
    unsigned mask = 0;
    for (const int interval : scaleIntervals(scale))
        mask |= 1u << (((interval % 12) + 12) % 12);
    return mask | 1u;
}

int nearestAllowedNote(double midi, int root, unsigned mask) {
    if (!std::isfinite(midi))
        return -1;
    mask |= 1u;
    root = ((root % 12) + 12) % 12;
    midi = std::clamp(midi, kMappingLowestMidi, kMappingHighestMidi);
    // Every mask holds the root, so both searches end within 12 steps.
    int lower = static_cast<int>(std::floor(midi));
    while (!inMask(lower, root, mask))
        --lower;
    int upper = static_cast<int>(std::ceil(midi));
    while (!inMask(upper, root, mask))
        ++upper;
    const double below = midi - lower;
    const double above = upper - midi;
    int note = 0;
    if (lower == upper)
        note = lower;
    else if (std::fabs(below - above) <= 1e-9)
        note = lower;
    else
        note = below < above ? lower : upper;
    if (note < 0)
        note = upper;
    if (note > 127)
        note = lower;
    while (note > 127 || !inMask(note, root, mask))
        --note;
    while (note < 0 || !inMask(note, root, mask))
        ++note;
    return note;
}

PitchCorrectionKernel::PitchCorrectionKernel(const LiveCorrectionSettings& settings, const LiveCorrectionParams& params)
    : config(settings) {
    packedParams.store(packParams(params), std::memory_order_release);
}

PitchCorrectionKernel::~PitchCorrectionKernel() {
    stopWorker();
}

void PitchCorrectionKernel::stopWorker() noexcept {
    if (!worker.joinable())
        return;
    workerStop.store(true, std::memory_order_release);
    worker.join();
}

std::string PitchCorrectionKernel::prepare(const RealtimeSpec& spec) {
    stopWorker();
    ready = false;
    const auto settingsError = checkLiveCorrectionSettings(config);
    if (!settingsError.empty())
        return settingsError;
    if (spec.channels < 1 || spec.channels > kRealtimeMaxChannels)
        return "Live pitch correction supports 1 or 2 channels.";
    if (spec.maxFrames < 1 || spec.maxFrames > kRealtimeMaxBlock)
        return "Live pitch correction needs a block size from 1 to " + std::to_string(kRealtimeMaxBlock) + " samples.";

    LivePitchSettings analysisSettings;
    analysisSettings.minHz = kLiveCorrectionMinHz;
    analysisSettings.maxHz = kLiveCorrectionMaxHz;
    analysisSettings.hopSize = kLiveCorrectionHop;
    analysisSettings.windowSize = 0;
    analysisSettings.input = config.input;
    analysisSettings.tracker.octaveFrames = 10;   // the same ~27 ms as 5 frames at the detector's 256-sample hop
    const auto analysisError = analyzer.prepare(spec.sampleRate, analysisSettings);
    if (!analysisError.empty())
        return analysisError;
    analyzer.setTargetMapping(false);

    rate = spec.sampleRate;
    channelCount = spec.channels;
    maxFrames = spec.maxFrames;
    const auto& pp = analyzer.parameters();
    lat = LiveCorrectionLatency {};
    lat.windowSize = pp.windowSize;
    lat.hopSize = pp.hopSize;
    lat.maxPeriod = static_cast<int>(std::ceil(rate / kLiveCorrectionMinHz));
    lat.detection = pp.windowSize / 2 + pp.hopSize;
    lat.delivery = config.analysis == LiveAnalysisMode::inCallback
        ? 0 : maxFrames + static_cast<int>(std::ceil(config.workerMarginMs * rate / 1000.0));
    lat.shifter = static_cast<int>(std::ceil((0.5 + kDriftBound) * lat.maxPeriod)) + 4;
    lat.total = lat.detection + lat.delivery + lat.shifter;
    if (lat.total > kRealtimeMaxLatency)
        return "The live correction latency would exceed " + std::to_string(kRealtimeMaxLatency) + " samples.";
    minPeriod = std::max(2, static_cast<int>(std::floor(rate / kLiveCorrectionMaxHz)));
    minJump = kLiveMinJumpMs * rate / 1000.0;
    unvoicedJump = std::min(static_cast<double>(lat.maxPeriod), std::round(kLiveUnvoicedJumpMs * rate / 1000.0));
    recentreLength = std::max(1, std::min(lat.maxPeriod, static_cast<int>(std::lround(kLiveRecentreMs * rate / 1000.0))));
    missingHold = static_cast<int>(std::lround(kLiveMissingHoldMs * rate / 1000.0));

    // The oldest sample read is L + J + 1 behind the output, the newest written maxFrames - 1 ahead.
    const int needed = lat.total + lat.shifter + maxFrames + 8;
    histCap = 1;
    while (histCap < needed)
        histCap <<= 1;
    histMask = static_cast<int64_t>(histCap - 1);
    history.assign(static_cast<size_t>(channelCount) * static_cast<size_t>(histCap), 0.0f);
    mono.assign(static_cast<size_t>(maxFrames), 0.0f);
    window.assign(static_cast<size_t>(kLiveResultWindow), PitchStamp {});
    ring.assign(static_cast<size_t>(kLiveResultRing), PitchStamp {});
    ringHead.store(0);
    ringTail.store(0);
    queue = config.analysis == LiveAnalysisMode::inCallback ? nullptr : std::make_unique<RecordQueue>(kLiveAnalysisSlots);
    int fftSize = 1;
    while (fftSize < pp.windowSize)
        fftSize <<= 1;
    const int tauMax = lat.maxPeriod;
    analysisBytes = analyzer.bytes() + static_cast<size_t>(fftSize) * (2 * 16 + 8 + 4)   // spectra, twiddles, bit reversal
        + static_cast<size_t>(pp.windowSize + 1) * 8 + static_cast<size_t>(tauMax + 2) * 16;

    analysisEpoch = ~0u;
    audioEpoch = 0;
    inIndex = 0;
    appliedPacked = ~0ull;
    statsResetPending.store(false);
    clearAudioStats();
    for (auto* s : { &statWindows, &statVoiced, &statDropped, &statWithheld, &statGaps, &statWindowNs, &statMaxWindowNs })
        s->store(0);
    reset();
    counters.resets = 0;
    statResets.store(0);
    ready = true;
    if (config.analysis == LiveAnalysisMode::worker) {
        workerStop.store(false);
        workerPaused.store(false);
        worker = std::thread([this] { runWorker(); });
    }
    return {};
}

void PitchCorrectionKernel::applyParams(uint64_t packed) noexcept {
    appliedPacked = packed;
    const auto p = unpackParams(packed);
    root = p.root;
    mask = static_cast<unsigned>((packed >> 7) & 0xfffu) | 1u;
    strengthTarget = p.strength;
    alphaRetune = onePole(std::max(p.retuneMs / 3.0, kLiveMinRetuneTauMs), rate);
    alphaRelease = onePole(kLiveReleaseMs, rate);
    alphaStrength = onePole(kLiveStrengthSmoothingMs, rate);
}

void PitchCorrectionKernel::reset() noexcept {
    if (history.empty())
        return;
    std::fill(history.begin(), history.end(), 0.0f);
    ++audioEpoch;
    currentEpoch.store(audioEpoch, std::memory_order_release);
    epochStart = inIndex;
    winFirst = winEnd = cursor = 0;
    maxReadPos = -1.0e300;
    started = false;
    fading = false;
    fadePos = 0;
    tapA = tapB = Tap {};
    smoothedCents = 0.0;
    lastGoal = 0.0;
    lastPeriod = 0.0;
    missingRun = 0;
    target = -1;
    applyParams(packedParams.load(std::memory_order_acquire));
    smoothedStrength = strengthTarget;
    if (config.analysis == LiveAnalysisMode::inCallback) {
        analyzer.reset();
        analysisEpoch = audioEpoch;
    }
    ++counters.resets;
    statResets.store(counters.resets, std::memory_order_relaxed);
}

void PitchCorrectionKernel::setParams(const LiveCorrectionParams& params) noexcept {
    packedParams.store(packParams(params), std::memory_order_release);
}

LiveCorrectionParams PitchCorrectionKernel::params() const noexcept {
    return unpackParams(packedParams.load(std::memory_order_acquire));
}

float PitchCorrectionKernel::sample(int channel, int64_t index) const noexcept {
    return history[static_cast<size_t>(channel) * static_cast<size_t>(histCap) + static_cast<size_t>(index & histMask)];
}

float PitchCorrectionKernel::read(int channel, const Tap& tap) const noexcept {
    // Linear interpolation. Catmull-Rom overshoots at the abrupt frequency steps of a legato
    // note change (phase-continuous, ω discontinuous) and produced second-difference spikes
    // several times the input's; linear stays inside the input's envelope there and is enough
    // for the sub-semitone ratios used here.
    if (tap.f == 0.0)
        return sample(channel, tap.i);
    const float x0 = sample(channel, tap.i);
    const float x1 = sample(channel, tap.i + 1);
    return x0 + static_cast<float>(tap.f) * (x1 - x0);
}

int PitchCorrectionKernel::analyse(const float* input, int frames, int64_t first, uint32_t epoch, int64_t stampNs, bool deliver,
                                   bool direct) noexcept {
    if (epoch != analysisEpoch) {
        analyzer.reset();
        analysisEpoch = epoch;
    }
    int windows = 0;
    const int half = lat.windowSize / 2;
    for (int done = 0; done < frames;) {
        const int n = std::min(frames - done, kRecordSlotFrames);
        analyzer.push(input + done, 1, n, first + done, stampNs, livePitchNowNs());
        done += n;
        LivePitchResult r;
        while (analyzer.next(r)) {
            ++windows;
            const int64_t ns = r.completedNs - r.startedNs;
            statWindows.fetch_add(1, std::memory_order_relaxed);
            statWindowNs.fetch_add(ns, std::memory_order_relaxed);
            if (ns > statMaxWindowNs.load(std::memory_order_relaxed))
                statMaxWindowNs.store(ns, std::memory_order_relaxed);
            PitchStamp stamp;
            stamp.windowStart = r.windowStart;
            stamp.windowEnd = r.windowEnd;
            stamp.centre = r.windowStart + half;
            stamp.epoch = epoch;
            stamp.voiced = r.voiced && r.tracked.pitch > 0.0 && std::isfinite(r.tracked.pitch);
            stamp.pitch = stamp.voiced ? static_cast<float>(r.tracked.pitch) : 0.0f;
            stamp.held = !stamp.voiced && r.tracked.held;
            stamp.gap = r.gap;
            if (stamp.voiced)
                statVoiced.fetch_add(1, std::memory_order_relaxed);
            if (!deliver)
                statWithheld.fetch_add(1, std::memory_order_relaxed);
            else if (direct)
                accept(stamp, inIndex - frames);
            else
                postResult(stamp);
        }
    }
    statGaps.store(analyzer.gaps(), std::memory_order_relaxed);
    return windows;
}

bool PitchCorrectionKernel::postResult(const PitchStamp& stamp) noexcept {
    const uint64_t head = ringHead.load(std::memory_order_relaxed);
    if (head - ringTail.load(std::memory_order_acquire) >= static_cast<uint64_t>(kLiveResultRing)) {
        statDropped.fetch_add(1, std::memory_order_relaxed);
        return false;
    }
    ring[static_cast<size_t>(head & static_cast<uint64_t>(kLiveResultRing - 1))] = stamp;
    ringHead.store(head + 1, std::memory_order_release);
    return true;
}

int PitchCorrectionKernel::pumpAnalysis(bool deliver) noexcept {
    if (!ready || queue == nullptr)
        return 0;
    int windows = 0;
    while (auto* slot = queue->front()) {
        windows += analyse(slot->data, slot->frames, slot->frame, static_cast<uint32_t>(slot->stream), slot->stamp, deliver, false);
        queue->pop();
    }
    return windows;
}

bool PitchCorrectionKernel::deliverResult(const PitchStamp& stamp) noexcept {
    if (!ready || config.analysis != LiveAnalysisMode::manual)
        return false;
    return postResult(stamp);
}

void PitchCorrectionKernel::runWorker() noexcept {
    while (!workerStop.load(std::memory_order_acquire)) {
        if (!workerPaused.load(std::memory_order_acquire) && queue->front() != nullptr)
            pumpAnalysis(true);
        else
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
}

void PitchCorrectionKernel::accept(const PitchStamp& stamp, int64_t blockStart) noexcept {
    if (stamp.epoch != audioEpoch) {
        ++counters.staleResults;
        return;
    }
    const uint64_t wmask = static_cast<uint64_t>(kLiveResultWindow - 1);
    const PitchStamp* last = winEnd > winFirst ? &window[static_cast<size_t>((winEnd - 1) & wmask)] : nullptr;
    if (last != nullptr && stamp.centre <= last->centre) {
        ++counters.staleResults;
        return;
    }
    const int64_t lag = blockStart - stamp.windowEnd;
    counters.maxLag = std::max(counters.maxLag, lag);
    counters.lagSum += lag;
    ++counters.lagCount;
    // Positions in [previous centre, this centre) needed this result (at most one hop back: after an
    // analysis gap the positions inside the gap count as missing, not as waiting for this result).
    const double neededFrom = static_cast<double>(last != nullptr ? std::max(last->centre, stamp.centre - lat.hopSize) : stamp.centre);
    if (maxReadPos > neededFrom)
        ++counters.lateResults;
    if (winEnd - winFirst == static_cast<uint64_t>(kLiveResultWindow)) {
        ++winFirst;
        cursor = std::max(cursor, winFirst);
    }
    window[static_cast<size_t>(winEnd & wmask)] = stamp;
    ++winEnd;
    ++counters.resultsReceived;
}

PitchCorrectionKernel::Info PitchCorrectionKernel::lookup(double p) noexcept {
    const uint64_t wmask = static_cast<uint64_t>(kLiveResultWindow - 1);
    const double firstCentre = static_cast<double>(epochStart + lat.windowSize / 2);
    if (winEnd == winFirst)
        return { p < firstCentre ? kindNone : kindMissing, 0.0 };
    cursor = std::clamp(cursor, winFirst, winEnd - 1);
    auto at = [&](uint64_t k) -> const PitchStamp& { return window[static_cast<size_t>(k & wmask)]; };
    while (cursor + 1 < winEnd && static_cast<double>(at(cursor + 1).centre) <= p)
        ++cursor;
    while (cursor > winFirst && static_cast<double>(at(cursor).centre) > p)
        --cursor;
    auto from = [](const PitchStamp& s) -> Info {
        if (s.voiced)
            return { kindVoiced, static_cast<double>(s.pitch) };
        return { s.held ? kindHeld : kindUnvoiced, 0.0 };
    };
    const PitchStamp& a = at(cursor);
    const double ca = static_cast<double>(a.centre);
    if (p < ca)
        return { p < firstCentre ? kindNone : kindMissing, 0.0 };
    if (p == ca)
        return from(a);
    if (cursor + 1 >= winEnd)
        return { kindMissing, 0.0 };
    const PitchStamp& b = at(cursor + 1);
    const double cb = static_cast<double>(b.centre);
    const double span = cb - ca;
    const double hop = static_cast<double>(lat.hopSize);
    if (span > 2.0 * hop) {
        // Lost analysis input between these windows.
        if (p - ca <= 0.5 * hop)
            return from(a);
        if (cb - p <= 0.5 * hop)
            return from(b);
        return { kindMissing, 0.0 };
    }
    const double t = (p - ca) / span;
    if (a.voiced && b.voiced)
        return { kindVoiced, static_cast<double>(a.pitch) + t * (static_cast<double>(b.pitch) - static_cast<double>(a.pitch)) };
    return from(t < 0.5 ? a : b);
}

void PitchCorrectionKernel::process(float* const* data, int frames) noexcept {
    if (!ready || data == nullptr || frames <= 0)
        return;
    frames = std::min(frames, maxFrames);
    if (statsResetPending.exchange(false, std::memory_order_acq_rel)) {
        clearAudioStats();
        for (auto* s : { &statWindows, &statVoiced, &statDropped, &statWithheld, &statWindowNs, &statMaxWindowNs })
            s->store(0, std::memory_order_relaxed);
    }
    const uint64_t packed = packedParams.load(std::memory_order_acquire);
    if (packed != appliedPacked)
        applyParams(packed);

    // 1. Store the block on the input timeline and take the mono analysis copy.
    const int64_t start = inIndex;
    const int pos = static_cast<int>(start & histMask);
    const int first = std::min(frames, histCap - pos);
    for (int c = 0; c < channelCount; ++c) {
        float* base = history.data() + static_cast<size_t>(c) * static_cast<size_t>(histCap);
        std::memcpy(base + pos, data[c], sizeof(float) * static_cast<size_t>(first));
        std::memcpy(base, data[c] + first, sizeof(float) * static_cast<size_t>(frames - first));
    }
    const float* left = data[0];
    const float* right = channelCount > 1 ? data[1] : data[0];
    if (channelCount == 1 || config.input == LivePitchInput::left)
        std::memcpy(mono.data(), left, sizeof(float) * static_cast<size_t>(frames));
    else if (config.input == LivePitchInput::right)
        std::memcpy(mono.data(), right, sizeof(float) * static_cast<size_t>(frames));
    else
        for (int i = 0; i < frames; ++i)
            mono[static_cast<size_t>(i)] = 0.5f * left[i] + 0.5f * right[i];
    inIndex = start + frames;

    // 2. Analysis, then every result that has arrived.
    const int64_t now = livePitchNowNs();
    if (config.analysis == LiveAnalysisMode::inCallback) {
        analyse(mono.data(), frames, start, audioEpoch, now, true, true);
    } else {
        queue->push(static_cast<int>(audioEpoch), start, mono.data(), nullptr, 1, frames, now);
        uint64_t tail = ringTail.load(std::memory_order_relaxed);
        const uint64_t head = ringHead.load(std::memory_order_acquire);
        while (tail != head) {
            accept(ring[static_cast<size_t>(tail & static_cast<uint64_t>(kLiveResultRing - 1))], start);
            ++tail;
        }
        ringTail.store(tail, std::memory_order_release);
    }

    // 3. One output sample at a time.
    const double latency = static_cast<double>(lat.total);
    const double lowest = latency - lat.shifter - 1.0;
    const double highest = latency + lat.shifter + 1.0;
    Info info;
    double ratio = 1.0;
    double applied = 0.0;
    for (int i = 0; i < frames; ++i) {
        const int64_t n = start + i;
        if (!started) {
            tapA = Tap { n - lat.total, 0.0 };
            fading = false;
            started = true;
        }
        const double p = static_cast<double>(tapA.i) + tapA.f;
        maxReadPos = std::max(maxReadPos, fading ? std::max(p, static_cast<double>(tapB.i) + tapB.f) : p);
        info = lookup(p);

        double goal = 0.0;
        double alpha = alphaRelease;
        switch (info.kind) {
            case kindVoiced: {
                const int candidate = nearestAllowedNote(info.midi, root, mask);
                const bool keep = target >= 0 && candidate != target && inMask(target, root, mask)
                    && std::fabs(info.midi - target) < std::fabs(info.midi - candidate) + kLiveTargetHysteresis;
                if (!keep)
                    target = candidate;
                goal = std::clamp((target - info.midi) * 100.0, -kLiveCorrectionMaxCents, kLiveCorrectionMaxCents);
                lastGoal = goal;
                alpha = alphaRetune;
                missingRun = 0;
                lastPeriod = std::clamp(rate / (440.0 * std::exp2((info.midi - 69.0) / 12.0)), static_cast<double>(minPeriod),
                                        static_cast<double>(lat.maxPeriod));
                break;
            }
            case kindHeld:
                goal = lastGoal;
                alpha = alphaRetune;
                missingRun = 0;
                break;
            case kindMissing:
                ++counters.missingSamples;
                if (missingRun < missingHold) {
                    goal = lastGoal;
                    alpha = alphaRetune;
                } else {
                    lastGoal = 0.0;
                    lastPeriod = 0.0;
                    target = -1;
                }
                ++missingRun;
                break;
            default:
                target = -1;
                lastGoal = 0.0;
                lastPeriod = 0.0;
                missingRun = 0;
                break;
        }
        smoothedCents += alpha * (goal - smoothedCents);
        if (goal == 0.0 && std::fabs(smoothedCents) < 1.0e-4)
            smoothedCents = 0.0;
        if (smoothedStrength != strengthTarget) {
            smoothedStrength += alphaStrength * (strengthTarget - smoothedStrength);
            if (std::fabs(strengthTarget - smoothedStrength) < 1.0e-6)
                smoothedStrength = strengthTarget;
        }
        applied = std::clamp(smoothedCents * smoothedStrength, -kLiveCorrectionMaxCents, kLiveCorrectionMaxCents);
        ratio = applied == 0.0 ? 1.0 : std::exp2(applied / 1200.0);
        if (applied != 0.0)
            ++counters.correctedSamples;

        double g = 0.0;
        if (fading)
            g = 0.5 - 0.5 * std::cos(kPi * (static_cast<double>(fadePos) + 0.5) / static_cast<double>(fadeLen));
        for (int c = 0; c < channelCount; ++c) {
            float y = read(c, tapA);
            if (fading)
                y += static_cast<float>(g) * (read(c, tapB) - y);
            data[c][i] = y;
        }
        if (tracePtr != nullptr && tracePtr->count < tracePtr->readPos.size()) {
            const size_t k = tracePtr->count++;
            tracePtr->readPos[k] = p;
            tracePtr->inputMidi[k] = static_cast<float>(info.midi);
            tracePtr->cents[k] = static_cast<float>(applied);
            tracePtr->kind[k] = static_cast<int8_t>(info.kind);
        }

        // Advance, then decide on a splice for the next output sample.
        auto advance = [ratio](Tap& tap) {
            tap.f += ratio;
            const double whole = std::floor(tap.f);
            tap.i += static_cast<int64_t>(whole);
            tap.f -= whole;
        };
        advance(tapA);
        if (fading) {
            advance(tapB);
            if (++fadePos >= fadeLen) {
                tapA = tapB;
                fading = false;
            }
        }
        const int64_t next = n + 1;
        auto startFade = [&](const Tap& to, int length) {
            tapB = to;
            fadePos = 0;
            fadeLen = std::max(1, length);
            fading = true;
        };
        auto shifted = [](const Tap& tap, double by) {
            const double f = tap.f + by;
            const double whole = std::floor(f);
            return Tap { tap.i + static_cast<int64_t>(whole), f - whole };
        };
        if (!fading) {
            const double delay = static_cast<double>(next - tapA.i) - tapA.f;
            // Jump by a whole number of detected periods (at least minJump). The crossfade runs
            // for twice that length so a raised-cosine blend stays smooth while the ratio is
            // still moving after a note change; the trigger stays at half a jump so the tap
            // never leaves the L +- J headroom prepared for it.
            const double jump = lastPeriod > 0.0 ? std::ceil(minJump / lastPeriod) * lastPeriod : unvoicedJump;
            const int fade = std::max(1, static_cast<int>(std::lround(2.0 * jump)));
            if (ratio > 1.0 && delay < latency - 0.5 * jump) {
                startFade(shifted(tapA, -jump), fade);
                ++counters.jumps;
            } else if (ratio < 1.0 && delay > latency + 0.5 * jump) {
                startFade(shifted(tapA, jump), fade);
                ++counters.jumps;
            } else if (ratio == 1.0 && (tapA.i != next - lat.total || tapA.f != 0.0)) {
                startFade(Tap { next - lat.total, 0.0 }, recentreLength);
                ++counters.recentres;
            }
        }
        const double delayA = static_cast<double>(next - tapA.i) - tapA.f;
        const double delayB = fading ? static_cast<double>(next - tapB.i) - tapB.f : latency;
        if (delayA < lowest || delayA > highest || delayB < lowest || delayB > highest) {
            tapA = Tap { next - lat.total, 0.0 };
            fading = false;
            ++counters.recoveries;
        }
    }

    counters.samples += frames;
    statSamples.store(counters.samples, std::memory_order_relaxed);
    statReceived.store(counters.resultsReceived, std::memory_order_relaxed);
    statLate.store(counters.lateResults, std::memory_order_relaxed);
    statStale.store(counters.staleResults, std::memory_order_relaxed);
    statMissing.store(counters.missingSamples, std::memory_order_relaxed);
    statCorrected.store(counters.correctedSamples, std::memory_order_relaxed);
    statJumps.store(counters.jumps, std::memory_order_relaxed);
    statRecentres.store(counters.recentres, std::memory_order_relaxed);
    statRecoveries.store(counters.recoveries, std::memory_order_relaxed);
    statMaxLag.store(counters.maxLag, std::memory_order_relaxed);
    statLagSum.store(counters.lagSum, std::memory_order_relaxed);
    statLagCount.store(counters.lagCount, std::memory_order_relaxed);
    statInputMidi.store(info.kind == kindVoiced ? info.midi : 0.0, std::memory_order_relaxed);
    statTarget.store(info.kind == kindVoiced || info.kind == kindHeld ? target : -1, std::memory_order_relaxed);
    statAppliedCents.store(applied, std::memory_order_relaxed);
    statRatio.store(ratio, std::memory_order_relaxed);
}

void PitchCorrectionKernel::clearAudioStats() noexcept {
    const int64_t resets = counters.resets;
    counters = AudioCounters {};
    counters.resets = resets;
}

LiveCorrectionStats PitchCorrectionKernel::statistics() const noexcept {
    LiveCorrectionStats s;
    s.samples = statSamples.load(std::memory_order_relaxed);
    s.windows = statWindows.load(std::memory_order_relaxed);
    s.voicedWindows = statVoiced.load(std::memory_order_relaxed);
    s.analysisDroppedFrames = queue != nullptr ? queue->droppedFrames() : 0;
    s.analysisGaps = statGaps.load(std::memory_order_relaxed);
    s.resultsReceived = statReceived.load(std::memory_order_relaxed);
    s.resultsDropped = statDropped.load(std::memory_order_relaxed);
    s.resultsWithheld = statWithheld.load(std::memory_order_relaxed);
    s.lateResults = statLate.load(std::memory_order_relaxed);
    s.staleResults = statStale.load(std::memory_order_relaxed);
    s.missingSamples = statMissing.load(std::memory_order_relaxed);
    s.correctedSamples = statCorrected.load(std::memory_order_relaxed);
    s.jumps = statJumps.load(std::memory_order_relaxed);
    s.recentres = statRecentres.load(std::memory_order_relaxed);
    s.recoveries = statRecoveries.load(std::memory_order_relaxed);
    s.resets = statResets.load(std::memory_order_relaxed);
    const int64_t lagCount = statLagCount.load(std::memory_order_relaxed);
    const int64_t maxLag = statMaxLag.load(std::memory_order_relaxed);
    s.maxDeliveryLag = lagCount > 0 ? maxLag : 0;
    s.meanDeliveryLag = lagCount > 0 ? static_cast<double>(statLagSum.load(std::memory_order_relaxed)) / static_cast<double>(lagCount) : 0.0;
    s.maxWindowMs = static_cast<double>(statMaxWindowNs.load(std::memory_order_relaxed)) * 1.0e-6;
    s.meanWindowMs = s.windows > 0 ? static_cast<double>(statWindowNs.load(std::memory_order_relaxed)) * 1.0e-6 / static_cast<double>(s.windows) : 0.0;
    s.inputMidi = statInputMidi.load(std::memory_order_relaxed);
    s.targetMidi = statTarget.load(std::memory_order_relaxed);
    s.appliedCents = statAppliedCents.load(std::memory_order_relaxed);
    s.ratio = statRatio.load(std::memory_order_relaxed);
    s.bytes = bytes();
    return s;
}

size_t PitchCorrectionKernel::bytes() const noexcept {
    return history.capacity() * sizeof(float) + mono.capacity() * sizeof(float) + window.capacity() * sizeof(PitchStamp)
        + ring.capacity() * sizeof(PitchStamp) + (queue != nullptr ? static_cast<size_t>(queue->capacity()) * sizeof(RecordSlot) : 0)
        + analysisBytes;
}

} // namespace msp
