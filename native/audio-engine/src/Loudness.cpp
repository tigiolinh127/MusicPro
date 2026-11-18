#include "msp/Loudness.h"
#include "msp/WavIO.h"

#include <juce_audio_basics/juce_audio_basics.h>

#include <algorithm>
#include <cmath>
#include <cstring>

namespace msp {
namespace {

constexpr double kPi = 3.14159265358979323846;
constexpr double kLoudnessOffset = -0.691; // BS.1770

struct Biquad {
    double b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0;
    double z1 = 0, z2 = 0;

    void reset() { z1 = z2 = 0; }

    double process(double x) {
        const double y = b0 * x + z1;
        z1 = b1 * x - a1 * y + z2;
        z2 = b2 * x - a2 * y;
        return y;
    }
};

// Bilinear transform of the BS.1770-4 analog stages (Annex 1).
Biquad makeHighShelf(double sampleRate, double f0, double gainDb, double Q) {
    const double K = std::tan(kPi * f0 / sampleRate);
    const double Vh = std::pow(10.0, gainDb / 20.0);
    const double Vb = std::pow(Vh, 0.4996667741545416);
    const double a0 = 1.0 + K / Q + K * K;
    Biquad b;
    b.b0 = (Vh + Vb * K / Q + K * K) / a0;
    b.b1 = 2.0 * (K * K - Vh) / a0;
    b.b2 = (Vh - Vb * K / Q + K * K) / a0;
    b.a1 = 2.0 * (K * K - 1.0) / a0;
    b.a2 = (1.0 - K / Q + K * K) / a0;
    return b;
}

Biquad makeHighPass(double sampleRate, double f0, double Q) {
    const double K = std::tan(kPi * f0 / sampleRate);
    const double a0 = 1.0 + K / Q + K * K;
    Biquad b;
    b.b0 = 1.0 / a0;
    b.b1 = -2.0 / a0;
    b.b2 = 1.0 / a0;
    b.a1 = 2.0 * (K * K - 1.0) / a0;
    b.a2 = (1.0 - K / Q + K * K) / a0;
    return b;
}

void designK(double sampleRate, Biquad& pre, Biquad& rlb) {
    // ITU-R BS.1770-4 Annex 1 constants
    pre = makeHighShelf(sampleRate, 1681.974450955533, 3.999843853973347, 0.7071752369554196);
    rlb = makeHighPass(sampleRate, 38.13547087602444, 0.5003270373238773);
}

double biquadMag(const Biquad& b, double w) {
    const double c1 = std::cos(w), s1 = std::sin(w), c2 = std::cos(2.0 * w), s2 = std::sin(2.0 * w);
    const double numRe = b.b0 + b.b1 * c1 + b.b2 * c2;
    const double numIm = -(b.b1 * s1 + b.b2 * s2);
    const double denRe = 1.0 + b.a1 * c1 + b.a2 * c2;
    const double denIm = -(b.a1 * s1 + b.a2 * s2);
    return std::sqrt((numRe * numRe + numIm * numIm) / (denRe * denRe + denIm * denIm));
}

double toLufs(double meanSquare) {
    if (!(meanSquare > 1.0e-20) || !std::isfinite(meanSquare))
        return -120.0;
    return kLoudnessOffset + 10.0 * std::log10(meanSquare);
}

double toDbFs(double peak) {
    if (!(peak > 1.0e-20) || !std::isfinite(peak))
        return -120.0;
    return 20.0 * std::log10(peak);
}

bool cancelled(std::atomic<bool>* cancel) {
    return cancel != nullptr && cancel->load(std::memory_order_relaxed);
}

// 4× true-peak via zero-stuff + Kaiser low-pass (offline; allocations OK).
double measureTruePeak(const float* left, const float* right, int64_t frames, int channels,
                       std::atomic<bool>* cancel) {
    if (frames <= 0)
        return 0.0;
    const int factor = kTruePeakOversample;
    const int taps = 49; // odd length FIR (Hann-windowed sinc, cutoff π/factor)
    std::vector<double> fir(static_cast<size_t>(taps), 0.0);
    const int mid = taps / 2;
    double sum = 0.0;
    for (int i = 0; i < taps; ++i) {
        const double x = static_cast<double>(i - mid);
        const double sinc = (std::fabs(x) < 1.0e-12) ? 1.0 : std::sin(kPi * x / factor) / (kPi * x / factor);
        const double hann = 0.5 - 0.5 * std::cos(2.0 * kPi * static_cast<double>(i) / static_cast<double>(taps - 1));
        fir[static_cast<size_t>(i)] = sinc * hann;
        sum += fir[static_cast<size_t>(i)];
    }
    for (double& c : fir)
        c *= static_cast<double>(factor) / sum;

    auto peakOf = [&](const float* src) {
        double peak = 0.0;
        // Process in chunks to keep memory bounded: streaming FIR on zero-stuffed stream.
        std::vector<double> hist(static_cast<size_t>(taps), 0.0);
        int histPos = 0;
        for (int64_t n = 0; n < frames; ++n) {
            if ((n & 4095) == 0 && cancelled(cancel))
                return peak;
            const double sample = std::isfinite(src[n]) ? static_cast<double>(src[n]) : 0.0;
            for (int z = 0; z < factor; ++z) {
                hist[static_cast<size_t>(histPos)] = (z == 0) ? sample : 0.0;
                double y = 0.0;
                int idx = histPos;
                for (int t = 0; t < taps; ++t) {
                    y += fir[static_cast<size_t>(t)] * hist[static_cast<size_t>(idx)];
                    if (--idx < 0)
                        idx = taps - 1;
                }
                peak = std::max(peak, std::fabs(y));
                if (++histPos >= taps)
                    histPos = 0;
            }
        }
        return peak;
    };

    double peak = peakOf(left);
    if (channels > 1 && right != nullptr)
        peak = std::max(peak, peakOf(right));
    return peak;
}

double percentile(std::vector<double> values, double p) {
    if (values.empty())
        return 0.0;
    std::sort(values.begin(), values.end());
    const double idx = p * static_cast<double>(values.size() - 1);
    const size_t i = static_cast<size_t>(idx);
    const double f = idx - static_cast<double>(i);
    if (i + 1 >= values.size())
        return values.back();
    return values[i] * (1.0 - f) + values[i + 1] * f;
}

} // namespace

double kWeightingMagnitudeDb(double sampleRate, double hz) {
    if (!(sampleRate > 0.0) || !(hz > 0.0) || hz >= sampleRate * 0.5)
        return 0.0;
    Biquad pre, rlb;
    designK(sampleRate, pre, rlb);
    const double w = 2.0 * kPi * hz / sampleRate;
    const double mag = biquadMag(pre, w) * biquadMag(rlb, w);
    return 20.0 * std::log10(std::max(mag, 1.0e-12));
}

LoudnessReport analyzeLoudness(const float* left,
                               const float* right,
                               int64_t frames,
                               double sampleRate,
                               int channels,
                               std::atomic<bool>* cancel,
                               const std::function<void(int64_t done, int64_t total)>& progress) {
    LoudnessReport report;
    report.sampleRate = sampleRate;
    report.channels = std::clamp(channels, 1, 2);
    report.frames = frames;
    if (left == nullptr || !(sampleRate >= 8000.0) || frames < 0) {
        report.error = "Loudness analysis needs valid PCM and sample rate.";
        return report;
    }
    if (report.channels > 1 && right == nullptr)
        right = left;
    report.durationSeconds = static_cast<double>(frames) / sampleRate;

    const int64_t block = std::max<int64_t>(1, static_cast<int64_t>(std::llround(kMomentarySeconds * sampleRate)));
    const int64_t hop = std::max<int64_t>(1, static_cast<int64_t>(std::llround(kBlockHopSeconds * sampleRate)));
    const int64_t shortBlocks = std::max<int64_t>(1, static_cast<int64_t>(std::llround(kShortTermSeconds / kBlockHopSeconds)));

    if (frames < block) {
        // Too short for a full momentary window — still report peaks if any samples exist.
        double samplePeak = 0.0;
        for (int64_t i = 0; i < frames; ++i) {
            const double l = std::isfinite(left[i]) ? std::fabs(static_cast<double>(left[i])) : 0.0;
            const double r = report.channels > 1 ? (std::isfinite(right[i]) ? std::fabs(static_cast<double>(right[i])) : 0.0) : l;
            samplePeak = std::max(samplePeak, std::max(l, r));
        }
        report.samplePeakValid = frames > 0;
        report.samplePeakDbFs = toDbFs(samplePeak);
        report.clippingSample = report.samplePeakDbFs >= -0.001;
        if (frames > 0) {
            const double tp = measureTruePeak(left, right, frames, report.channels, cancel);
            report.truePeakValid = !cancelled(cancel);
            report.truePeakDbTp = toDbFs(tp);
            report.clippingTruePeak = report.truePeakDbTp >= -0.001;
        }
        if (cancelled(cancel)) {
            report.cancelled = true;
            report.error = "Loudness analysis was cancelled.";
        }
        // LUFS unavailable for sub-momentary files
        return report;
    }

    Biquad preL, rlbL, preR, rlbR;
    designK(sampleRate, preL, rlbL);
    designK(sampleRate, preR, rlbR);

    std::vector<double> filteredL(static_cast<size_t>(frames));
    std::vector<double> filteredR(static_cast<size_t>(frames));
    double samplePeak = 0.0;
    for (int64_t i = 0; i < frames; ++i) {
        if ((i & 8191) == 0) {
            if (cancelled(cancel)) {
                report.cancelled = true;
                report.error = "Loudness analysis was cancelled.";
                return report;
            }
            if (progress)
                progress(i, frames * 2);
        }
        double l = std::isfinite(left[i]) ? static_cast<double>(left[i]) : 0.0;
        double r = report.channels > 1 ? (std::isfinite(right[i]) ? static_cast<double>(right[i]) : 0.0) : l;
        samplePeak = std::max(samplePeak, std::max(std::fabs(l), std::fabs(r)));
        filteredL[static_cast<size_t>(i)] = rlbL.process(preL.process(l));
        filteredR[static_cast<size_t>(i)] = report.channels > 1 ? rlbR.process(preR.process(r)) : filteredL[static_cast<size_t>(i)];
    }

    report.samplePeakValid = true;
    report.samplePeakDbFs = toDbFs(samplePeak);
    report.clippingSample = report.samplePeakDbFs >= -0.001;

    // Mean-square energy of each 400 ms block (channel-weighted).
    std::vector<double> blockMs;
    blockMs.reserve(static_cast<size_t>((frames - block) / hop + 1));
    for (int64_t start = 0; start + block <= frames; start += hop) {
        if ((start & 16383) == 0 && cancelled(cancel)) {
            report.cancelled = true;
            report.error = "Loudness analysis was cancelled.";
            return report;
        }
        double sum = 0.0;
        for (int64_t i = 0; i < block; ++i) {
            const double yl = filteredL[static_cast<size_t>(start + i)];
            // BS.1770 channel weights = 1.0 for L/R; mono uses a single weighted channel.
            sum += yl * yl;
            if (report.channels > 1) {
                const double yr = filteredR[static_cast<size_t>(start + i)];
                sum += yr * yr;
            }
        }
        blockMs.push_back(sum / static_cast<double>(block));
    }

    if (blockMs.empty())
        return report;

    // Momentary: max over 400 ms blocks; short-term: max of 3 s sliding mean of mean-squares.
    double maxMomentaryMs = 0.0;
    double maxShortMs = 0.0;
    double shortAcc = 0.0;
    for (size_t i = 0; i < blockMs.size(); ++i) {
        maxMomentaryMs = std::max(maxMomentaryMs, blockMs[i]);
        shortAcc += blockMs[i];
        if (i >= static_cast<size_t>(shortBlocks))
            shortAcc -= blockMs[i - static_cast<size_t>(shortBlocks)];
        if (i + 1 >= static_cast<size_t>(shortBlocks))
            maxShortMs = std::max(maxShortMs, shortAcc / static_cast<double>(shortBlocks));
    }
    report.momentaryValid = true;
    report.momentaryLufs = toLufs(maxMomentaryMs);
    report.shortTermValid = blockMs.size() >= static_cast<size_t>(shortBlocks);
    if (report.shortTermValid)
        report.shortTermLufs = toLufs(maxShortMs);

    // Integrated with absolute then relative gating.
    auto gatedMean = [&](double absGate, double relOffset, bool* valid) {
        double sum = 0.0;
        int count = 0;
        for (double ms : blockMs) {
            if (toLufs(ms) >= absGate) {
                sum += ms;
                ++count;
            }
        }
        if (count == 0) {
            *valid = false;
            return 0.0;
        }
        const double relGate = toLufs(sum / count) + relOffset;
        sum = 0.0;
        count = 0;
        for (double ms : blockMs) {
            if (toLufs(ms) >= absGate && toLufs(ms) >= relGate) {
                sum += ms;
                ++count;
            }
        }
        if (count == 0) {
            *valid = false;
            return 0.0;
        }
        *valid = true;
        return sum / static_cast<double>(count);
    };

    bool integOk = false;
    const double integMs = gatedMean(kAbsGateLufs, kRelGateLu, &integOk);
    report.integratedValid = integOk;
    if (integOk)
        report.integratedLufs = toLufs(integMs);

    // LRA from short-term loudness values (EBU Tech 3342).
    if (report.shortTermValid) {
        std::vector<double> shortLufs;
        double acc = 0.0;
        for (size_t i = 0; i < blockMs.size(); ++i) {
            acc += blockMs[i];
            if (i >= static_cast<size_t>(shortBlocks))
                acc -= blockMs[i - static_cast<size_t>(shortBlocks)];
            if (i + 1 >= static_cast<size_t>(shortBlocks))
                shortLufs.push_back(toLufs(acc / static_cast<double>(shortBlocks)));
        }
        std::vector<double> absGated;
        for (double v : shortLufs) {
            if (v >= kAbsGateLufs)
                absGated.push_back(v);
        }
        if (absGated.size() >= 2) {
            double sum = 0.0;
            for (double v : absGated)
                sum += std::pow(10.0, (v - kLoudnessOffset) / 10.0);
            const double absIntegrated = toLufs(sum / static_cast<double>(absGated.size()));
            const double rel = absIntegrated + kLraRelGateLu;
            std::vector<double> relGated;
            for (double v : absGated) {
                if (v >= rel)
                    relGated.push_back(v);
            }
            if (relGated.size() >= 2) {
                const double p10 = percentile(relGated, 0.10);
                const double p95 = percentile(relGated, 0.95);
                report.lraValid = true;
                report.lraLu = std::max(0.0, p95 - p10);
            }
        }
    }

    if (progress)
        progress(frames, frames * 2);
    if (cancelled(cancel)) {
        report.cancelled = true;
        report.error = "Loudness analysis was cancelled.";
        return report;
    }

    const double tp = measureTruePeak(left, right, frames, report.channels, cancel);
    if (cancelled(cancel)) {
        report.cancelled = true;
        report.error = "Loudness analysis was cancelled.";
        return report;
    }
    report.truePeakValid = true;
    report.truePeakDbTp = toDbFs(tp);
    report.clippingTruePeak = report.truePeakDbTp >= -0.001;

    // Silence / no gated energy → available=false for LUFS fields already; mark overall.
    report.available = report.integratedValid || report.momentaryValid;
    if (!report.integratedValid && report.momentaryLufs <= kAbsGateLufs + 0.5)
        report.available = report.samplePeakValid && report.samplePeakDbFs > -90.0;

    // Prefer clear unavailable when effectively silent.
    if (report.samplePeakDbFs <= -90.0) {
        report.integratedValid = false;
        report.momentaryValid = false;
        report.shortTermValid = false;
        report.lraValid = false;
        report.available = false;
    } else {
        report.available = true;
    }

    if (progress)
        progress(frames * 2, frames * 2);
    return report;
}

LoudnessReport analyzeLoudnessFile(const std::string& path,
                                   std::atomic<bool>* cancel,
                                   const std::function<void(int64_t done, int64_t total)>& progress) {
    LoudnessReport report;
    report.path = path;
    auto pcm = readWavFile(path);
    if (!pcm.error.empty()) {
        report.error = pcm.error;
        return report;
    }
    if (pcm.left.empty()) {
        report.error = "The WAV file contains no audio samples.";
        report.sampleRate = pcm.sampleRate;
        report.channels = pcm.sourceChannels;
        return report;
    }
    report = analyzeLoudness(pcm.left.data(), pcm.right.data(),
                             static_cast<int64_t>(pcm.left.size()), pcm.sampleRate,
                             pcm.sourceChannels > 1 ? 2 : 1, cancel, progress);
    report.path = path;
    return report;
}

} // namespace msp
