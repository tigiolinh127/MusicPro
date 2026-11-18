#include "msp/PitchCorrect.h"

#include "msp/Fft.h"
#include "msp/PitchShift.h"

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

double median(std::vector<double> values) {
    if (values.empty())
        return 0.0;
    const size_t mid = values.size() / 2;
    std::nth_element(values.begin(), values.begin() + static_cast<std::ptrdiff_t>(mid), values.end());
    double result = values[mid];
    if (values.size() % 2 == 0) {
        std::nth_element(values.begin(), values.begin() + static_cast<std::ptrdiff_t>(mid) - 1, values.end());
        result = 0.5 * (result + values[mid - 1]);
    }
    return result;
}

double raisedCosine(double x) {
    return 0.5 - 0.5 * std::cos(kPi * std::clamp(x, 0.0, 1.0));
}

// The time warp tau(x) = integral of r, piecewise linear with one ratio per curve point. Before
// sample 0 and after the curve the ratio is 1.
class Warp {
public:
    void prepare(const CorrectionCurve& curve) {
        points = curve.cents.size();
        mix = &curve.mix;
        ratio.resize(points);
        tau.resize(points + 1);
        active.resize(points + 1);
        tau[0] = 0.0;
        active[0] = 0;
        for (size_t p = 0; p < points; ++p) {
            ratio[p] = std::pow(2.0, static_cast<double>(curve.cents[p]) / 1200.0);
            tau[p + 1] = tau[p] + kCorrectionControlStep * ratio[p];
            active[p + 1] = active[p] + (curve.mix[p] > 0.0f ? 1 : 0);
        }
        hint = 0;
    }

    int64_t bytes() const {
        return static_cast<int64_t>(ratio.capacity() * sizeof(double) + tau.capacity() * sizeof(double) + active.capacity() * sizeof(int32_t));
    }

    double ratioAt(int64_t n) const {
        if (n < 0)
            return 1.0;
        const auto p = static_cast<size_t>(n / kCorrectionControlStep);
        return p < points ? ratio[p] : 1.0;
    }

    double tauAt(double x) const {
        if (x <= 0.0)
            return x;
        const auto p = static_cast<size_t>(x / kCorrectionControlStep);
        if (p >= points)
            return tau[points] + (x - static_cast<double>(points) * kCorrectionControlStep);
        return tau[p] + (x - static_cast<double>(p) * kCorrectionControlStep) * ratio[p];
    }

    // Input position whose warped position is `target`. Calls are mostly increasing.
    double inverse(double target) {
        if (target <= 0.0)
            return target;
        if (target >= tau[points])
            return static_cast<double>(points) * kCorrectionControlStep + (target - tau[points]);
        while (hint > 0 && tau[hint] > target)
            --hint;
        while (hint + 1 < points && tau[hint + 1] <= target)
            ++hint;
        return static_cast<double>(hint) * kCorrectionControlStep + (target - tau[hint]) / ratio[hint];
    }

    float mixAt(int64_t n) const {
        if (n < 0)
            return 0.0f;
        const auto p = static_cast<size_t>(n / kCorrectionControlStep);
        if (p >= points)
            return 0.0f;
        const float a = (*mix)[p];
        const float b = p + 1 < points ? (*mix)[p + 1] : 0.0f;
        if (a == 0.0f && b == 0.0f)
            return 0.0f;
        const float frac = static_cast<float>(n - static_cast<int64_t>(p) * kCorrectionControlStep) / kCorrectionControlStep;
        return a + (b - a) * frac;
    }

    // Whether any curve point in input samples [from, to] has a mix above 0.
    bool anyActive(int64_t from, int64_t to) const {
        if (to < 0)
            return false;
        const auto p0 = std::min<int64_t>(static_cast<int64_t>(points), std::max<int64_t>(0, from) / kCorrectionControlStep);
        const auto p1 = std::min<int64_t>(static_cast<int64_t>(points), to / kCorrectionControlStep + 2);
        return active[static_cast<size_t>(p1)] - active[static_cast<size_t>(p0)] > 0;
    }

private:
    size_t points = 0;
    const std::vector<float>* mix = nullptr;
    std::vector<double> ratio;
    std::vector<double> tau;
    std::vector<int32_t> active;
    size_t hint = 0;
};

// Phase vocoder with variable hops. Frame k is analysed at the integer input position a_k nearest
// to tau^-1(k * hs) and synthesised at the warped position tau(a_k), so its local stretch follows
// the curve. Identity phase locking with one rotation per peak region (shared by all channels);
// the analysis phases are used unchanged on onsets and after skipped frames. Reads the caller's
// channels directly (non-finite samples count as silence). With a shaper, each frame's spectral
// envelope is compensated for the ratio at its analysis position.
class VarStretcher {
public:
    std::string prepare(const float* const* source, int sourceChannels, int64_t sourceFrames, Warp& map, int fftSize,
                        int overlap, EnvelopeShaper* envelopeShaper, const VocalQuality& vocal) {
        input = source;
        frames = sourceFrames;
        channels = sourceChannels;
        warp = &map;
        shaper = envelopeShaper;
        quality = vocal;
        n = fftSize;
        bins = n / 2 + 1;
        hs = n / overlap;
        gain.assign(static_cast<size_t>(bins), 1.0);
        const auto error = fft.prepare(n);
        if (!error.empty())
            return error;
        window.resize(static_cast<size_t>(n));
        cosTable.resize(static_cast<size_t>(n));
        sinTable.resize(static_cast<size_t>(n));
        synthWindow.resize(static_cast<size_t>(n));
        for (int j = 0; j < n; ++j) {
            cosTable[static_cast<size_t>(j)] = std::cos(kTwoPi * j / n);
            sinTable[static_cast<size_t>(j)] = std::sin(kTwoPi * j / n);
            window[static_cast<size_t>(j)] = 0.5 - 0.5 * cosTable[static_cast<size_t>(j)];
        }
        spectra.assign(static_cast<size_t>(channels), std::vector<std::complex<double>>(static_cast<size_t>(n)));
        phase.assign(static_cast<size_t>(channels), std::vector<double>(static_cast<size_t>(bins), 0.0));
        lastPhase = phase;
        lastSynth = phase;
        magnitude.assign(static_cast<size_t>(bins), 0.0);
        rotation.assign(static_cast<size_t>(bins), 0.0);
        peaks.reserve(static_cast<size_t>(bins));
        acc.assign(static_cast<size_t>(channels), {});
        norm.clear();
        origin = 2 * static_cast<int64_t>(n);
        base = 0;
        // Frames this far from any corrected point cannot reach a corrected output sample.
        margin = 2 * static_cast<int64_t>(n) + 128;
        m = -(n / hs) - 2;
        position(m, nextA, nextS);
        first = true;
        lastEnergy = 0.0;
        return {};
    }

    // Warped samples before this position are final.
    int64_t ready() const { return static_cast<int64_t>(std::floor(nextS)) - n / 2; }

    void nextFrame() {
        const int64_t a = nextA;
        const double s = nextS;
        ++m;
        position(m, nextA, nextS);
        if (!warp->anyActive(a - margin, a + margin)) {
            ++skipped;
            first = true;
            return;
        }
        ++computed;
        const int64_t start = a - n / 2;
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
        const double floorEnergy = 1e-8 * n * n;
        const bool reset = first || (energy > 4.0 * lastEnergy && energy > floorEnergy);
        const int64_t hopA = a - lastA;
        const double hopS = s - lastS;

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
        if (!reset && hopA > 0 && !peaks.empty()) {
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
                int ref = 0;
                for (int c = 1; c < channels; ++c) {
                    if (std::abs(spectra[static_cast<size_t>(c)][static_cast<size_t>(p)])
                        > std::abs(spectra[static_cast<size_t>(ref)][static_cast<size_t>(p)]))
                        ref = c;
                }
                const double omega = kTwoPi * p / n;
                const double current = phase[static_cast<size_t>(ref)][static_cast<size_t>(p)];
                const double deviation = princarg(current - lastPhase[static_cast<size_t>(ref)][static_cast<size_t>(p)] - omega * static_cast<double>(hopA));
                const double trueOmega = omega + deviation / static_cast<double>(hopA);
                const double synth = lastSynth[static_cast<size_t>(ref)][static_cast<size_t>(p)] + trueOmega * hopS;
                const double delta = princarg(synth - current);
                for (int k = regionStart; k < regionEnd; ++k)
                    rotation[static_cast<size_t>(k)] = delta;
                regionStart = regionEnd;
            }
        }

        // Fractional placement: delay the frame by `frac` samples with a linear phase ramp and use
        // the synthesis window at the same offset.
        bool shaped = false;
        if (shaper != nullptr) {
            const double ratio = warp->ratioAt(a);
            shaped = shaper->compute(magnitude, ratio, envelopeScale(quality, ratio), gain);
            if (shaped)
                ++envelopeFrames;
        }

        const auto whole = static_cast<int64_t>(std::floor(s));
        const double frac = s - static_cast<double>(whole);
        const int64_t writeStart = whole - n / 2;
        place(writeStart);
        const int64_t offset = writeStart + origin - base;
        const double cf = std::cos(kTwoPi * frac / n);
        const double sf = std::sin(kTwoPi * frac / n);
        for (int j = 0; j < n; ++j)
            synthWindow[static_cast<size_t>(j)] = 0.5 - 0.5 * (cosTable[static_cast<size_t>(j)] * cf + sinTable[static_cast<size_t>(j)] * sf);
        const std::complex<double> turnStep = std::polar(1.0, -kTwoPi * frac / n);
        for (int c = 0; c < channels; ++c) {
            auto& spectrum = spectra[static_cast<size_t>(c)];
            std::complex<double> turn(1.0, 0.0);
            for (int k = 0; k < bins; ++k) {
                const double delta = rotation[static_cast<size_t>(k)];
                if (delta != 0.0)
                    spectrum[static_cast<size_t>(k)] *= std::polar(1.0, delta);
                lastSynth[static_cast<size_t>(c)][static_cast<size_t>(k)] = princarg(phase[static_cast<size_t>(c)][static_cast<size_t>(k)] + delta);
                spectrum[static_cast<size_t>(k)] *= shaped ? turn * gain[static_cast<size_t>(k)] : turn;
                turn *= turnStep;
            }
            spectrum[0] = { spectrum[0].real(), 0.0 };
            spectrum[static_cast<size_t>(n / 2)] = { spectrum[static_cast<size_t>(n / 2)].real(), 0.0 };
            for (int k = 1; k < n / 2; ++k)
                spectrum[static_cast<size_t>(n - k)] = std::conj(spectrum[static_cast<size_t>(k)]);
            fft.transform(spectrum, true);
            auto& out = acc[static_cast<size_t>(c)];
            for (int j = 0; j < n; ++j)
                out[static_cast<size_t>(offset + j)] += static_cast<float>(spectrum[static_cast<size_t>(j)].real() * synthWindow[static_cast<size_t>(j)]);
        }
        for (int j = 0; j < n; ++j) {
            const double w = synthWindow[static_cast<size_t>(j)];
            norm[static_cast<size_t>(offset + j)] += static_cast<float>(w * w);
        }
        lastPhase = phase;
        lastEnergy = energy;
        lastA = a;
        lastS = s;
        first = false;
    }

    float at(int c, int64_t t) const {
        const int64_t index = t + origin - base;
        if (index < 0 || index >= static_cast<int64_t>(norm.size()))
            return 0.0f;
        const float weight = norm[static_cast<size_t>(index)];
        return weight > 0.05f ? acc[static_cast<size_t>(c)][static_cast<size_t>(index)] / weight : 0.0f;
    }

    // Frees samples before warped position t once enough have accumulated.
    void discardBefore(int64_t t) {
        const int64_t drop = std::min<int64_t>(t + origin - base, static_cast<int64_t>(norm.size()));
        if (drop < 65536)
            return;
        for (auto& out : acc)
            out.erase(out.begin(), out.begin() + static_cast<std::ptrdiff_t>(drop));
        norm.erase(norm.begin(), norm.begin() + static_cast<std::ptrdiff_t>(drop));
        base += drop;
    }

    int64_t computedFrames() const { return computed; }
    int64_t skippedFrames() const { return skipped; }
    int64_t shapedFrames() const { return envelopeFrames; }
    int64_t bytes() const {
        const auto spectrumBytes = static_cast<int64_t>(channels) * n * static_cast<int64_t>(sizeof(std::complex<double>));
        const auto phaseBytes = 3 * static_cast<int64_t>(channels) * bins * static_cast<int64_t>(sizeof(double));
        const auto tableBytes = static_cast<int64_t>(4 * n + 2 * bins) * static_cast<int64_t>(sizeof(double));
        return peakSamples * (channels + 1) * static_cast<int64_t>(sizeof(float)) + spectrumBytes + phaseBytes + tableBytes;
    }

private:
    void position(int64_t index, int64_t& a, double& s) {
        a = std::llround(warp->inverse(static_cast<double>(index) * hs));
        s = warp->tauAt(static_cast<double>(a));
    }

    // Makes room for a frame written from warped position `writeStart`. A long gap (after skipped
    // frames) holds only zeros that no output sample reads, so the buffer restarts there.
    void place(int64_t writeStart) {
        int64_t relative = writeStart + origin - base;
        if (relative > static_cast<int64_t>(norm.size()) + 65536) {
            for (auto& out : acc)
                out.clear();
            norm.clear();
            base = writeStart + origin;
            relative = 0;
        }
        const auto size = static_cast<size_t>(relative + n);
        if (norm.size() < size) {
            for (auto& out : acc)
                out.resize(size, 0.0f);
            norm.resize(size, 0.0f);
        }
        peakSamples = std::max<int64_t>(peakSamples, static_cast<int64_t>(norm.capacity()));
    }

    const float* const* input = nullptr;
    int64_t frames = 0;
    int channels = 0;
    Warp* warp = nullptr;
    EnvelopeShaper* shaper = nullptr;
    VocalQuality quality;
    std::vector<double> gain;
    int64_t envelopeFrames = 0;
    int n = 0;
    int bins = 0;
    int hs = 0;
    Fft fft;
    std::vector<double> window;
    std::vector<double> cosTable;
    std::vector<double> sinTable;
    std::vector<double> synthWindow;
    std::vector<std::vector<std::complex<double>>> spectra;
    std::vector<std::vector<double>> phase;
    std::vector<std::vector<double>> lastPhase;
    std::vector<std::vector<double>> lastSynth;
    std::vector<double> magnitude;
    std::vector<double> rotation;
    std::vector<int> peaks;
    std::vector<std::vector<float>> acc;
    std::vector<float> norm;
    int64_t origin = 0;
    int64_t base = 0;
    int64_t margin = 0;
    int64_t m = 0;
    int64_t nextA = 0;
    double nextS = 0.0;
    int64_t lastA = 0;
    double lastS = 0.0;
    double lastEnergy = 0.0;
    bool first = true;
    int64_t computed = 0;
    int64_t skipped = 0;
    int64_t peakSamples = 0;
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

// Kaiser-windowed sinc interpolator whose cutoff can change for every output sample. The kernel
// is tabulated once over its own argument; a cutoff fc stretches it to Z / fc input samples.
class VarResampler {
public:
    void prepare() {
        const int size = static_cast<int>(kZeroCrossings * kSteps) + 2;
        table.resize(static_cast<size_t>(size));
        const double norm = besselI0(kBeta);
        for (int i = 0; i < size; ++i) {
            const double u = static_cast<double>(i) / kSteps;
            if (u >= kZeroCrossings) {
                table[static_cast<size_t>(i)] = 0.0;
                continue;
            }
            const double sinc = u == 0.0 ? 1.0 : std::sin(kPi * u) / (kPi * u);
            const double r = u / kZeroCrossings;
            table[static_cast<size_t>(i)] = sinc * besselI0(kBeta * std::sqrt(1.0 - r * r)) / norm;
        }
        weights.resize(static_cast<size_t>(2 * (static_cast<int>(std::ceil(kZeroCrossings / kMinCutoff)) + 1)));
    }

    // Fills the weights for reading at position t with cutoff fc (fraction of Nyquist); returns the
    // first sample index and sets `count`.
    int64_t weigh(double t, double fc, int& count) {
        fc = std::clamp(fc, kMinCutoff, 1.0);
        const int taps = static_cast<int>(std::ceil(kZeroCrossings / fc));
        const auto i0 = static_cast<int64_t>(std::floor(t));
        const int64_t first = i0 - taps + 1;
        count = 2 * taps;
        double sum = 0.0;
        for (int k = 0; k < count; ++k) {
            const double u = std::abs(t - static_cast<double>(first + k)) * fc * kSteps;
            const auto index = static_cast<size_t>(u);
            double w = 0.0;
            if (index + 1 < table.size()) {
                const double frac = u - static_cast<double>(index);
                w = table[index] + (table[index + 1] - table[index]) * frac;
            }
            weights[static_cast<size_t>(k)] = w;
            sum += w;
        }
        if (sum > 0.0) {
            for (int k = 0; k < count; ++k)
                weights[static_cast<size_t>(k)] /= sum;
        }
        return first;
    }

    const std::vector<double>& current() const { return weights; }
    int64_t bytes() const { return static_cast<int64_t>((table.capacity() + weights.capacity()) * sizeof(double)); }

private:
    static constexpr double kZeroCrossings = 24.0;
    static constexpr double kBeta = 9.0;
    static constexpr int kSteps = 512;
    static constexpr double kMinCutoff = 0.97 * 0.5;
    std::vector<double> table;
    std::vector<double> weights;
};

struct Span {
    double start = 0.0;
    double end = 0.0;
    int target = 60;
    std::vector<double> time;
    std::vector<double> midi;

    double measured(double t) const {
        if (t <= time.front())
            return midi.front();
        if (t >= time.back())
            return midi.back();
        const auto upper = std::upper_bound(time.begin(), time.end(), t);
        const auto k = static_cast<size_t>(upper - time.begin());
        const double f = (t - time[k - 1]) / std::max(1e-12, time[k] - time[k - 1]);
        return midi[k - 1] + (midi[k] - midi[k - 1]) * f;
    }
};
} // namespace

std::string checkCorrectionSettings(const CorrectionSettings& settings) {
    if (!std::isfinite(settings.retuneMs) || settings.retuneMs < 0.0 || settings.retuneMs > kRetuneMaxMs)
        return "The retune speed must be between 0 and 200 ms.";
    if (!std::isfinite(settings.strength) || settings.strength < 0.0 || settings.strength > 1.0)
        return "The correction strength must be between 0 and 100%.";
    return checkVocalQuality(settings.quality);
}

std::vector<CorrectionNote> correctionNotes(const std::vector<NoteSegment>& segments, const std::vector<int>& targets,
                                            double edgeSeconds) {
    std::vector<CorrectionNote> notes;
    const double edge = std::isfinite(edgeSeconds) ? std::max(0.0, edgeSeconds) : 0.0;
    for (size_t i = 0; i < segments.size() && i < targets.size(); ++i) {
        if (targets[i] < 0 || targets[i] > 127)
            continue;
        const auto& segment = segments[i];
        CorrectionNote note;
        note.start = std::max(0.0, segment.start - edge);
        if (i > 0)
            note.start = std::max(note.start, 0.5 * (segments[i - 1].end + segment.start));
        note.end = segment.end + edge;
        if (i + 1 < segments.size())
            note.end = std::min(note.end, 0.5 * (segment.end + segments[i + 1].start));
        note.firstFrame = segment.firstFrame;
        note.lastFrame = segment.lastFrame;
        note.targetMidi = targets[i];
        if (note.end > note.start)
            notes.push_back(note);
    }
    return notes;
}

CorrectionCurve buildCorrectionCurve(const std::vector<PitchFrame>& frames, const std::vector<CorrectionNote>& notes,
                                     const CorrectionSettings& settings, double sampleRate, int64_t totalFrames,
                                     double offsetSeconds) {
    CorrectionCurve curve;
    curve.sampleRate = sampleRate;
    curve.frames = totalFrames;
    curve.quality = settings.quality;
    if (!(sampleRate > 0.0) || totalFrames <= 0 || !std::isfinite(offsetSeconds))
        return curve;
    const size_t points = static_cast<size_t>(totalFrames / kCorrectionControlStep) + 2;
    curve.cents.assign(points, 0.0f);
    curve.goal.assign(points, 0.0f);
    curve.mix.assign(points, 0.0f);
    if (!checkCorrectionSettings(settings).empty() || settings.strength <= 0.0)
        return curve;

    std::vector<Span> spans;
    for (size_t noteIndex = 0; noteIndex < notes.size(); ++noteIndex) {
        const auto& note = notes[noteIndex];
        if (!std::isfinite(note.start) || !std::isfinite(note.end) || note.end <= note.start || note.targetMidi < 0 || note.targetMidi > 127)
            continue;
        Span span;
        span.start = note.start;
        span.end = note.end;
        span.target = note.targetMidi;
        std::vector<double> raw;
        for (int f = std::max(0, note.firstFrame); f <= note.lastFrame && f < static_cast<int>(frames.size()); ++f) {
            const auto& frame = frames[static_cast<size_t>(f)];
            if (!frame.voiced || !(frame.frequency > 0.0) || !std::isfinite(frame.frequency) || !std::isfinite(frame.time))
                continue;
            span.time.push_back(frame.time);
            raw.push_back(midiFromFrequency(frame.frequency));
        }
        if (raw.empty())
            continue;
        // Octave (or larger) detection errors are dropped before smoothing.
        const double centre = median(raw);
        size_t kept = 0;
        for (size_t i = 0; i < raw.size(); ++i) {
            if (std::abs(raw[i] - centre) > kOctaveRejectSemitones) {
                ++curve.octaveFrames;
                continue;
            }
            raw[kept] = raw[i];
            span.time[kept] = span.time[i];
            ++kept;
        }
        raw.resize(kept);
        span.time.resize(kept);
        if (raw.empty())
            continue;
        for (size_t i = 0; i < raw.size(); ++i) {
            const size_t from = i >= 2 ? i - 2 : 0;
            const size_t to = std::min(raw.size(), i + 3);
            span.midi.push_back(median(std::vector<double>(raw.begin() + static_cast<std::ptrdiff_t>(from), raw.begin() + static_cast<std::ptrdiff_t>(to))));
        }
        const double length = span.time.back() - span.time.front();
        if (length >= kGlideMinSeconds && span.midi.size() >= 5) {
            double meanT = 0.0;
            double meanM = 0.0;
            for (size_t i = 0; i < span.midi.size(); ++i) {
                meanT += span.time[i];
                meanM += span.midi[i];
            }
            meanT /= static_cast<double>(span.midi.size());
            meanM /= static_cast<double>(span.midi.size());
            double stt = 0.0;
            double stm = 0.0;
            double smm = 0.0;
            for (size_t i = 0; i < span.midi.size(); ++i) {
                stt += (span.time[i] - meanT) * (span.time[i] - meanT);
                stm += (span.time[i] - meanT) * (span.midi[i] - meanM);
                smm += (span.midi[i] - meanM) * (span.midi[i] - meanM);
            }
            const double slope = stt > 0.0 ? stm / stt : 0.0;
            const double fit = smm > 0.0 && stt > 0.0 ? stm * stm / (stt * smm) : 0.0;
            if (std::abs(slope) >= kGlideMinSlope && std::abs(slope) * length >= kGlideMinTravel && fit >= kGlideMinFit) {
                curve.glideNotes.push_back(noteIndex);
                continue;
            }
        }
        spans.push_back(std::move(span));
    }
    std::sort(spans.begin(), spans.end(), [](const Span& a, const Span& b) { return a.start < b.start; });

    const double step = kCorrectionControlStep / sampleRate;
    auto timeAt = [&](size_t p) { return static_cast<double>(p) * step - offsetSeconds; };
    // Crossfade weight: ramps in before the span, holds through the release after it, ramps out.
    const double fade = kCorrectionFadeSeconds;
    const double hold = 6.0 * kCorrectionReleaseSeconds;
    for (const auto& span : spans) {
        const auto p0 = static_cast<int64_t>(std::floor((span.start - fade + offsetSeconds) / step));
        const auto p1 = static_cast<int64_t>(std::ceil((span.end + hold + fade + offsetSeconds) / step));
        for (int64_t p = std::max<int64_t>(0, p0); p <= std::min<int64_t>(static_cast<int64_t>(points) - 1, p1); ++p) {
            const double t = timeAt(static_cast<size_t>(p));
            double w = 0.0;
            if (t >= span.start - fade && t < span.start)
                w = raisedCosine((t - (span.start - fade)) / fade);
            else if (t >= span.start && t <= span.end + hold)
                w = 1.0;
            else if (t > span.end + hold && t <= span.end + hold + fade)
                w = raisedCosine((span.end + hold + fade - t) / fade);
            curve.mix[static_cast<size_t>(p)] = std::max(curve.mix[static_cast<size_t>(p)], static_cast<float>(w));
        }
    }

    const double tauNote = std::max(settings.retuneMs / 3.0, 1.0) / 1000.0;
    const double followNote = 1.0 - std::exp(-step / tauNote);
    const double followRelease = 1.0 - std::exp(-step / kCorrectionReleaseSeconds);
    double c = 0.0;
    size_t current = 0;
    for (size_t p = 0; p < points; ++p) {
        if (curve.mix[p] == 0.0f) {
            c = 0.0;
            continue;
        }
        const double t = timeAt(p);
        while (current < spans.size() && spans[current].end < t)
            ++current;
        if (current < spans.size() && t >= spans[current].start) {
            const auto& span = spans[current];
            const double goal = std::clamp((span.target - span.measured(t)) * 100.0, -kCorrectionMaxCents, kCorrectionMaxCents);
            c += (goal - c) * followNote;
            curve.goal[p] = static_cast<float>(goal * settings.strength);
        } else {
            c -= c * followRelease;
        }
        const double value = c * settings.strength;
        curve.cents[p] = static_cast<float>(value);
        curve.maxAbsCents = std::max(curve.maxAbsCents, std::abs(value));
        if (curve.cents[p] != 0.0f)
            curve.identity = false;
    }
    if (settings.quality.formantShiftSemitones != 0.0 && !spans.empty())
        curve.identity = false;
    return curve;
}

PitchCorrectResult pitchCorrect(const float* left, const float* right, int64_t frames, int channels, double sampleRate,
                                const CorrectionCurve& curve, int64_t lead, int64_t tail,
                                const std::atomic<bool>* cancel, const std::function<void(double)>& progress) {
    PitchCorrectResult out;
    if (!std::isfinite(sampleRate) || sampleRate < 8000.0 || sampleRate > 192000.0) {
        out.error = "Pitch correction supports sample rates from 8 kHz to 192 kHz. This audio is at " + number(sampleRate, 0) + " Hz.";
        return out;
    }
    if (channels != 1 && channels != 2) {
        out.error = "Pitch correction supports mono and stereo audio.";
        return out;
    }
    if (left == nullptr || (channels == 2 && right == nullptr) || frames <= 0) {
        out.error = "No audio was given to correct.";
        return out;
    }
    if (lead < 0 || tail < 0 || lead + tail >= frames) {
        out.error = "The region to correct is empty.";
        return out;
    }
    const size_t needPoints = static_cast<size_t>(frames / kCorrectionControlStep) + 2;
    if (curve.frames != frames || curve.cents.size() < needPoints || curve.mix.size() != curve.cents.size()) {
        out.error = "The correction curve does not match the audio.";
        return out;
    }
    out.error = checkVocalQuality(curve.quality);
    if (!out.error.empty())
        return out;
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
    if (curve.identity) {
        out.identity = true;
        out.copiedSamples = count;
        for (int c = 0; c < channels; ++c)
            std::transform(sources[c] + lead, sources[c] + lead + count, result[static_cast<size_t>(c)].begin(), clean);
        out.outputPeak = out.inputPeak;
    } else {
        const int fftSize = pitchShiftFrameSize(sampleRate);
        const auto& quality = curve.quality;
        Warp warp;
        warp.prepare(curve);
        EnvelopeShaper shaper;
        const bool shaping = quality.preserveFormants || quality.formantShiftSemitones != 0.0;
        if (shaping) {
            out.error = shaper.prepare(fftSize, sampleRate, quality.high);
            if (!out.error.empty())
                return out;
        }
        VarStretcher stretcher;
        out.error = stretcher.prepare(sources, channels, frames, warp, fftSize, vocoderOverlap(quality),
                                      shaping ? &shaper : nullptr, quality);
        if (!out.error.empty())
            return out;
        // Ratios stay within a few semitones of 1 in practice, so the pre-echo reach is half a frame.
        TransientGuard guard;
        if (quality.protectTransients)
            guard.prepare(left, channels == 2 ? right : nullptr, frames, sampleRate, fftSize / 2);
        VarResampler resampler;
        resampler.prepare();
        for (int64_t i = 0; i < count; ++i) {
            if ((i & 4095) == 0) {
                if (cancel != nullptr && cancel->load(std::memory_order_relaxed)) {
                    out.cancelled = true;
                    return out;
                }
                if (progress)
                    progress(static_cast<double>(i) / static_cast<double>(count));
            }
            const int64_t position = lead + i;
            float mix = warp.mixAt(position);
            if (mix > 0.0f && !guard.onsets().empty())
                mix *= 1.0f - guard.weight(position);
            if (mix == 0.0f) {
                for (int c = 0; c < channels; ++c)
                    result[static_cast<size_t>(c)][static_cast<size_t>(i)] = clean(sources[c][position]);
                ++out.copiedSamples;
                continue;
            }
            const double ratio = warp.ratioAt(position);
            int taps = 0;
            const int64_t first = resampler.weigh(warp.tauAt(static_cast<double>(position)), 0.97 * std::min(1.0, 1.0 / ratio), taps);
            while (stretcher.ready() < first + taps) {
                if (cancel != nullptr && cancel->load(std::memory_order_relaxed)) {
                    out.cancelled = true;
                    return out;
                }
                stretcher.nextFrame();
            }
            const auto& weights = resampler.current();
            for (int c = 0; c < channels; ++c) {
                double sum = 0.0;
                for (int k = 0; k < taps; ++k)
                    sum += weights[static_cast<size_t>(k)] * stretcher.at(c, first + k);
                const double original = clean(sources[c][position]);
                const auto value = static_cast<float>(mix * sum + (1.0 - mix) * original);
                result[static_cast<size_t>(c)][static_cast<size_t>(i)] = std::isfinite(value) ? value : 0.0f;
            }
            stretcher.discardBefore(first);
        }
        out.vocoderFrames = stretcher.computedFrames();
        out.skippedFrames = stretcher.skippedFrames();
        out.envelopeFrames = stretcher.shapedFrames();
        out.transients = static_cast<int>(std::count_if(guard.onsets().begin(), guard.onsets().end(), [&](int64_t at) {
            return at >= lead && at < frames - tail && warp.mixAt(at) > 0.0f;
        }));
        out.workingBytes = warp.bytes() + stretcher.bytes() + resampler.bytes() + (shaping ? shaper.bytes() : 0)
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
    out.workingBytes += static_cast<int64_t>((curve.cents.capacity() + curve.goal.capacity() + curve.mix.capacity()) * sizeof(float));
    if (progress)
        progress(1.0);
    out.left = std::move(result[0]);
    if (channels == 2)
        out.right = std::move(result[1]);
    return out;
}

} // namespace msp
