#include "msp/LatencyCalibration.h"

#include <algorithm>
#include <cmath>
#include <sstream>

namespace msp {
namespace {

constexpr double kReliableConfidence = 0.55;
constexpr double kMinPeakCorrelation = 0.35;

std::vector<float> toMono(const float* left, const float* right, size_t frames) {
    std::vector<float> out(frames, 0.0f);
    if (left == nullptr)
        return out;
    if (right == nullptr) {
        for (size_t i = 0; i < frames; ++i)
            out[i] = left[i];
        return out;
    }
    for (size_t i = 0; i < frames; ++i)
        out[i] = 0.5f * (left[i] + right[i]);
    return out;
}

double energy(const std::vector<float>& x) {
    double sum = 0.0;
    for (float v : x)
        sum += static_cast<double>(v) * static_cast<double>(v);
    return sum;
}

} // namespace

LatencyEstimate estimateLatencySamples(const float* reference, size_t referenceFrames,
                                       const float* recorded, size_t recordedFrames,
                                       double sampleRate, int64_t maxLagSamples) {
    LatencyEstimate out;
    if (reference == nullptr || recorded == nullptr || referenceFrames < 8 || recordedFrames < 8
        || !(sampleRate > 0.0) || maxLagSamples < 1) {
        out.message = "Reference and recorded buffers need enough samples, and sampleRate/maxLag must be positive.";
        return out;
    }
    const auto ref = toMono(reference, nullptr, referenceFrames);
    const auto sig = toMono(recorded, nullptr, recordedFrames);
    const double refE = energy(ref);
    const double sigE = energy(sig);
    if (!(refE > 1.0e-12) || !(sigE > 1.0e-12)) {
        out.message = "Reference or recorded signal is silent — cannot estimate delay.";
        return out;
    }

    const int64_t maxLag = std::min<int64_t>(maxLagSamples,
                                             static_cast<int64_t>(std::min(ref.size(), sig.size()) - 1));
    double bestCorr = -1.0;
    int64_t bestLag = 0;
    double secondCorr = -1.0;
    const double refNorm = std::sqrt(refE);
    // Lag L means sig[n+L] aligns with ref[n] → positive L = recorded lags reference.
    for (int64_t lag = -maxLag; lag <= maxLag; ++lag) {
        double dot = 0.0;
        double sigWindow = 0.0;
        size_t count = 0;
        for (size_t i = 0; i < ref.size(); ++i) {
            const int64_t j = static_cast<int64_t>(i) + lag;
            if (j < 0 || static_cast<size_t>(j) >= sig.size())
                continue;
            const double r = ref[i];
            const double s = sig[static_cast<size_t>(j)];
            dot += r * s;
            sigWindow += s * s;
            ++count;
        }
        if (count < 8 || !(sigWindow > 1.0e-12))
            continue;
        const double corr = std::fabs(dot) / (refNorm * std::sqrt(sigWindow));
        if (corr > bestCorr) {
            secondCorr = bestCorr;
            bestCorr = corr;
            bestLag = lag;
        } else if (corr > secondCorr) {
            secondCorr = corr;
        }
    }
    out.delaySamples = bestLag;
    out.delayMs = 1000.0 * static_cast<double>(bestLag) / sampleRate;
    out.peakCorrelation = bestCorr;
    const double sharpness = bestCorr > 1.0e-9 ? std::max(0.0, (bestCorr - std::max(0.0, secondCorr)) / bestCorr) : 0.0;
    out.confidence = std::clamp(bestCorr * (0.5 + 0.5 * sharpness), 0.0, 1.0);
    out.reliable = out.confidence >= kReliableConfidence && out.peakCorrelation >= kMinPeakCorrelation;
    if (!out.reliable) {
        out.message = out.peakCorrelation < kMinPeakCorrelation
                          ? "Correlation peak is too weak — check the loopback connection and try again."
                          : "Estimate confidence is too low to apply automatically.";
    } else {
        out.message = "Reliable delay estimate.";
    }
    return out;
}

LatencyEstimate estimateLatencyMono(const std::vector<float>& reference,
                                    const std::vector<float>& recorded,
                                    double sampleRate, double maxLagMs) {
    const int64_t maxLag = std::max<int64_t>(1, static_cast<int64_t>(std::llround(std::abs(maxLagMs) * sampleRate / 1000.0)));
    return estimateLatencySamples(reference.data(), reference.size(), recorded.data(), recorded.size(),
                                  sampleRate, maxLag);
}

int64_t recordingOffsetSamples(double offsetMs, double sampleRate, double maxMs) {
    if (!(sampleRate > 0.0) || !std::isfinite(offsetMs))
        return 0;
    const double clamped = std::clamp(offsetMs, -std::abs(maxMs), std::abs(maxMs));
    return static_cast<int64_t>(std::llround(clamped * sampleRate / 1000.0));
}

double recordingOffsetMsFromSamples(int64_t samples, double sampleRate) {
    if (!(sampleRate > 0.0))
        return 0.0;
    return 1000.0 * static_cast<double>(samples) / sampleRate;
}

std::string recordingLatencyProfileKey(const std::string& outputDevice,
                                       const std::string& inputDevice,
                                       int sampleRate, int bufferSize) {
    std::ostringstream key;
    key << outputDevice << '\n' << inputDevice << '\n' << sampleRate << '\n' << bufferSize;
    return key.str();
}

} // namespace msp
