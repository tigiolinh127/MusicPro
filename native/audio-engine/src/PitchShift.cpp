#include "msp/PitchShift.h"
#include "msp/TimeStretch.h"
#include "msp/Timing.h"

#include "msp/Fft.h"

#include <algorithm>
#include <cmath>
#include <complex>
#include <cstdio>

namespace msp {
namespace {
constexpr double kPi = 3.14159265358979323846;
constexpr double kTwoPi = 2.0 * kPi;
constexpr float kPeakLimit = 0.999f;   // about -0.01 dBFS

std::string number(double value, int decimals) {
    char text[64];
    std::snprintf(text, sizeof(text), "%.*f", decimals, value);
    return text;
}

double princarg(double phase) {
    return phase - kTwoPi * std::floor((phase + kPi) / kTwoPi);
}

// Phase-vocoder time stretch by `factor`, produced one synthesis frame at a time. Stretched time t
// corresponds to input time t / factor. Samples are kept only from the last discard point on.
// Reads the caller's channels directly (non-finite samples count as silence). With a shaper, each
// frame's spectral envelope is compensated before resynthesis (see VocalQuality.h).
class Stretcher {
public:
    std::string prepare(const float* const* source, int sourceChannels, int64_t sourceFrames, double factor, int fftSize,
                        int overlap, EnvelopeShaper* envelopeShaper, double envelopeScale) {
        input = source;
        frames = sourceFrames;
        channels = sourceChannels;
        n = fftSize;
        bins = n / 2 + 1;
        hs = n / overlap;
        ha = hs / factor;
        ratio = factor;
        shaper = envelopeShaper;
        scale = envelopeScale;
        const auto error = fft.prepare(n);
        if (!error.empty())
            return error;
        window.resize(static_cast<size_t>(n));
        for (int j = 0; j < n; ++j)
            window[static_cast<size_t>(j)] = 0.5 - 0.5 * std::cos(kTwoPi * j / n);
        // Periodic Hann analysis and synthesis windows at hop hs overlap-add to 3n / (8 hs)
        // (1.5 at n/4, 3 at n/8).
        outputScale = 8.0 * hs / (3.0 * n);
        gain.assign(static_cast<size_t>(bins), 1.0);
        spectra.assign(static_cast<size_t>(channels), std::vector<std::complex<double>>(static_cast<size_t>(n)));
        phase.assign(static_cast<size_t>(channels), std::vector<double>(static_cast<size_t>(bins), 0.0));
        lastPhase = phase;
        lastSynth = phase;
        magnitude.assign(static_cast<size_t>(bins), 0.0);
        rotation.assign(static_cast<size_t>(bins), 0.0);
        peaks.reserve(static_cast<size_t>(bins));
        // Start early enough that every stretched sample from a little before 0 has full overlap.
        const int64_t lead = static_cast<int64_t>(std::ceil((n / 2.0) / ha)) + n / (2 * hs) + 2;
        m = -lead;
        origin = lead * hs + n / 2;
        base = 0;
        acc.assign(static_cast<size_t>(channels), {});
        first = true;
        lastEnergy = 0.0;
        return {};
    }

    void nextFrame() {
        const int64_t start = std::llround(static_cast<double>(m) * ha) - n / 2;
        for (int c = 0; c < channels; ++c) {
            const float* x = input[c];
            auto& spectrum = spectra[static_cast<size_t>(c)];
            for (int j = 0; j < n; ++j) {
                const int64_t index = start + j;
                const float raw = index >= 0 && index < frames ? x[index] : 0.0f;
                const double value = std::isfinite(raw) ? raw : 0.0;
                spectrum[static_cast<size_t>(j)] = { value * window[static_cast<size_t>(j)], 0.0 };
            }
            fft.transform(spectrum, false);
        }

        double energy = 0.0;
        double loudest = 0.0;
        for (int k = 0; k < bins; ++k) {
            double sum = 0.0;
            for (int c = 0; c < channels; ++c) {
                const auto value = spectra[static_cast<size_t>(c)][static_cast<size_t>(k)];
                sum += std::abs(value);
                phase[static_cast<size_t>(c)][static_cast<size_t>(k)] = std::arg(value);
            }
            magnitude[static_cast<size_t>(k)] = sum;
            energy += sum * sum;
            loudest = std::max(loudest, sum);
        }
        // An energy jump of more than 6 dB is treated as an onset: the analysis phases are used
        // unchanged so the attack is not smeared.
        const double floorEnergy = 1e-8 * n * n;
        const bool reset = first || (energy > 4.0 * lastEnergy && energy > floorEnergy);
        const int hop = static_cast<int>(start - lastStart);

        peaks.clear();
        const double peakFloor = loudest * 1e-6;
        for (int k = 1; k + 1 < bins; ++k) {
            const double v = magnitude[static_cast<size_t>(k)];
            if (v > peakFloor && v > magnitude[static_cast<size_t>(k) - 1] && v >= magnitude[static_cast<size_t>(k) + 1]
                && (k < 2 || v > magnitude[static_cast<size_t>(k) - 2])
                && (k + 2 >= bins || v >= magnitude[static_cast<size_t>(k) + 2]))
                peaks.push_back(k);
        }

        std::fill(rotation.begin(), rotation.end(), 0.0);
        if (!reset && hop > 0 && !peaks.empty()) {
            int regionStart = 0;
            for (size_t i = 0; i < peaks.size(); ++i) {
                const int p = peaks[i];
                int regionEnd = bins;
                if (i + 1 < peaks.size()) {
                    regionEnd = p + 1;
                    for (int k = p + 1; k < peaks[i + 1]; ++k) {
                        if (magnitude[static_cast<size_t>(k)] < magnitude[static_cast<size_t>(regionEnd)])
                            regionEnd = k;
                    }
                    regionEnd = std::max(regionEnd, p + 1);
                }
                // The louder channel at the peak supplies the frequency estimate; every channel gets
                // the same rotation, so inter-channel phase differences are kept.
                int ref = 0;
                for (int c = 1; c < channels; ++c) {
                    if (std::abs(spectra[static_cast<size_t>(c)][static_cast<size_t>(p)])
                        > std::abs(spectra[static_cast<size_t>(ref)][static_cast<size_t>(p)]))
                        ref = c;
                }
                const double omega = kTwoPi * p / n;
                const double current = phase[static_cast<size_t>(ref)][static_cast<size_t>(p)];
                const double deviation = princarg(current - lastPhase[static_cast<size_t>(ref)][static_cast<size_t>(p)] - omega * hop);
                const double trueOmega = omega + deviation / hop;
                const double synth = lastSynth[static_cast<size_t>(ref)][static_cast<size_t>(p)] + trueOmega * hs;
                const double delta = princarg(synth - current);
                for (int k = regionStart; k < regionEnd; ++k)
                    rotation[static_cast<size_t>(k)] = delta;
                regionStart = regionEnd;
            }
        }

        const bool shaped = shaper != nullptr && shaper->compute(magnitude, ratio, scale, gain);
        if (shaped)
            ++envelopeFrames;
        const int64_t synthStart = m * hs - n / 2 + origin - base;
        ensure(synthStart + n);
        for (int c = 0; c < channels; ++c) {
            auto& spectrum = spectra[static_cast<size_t>(c)];
            for (int k = 0; k < bins; ++k) {
                const double delta = rotation[static_cast<size_t>(k)];
                if (delta != 0.0)
                    spectrum[static_cast<size_t>(k)] *= std::polar(1.0, delta);
                lastSynth[static_cast<size_t>(c)][static_cast<size_t>(k)] = princarg(phase[static_cast<size_t>(c)][static_cast<size_t>(k)] + delta);
                if (shaped)
                    spectrum[static_cast<size_t>(k)] *= gain[static_cast<size_t>(k)];
            }
            spectrum[0] = { spectrum[0].real(), 0.0 };
            spectrum[static_cast<size_t>(n / 2)] = { spectrum[static_cast<size_t>(n / 2)].real(), 0.0 };
            for (int k = 1; k < n / 2; ++k)
                spectrum[static_cast<size_t>(n - k)] = std::conj(spectrum[static_cast<size_t>(k)]);
            fft.transform(spectrum, true);
            auto& out = acc[static_cast<size_t>(c)];
            for (int j = 0; j < n; ++j)
                out[static_cast<size_t>(synthStart + j)] += static_cast<float>(spectrum[static_cast<size_t>(j)].real() * window[static_cast<size_t>(j)] * outputScale);
        }
        lastPhase = phase;
        lastEnergy = energy;
        lastStart = start;
        first = false;
        ++m;
    }

    // Stretched samples before this time are final.
    int64_t ready() const { return m * hs - n / 2; }
    float at(int c, int64_t t) const {
        const int64_t index = t + origin - base;
        const auto& out = acc[static_cast<size_t>(c)];
        if (index < 0 || index >= static_cast<int64_t>(out.size()))
            return 0.0f;
        return out[static_cast<size_t>(index)];
    }
    // Frees samples before stretched time t once enough have accumulated.
    void discardBefore(int64_t t) {
        const int64_t drop = t + origin - base;
        if (drop < 65536)
            return;
        for (auto& out : acc)
            out.erase(out.begin(), out.begin() + static_cast<std::ptrdiff_t>(std::min<int64_t>(drop, static_cast<int64_t>(out.size()))));
        base += drop;
    }

    int64_t shapedFrames() const { return envelopeFrames; }
    int64_t bytes() const {
        const auto spectrumBytes = static_cast<int64_t>(channels) * n * static_cast<int64_t>(sizeof(std::complex<double>));
        const auto phaseBytes = 3 * static_cast<int64_t>(channels) * bins * static_cast<int64_t>(sizeof(double));
        return peakSamples * channels * static_cast<int64_t>(sizeof(float)) + spectrumBytes + phaseBytes
            + static_cast<int64_t>(n + 4 * bins) * static_cast<int64_t>(sizeof(double));
    }

private:
    void ensure(int64_t size) {
        for (auto& out : acc) {
            if (static_cast<int64_t>(out.size()) < size)
                out.resize(static_cast<size_t>(size), 0.0f);
            peakSamples = std::max<int64_t>(peakSamples, static_cast<int64_t>(out.capacity()));
        }
    }

    const float* const* input = nullptr;
    int64_t frames = 0;
    int channels = 0;
    int n = 0;
    int bins = 0;
    int hs = 0;
    double ha = 0.0;
    double ratio = 1.0;
    double scale = 1.0;
    EnvelopeShaper* shaper = nullptr;
    std::vector<double> gain;
    int64_t envelopeFrames = 0;
    int64_t peakSamples = 0;
    double outputScale = 1.0;
    Fft fft;
    std::vector<double> window;
    std::vector<std::vector<std::complex<double>>> spectra;
    std::vector<std::vector<double>> phase;
    std::vector<std::vector<double>> lastPhase;
    std::vector<std::vector<double>> lastSynth;
    std::vector<double> magnitude;
    std::vector<double> rotation;
    std::vector<int> peaks;
    int64_t m = 0;
    int64_t origin = 0;
    int64_t base = 0;
    int64_t lastStart = 0;
    double lastEnergy = 0.0;
    bool first = true;
    std::vector<std::vector<float>> acc;
};

double besselI0(double x) {
    double sum = 1.0;
    double term = 1.0;
    for (int k = 1; k < 64; ++k) {
        term *= (x / (2.0 * k)) * (x / (2.0 * k));
        sum += term;
        if (term < sum * 1e-17)
            break;
    }
    return sum;
}

// Kaiser-windowed sinc interpolator with cutoff `cutoff` (fraction of the input Nyquist).
class SincResampler {
public:
    void prepare(double cutoff) {
        fc = cutoff;
        halfWidth = kZeroCrossings / fc;
        taps = static_cast<int>(std::ceil(halfWidth));
        const int size = static_cast<int>(std::ceil(halfWidth * kSteps)) + 2;
        table.resize(static_cast<size_t>(size));
        const double norm = besselI0(kBeta);
        for (int i = 0; i < size; ++i) {
            const double x = static_cast<double>(i) / kSteps;
            if (x >= halfWidth) {
                table[static_cast<size_t>(i)] = 0.0;
                continue;
            }
            const double u = fc * x;
            const double sinc = u == 0.0 ? 1.0 : std::sin(kPi * u) / (kPi * u);
            const double r = x / halfWidth;
            table[static_cast<size_t>(i)] = fc * sinc * besselI0(kBeta * std::sqrt(1.0 - r * r)) / norm;
        }
        weights.resize(static_cast<size_t>(2 * taps));
    }

    int tapCount() const { return taps; }

    // Fills the weights for reading at fractional position t; returns the first sample index.
    int64_t weigh(double t) {
        const int64_t i0 = static_cast<int64_t>(std::floor(t));
        const int64_t first = i0 - taps + 1;
        double sum = 0.0;
        for (int k = 0; k < 2 * taps; ++k) {
            const double x = std::abs(t - static_cast<double>(first + k)) * kSteps;
            const auto index = static_cast<size_t>(x);
            double w = 0.0;
            if (index + 1 < table.size()) {
                const double frac = x - static_cast<double>(index);
                w = table[index] + (table[index + 1] - table[index]) * frac;
            }
            weights[static_cast<size_t>(k)] = w;
            sum += w;
        }
        // Unity gain at DC for every fractional position.
        if (sum > 0.0) {
            for (auto& w : weights)
                w /= sum;
        }
        return first;
    }

    const std::vector<double>& current() const { return weights; }

private:
    static constexpr double kZeroCrossings = 24.0;
    static constexpr double kBeta = 9.0;
    static constexpr int kSteps = 512;
    double fc = 1.0;
    double halfWidth = 0.0;
    int taps = 0;
    std::vector<double> table;
    std::vector<double> weights;
};
} // namespace

int pitchShiftFrameSize(double sampleRate) {
    int size = 2048;
    double limit = 50000.0;
    while (sampleRate > limit && size < 16384) {
        size *= 2;
        limit *= 2.0;
    }
    return size;
}

std::string checkPitchShift(const PitchShiftSettings& settings, double sampleRate, int channels) {
    if (settings.semitones < -kPitchShiftMaxSemitones || settings.semitones > kPitchShiftMaxSemitones)
        return "The pitch shift must be between -12 and +12 semitones.";
    if (!std::isfinite(settings.cents) || settings.cents < -kPitchShiftMaxCents || settings.cents > kPitchShiftMaxCents)
        return "The fine tuning must be between -100 and +100 cents.";
    if (!std::isfinite(sampleRate) || sampleRate < 8000.0 || sampleRate > 192000.0)
        return "Pitch shifting supports sample rates from 8 kHz to 192 kHz. This audio is at " + number(sampleRate, 0) + " Hz.";
    if (channels != 1 && channels != 2)
        return "Pitch shifting supports mono and stereo audio.";
    return {};
}

double pitchShiftRatio(const PitchShiftSettings& settings) {
    return std::pow(2.0, (settings.semitones + settings.cents / 100.0) / 12.0);
}

bool isIdentityShift(const PitchShiftSettings& settings) {
    return settings.semitones * 100.0 + settings.cents == 0.0 && settings.quality.formantShiftSemitones == 0.0;
}

PitchShiftResult pitchShift(const float* left, const float* right, int64_t frames, int channels,
                            double sampleRate, const PitchShiftSettings& settings,
                            int64_t lead, int64_t tail,
                            const std::atomic<bool>* cancel,
                            const std::function<void(double)>& progress) {
    PitchShiftResult out;
    out.error = checkPitchShift(settings, sampleRate, channels);
    if (out.error.empty())
        out.error = checkVocalQuality(settings.quality);
    if (!out.error.empty())
        return out;
    if (left == nullptr || (channels == 2 && right == nullptr) || frames <= 0) {
        out.error = "No audio was given to pitch shift.";
        return out;
    }
    if (lead < 0 || tail < 0 || lead + tail >= frames) {
        out.error = "The region to pitch shift is empty.";
        return out;
    }
    out.ratio = pitchShiftRatio(settings);
    const int64_t count = frames - lead - tail;

    // The caller's samples are read in place; non-finite ones are treated as silence.
    const float* sources[2] = { left, right };
    for (int c = 0; c < channels; ++c) {
        for (int64_t i = lead; i < frames - tail; ++i) {
            const float value = sources[c][i];
            if (!std::isfinite(value))
                ++out.repairedSamples;
            else
                out.inputPeak = std::max(out.inputPeak, static_cast<double>(std::abs(value)));
        }
    }
    auto clean = [](float value) { return std::isfinite(value) ? value : 0.0f; };

    std::vector<std::vector<float>> result(static_cast<size_t>(channels), std::vector<float>(static_cast<size_t>(count), 0.0f));
    if (isIdentityShift(settings)) {
        out.identity = true;
        for (int c = 0; c < channels; ++c)
            std::transform(sources[c] + lead, sources[c] + lead + count, result[static_cast<size_t>(c)].begin(), clean);
        out.outputPeak = out.inputPeak;
    } else {
        const int fftSize = pitchShiftFrameSize(sampleRate);
        const double scale = envelopeScale(settings.quality, out.ratio);
        EnvelopeShaper shaper;
        const bool shaping = changesEnvelope(settings.quality, out.ratio);
        if (shaping) {
            out.error = shaper.prepare(fftSize, sampleRate, settings.quality.high);
            if (!out.error.empty())
                return out;
        }
        Stretcher stretcher;
        out.error = stretcher.prepare(sources, channels, frames, out.ratio, fftSize, vocoderOverlap(settings.quality),
                                      shaping ? &shaper : nullptr, scale);
        if (!out.error.empty())
            return out;
        // Vocoder pre-echo reaches half a frame ahead of an attack in stretched time, which is
        // fftSize / 2 / ratio output samples.
        TransientGuard guard;
        if (settings.quality.protectTransients)
            guard.prepare(left, channels == 2 ? right : nullptr, frames, sampleRate,
                          static_cast<int64_t>(std::ceil(fftSize / 2.0 / std::min(1.0, out.ratio))));
        out.transients = static_cast<int>(std::count_if(guard.onsets().begin(), guard.onsets().end(),
            [&](int64_t at) { return at >= lead && at < frames - tail; }));
        SincResampler resampler;
        resampler.prepare(0.97 * std::min(1.0, 1.0 / out.ratio));
        for (int64_t i = 0; i < count; ++i) {
            if ((i & 4095) == 0) {
                if (cancel != nullptr && cancel->load(std::memory_order_relaxed)) {
                    out.cancelled = true;
                    return out;
                }
                if (progress)
                    progress(static_cast<double>(i) / static_cast<double>(count));
            }
            const double t = static_cast<double>(lead + i) * out.ratio;
            const int64_t first = resampler.weigh(t);
            const int64_t needed = first + 2 * resampler.tapCount();
            while (stretcher.ready() < needed) {
                if (cancel != nullptr && cancel->load(std::memory_order_relaxed)) {
                    out.cancelled = true;
                    return out;
                }
                stretcher.nextFrame();
            }
            const auto& weights = resampler.current();
            const float keep = guard.onsets().empty() ? 0.0f : guard.weight(lead + i);
            for (int c = 0; c < channels; ++c) {
                double sum = 0.0;
                for (size_t k = 0; k < weights.size(); ++k)
                    sum += weights[k] * stretcher.at(c, first + static_cast<int64_t>(k));
                float value = static_cast<float>(sum);
                if (keep > 0.0f)
                    value = (1.0f - keep) * value + keep * clean(sources[c][lead + i]);
                result[static_cast<size_t>(c)][static_cast<size_t>(i)] = std::isfinite(value) ? value : 0.0f;
            }
            stretcher.discardBefore(first);
        }
        out.envelopeFrames = stretcher.shapedFrames();
        out.workingBytes = stretcher.bytes() + (shaping ? shaper.bytes() : 0)
            + static_cast<int64_t>(guard.onsets().capacity() * sizeof(int64_t));
        for (const auto& channel : result)
            for (const float value : channel)
                out.outputPeak = std::max(out.outputPeak, static_cast<double>(std::abs(value)));
        if (out.outputPeak > kPeakLimit) {
            const double gain = kPeakLimit / out.outputPeak;
            for (auto& channel : result)
                for (auto& value : channel)
                    value = std::clamp(static_cast<float>(value * gain), -kPeakLimit, kPeakLimit);
            out.gainReductionDb = -20.0 * std::log10(gain);
            out.outputPeak = kPeakLimit;
        }
    }
    if (progress)
        progress(1.0);
    out.left = std::move(result[0]);
    if (channels == 2)
        out.right = std::move(result[1]);
    return out;
}

std::string checkTimeStretch(double ratio, double sampleRate, int channels) {
    if (!std::isfinite(ratio) || ratio < kTimeStretchMinRatio || ratio > kTimeStretchMaxRatio)
        return "Time stretch ratio must be between 0.75x and 1.25x.";
    if (!std::isfinite(sampleRate) || sampleRate < 8000.0 || sampleRate > 192000.0)
        return "Time stretching supports sample rates from 8 kHz to 192 kHz. This audio is at " + number(sampleRate, 0) + " Hz.";
    if (channels != 1 && channels != 2)
        return "Time stretching supports mono and stereo audio.";
    return {};
}

TimeStretchResult timeStretch(const float* left, const float* right, int64_t frames, int channels,
                              double sampleRate, double ratio,
                              int64_t lead, int64_t tail,
                              const std::atomic<bool>* cancel,
                              const std::function<void(double)>& progress) {
    TimeStretchResult out;
    out.error = checkTimeStretch(ratio, sampleRate, channels);
    if (!out.error.empty())
        return out;
    if (left == nullptr || (channels == 2 && right == nullptr) || frames <= 0) {
        out.error = "No audio was given to time stretch.";
        return out;
    }
    if (lead < 0 || tail < 0 || lead + tail >= frames) {
        out.error = "The region to time stretch is empty.";
        return out;
    }
    out.ratio = ratio;
    out.inputFrames = frames - lead - tail;
    const float* sources[2] = { left, right };
    auto clean = [](float value) { return std::isfinite(value) ? value : 0.0f; };
    for (int c = 0; c < channels; ++c) {
        for (int64_t i = lead; i < frames - tail; ++i) {
            const float value = sources[c][i];
            if (!std::isfinite(value))
                ++out.repairedSamples;
            else
                out.inputPeak = std::max(out.inputPeak, static_cast<double>(std::abs(value)));
        }
    }

    if (std::fabs(ratio - 1.0) < 1.0e-9) {
        out.identity = true;
        out.outputFrames = out.inputFrames;
        out.left.assign(static_cast<size_t>(out.inputFrames), 0.0f);
        std::transform(sources[0] + lead, sources[0] + lead + out.inputFrames, out.left.begin(), clean);
        if (channels == 2) {
            out.right.assign(static_cast<size_t>(out.inputFrames), 0.0f);
            std::transform(sources[1] + lead, sources[1] + lead + out.inputFrames, out.right.begin(), clean);
        }
        out.outputPeak = out.inputPeak;
        if (progress)
            progress(1.0);
        return out;
    }

    const int64_t outputFrames = std::max<int64_t>(1, static_cast<int64_t>(std::llround(static_cast<double>(out.inputFrames) * ratio)));
    out.outputFrames = outputFrames;
    std::vector<std::vector<float>> result(static_cast<size_t>(channels), std::vector<float>(static_cast<size_t>(outputFrames), 0.0f));
    const int fftSize = pitchShiftFrameSize(sampleRate);
    Stretcher stretcher;
    out.error = stretcher.prepare(sources, channels, frames, ratio, fftSize, 4, nullptr, 1.0);
    if (!out.error.empty())
        return out;

    // Map output sample i to stretched time: region starts at lead * ratio in stretcher time when
    // the stretcher maps input time t_in to t_in * ratio. Input sample lead+j maps to (lead+j)*ratio.
    const double regionStart = static_cast<double>(lead) * ratio;
    for (int64_t i = 0; i < outputFrames; ++i) {
        if ((i & 2047) == 0) {
            if (cancel != nullptr && cancel->load(std::memory_order_relaxed)) {
                out.cancelled = true;
                return out;
            }
            if (progress)
                progress(static_cast<double>(i) / static_cast<double>(outputFrames));
        }
        const double t = regionStart + static_cast<double>(i);
        const int64_t first = static_cast<int64_t>(std::floor(t));
        const double frac = t - static_cast<double>(first);
        while (stretcher.ready() < first + 2) {
            if (cancel != nullptr && cancel->load(std::memory_order_relaxed)) {
                out.cancelled = true;
                return out;
            }
            stretcher.nextFrame();
        }
        for (int c = 0; c < channels; ++c) {
            const float a = stretcher.at(c, first);
            const float b = stretcher.at(c, first + 1);
            const float value = static_cast<float>(a + (b - a) * frac);
            result[static_cast<size_t>(c)][static_cast<size_t>(i)] = std::isfinite(value) ? value : 0.0f;
        }
        stretcher.discardBefore(first);
    }
    for (const auto& channel : result)
        for (float value : channel)
            out.outputPeak = std::max(out.outputPeak, static_cast<double>(std::abs(value)));
    if (out.outputPeak > kPeakLimit) {
        const double gain = kPeakLimit / out.outputPeak;
        for (auto& channel : result)
            for (auto& value : channel)
                value = std::clamp(static_cast<float>(value * gain), -kPeakLimit, kPeakLimit);
        out.gainReductionDb = -20.0 * std::log10(gain);
        out.outputPeak = kPeakLimit;
    }
    if (progress)
        progress(1.0);
    out.left = std::move(result[0]);
    if (channels == 2)
        out.right = std::move(result[1]);
    return out;
}

TimeStretchResult timeWarpSegments(const float* left, const float* right, int64_t frames, int channels,
                                   double sampleRate, const std::vector<int64_t>& sourceBreaks,
                                   const std::vector<int64_t>& destLengths,
                                   int64_t lead, int64_t tail,
                                   const std::atomic<bool>* cancel,
                                   const std::function<void(double)>& progress) {
    TimeStretchResult out;
    if (sourceBreaks.size() < 2 || destLengths.size() + 1 != sourceBreaks.size()) {
        out.error = "Timing warp needs matching source breaks and destination lengths.";
        return out;
    }
    if (lead < 0 || tail < 0 || lead + tail >= frames) {
        out.error = "The region to time warp is empty.";
        return out;
    }
    const int64_t regionStart = lead;
    const int64_t regionEnd = frames - tail;
    if (sourceBreaks.front() != regionStart || sourceBreaks.back() != regionEnd) {
        out.error = "Timing warp breaks must start and end on the clip region.";
        return out;
    }
    for (size_t i = 1; i < sourceBreaks.size(); ++i) {
        if (sourceBreaks[i] <= sourceBreaks[i - 1]) {
            out.error = "Timing warp breaks must be strictly increasing.";
            return out;
        }
    }
    int64_t totalDest = 0;
    for (size_t i = 0; i + 1 < sourceBreaks.size(); ++i) {
        const int64_t srcLen = sourceBreaks[i + 1] - sourceBreaks[i];
        const int64_t dstLen = destLengths[i];
        if (srcLen <= 0 || dstLen <= 0) {
            out.error = "A timing warp segment cannot have zero or negative length.";
            return out;
        }
        const double ratio = static_cast<double>(dstLen) / static_cast<double>(srcLen);
        out.error = checkTimeStretch(ratio, sampleRate, channels);
        if (!out.error.empty())
            return out;
        totalDest += dstLen;
    }

    const int64_t xfade = std::max<int64_t>(1, static_cast<int64_t>(std::llround(sampleRate * kDefaultTimingCrossfadeMs / 1000.0)));
    out.left.assign(static_cast<size_t>(totalDest), 0.0f);
    if (channels == 2)
        out.right.assign(static_cast<size_t>(totalDest), 0.0f);
    out.inputFrames = regionEnd - regionStart;
    out.outputFrames = totalDest;
    out.ratio = static_cast<double>(totalDest) / static_cast<double>(std::max<int64_t>(1, out.inputFrames));

    int64_t writeAt = 0;
    for (size_t i = 0; i + 1 < sourceBreaks.size(); ++i) {
        if (cancel != nullptr && cancel->load(std::memory_order_relaxed)) {
            out.cancelled = true;
            return out;
        }
        const int64_t src0 = sourceBreaks[i];
        const int64_t src1 = sourceBreaks[i + 1];
        const int64_t srcLen = src1 - src0;
        const int64_t dstLen = destLengths[i];
        const double ratio = static_cast<double>(dstLen) / static_cast<double>(srcLen);
        // Context around the segment for clean vocoder edges.
        const int64_t ctx = pitchShiftFrameSize(sampleRate);
        const int64_t from = std::max<int64_t>(0, src0 - ctx);
        const int64_t to = std::min<int64_t>(frames, src1 + ctx);
        std::vector<float> segL(left + from, left + to);
        std::vector<float> segR;
        if (channels == 2)
            segR.assign(right + from, right + to);
        auto stretched = timeStretch(segL.data(), channels == 2 ? segR.data() : nullptr,
                                     static_cast<int64_t>(segL.size()), channels, sampleRate, ratio,
                                     src0 - from, to - src1, cancel, {});
        if (!stretched.error.empty() || stretched.cancelled) {
            out.error = stretched.error.empty() ? "Timing warp was cancelled." : stretched.error;
            out.cancelled = stretched.cancelled;
            return out;
        }
        // Stretched region length should be ~dstLen; crop/pad to exact.
        const int64_t got = static_cast<int64_t>(stretched.left.size());
        const int64_t use = std::min(got, dstLen);
        const int64_t fade = std::min({ xfade, use / 2, writeAt > 0 ? writeAt : xfade });
        for (int64_t n = 0; n < dstLen; ++n) {
            float L = n < use ? stretched.left[static_cast<size_t>(n)] : 0.0f;
            float R = (channels == 2 && n < use) ? stretched.right[static_cast<size_t>(n)] : L;
            if (writeAt > 0 && n < fade) {
                const float w = static_cast<float>(n + 1) / static_cast<float>(fade + 1);
                const int64_t at = writeAt + n;
                out.left[static_cast<size_t>(at)] = out.left[static_cast<size_t>(at)] * (1.0f - w) + L * w;
                if (channels == 2)
                    out.right[static_cast<size_t>(at)] = out.right[static_cast<size_t>(at)] * (1.0f - w) + R * w;
            } else {
                out.left[static_cast<size_t>(writeAt + n)] = L;
                if (channels == 2)
                    out.right[static_cast<size_t>(writeAt + n)] = R;
            }
            out.outputPeak = std::max(out.outputPeak, static_cast<double>(std::max(std::fabs(L), std::fabs(R))));
        }
        out.repairedSamples += stretched.repairedSamples;
        writeAt += dstLen;
        if (progress)
            progress(static_cast<double>(i + 1) / static_cast<double>(destLengths.size()));
    }
    return out;
}

} // namespace msp
