#include "msp/Pitch.h"

#include <algorithm>
#include <cmath>
#include <cstdio>

namespace msp {
namespace {
std::string number(double value, int decimals) {
    char text[64];
    std::snprintf(text, sizeof(text), "%.*f", decimals, value);
    return text;
}

// Lag range searched for the period, and the shortest window that holds two of the longest periods.
int lagMin(double rate, double maxHz) { return std::max(2, static_cast<int>(std::floor(rate / maxHz))); }
int lagMax(double rate, double minHz) { return static_cast<int>(std::ceil(rate / minHz)); }
int shortestWindow(double rate, double minHz) { return 2 * (lagMax(rate, minHz) + 1); }
} // namespace

std::string checkPitchParams(const PitchParams& p, double rate) {
    if (!std::isfinite(rate) || rate < kPitchMinSampleRate || rate > kPitchMaxSampleRate)
        return "Pitch analysis supports sample rates from 8 kHz to 192 kHz. This audio is at " + number(rate, 0) + " Hz.";
    if (!std::isfinite(p.minHz) || !std::isfinite(p.maxHz) || p.minHz < kPitchLowestHz || p.maxHz > kPitchHighestHz)
        return "The pitch range must lie between 30 Hz and 4000 Hz.";
    if (p.minHz >= p.maxHz)
        return "The minimum frequency must be lower than the maximum frequency.";
    if (p.maxHz > rate / 4.0)
        return "The maximum frequency can be at most a quarter of the sample rate (" + number(rate / 4.0, 0) + " Hz here).";
    if (p.windowSize < kPitchMinWindow || p.windowSize > kPitchMaxWindow)
        return "The analysis window must be between 256 and 16384 samples.";
    const int needed = shortestWindow(rate, p.minHz);
    if (p.windowSize < needed)
        return "An analysis window of " + std::to_string(p.windowSize) + " samples is too short to detect " + number(p.minHz, 1)
            + " Hz at " + number(rate, 0) + " Hz. Use at least " + std::to_string(needed) + " samples or raise the minimum frequency.";
    if (p.hopSize < kPitchMinHop || p.hopSize > p.windowSize)
        return "The hop size must be between 16 samples and the window size.";
    if (!std::isfinite(p.confidenceThreshold) || p.confidenceThreshold < 0.1 || p.confidenceThreshold > 0.99)
        return "The confidence threshold must be between 0.1 and 0.99.";
    if (!std::isfinite(p.silenceDb) || p.silenceDb < -120.0 || p.silenceDb > -20.0)
        return "The silence threshold must be between -120 and -20 dBFS.";
    return {};
}

double midiFromFrequency(double hz) {
    if (!(hz > 0.0))
        return 0.0;
    return 69.0 + 12.0 * std::log2(hz / 440.0);
}

std::string noteName(int midi) {
    static const char* const names[12] = { "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B" };
    if (midi < 0 || midi > 127)
        return {};
    return std::string(names[midi % 12]) + std::to_string(midi / 12 - 1);
}

std::string PitchDetector::prepare(double sampleRate, const PitchParams& values) {
    const auto error = checkPitchParams(values, sampleRate);
    if (!error.empty())
        return error;
    params = values;
    rate = sampleRate;
    tauMin = lagMin(rate, params.maxHz);
    tauMax = lagMax(rate, params.minHz);
    integration = params.windowSize - tauMax - 1;
    fftSize = 1;
    while (fftSize < params.windowSize)
        fftSize <<= 1;
    spectrumA.assign(static_cast<size_t>(fftSize), {});
    spectrumX.assign(static_cast<size_t>(fftSize), {});
    const auto fftError = fft.prepare(fftSize);
    if (!fftError.empty())
        return fftError;
    energy.assign(static_cast<size_t>(params.windowSize) + 1, 0.0);
    diff.assign(static_cast<size_t>(tauMax) + 2, 0.0);
    cmnd.assign(static_cast<size_t>(tauMax) + 2, 1.0);
    return {};
}

PitchFrame PitchDetector::analyze(const float* x, double time) {
    PitchFrame frame;
    frame.time = time;
    const int n = params.windowSize;
    for (int i = 0; i < n; ++i) {
        const double value = static_cast<double>(x[i]);
        if (!std::isfinite(value))
            return frame;   // damaged samples: unvoiced, no level
        energy[static_cast<size_t>(i) + 1] = energy[static_cast<size_t>(i)] + value * value;
    }
    const double rms = std::sqrt(energy[static_cast<size_t>(n)] / n);
    frame.levelDb = rms > 0.0 ? 20.0 * std::log10(rms) : -200.0;
    if (frame.levelDb < params.silenceDb)
        return frame;

    // Difference function d(tau) = sum_{j<W} (x_j - x_{j+tau})^2, from FFT cross-correlation.
    const int w = integration;
    for (int i = 0; i < fftSize; ++i) {
        spectrumA[static_cast<size_t>(i)] = i < w ? std::complex<double>(x[i], 0.0) : std::complex<double>();
        spectrumX[static_cast<size_t>(i)] = i < n ? std::complex<double>(x[i], 0.0) : std::complex<double>();
    }
    fft.transform(spectrumA, false);
    fft.transform(spectrumX, false);
    for (int i = 0; i < fftSize; ++i)
        spectrumA[static_cast<size_t>(i)] = std::conj(spectrumA[static_cast<size_t>(i)]) * spectrumX[static_cast<size_t>(i)];
    fft.transform(spectrumA, true);
    const double e0 = energy[static_cast<size_t>(w)];
    for (int tau = 0; tau <= tauMax + 1; ++tau) {
        const double shifted = energy[static_cast<size_t>(tau + w)] - energy[static_cast<size_t>(tau)];
        diff[static_cast<size_t>(tau)] = std::max(0.0, e0 + shifted - 2.0 * spectrumA[static_cast<size_t>(tau)].real());
    }

    // Cumulative mean normalized difference.
    cmnd[0] = 1.0;
    double sum = 0.0;
    for (int tau = 1; tau <= tauMax + 1; ++tau) {
        sum += diff[static_cast<size_t>(tau)];
        cmnd[static_cast<size_t>(tau)] = sum > 0.0 ? diff[static_cast<size_t>(tau)] * tau / sum : 1.0;
    }

    // First dip below the threshold, followed down to its minimum; otherwise the global minimum.
    const double threshold = 1.0 - params.confidenceThreshold;
    int best = -1;
    for (int tau = tauMin; tau <= tauMax; ++tau) {
        if (cmnd[static_cast<size_t>(tau)] < threshold) {
            while (tau + 1 <= tauMax && cmnd[static_cast<size_t>(tau) + 1] < cmnd[static_cast<size_t>(tau)])
                ++tau;
            best = tau;
            break;
        }
    }
    if (best < 0) {
        best = tauMin;
        for (int tau = tauMin + 1; tau <= tauMax; ++tau) {
            if (cmnd[static_cast<size_t>(tau)] < cmnd[static_cast<size_t>(best)])
                best = tau;
        }
    }
    frame.confidence = std::clamp(1.0 - cmnd[static_cast<size_t>(best)], 0.0, 1.0);

    // A period at the edge of the range that keeps falling outside it, or a periodic half period
    // below tauMin, means the pitch is outside minHz..maxHz: unvoiced rather than an octave error.
    bool outside = (best == tauMax && cmnd[static_cast<size_t>(tauMax) + 1] < cmnd[static_cast<size_t>(tauMax)])
        || (best == tauMin && cmnd[static_cast<size_t>(tauMin) - 1] < cmnd[static_cast<size_t>(tauMin)]);
    const int halfPeriod = static_cast<int>(std::lround(best / 2.0));
    if (halfPeriod >= 2 && halfPeriod < tauMin) {
        for (int tau = std::max(1, halfPeriod - 1); tau <= halfPeriod + 1; ++tau)
            outside = outside || cmnd[static_cast<size_t>(tau)] < threshold;
    }
    if (outside || frame.confidence < params.confidenceThreshold)
        return frame;

    // Parabolic interpolation of the raw difference around the chosen lag.
    double period = best;
    const double a = diff[static_cast<size_t>(best) - 1];
    const double b = diff[static_cast<size_t>(best)];
    const double c = diff[static_cast<size_t>(best) + 1];
    const double curve = a - 2.0 * b + c;
    if (curve > 0.0)
        period += std::clamp(0.5 * (a - c) / curve, -1.0, 1.0);
    frame.frequency = rate / period;
    const double midi = midiFromFrequency(frame.frequency);
    frame.midi = static_cast<int>(std::lround(midi));
    frame.cents = (midi - frame.midi) * 100.0;
    frame.voiced = true;
    return frame;
}

int64_t pitchFrameCount(int64_t count, const PitchParams& params) {
    if (params.windowSize <= 0 || params.hopSize <= 0 || count < params.windowSize)
        return 0;
    return (count - params.windowSize) / params.hopSize + 1;
}

PitchAnalysis analyzePitch(const float* samples, int64_t count, double sampleRate, const PitchParams& params,
                           const std::atomic<bool>* cancel, const std::function<void(int64_t, int64_t)>& progress) {
    PitchAnalysis out;
    out.sampleRate = sampleRate;
    out.params = params;
    out.error = checkPitchParams(params, sampleRate);
    if (!out.error.empty())
        return out;
    if (samples == nullptr && count > 0) {
        out.error = "No audio was given to analyse.";
        return out;
    }
    const int64_t total = pitchFrameCount(count, params);
    if (total == 0) {
        out.error = "The audio is " + number(1000.0 * static_cast<double>(std::max<int64_t>(0, count)) / sampleRate, 1)
            + " ms long, shorter than one analysis window (" + number(1000.0 * params.windowSize / sampleRate, 1) + " ms).";
        return out;
    }
    PitchDetector detector;
    out.error = detector.prepare(sampleRate, params);
    if (!out.error.empty())
        return out;
    out.frames.reserve(static_cast<size_t>(total));
    for (int64_t k = 0; k < total; ++k) {
        if (cancel != nullptr && cancel->load(std::memory_order_relaxed)) {
            out.cancelled = true;
            break;
        }
        const int64_t start = k * params.hopSize;
        out.frames.push_back(detector.analyze(samples + start, (static_cast<double>(start) + params.windowSize / 2.0) / sampleRate));
        if (progress)
            progress(k + 1, total);
    }
    out.notes = pitchNotes(out.frames, params.hopSize / sampleRate);
    return out;
}

std::vector<PitchNote> pitchNotes(const std::vector<PitchFrame>& frames, double hopSeconds) {
    std::vector<PitchNote> notes;
    size_t i = 0;
    while (i < frames.size()) {
        if (!frames[i].voiced) {
            ++i;
            continue;
        }
        size_t j = i;
        PitchNote note;
        note.midi = frames[i].midi;
        while (j < frames.size() && frames[j].voiced && frames[j].midi == note.midi) {
            note.frequency += frames[j].frequency;
            note.cents += frames[j].cents;
            note.confidence += frames[j].confidence;
            ++j;
        }
        note.frames = static_cast<int>(j - i);
        note.frequency /= note.frames;
        note.cents /= note.frames;
        note.confidence /= note.frames;
        note.start = std::max(0.0, frames[i].time - hopSeconds / 2.0);
        note.end = frames[j - 1].time + hopSeconds / 2.0;
        note.name = noteName(note.midi);
        notes.push_back(std::move(note));
        i = j;
    }
    return notes;
}

} // namespace msp
