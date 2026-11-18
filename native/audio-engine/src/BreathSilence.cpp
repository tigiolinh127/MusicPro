#include "msp/BreathSilence.h"

#include "msp/Fft.h"

#include <algorithm>
#include <cmath>
#include <complex>
#include <cstdio>
#include <numeric>

namespace msp {
namespace {

std::string number(double value, int decimals) {
    char text[64];
    std::snprintf(text, sizeof(text), "%.*f", decimals, value);
    return text;
}

float monoAt(const float* left, const float* right, int channels, int64_t i, int64_t* repaired) {
    float a = left[i];
    float b = channels >= 2 && right != nullptr ? right[i] : a;
    if (!std::isfinite(a)) {
        a = 0.0f;
        if (repaired != nullptr)
            ++(*repaired);
    }
    if (!std::isfinite(b)) {
        b = 0.0f;
        if (repaired != nullptr)
            ++(*repaired);
    }
    return 0.5f * (a + b);
}

double dbFromRms(double rms) {
    if (!(rms > 0.0) || !std::isfinite(rms))
        return -120.0;
    return 20.0 * std::log10(std::max(rms, 1.0e-12));
}

double raisedCosine(double t) {
    // t in [0,1]: 0 → 1, 1 → 0
    t = std::clamp(t, 0.0, 1.0);
    return 0.5 + 0.5 * std::cos(3.14159265358979323846 * t);
}

} // namespace

const char* breathKindName(BreathKind kind) {
    switch (kind) {
        case BreathKind::silence: return "silence";
        case BreathKind::breath: return "breath";
        case BreathKind::manual: return "manual";
    }
    return "manual";
}

BreathKind breathKindFromName(const std::string& name) {
    if (name == "silence")
        return BreathKind::silence;
    if (name == "breath")
        return BreathKind::breath;
    return BreathKind::manual;
}

std::string checkSilenceSettings(const SilenceSettings& settings, double sampleRate, int channels) {
    if (!std::isfinite(sampleRate) || sampleRate < 8000.0 || sampleRate > 192000.0)
        return "Silence detection supports sample rates from 8 kHz to 192 kHz. This audio is at "
            + number(sampleRate, 0) + " Hz.";
    if (channels != 1 && channels != 2)
        return "Silence detection supports mono and stereo audio.";
    if (!std::isfinite(settings.thresholdDb) || settings.thresholdDb > -6.0 || settings.thresholdDb < -120.0)
        return "Silence threshold must be between -120 and -6 dBFS.";
    if (!std::isfinite(settings.minDurationMs) || settings.minDurationMs < 10.0 || settings.minDurationMs > 5000.0)
        return "Silence minimum duration must be between 10 and 5000 milliseconds.";
    if (!std::isfinite(settings.hangMs) || settings.hangMs < 0.0 || settings.hangMs > 1000.0)
        return "Silence hang time must be between 0 and 1000 milliseconds.";
    if (!std::isfinite(settings.adaptiveMarginDb) || settings.adaptiveMarginDb < 0.0 || settings.adaptiveMarginDb > 40.0)
        return "Adaptive silence margin must be between 0 and 40 dB.";
    return {};
}

std::string checkBreathDetectSettings(const BreathDetectSettings& settings, double sampleRate, int channels) {
    if (!std::isfinite(sampleRate) || sampleRate < 8000.0 || sampleRate > 192000.0)
        return "Breath detection supports sample rates from 8 kHz to 192 kHz.";
    if (channels != 1 && channels != 2)
        return "Breath detection supports mono and stereo audio.";
    if (!std::isfinite(settings.minDurationMs) || settings.minDurationMs < 10.0 || settings.minDurationMs > 2000.0)
        return "Breath minimum duration must be between 10 and 2000 milliseconds.";
    if (!std::isfinite(settings.maxDurationMs) || settings.maxDurationMs < settings.minDurationMs
        || settings.maxDurationMs > 2000.0)
        return "Breath maximum duration must be at least the minimum and at most 2000 milliseconds.";
    if (!std::isfinite(settings.minConfidence) || settings.minConfidence < 0.0 || settings.minConfidence > 1.0)
        return "Breath confidence must be between 0 and 1.";
    return {};
}

std::string validateBreathGainDb(float gainDb) {
    if (!std::isfinite(gainDb) || gainDb < kBreathGainMinDb || gainDb > kBreathGainMaxDb)
        return "Region gain must be between " + number(kBreathGainMinDb, 0) + " and "
            + number(kBreathGainMaxDb, 0) + " dB.";
    return {};
}

std::string validateBreathRegion(const BreathRegion& region, int64_t sourceOffset, int64_t duration) {
    if (region.id.empty())
        return "A breath region needs an id.";
    if (region.sourceEnd <= region.sourceStart)
        return "A breath region needs a positive duration.";
    if (region.sourceStart < sourceOffset || region.sourceEnd > sourceOffset + duration)
        return "A breath region must stay inside the clip.";
    if (region.fadeIn < 0 || region.fadeOut < 0)
        return "Region fades cannot be negative.";
    const int64_t length = region.sourceEnd - region.sourceStart;
    if (region.fadeIn + region.fadeOut > length)
        return "Region fades cannot be longer than the region.";
    if (!std::isfinite(region.confidence) || region.confidence < 0.0f || region.confidence > 1.0f)
        return "Region confidence must be between 0 and 1.";
    return validateBreathGainDb(region.gainDb);
}

void sortBreathRegions(std::vector<BreathRegion>& regions) {
    std::sort(regions.begin(), regions.end(), [](const BreathRegion& a, const BreathRegion& b) {
        if (a.sourceStart != b.sourceStart)
            return a.sourceStart < b.sourceStart;
        return a.sourceEnd < b.sourceEnd;
    });
}

std::string checkBreathRegionOverlaps(const std::vector<BreathRegion>& regions) {
    std::vector<BreathRegion> active;
    for (const auto& region : regions)
        if (!region.ignored)
            active.push_back(region);
    sortBreathRegions(active);
    for (size_t i = 1; i < active.size(); ++i) {
        if (active[i].sourceStart < active[i - 1].sourceEnd)
            return "Breath/silence regions cannot overlap.";
    }
    return {};
}

SilenceDetectResult detectSilence(const float* left, const float* right, int64_t frames, int channels,
                                  double sampleRate, const SilenceSettings& settings) {
    SilenceDetectResult out;
    out.error = checkSilenceSettings(settings, sampleRate, channels);
    if (!out.error.empty())
        return out;
    if (left == nullptr || frames <= 0) {
        out.error = "No audio was given for silence detection.";
        return out;
    }
    if (channels == 2 && right == nullptr) {
        out.error = "Stereo silence detection needs both channels.";
        return out;
    }

    const int hop = std::max(32, static_cast<int>(std::llround(sampleRate * 0.005))); // 5 ms
    const int win = hop * 2;
    std::vector<double> rmsDb;
    rmsDb.reserve(static_cast<size_t>(frames / hop) + 1);
    for (int64_t start = 0; start < frames; start += hop) {
        const int64_t end = std::min(start + win, frames);
        double sum = 0.0;
        int count = 0;
        for (int64_t i = start; i < end; ++i) {
            const float v = monoAt(left, right, channels, i, &out.repairedSamples);
            sum += static_cast<double>(v) * static_cast<double>(v);
            ++count;
        }
        rmsDb.push_back(dbFromRms(std::sqrt(sum / std::max(1, count))));
    }
    if (rmsDb.empty())
        return out;

    double floorDb = settings.thresholdDb;
    if (settings.adaptiveFloor) {
        std::vector<double> sorted = rmsDb;
        const size_t idx = std::min(sorted.size() - 1, sorted.size() / 10); // ~10th percentile
        std::nth_element(sorted.begin(), sorted.begin() + static_cast<std::ptrdiff_t>(idx), sorted.end());
        floorDb = sorted[idx];
        // Digital silence: clamp floor so adaptive margin still works.
        floorDb = std::max(floorDb, -96.0);
    }
    out.noiseFloorDb = floorDb;
    out.thresholdDb = settings.adaptiveFloor ? floorDb + settings.adaptiveMarginDb : settings.thresholdDb;
    const double enterDb = out.thresholdDb;
    const double exitDb = enterDb + 3.0; // hysteresis
    const int64_t minSamples = std::max<int64_t>(1, static_cast<int64_t>(std::llround(sampleRate * settings.minDurationMs / 1000.0)));
    const int64_t hangSamples = std::max<int64_t>(0, static_cast<int64_t>(std::llround(sampleRate * settings.hangMs / 1000.0)));

    bool inSilence = false;
    int64_t regionStart = 0;
    int64_t belowSince = -1;
    int64_t aboveSince = -1;
    for (size_t i = 0; i < rmsDb.size(); ++i) {
        const int64_t sample = static_cast<int64_t>(i) * hop;
        const double db = rmsDb[i];
        if (!inSilence) {
            if (db <= enterDb) {
                if (belowSince < 0)
                    belowSince = sample;
                if (sample - belowSince >= hangSamples) {
                    inSilence = true;
                    regionStart = belowSince;
                    aboveSince = -1;
                }
            } else {
                belowSince = -1;
            }
        } else {
            if (db > exitDb) {
                if (aboveSince < 0)
                    aboveSince = sample;
                if (sample - aboveSince >= hangSamples) {
                    const int64_t regionEnd = std::min(frames, aboveSince);
                    if (regionEnd - regionStart >= minSamples)
                        out.regions.emplace_back(regionStart, regionEnd);
                    inSilence = false;
                    belowSince = -1;
                    aboveSince = -1;
                }
            } else {
                aboveSince = -1;
            }
        }
    }
    if (inSilence && frames - regionStart >= minSamples)
        out.regions.emplace_back(regionStart, frames);

    // Merge tiny gaps (< hang) between silence regions to avoid fragmentation.
    if (out.regions.size() >= 2) {
        std::vector<std::pair<int64_t, int64_t>> merged;
        merged.push_back(out.regions.front());
        for (size_t i = 1; i < out.regions.size(); ++i) {
            if (out.regions[i].first - merged.back().second <= hangSamples)
                merged.back().second = out.regions[i].second;
            else
                merged.push_back(out.regions[i]);
        }
        out.regions = std::move(merged);
    }
    return out;
}

BreathDetectResult detectBreathCandidates(const float* left, const float* right, int64_t frames, int channels,
                                          double sampleRate, const SilenceSettings& silence,
                                          const BreathDetectSettings& settings) {
    BreathDetectResult out;
    out.error = checkBreathDetectSettings(settings, sampleRate, channels);
    if (!out.error.empty())
        return out;
    auto silenceCheck = checkSilenceSettings(silence, sampleRate, channels);
    if (!silenceCheck.empty()) {
        out.error = silenceCheck;
        return out;
    }
    if (left == nullptr || frames <= 0) {
        out.error = "No audio was given for breath detection.";
        return out;
    }
    if (channels == 2 && right == nullptr) {
        out.error = "Stereo breath detection needs both channels.";
        return out;
    }

    auto silenceResult = detectSilence(left, right, frames, channels, sampleRate, silence);
    if (!silenceResult.error.empty()) {
        out.error = silenceResult.error;
        return out;
    }
    out.repairedSamples = silenceResult.repairedSamples;

    int fftSize = 512;
    if (sampleRate > 60000.0)
        fftSize = 1024;
    const int hop = fftSize / 4;
    if (frames < fftSize + hop)
        return out;

    Fft fft;
    out.error = fft.prepare(fftSize);
    if (!out.error.empty())
        return out;

    const int bins = fftSize / 2 + 1;
    const double binHz = sampleRate / static_cast<double>(fftSize);
    std::vector<double> window(static_cast<size_t>(fftSize));
    for (int i = 0; i < fftSize; ++i)
        window[static_cast<size_t>(i)] = 0.5 - 0.5 * std::cos(2.0 * 3.14159265358979323846 * i / fftSize);

    std::vector<float> score(static_cast<size_t>((frames - fftSize) / hop + 1), 0.0f);
    std::vector<std::complex<double>> spectrum(static_cast<size_t>(fftSize));
    std::vector<char> nearSilence(score.size(), 0);

    const int64_t pad = std::max<int64_t>(1, static_cast<int64_t>(std::llround(sampleRate * settings.silencePadMs / 1000.0)));
    for (size_t fi = 0; fi < score.size(); ++fi) {
        const int64_t centre = static_cast<int64_t>(fi) * hop + fftSize / 2;
        for (const auto& region : silenceResult.regions) {
            if (std::llabs(centre - region.first) <= pad || std::llabs(centre - region.second) <= pad
                || (centre >= region.first - pad && centre <= region.second + pad
                    && !(centre >= region.first && centre < region.second))) {
                nearSilence[fi] = 1;
                break;
            }
        }
    }

    for (size_t fi = 0; fi < score.size(); ++fi) {
        const int64_t start = static_cast<int64_t>(fi) * hop;
        double energy = 0.0;
        double hf = 0.0;
        double geo = 0.0;
        double arith = 0.0;
        int used = 0;
        for (int i = 0; i < fftSize; ++i) {
            const float v = monoAt(left, right, channels, start + i, &out.repairedSamples);
            spectrum[static_cast<size_t>(i)] = { v * window[static_cast<size_t>(i)], 0.0 };
        }
        fft.transform(spectrum, false);
        for (int k = 1; k < bins; ++k) {
            const double mag = std::abs(spectrum[static_cast<size_t>(k)]);
            const double p = mag * mag;
            energy += p;
            const double hz = k * binHz;
            if (hz >= 1500.0)
                hf += p;
            if (p > 1.0e-18) {
                geo += std::log(p);
                arith += p;
                ++used;
            }
        }
        const double rmsDb = dbFromRms(std::sqrt(energy / std::max(1, fftSize / 2)));
        // Reject digital silence and loud voiced energy.
        if (rmsDb < silenceResult.thresholdDb || rmsDb > -12.0) {
            score[fi] = 0.0f;
            continue;
        }
        const double hfRatio = energy > 0.0 ? hf / energy : 0.0;
        double flatness = 0.0;
        if (used > 0 && arith > 0.0)
            flatness = std::exp(geo / used) / (arith / used);
        flatness = std::clamp(flatness, 0.0, 1.0);
        // Low harmonicity proxy: high flatness + strong HF share.
        double s = 0.35 * flatness + 0.35 * std::clamp(hfRatio * 1.5, 0.0, 1.0);
        // Mid-level envelope (quieter than speech peaks).
        const double mid = 1.0 - std::clamp((rmsDb + 12.0) / 28.0, 0.0, 1.0);
        s = 0.55 * s + 0.25 * mid + (nearSilence[fi] ? 0.20 : 0.0);
        score[fi] = static_cast<float>(std::clamp(s, 0.0, 1.0));
    }

    const int64_t minSamples = std::max<int64_t>(1, static_cast<int64_t>(std::llround(sampleRate * settings.minDurationMs / 1000.0)));
    const int64_t maxSamples = std::max(minSamples, static_cast<int64_t>(std::llround(sampleRate * settings.maxDurationMs / 1000.0)));
    const float gate = static_cast<float>(settings.minConfidence);

    bool active = false;
    size_t startFi = 0;
    float peak = 0.0f;
    auto flush = [&](size_t endFi) {
        if (!active)
            return;
        const int64_t a = static_cast<int64_t>(startFi) * hop;
        const int64_t b = std::min(frames, static_cast<int64_t>(endFi) * hop + fftSize / 2);
        const int64_t len = b - a;
        if (len >= minSamples && len <= maxSamples && peak >= gate) {
            // Skip if mostly covered by silence.
            int64_t silenceOverlap = 0;
            for (const auto& region : silenceResult.regions)
                silenceOverlap += std::max<int64_t>(0, std::min(b, region.second) - std::max(a, region.first));
            if (silenceOverlap * 2 < len) {
                BreathDetectResult::Candidate c;
                c.start = a;
                c.end = b;
                c.confidence = peak;
                out.candidates.push_back(c);
            }
        }
        active = false;
        peak = 0.0f;
    };

    for (size_t fi = 0; fi < score.size(); ++fi) {
        if (score[fi] >= gate) {
            if (!active) {
                active = true;
                startFi = fi;
                peak = score[fi];
            } else {
                peak = std::max(peak, score[fi]);
            }
        } else {
            flush(fi);
        }
    }
    flush(score.size());
    return out;
}

std::string applyBreathGains(float* left, float* right, int64_t frames, int channels,
                             double sampleRate, int64_t sourceOffset,
                             const std::vector<BreathRegion>& regions) {
    if (left == nullptr || frames <= 0)
        return "No audio was given for breath gain.";
    if (channels != 1 && channels != 2)
        return "Breath gain supports mono and stereo audio.";
    if (channels == 2 && right == nullptr)
        return "Stereo breath gain needs both channels.";
    if (!std::isfinite(sampleRate) || sampleRate <= 0.0)
        return "Breath gain needs a valid sample rate.";

    const int64_t minFade = std::max<int64_t>(1, static_cast<int64_t>(std::llround(sampleRate * 0.003)));
    for (const auto& region : regions) {
        if (region.ignored)
            continue;
        const auto gainError = validateBreathGainDb(region.gainDb);
        if (!gainError.empty())
            return gainError;
        if (std::fabs(region.gainDb) < 1.0e-4f)
            continue;
        const int64_t localStart = region.sourceStart - sourceOffset;
        const int64_t localEnd = region.sourceEnd - sourceOffset;
        if (localEnd <= 0 || localStart >= frames)
            continue;
        const int64_t a = std::clamp(localStart, int64_t { 0 }, frames);
        const int64_t b = std::clamp(localEnd, a, frames);
        if (b <= a)
            continue;
        const int64_t length = b - a;
        int64_t fadeIn = std::max(region.fadeIn, minFade);
        int64_t fadeOut = std::max(region.fadeOut, minFade);
        if (fadeIn + fadeOut > length) {
            fadeIn = length / 2;
            fadeOut = length - fadeIn;
        }
        const double linear = std::pow(10.0, static_cast<double>(region.gainDb) / 20.0);
        for (int64_t i = a; i < b; ++i) {
            double env = linear;
            const int64_t into = i - a;
            const int64_t fromEnd = b - 1 - i;
            if (fadeIn > 0 && into < fadeIn) {
                const double t = static_cast<double>(into) / static_cast<double>(fadeIn);
                const double w = 1.0 - raisedCosine(t); // 0→1
                env = 1.0 + (linear - 1.0) * w;
            } else if (fadeOut > 0 && fromEnd < fadeOut) {
                const double t = static_cast<double>(fromEnd) / static_cast<double>(fadeOut);
                const double w = 1.0 - raisedCosine(t); // 1 at edge inside → 0 at boundary
                env = 1.0 + (linear - 1.0) * w;
            }
            if (!std::isfinite(env))
                env = 1.0;
            left[i] = static_cast<float>(left[i] * env);
            if (channels >= 2 && right != nullptr)
                right[i] = static_cast<float>(right[i] * env);
        }
    }
    return {};
}

} // namespace msp
