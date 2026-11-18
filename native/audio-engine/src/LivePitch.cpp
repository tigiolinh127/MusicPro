#include "msp/LivePitch.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>

namespace msp {

namespace {

uint64_t packKey(const MusicalKey& key, const MappingSettings& mapping) {
    const auto tolerance = static_cast<uint64_t>(std::llround(std::clamp(mapping.toleranceCents, 0.0, 50.0) * 1000.0));
    return static_cast<uint64_t>(key.root & 0xff) | (static_cast<uint64_t>(static_cast<int>(key.scale) & 0xff) << 8)
        | (static_cast<uint64_t>(mapping.tieBreak == TieBreak::upper ? 1 : 0) << 16) | (tolerance << 32);
}

void unpackKey(uint64_t packed, MusicalKey& key, MappingSettings& mapping) {
    key.root = static_cast<int>(packed & 0xff) % 12;
    key.scale = scaleTypeAt(std::clamp(static_cast<int>((packed >> 8) & 0xff), 0, kScaleTypeCount - 1));
    mapping.tieBreak = ((packed >> 16) & 0xff) != 0 ? TieBreak::upper : TieBreak::lower;
    mapping.toleranceCents = static_cast<double>(packed >> 32) / 1000.0;
}

} // namespace

const char* livePitchInputName(LivePitchInput input) {
    switch (input) {
        case LivePitchInput::left: return "input1";
        case LivePitchInput::right: return "input2";
        case LivePitchInput::mix: return "mix";
    }
    return "mix";
}

bool livePitchInputFromName(const std::string& name, LivePitchInput& input) {
    if (name == "input1")
        input = LivePitchInput::left;
    else if (name == "input2")
        input = LivePitchInput::right;
    else if (name == "mix")
        input = LivePitchInput::mix;
    else
        return false;
    return true;
}

int64_t livePitchNowNs() {
    return std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now().time_since_epoch()).count();
}

// --- NoteTracker -------------------------------------------------------------------------------

NoteTracker::NoteTracker(const NoteTrackerSettings& settings) : cfg(settings) {}

void NoteTracker::configure(const NoteTrackerSettings& settings) {
    cfg = settings;
    reset();
}

void NoteTracker::reset() {
    current = -1;
    candidate = 0.0;
    candidateSum = 0.0;
    candidateFrames = 0;
    octaveRun = 0;
    unvoicedRun = 0;
}

std::string checkNoteTrackerSettings(const NoteTrackerSettings& s) {
    if (!std::isfinite(s.hysteresis) || s.hysteresis < 0.0 || s.hysteresis > 0.5)
        return "The note hysteresis must be between 0 and 0.5 semitones.";
    if (s.onsetFrames < 1 || s.onsetFrames > 16)
        return "onsetFrames must be between 1 and 16.";
    if (s.changeFrames < 1 || s.changeFrames > 32)
        return "changeFrames must be between 1 and 32.";
    if (s.octaveFrames < 1 || s.octaveFrames > 32)
        return "octaveFrames must be between 1 and 32.";
    if (s.holdFrames < 0 || s.holdFrames > 64)
        return "holdFrames must be between 0 and 64.";
    return {};
}

TrackedPitch NoteTracker::update(bool voiced, double midi) {
    TrackedPitch out;
    const double reach = 0.5 + cfg.hysteresis;
    if (!voiced || !std::isfinite(midi) || midi <= 0.0) {
        candidateFrames = 0;
        octaveRun = 0;
        ++unvoicedRun;
        if (current >= 0 && unvoicedRun > cfg.holdFrames)
            current = -1;
        out.note = current;
        out.held = current >= 0;
        return out;
    }
    unvoicedRun = 0;
    out.pitch = midi;

    // Counts consecutive frames that agree with each other on a pitch away from the note; the
    // new note is the one nearest their mean.
    auto agree = [&](int needed) {
        if (candidateFrames > 0 && std::abs(midi - candidate) < reach) {
            ++candidateFrames;
            candidateSum += midi;
        } else {
            candidateFrames = 1;
            candidateSum = midi;
        }
        candidate = midi;
        return candidateFrames >= needed;
    };
    auto candidateNote = [&] { return static_cast<int>(std::lround(candidateSum / candidateFrames)); };

    if (current < 0) {
        if (agree(cfg.onsetFrames)) {
            current = candidateNote();
            candidateFrames = 0;
            out.onset = true;
        } else {
            out.pending = true;
        }
        out.note = current;
        return out;
    }

    const double away = midi - static_cast<double>(current);
    if (std::abs(away) < reach) {
        candidateFrames = 0;
        octaveRun = 0;
        out.note = current;
        return out;
    }
    const int octaves = static_cast<int>(std::lround(away / 12.0));
    if (octaves != 0 && std::abs(octaves) <= 2 && std::abs(away - 12.0 * octaves) < reach) {
        candidateFrames = 0;
        if (++octaveRun < cfg.octaveFrames) {
            out.pitch = midi - 12.0 * octaves;
            out.octaveCorrected = true;
            out.note = current;
            return out;
        }
        current = static_cast<int>(std::lround(midi));
        octaveRun = 0;
        out.onset = true;
        out.note = current;
        return out;
    }
    octaveRun = 0;
    if (agree(cfg.changeFrames)) {
        current = candidateNote();
        candidateFrames = 0;
        out.onset = true;
    } else {
        out.pending = true;
    }
    out.note = current;
    return out;
}

// --- Settings ----------------------------------------------------------------------------------

PitchParams livePitchParams(const LivePitchSettings& s, double sampleRate) {
    PitchParams p;
    p.minHz = s.minHz;
    p.maxHz = s.maxHz;
    p.hopSize = s.hopSize;
    p.confidenceThreshold = s.confidenceThreshold;
    p.silenceDb = s.silenceDb;
    p.windowSize = s.windowSize;
    if (p.windowSize == 0) {
        p.windowSize = kPitchMinWindow;
        if (std::isfinite(sampleRate) && sampleRate > 0.0 && std::isfinite(s.minHz) && s.minHz >= kPitchLowestHz) {
            const int needed = 2 * (static_cast<int>(std::ceil(sampleRate / s.minHz)) + 1);
            p.windowSize = std::max(kPitchMinWindow, (needed + 63) / 64 * 64);
        }
    }
    return p;
}

std::string checkLivePitchSettings(const LivePitchSettings& s, double sampleRate) {
    if (s.windowSize != 0 && (s.windowSize < kPitchMinWindow || s.windowSize > kPitchMaxWindow))
        return "The live analysis window must be 0 (automatic) or between 256 and 16384 samples.";
    if (s.input != LivePitchInput::left && s.input != LivePitchInput::right && s.input != LivePitchInput::mix)
        return "The live pitch input must be input1, input2 or mix.";
    const auto tracker = checkNoteTrackerSettings(s.tracker);
    if (!tracker.empty())
        return tracker;
    return checkPitchParams(livePitchParams(s, sampleRate), sampleRate);
}

// --- LivePitchAnalyzer -------------------------------------------------------------------------

std::string LivePitchAnalyzer::prepare(double sampleRate, const LivePitchSettings& settings) {
    rate = 0.0;
    const auto error = checkLivePitchSettings(settings, sampleRate);
    if (!error.empty())
        return error;
    params = livePitchParams(settings, sampleRate);
    const auto detectorError = detector.prepare(sampleRate, params);
    if (!detectorError.empty())
        return detectorError;
    tracker.configure(settings.tracker);
    buffer.assign(static_cast<size_t>(params.windowSize + kRecordSlotFrames), 0.0f);
    rate = sampleRate;
    windowCount = 0;
    gapCount = 0;
    invalidCount = 0;
    reset();
    return {};
}

void LivePitchAnalyzer::reset() {
    count = 0;
    bufferStart = 0;
    expected = -1;
    lastInvalid = -1;
    arrival = 0;
    dequeue = 0;
    sequence = 0;
    gapPending = true;
    tracker.reset();
}

void LivePitchAnalyzer::setKey(const MusicalKey& value, const MappingSettings& settings) {
    key = value;
    mapping = settings;
}

bool LivePitchAnalyzer::push(const float* data, int channels, int frames, int64_t first, int64_t arrivalNs, int64_t dequeueNs) {
    if (!prepared() || data == nullptr || frames <= 0 || frames > kRecordSlotFrames || (channels != 1 && channels != 2))
        return false;
    if (expected >= 0 && first != expected) {
        // Input was lost (queue overflow): the buffered audio no longer joins up with this block.
        count = 0;
        tracker.reset();
        gapPending = true;
        ++gapCount;
    }
    if (count == 0)
        bufferStart = first;
    if (count + frames > static_cast<int>(buffer.size()))
        return false;
    float* out = buffer.data() + count;
    for (int i = 0; i < frames; ++i) {
        const float value = channels == 2 ? 0.5f * (data[2 * i] + data[2 * i + 1]) : data[i];
        if (!std::isfinite(value))
            lastInvalid = first + i;
        out[i] = value;
    }
    count += frames;
    expected = first + frames;
    arrival = arrivalNs;
    dequeue = dequeueNs;
    return true;
}

bool LivePitchAnalyzer::next(LivePitchResult& r) {
    const int window = params.windowSize;
    if (!prepared() || count < window)
        return false;
    r = LivePitchResult {};
    r.startedNs = livePitchNowNs();
    r.sequence = sequence++;
    r.windowStart = bufferStart;
    r.windowEnd = bufferStart + window;
    r.arrivalNs = arrival;
    r.dequeueNs = dequeue;
    r.invalid = lastInvalid >= r.windowStart && lastInvalid < r.windowEnd;
    const auto frame = detector.analyze(buffer.data(), (static_cast<double>(bufferStart) + 0.5 * window) / rate);
    r.confidence = frame.confidence;
    r.levelDb = frame.levelDb;
    r.voiced = frame.voiced && !r.invalid;
    if (r.voiced) {
        r.frequency = frame.frequency;
        r.midi = midiFromFrequency(frame.frequency);
        r.nearestMidi = frame.midi;
        r.cents = frame.cents;
    }
    r.gap = gapPending;
    gapPending = false;
    r.tracked = tracker.update(r.voiced, r.midi);
    if (mapTargets && r.voiced && r.tracked.note >= 0) {
        const auto target = mapPitch(r.tracked.pitch, true, key, mapping);
        if (target.status == MappingStatus::inTune || target.status == MappingStatus::needsCorrection) {
            r.targetMidi = target.targetMidi;
            r.correctionCents = target.cents;
            r.inTune = target.status == MappingStatus::inTune;
        }
    }

    const int hop = params.hopSize;
    std::memmove(buffer.data(), buffer.data() + hop, sizeof(float) * static_cast<size_t>(count - hop));
    count -= hop;
    bufferStart += hop;
    ++windowCount;
    if (r.invalid)
        ++invalidCount;

    r.completedNs = livePitchNowNs();
    r.windowDelayMs = 1000.0 * 0.5 * window / rate;
    r.computeMs = static_cast<double>(r.completedNs - r.startedNs) / 1.0e6;
    if (r.arrivalNs > 0) {
        r.schedulingMs = static_cast<double>(std::max<int64_t>(0, r.dequeueNs - r.arrivalNs)) / 1.0e6;
        r.availabilityMs = r.windowDelayMs + static_cast<double>(std::max<int64_t>(0, r.completedNs - r.arrivalNs)) / 1.0e6;
    } else {
        r.availabilityMs = r.windowDelayMs + r.computeMs;
    }
    return true;
}

// --- LivePitchDetector -------------------------------------------------------------------------

LivePitchDetector::LivePitchDetector() : history(static_cast<size_t>(kLivePitchHistory)) {}

LivePitchDetector::~LivePitchDetector() {
    stop();
}

std::string LivePitchDetector::start(double sampleRate, const LivePitchSettings& settings, const MusicalKey& key,
                                     const MappingSettings& mapping) {
    stop();
    const auto error = analyzer.prepare(sampleRate, settings);
    if (!error.empty())
        return error;
    config = settings;
    params = analyzer.parameters();
    rate = sampleRate;
    queue = std::make_unique<RecordQueue>(kLivePitchQueueSlots);
    stageL.assign(static_cast<size_t>(kRecordSlotFrames), 0.0f);
    stageR.assign(static_cast<size_t>(kRecordSlotFrames), 0.0f);
    staged = 0;
    stageChannels = settings.input == LivePitchInput::mix ? 2 : 1;
    tapFrames = 0;
    inputFrames.store(0);
    resetRequested.store(false);
    stopping.store(false);
    {
        std::lock_guard<std::mutex> lock(resultMutex);
        published = 0;
        totals = LivePitchStats {};
        sumScheduling = sumCompute = sumAvailability = 0.0;
        droppedBase = overflowBase = inputBase = 0;
    }
    appliedKey = ~0ull;
    packedKey.store(packKey(key, mapping));
    applyKey(packedKey.load());
    worker = std::thread([this] { run(); });
    return {};
}

void LivePitchDetector::stop() {
    if (!worker.joinable())
        return;
    stopping.store(true, std::memory_order_release);
    worker.join();
}

void LivePitchDetector::flush(int64_t stampNs) noexcept {
    queue->push(0, tapFrames, stageL.data(), stageR.data(), stageChannels, staged, stampNs);
    tapFrames += staged;
    staged = 0;
}

void LivePitchDetector::write(const float* left, const float* right, int frames) noexcept {
    if (queue == nullptr || frames <= 0)
        return;
    const int64_t now = livePitchNowNs();
    const float* a = left;
    const float* b = right;
    if (config.input == LivePitchInput::right) {
        a = right != nullptr ? right : left;
        b = nullptr;
    } else if (config.input == LivePitchInput::left) {
        b = nullptr;
    } else if (b == nullptr) {
        b = a;   // the mix of a mono input is that input
    }
    int done = 0;
    while (done < frames) {
        const int n = std::min(frames - done, kRecordSlotFrames - staged);
        const size_t bytes = sizeof(float) * static_cast<size_t>(n);
        if (a != nullptr)
            std::memcpy(stageL.data() + staged, a + done, bytes);
        else
            std::memset(stageL.data() + staged, 0, bytes);
        if (stageChannels == 2) {
            if (b != nullptr)
                std::memcpy(stageR.data() + staged, b + done, bytes);
            else
                std::memset(stageR.data() + staged, 0, bytes);
        }
        staged += n;
        done += n;
        if (staged >= kLivePitchFlushFrames)
            flush(now);
    }
    inputFrames.store(tapFrames + staged, std::memory_order_release);
}

void LivePitchDetector::setKey(const MusicalKey& key, const MappingSettings& mapping) {
    packedKey.store(packKey(key, mapping), std::memory_order_release);
}

void LivePitchDetector::requestReset() {
    resetRequested.store(true, std::memory_order_release);
}

void LivePitchDetector::applyKey(uint64_t packed) {
    MusicalKey key;
    MappingSettings mapping;
    unpackKey(packed, key, mapping);
    analyzer.setKey(key, mapping);
    appliedKey = packed;
}

void LivePitchDetector::run() {
    LivePitchResult result;
    int64_t seenGaps = 0;
    while (!stopping.load(std::memory_order_acquire)) {
        if (resetRequested.exchange(false, std::memory_order_acq_rel)) {
            analyzer.reset();
            std::lock_guard<std::mutex> lock(resultMutex);
            ++totals.resets;
        }
        const uint64_t key = packedKey.load(std::memory_order_acquire);
        if (key != appliedKey)
            applyKey(key);
        bool worked = false;
        while (auto* slot = queue->front()) {
            const int64_t taken = livePitchNowNs();
            const int64_t queued = inputFrames.load(std::memory_order_acquire) - slot->frame;
            analyzer.push(slot->data, slot->channels, slot->frames, slot->frame, slot->stamp, taken);
            queue->pop();
            {
                std::lock_guard<std::mutex> lock(resultMutex);
                totals.gaps += analyzer.gaps() - seenGaps;
                totals.maxQueuedFrames = std::max(totals.maxQueuedFrames, queued);
                seenGaps = analyzer.gaps();
            }
            while (analyzer.next(result))
                publish(result);
            worked = true;
            if (stopping.load(std::memory_order_acquire))
                break;
        }
        if (!worked)
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
}

void LivePitchDetector::publish(const LivePitchResult& r) {
    std::lock_guard<std::mutex> lock(resultMutex);
    history[static_cast<size_t>(published % kLivePitchHistory)] = r;
    ++published;
    ++totals.windows;
    if (r.voiced)
        ++totals.voicedWindows;
    if (r.invalid)
        ++totals.invalidWindows;
    ++totals.latencyCount;
    sumScheduling += r.schedulingMs;
    sumCompute += r.computeMs;
    sumAvailability += r.availabilityMs;
    totals.maxSchedulingMs = std::max(totals.maxSchedulingMs, r.schedulingMs);
    totals.maxComputeMs = std::max(totals.maxComputeMs, r.computeMs);
    totals.maxAvailabilityMs = std::max(totals.maxAvailabilityMs, r.availabilityMs);
}

bool LivePitchDetector::latest(LivePitchResult& result) const {
    std::lock_guard<std::mutex> lock(resultMutex);
    if (published == 0)
        return false;
    result = history[static_cast<size_t>((published - 1) % kLivePitchHistory)];
    return true;
}

std::vector<LivePitchResult> LivePitchDetector::recent(int wanted) const {
    std::lock_guard<std::mutex> lock(resultMutex);
    const int64_t n = std::min<int64_t>({ static_cast<int64_t>(std::max(0, wanted)), published, static_cast<int64_t>(kLivePitchHistory) });
    std::vector<LivePitchResult> out;
    out.reserve(static_cast<size_t>(n));
    for (int64_t i = published - n; i < published; ++i)
        out.push_back(history[static_cast<size_t>(i % kLivePitchHistory)]);
    return out;
}

LivePitchStats LivePitchDetector::statistics() const {
    std::lock_guard<std::mutex> lock(resultMutex);
    LivePitchStats s = totals;
    s.inputFrames = inputFrames.load(std::memory_order_acquire) - inputBase;
    if (queue != nullptr) {
        s.droppedFrames = queue->droppedFrames() - droppedBase;
        s.overflows = queue->overflows() - overflowBase;
        s.queueSlots = queue->capacity();
    }
    s.queueFrames = s.queueSlots * kRecordSlotFrames;
    s.bytes = static_cast<size_t>(s.queueSlots) * sizeof(RecordSlot) + (stageL.size() + stageR.size()) * sizeof(float)
        + analyzer.bytes() + history.size() * sizeof(LivePitchResult);
    s.windowDelayMs = rate > 0.0 ? 1000.0 * 0.5 * params.windowSize / rate : 0.0;
    if (s.latencyCount > 0) {
        s.meanSchedulingMs = sumScheduling / static_cast<double>(s.latencyCount);
        s.meanComputeMs = sumCompute / static_cast<double>(s.latencyCount);
        s.meanAvailabilityMs = sumAvailability / static_cast<double>(s.latencyCount);
    }
    return s;
}

void LivePitchDetector::resetStatistics() {
    std::lock_guard<std::mutex> lock(resultMutex);
    const int64_t resets = totals.resets;
    totals = LivePitchStats {};
    totals.resets = resets;
    sumScheduling = sumCompute = sumAvailability = 0.0;
    inputBase = inputFrames.load(std::memory_order_acquire);
    if (queue != nullptr) {
        droppedBase = queue->droppedFrames();
        overflowBase = queue->overflows();
    }
}

} // namespace msp
