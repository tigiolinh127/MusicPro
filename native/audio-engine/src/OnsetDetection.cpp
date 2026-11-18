#include "msp/OnsetDetection.h"

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

float sampleAt(const float* left, const float* right, int channels, int64_t i) {
    const float a = left[i];
    const float b = channels >= 2 && right != nullptr ? right[i] : a;
    const float mono = 0.5f * ((std::isfinite(a) ? a : 0.0f) + (std::isfinite(b) ? b : 0.0f));
    return mono;
}

} // namespace

std::string checkOnsetSettings(const OnsetSettings& settings, double sampleRate, int channels) {
    if (!std::isfinite(sampleRate) || sampleRate < 8000.0 || sampleRate > 192000.0)
        return "Onset detection supports sample rates from 8 kHz to 192 kHz. This audio is at " + number(sampleRate, 0) + " Hz.";
    if (channels != 1 && channels != 2)
        return "Onset detection supports mono and stereo audio.";
    if (!std::isfinite(settings.minSeparationMs) || settings.minSeparationMs < 5.0 || settings.minSeparationMs > 500.0)
        return "Onset separation must be between 5 and 500 milliseconds.";
    if (!std::isfinite(settings.sensitivity) || settings.sensitivity < 0.0 || settings.sensitivity > 1.0)
        return "Onset sensitivity must be between 0 and 1.";
    if (!std::isfinite(settings.minLevelDb) || settings.minLevelDb > -6.0 || settings.minLevelDb < -120.0)
        return "Onset minimum level must be between -120 and -6 dBFS.";
    return {};
}

OnsetResult detectOnsets(const float* left, const float* right, int64_t frames, int channels,
                         double sampleRate, const OnsetSettings& settings) {
    OnsetResult out;
    out.error = checkOnsetSettings(settings, sampleRate, channels);
    if (!out.error.empty())
        return out;
    if (left == nullptr || frames <= 0) {
        out.error = "No audio was given for onset detection.";
        return out;
    }
    if (channels == 2 && right == nullptr) {
        out.error = "Stereo onset detection needs both channels.";
        return out;
    }

    int fftSize = 512;
    if (sampleRate > 60000.0)
        fftSize = 1024;
    const int hop = fftSize / 4;
    if (frames < fftSize + hop) {
        // Too short for analysis: treat a rising edge from silence as a single onset.
        double peak = 0.0;
        int64_t first = -1;
        for (int64_t i = 0; i < frames; ++i) {
            const float v = sampleAt(left, right, channels, i);
            if (!std::isfinite(left[i]) || (channels >= 2 && right != nullptr && !std::isfinite(right[i])))
                ++out.repairedSamples;
            const double a = std::fabs(v);
            if (a > peak)
                peak = a;
            if (first < 0 && a > 0.01)
                first = i;
        }
        if (first >= 0 && peak > std::pow(10.0, settings.minLevelDb / 20.0))
            out.samples.push_back(first);
        return out;
    }

    Fft fft;
    out.error = fft.prepare(fftSize);
    if (!out.error.empty())
        return out;

    const int bins = fftSize / 2 + 1;
    std::vector<double> window(static_cast<size_t>(fftSize));
    for (int i = 0; i < fftSize; ++i)
        window[static_cast<size_t>(i)] = 0.5 - 0.5 * std::cos(2.0 * 3.14159265358979323846 * i / fftSize);

    std::vector<double> energy;
    std::vector<double> flux;
    std::vector<double> prevMag(static_cast<size_t>(bins), 0.0);
    std::vector<std::complex<double>> spectrum(static_cast<size_t>(fftSize));
    bool first = true;

    for (int64_t start = 0; start + fftSize <= frames; start += hop) {
        for (int i = 0; i < fftSize; ++i) {
            const float v = sampleAt(left, right, channels, start + i);
            if (!std::isfinite(left[start + i]) || (channels >= 2 && right != nullptr && !std::isfinite(right[start + i])))
                ++out.repairedSamples;
            spectrum[static_cast<size_t>(i)] = { v * window[static_cast<size_t>(i)], 0.0 };
        }
        fft.transform(spectrum, false);
        double e = 0.0;
        double f = 0.0;
        for (int k = 0; k < bins; ++k) {
            const double mag = std::abs(spectrum[static_cast<size_t>(k)]);
            e += mag * mag;
            if (!first) {
                const double diff = mag - prevMag[static_cast<size_t>(k)];
                if (diff > 0.0)
                    f += diff;
            }
            prevMag[static_cast<size_t>(k)] = mag;
        }
        energy.push_back(e);
        flux.push_back(first ? 0.0 : f);
        first = false;
    }
    if (energy.empty())
        return out;

    // Adaptive threshold from median flux + sensitivity.
    std::vector<double> sorted = flux;
    std::nth_element(sorted.begin(), sorted.begin() + static_cast<std::ptrdiff_t>(sorted.size() / 2), sorted.end());
    const double median = sorted[sorted.size() / 2];
    double mean = std::accumulate(flux.begin(), flux.end(), 0.0) / static_cast<double>(flux.size());
    const double threshold = median + (0.35 + 1.4 * (1.0 - settings.sensitivity)) * std::max(mean, median);
    const double minEnergy = static_cast<double>(fftSize) * std::pow(10.0, settings.minLevelDb / 10.0);

    std::vector<int64_t> candidates;
    for (size_t i = 1; i + 1 < flux.size(); ++i) {
        if (flux[i] < threshold || energy[i] < minEnergy)
            continue;
        if (flux[i] >= flux[i - 1] && flux[i] > flux[i + 1]) {
            // Prefer silence-to-voice: energy rising vs previous frame.
            if (energy[i] > energy[i - 1] * 1.15 || flux[i] > threshold * 1.25)
                candidates.push_back(static_cast<int64_t>(i) * hop + fftSize / 4);
        }
    }

    const int64_t separation = std::max<int64_t>(1, static_cast<int64_t>(std::llround(sampleRate * settings.minSeparationMs / 1000.0)));
    for (int64_t at : candidates) {
        if (out.samples.empty() || at - out.samples.back() >= separation)
            out.samples.push_back(at);
        else if (at < frames) {
            // Keep the earlier marker; drop the later duplicate.
        }
    }
    return out;
}

} // namespace msp
