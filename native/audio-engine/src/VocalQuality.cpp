#include "msp/VocalQuality.h"

#include <algorithm>
#include <cmath>

namespace msp {
namespace {
constexpr double kPi = 3.14159265358979323846;
constexpr double kMinGain = 0.015848931924611134;   // -36 dB
constexpr double kMaxGain = 7.943282347242815;      // +18 dB
constexpr double kVoicedCepstrum = 0.1;             // cepstral peak (natural-log units) of a harmonic frame
constexpr double kTrueEnvelopeTolerance = 0.2302585092994046;   // 2 dB in natural-log units
constexpr int kTrueEnvelopeIterations = 16;

double raisedCosine(double x) {
    return 0.5 - 0.5 * std::cos(kPi * std::clamp(x, 0.0, 1.0));
}
} // namespace

std::string checkVocalQuality(const VocalQuality& quality) {
    if (!std::isfinite(quality.formantShiftSemitones) || std::abs(quality.formantShiftSemitones) > kFormantShiftMaxSemitones)
        return "The formant shift must be between -12 and +12 semitones.";
    return {};
}

double envelopeScale(const VocalQuality& quality, double ratio) {
    const double shift = std::pow(2.0, quality.formantShiftSemitones / 12.0);
    return (quality.preserveFormants ? ratio : 1.0) / shift;
}

bool changesEnvelope(const VocalQuality& quality, double ratio) {
    return std::abs(envelopeScale(quality, ratio) - 1.0) > 1e-9;
}

std::string EnvelopeShaper::prepare(int fftSize, double sampleRate, bool trueEnvelope) {
    n = fftSize;
    bins = n / 2 + 1;
    rate = sampleRate;
    iterate = trueEnvelope;
    const auto error = fft.prepare(n);
    if (!error.empty())
        return error;
    // Pitch periods of 1/1000 s to 1/60 s; the lifter keeps 0.6 of the period, so harmonics stay out.
    lowQuefrency = std::max(2, static_cast<int>(std::lround(rate / 1000.0)));
    highQuefrency = std::min(n / 2 - 1, static_cast<int>(std::lround(rate / 60.0)));
    minLifter = std::max(4, static_cast<int>(std::lround(rate / 2000.0)));
    maxLifter = std::min(n / 2 - 1, static_cast<int>(std::lround(0.6 * rate / 80.0)));
    defaultLifter = std::clamp(static_cast<int>(std::lround(0.6 * rate / 300.0)), minLifter, maxLifter);
    smoothedLifter = 0.0;
    logMagnitude.assign(static_cast<size_t>(bins), 0.0);
    fitted.assign(static_cast<size_t>(bins), 0.0);
    envelope.assign(static_cast<size_t>(bins), 0.0);
    cepstrum.assign(static_cast<size_t>(n), {});
    work.assign(static_cast<size_t>(n), {});
    return {};
}

int64_t EnvelopeShaper::bytes() const {
    return static_cast<int64_t>((logMagnitude.capacity() + fitted.capacity() + envelope.capacity()) * sizeof(double)
                                + (cepstrum.capacity() + work.capacity()) * sizeof(std::complex<double>));
}

void EnvelopeShaper::smooth(int cutoff, std::vector<double>& out) {
    // Rectangular lifter with a cosine taper over its last 20%.
    const double taper = std::max(1.0, 0.2 * cutoff);
    for (int q = 0; q < n; ++q) {
        const int index = std::min(q, n - q);
        double weight = 0.0;
        if (index <= cutoff)
            weight = index < cutoff - taper ? 1.0 : 0.5 + 0.5 * std::cos(kPi * (index - (cutoff - taper)) / taper);
        work[static_cast<size_t>(q)] = { cepstrum[static_cast<size_t>(q)].real() * weight, 0.0 };
    }
    fft.transform(work, false);
    for (int k = 0; k < bins; ++k)
        out[static_cast<size_t>(k)] = work[static_cast<size_t>(k)].real();
}

bool EnvelopeShaper::compute(const std::vector<double>& magnitude, double ratio, double scale, std::vector<double>& gain) {
    if (!(scale > 0.0) || !std::isfinite(scale) || std::abs(scale - 1.0) <= 1e-9 || static_cast<int>(magnitude.size()) < bins)
        return false;
    double loudest = 0.0;
    for (int k = 0; k < bins; ++k)
        loudest = std::max(loudest, magnitude[static_cast<size_t>(k)]);
    if (!(loudest > 0.0) || !std::isfinite(loudest))
        return false;
    const double floorValue = loudest * 1e-5;   // -100 dB: no log of zero, no huge valley boosts
    for (int k = 0; k < bins; ++k)
        logMagnitude[static_cast<size_t>(k)] = std::log(std::max(magnitude[static_cast<size_t>(k)], floorValue));

    auto cepstrumOf = [&](const std::vector<double>& logSpectrum) {
        for (int k = 0; k < bins; ++k)
            cepstrum[static_cast<size_t>(k)] = { logSpectrum[static_cast<size_t>(k)], 0.0 };
        for (int k = 1; k < n / 2; ++k)
            cepstrum[static_cast<size_t>(n - k)] = cepstrum[static_cast<size_t>(k)];
        fft.transform(cepstrum, true);
    };
    cepstrumOf(logMagnitude);

    // The lifter follows the frame's pitch period (cepstral peak; the first strong peak avoids
    // picking a multiple of the period). Unvoiced frames use a 300 Hz period.
    double strongest = 0.0;
    for (int q = lowQuefrency; q <= highQuefrency; ++q)
        strongest = std::max(strongest, cepstrum[static_cast<size_t>(q)].real());
    double period = rate / 300.0;
    if (strongest > kVoicedCepstrum) {
        for (int q = lowQuefrency + 1; q < highQuefrency; ++q) {
            const double c = cepstrum[static_cast<size_t>(q)].real();
            if (c >= 0.6 * strongest && c >= cepstrum[static_cast<size_t>(q) - 1].real() && c >= cepstrum[static_cast<size_t>(q) + 1].real()) {
                period = q;
                break;
            }
        }
    }
    const int cutoff = std::clamp(static_cast<int>(std::lround(0.6 * period)), minLifter, maxLifter);
    smoothedLifter = smoothedLifter <= 0.0 ? cutoff : 0.7 * smoothedLifter + 0.3 * cutoff;
    const int lift = std::clamp(static_cast<int>(smoothedLifter + 0.5), minLifter, maxLifter);

    // Peak envelope (SEEVOC): the loudest bin in every harmonic-wide band, joined by straight
    // lines in log magnitude. Smoothing that instead of the raw spectrum keeps formant peaks
    // instead of averaging them with the valleys between harmonics.
    const double spacing = std::max(2.0, static_cast<double>(n) / period);
    int lastBin = 0;
    double lastValue = 0.0;
    bool haveAnchor = false;
    for (double low = 0.5 * spacing; low < bins - 1; low += spacing) {
        const int from = static_cast<int>(std::ceil(low));
        const int to = std::min(bins - 1, static_cast<int>(std::ceil(low + spacing)) - 1);
        if (to < from)
            continue;
        int best = from;
        for (int k = from + 1; k <= to; ++k)
            if (logMagnitude[static_cast<size_t>(k)] > logMagnitude[static_cast<size_t>(best)])
                best = k;
        const double value = logMagnitude[static_cast<size_t>(best)];
        if (!haveAnchor) {
            for (int k = 0; k <= best; ++k)
                fitted[static_cast<size_t>(k)] = value;
        } else {
            for (int k = lastBin + 1; k <= best; ++k)
                fitted[static_cast<size_t>(k)] = lastValue + (value - lastValue) * (k - lastBin) / static_cast<double>(best - lastBin);
        }
        lastBin = best;
        lastValue = value;
        haveAnchor = true;
    }
    for (int k = haveAnchor ? lastBin + 1 : 0; k < bins; ++k)
        fitted[static_cast<size_t>(k)] = haveAnchor ? lastValue : logMagnitude[static_cast<size_t>(k)];
    cepstrumOf(fitted);
    smooth(lift, envelope);

    if (iterate) {
        // True envelope (Roebel & Rodet), started from the peak envelope: raise the spectrum to the
        // envelope and smooth again until the envelope passes within 2 dB over every spectral peak.
        for (int k = 0; k < bins; ++k)
            fitted[static_cast<size_t>(k)] = std::max(logMagnitude[static_cast<size_t>(k)], envelope[static_cast<size_t>(k)]);
        for (int i = 0; i < kTrueEnvelopeIterations; ++i) {
            double above = 0.0;
            for (int k = 0; k < bins; ++k) {
                above = std::max(above, logMagnitude[static_cast<size_t>(k)] - envelope[static_cast<size_t>(k)]);
                fitted[static_cast<size_t>(k)] = std::max(fitted[static_cast<size_t>(k)], envelope[static_cast<size_t>(k)]);
            }
            if (above < kTrueEnvelopeTolerance)
                break;
            cepstrumOf(fitted);
            smooth(lift, envelope);
        }
    }

    // Bins that survive the resampler's anti-aliasing filter.
    const int keep = std::min(bins, static_cast<int>(0.97 * (n / 2) * std::min(1.0, 1.0 / ratio)) + 1);
    double before = 0.0;
    double after = 0.0;
    for (int k = 0; k < bins; ++k) {
        const double x = std::min(static_cast<double>(bins - 1), k * scale);
        const auto i = static_cast<int>(x);
        const double f = x - i;
        const double target = i + 1 < bins
            ? envelope[static_cast<size_t>(i)] + (envelope[static_cast<size_t>(i) + 1] - envelope[static_cast<size_t>(i)]) * f
            : envelope[static_cast<size_t>(bins - 1)];
        const double g = std::clamp(std::exp(target - envelope[static_cast<size_t>(k)]), kMinGain, kMaxGain);
        gain[static_cast<size_t>(k)] = g;
        if (k < keep) {
            const double m = magnitude[static_cast<size_t>(k)];
            before += m * m;
            after += g * g * m * m;
        }
    }
    if (after > 0.0) {
        const double norm = std::clamp(std::sqrt(before / after), 0.25, 4.0);
        for (int k = 0; k < bins; ++k)
            gain[static_cast<size_t>(k)] *= norm;
    }
    return true;
}

void TransientGuard::prepare(const float* left, const float* right, int64_t frames, double sampleRate, int64_t preSamples) {
    attacks.clear();
    cursor = 0;
    pre = std::max<int64_t>(0, preSamples);
    hold = static_cast<int64_t>(std::lround(0.005 * sampleRate));
    fadeIn = std::max<int64_t>(1, static_cast<int64_t>(std::lround(0.003 * sampleRate)));
    fadeOut = std::max<int64_t>(1, static_cast<int64_t>(std::lround(0.010 * sampleRate)));
    if (left == nullptr || frames <= 0 || !(sampleRate > 0.0))
        return;
    const int64_t block = std::max<int64_t>(16, static_cast<int64_t>(std::lround(0.0025 * sampleRate)));
    const int64_t blocks = (frames + block - 1) / block;
    std::vector<float> energy(static_cast<size_t>(blocks), 0.0f);
    for (int64_t b = 0; b < blocks; ++b) {
        double sum = 0.0;
        const int64_t end = std::min(frames, (b + 1) * block);
        for (int64_t i = b * block; i < end; ++i) {
            float v = right != nullptr ? 0.5f * (left[i] + right[i]) : left[i];
            if (!std::isfinite(v))
                v = 0.0f;
            sum += static_cast<double>(v) * v;
        }
        energy[static_cast<size_t>(b)] = static_cast<float>(sum / static_cast<double>(end - b * block));
    }
    const int64_t back = 8;    // 20 ms
    const int64_t ahead = 4;   // 10 ms
    const int64_t gap = static_cast<int64_t>(0.05 * sampleRate);
    int64_t last = -gap - 1;
    for (int64_t b = 0; b < blocks; ++b) {
        float prior = 0.0f;
        for (int64_t j = std::max<int64_t>(0, b - back); j < b; ++j)
            prior = std::max(prior, energy[static_cast<size_t>(j)]);
        if (energy[static_cast<size_t>(b)] <= 4.0f * prior)
            continue;
        float post = 0.0f;
        for (int64_t j = b; j < std::min(blocks, b + ahead); ++j)
            post = std::max(post, energy[static_cast<size_t>(j)]);
        if (post < 1e-5f || post < 63.0f * prior)
            continue;
        const int64_t at = b * block;
        if (at - last < gap)
            continue;
        attacks.push_back(at);
        last = at;
    }
}

float TransientGuard::weight(int64_t n) {
    while (cursor > 0 && n < attacks[cursor - 1] + hold + fadeOut)
        --cursor;
    while (cursor < attacks.size() && n > attacks[cursor] + hold + fadeOut)
        ++cursor;
    double w = 0.0;
    for (size_t k = cursor; k < attacks.size() && k < cursor + 2; ++k) {
        const int64_t o = attacks[k];
        const int64_t a = o - pre - fadeIn;
        const int64_t b = o - pre;
        const int64_t c = o + hold;
        const int64_t d = c + fadeOut;
        double v = 0.0;
        if (n >= a && n < b)
            v = raisedCosine(static_cast<double>(n - a) / static_cast<double>(fadeIn));
        else if (n >= b && n <= c)
            v = 1.0;
        else if (n > c && n < d)
            v = raisedCosine(static_cast<double>(d - n) / static_cast<double>(fadeOut));
        w = std::max(w, v);
    }
    return static_cast<float>(w);
}

} // namespace msp
