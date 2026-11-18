#include "msp/SpectrumAnalyzer.h"

#include <algorithm>
#include <cmath>
#include <cstring>

namespace msp {
namespace {
constexpr double kPi = 3.14159265358979323846;

float monoSample(float l, float r) noexcept {
    return 0.5f * (l + r);
}
} // namespace

void SpectrumCapture::writeStereo(const float* left, const float* right, int n) noexcept {
    if (left == nullptr || right == nullptr || n <= 0)
        return;
    uint32_t w = writeIndex.load(std::memory_order_relaxed);
    for (int i = 0; i < n; ++i) {
        buffer[w & (kSpectrumRingSize - 1)] = monoSample(left[i], right[i]);
        ++w;
    }
    writeIndex.store(w, std::memory_order_release);
}

bool SpectrumCapture::latest(float* out, int count) const noexcept {
    if (out == nullptr || count <= 0 || count > kSpectrumRingSize)
        return false;
    const uint32_t w = writeIndex.load(std::memory_order_acquire);
    if (w < static_cast<uint32_t>(count))
        return false;
    const uint32_t start = w - static_cast<uint32_t>(count);
    for (int i = 0; i < count; ++i)
        out[i] = buffer[(start + static_cast<uint32_t>(i)) & (kSpectrumRingSize - 1)];
    return true;
}

void SpectrumCapture::clear() noexcept {
    writeIndex.store(0, std::memory_order_relaxed);
    std::memset(buffer, 0, sizeof(buffer));
}

std::string SpectrumAnalyzer::prepare(int fftSize) {
    const auto error = fft.prepare(fftSize);
    if (!error.empty())
        return error;
    spectrum.assign(static_cast<size_t>(fftSize), {});
    window.assign(static_cast<size_t>(fftSize), 0.0f);
    timeDomain.assign(static_cast<size_t>(fftSize), 0.0f);
    magDb.assign(static_cast<size_t>(fftSize / 2 + 1), -120.0f);
    for (int i = 0; i < fftSize; ++i)
        window[static_cast<size_t>(i)] = static_cast<float>(0.5 - 0.5 * std::cos(2.0 * kPi * i / fftSize));
    primed = false;
    return {};
}

bool SpectrumAnalyzer::process(const SpectrumCapture& capture, double sampleRate, bool available,
                               std::vector<float>& outDb, std::vector<float>& outHz) {
    outDb.assign(kSpectrumDisplayBins, -120.0f);
    outHz.assign(kSpectrumDisplayBins, 20.0f);
    if (!available || fft.size() < 2 || sampleRate <= 0.0)
        return false;
    if (!capture.latest(timeDomain.data(), fft.size()))
        return false;

    float peak = 0.0f;
    for (int i = 0; i < fft.size(); ++i) {
        const float v = timeDomain[static_cast<size_t>(i)] * window[static_cast<size_t>(i)];
        timeDomain[static_cast<size_t>(i)] = v;
        peak = std::max(peak, std::fabs(v));
        spectrum[static_cast<size_t>(i)] = { static_cast<double>(v), 0.0 };
    }
    fft.transform(spectrum, false);

    const int bins = fft.size() / 2 + 1;
    const double norm = 2.0 / static_cast<double>(fft.size());
    for (int k = 0; k < bins; ++k) {
        const double mag = std::abs(spectrum[static_cast<size_t>(k)]) * norm;
        double db = mag > 1.0e-12 ? 20.0 * std::log10(mag) : -120.0;
        db = std::clamp(db, -120.0, 12.0);
        if (!primed)
            magDb[static_cast<size_t>(k)] = static_cast<float>(db);
        else
            magDb[static_cast<size_t>(k)] = kSpectrumSmooth * magDb[static_cast<size_t>(k)]
                + (1.0f - kSpectrumSmooth) * static_cast<float>(db);
    }
    primed = true;

    // Silence: keep smoothed floor but still report available=true with quiet data.
    (void) peak;

    const double nyquist = sampleRate * 0.5;
    const double fMin = 20.0;
    const double fMax = std::min(20000.0, nyquist * 0.98);
    for (int i = 0; i < kSpectrumDisplayBins; ++i) {
        const double t = static_cast<double>(i) / static_cast<double>(kSpectrumDisplayBins - 1);
        const double hz = fMin * std::pow(fMax / fMin, t);
        outHz[static_cast<size_t>(i)] = static_cast<float>(hz);
        const double bin = hz * static_cast<double>(fft.size()) / sampleRate;
        const int k0 = std::clamp(static_cast<int>(std::floor(bin)), 0, bins - 1);
        const int k1 = std::min(bins - 1, k0 + 1);
        const double frac = std::clamp(bin - k0, 0.0, 1.0);
        outDb[static_cast<size_t>(i)] = static_cast<float>(
            (1.0 - frac) * magDb[static_cast<size_t>(k0)] + frac * magDb[static_cast<size_t>(k1)]);
    }
    return true;
}

} // namespace msp
