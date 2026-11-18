#include "msp/Effects.h"

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_dsp/juce_dsp.h>

#include <algorithm>
#include <cmath>
#include <cstring>

namespace msp {
namespace {
constexpr double kPi = 3.14159265358979323846;

const EffectParamSpec kEqParams[] = {
    { "band1Type", 0.0f, 2.0f, 0.0f, true },  { "band1Freq", 20.0f, 20000.0f, 100.0f, false },
    { "band1Gain", -24.0f, 24.0f, 0.0f, false }, { "band1Q", 0.1f, 18.0f, 0.71f, false },
    { "band2Type", 0.0f, 2.0f, 1.0f, true },  { "band2Freq", 20.0f, 20000.0f, 400.0f, false },
    { "band2Gain", -24.0f, 24.0f, 0.0f, false }, { "band2Q", 0.1f, 18.0f, 1.0f, false },
    { "band3Type", 0.0f, 2.0f, 1.0f, true },  { "band3Freq", 20.0f, 20000.0f, 2000.0f, false },
    { "band3Gain", -24.0f, 24.0f, 0.0f, false }, { "band3Q", 0.1f, 18.0f, 1.0f, false },
    { "band4Type", 0.0f, 2.0f, 2.0f, true },  { "band4Freq", 20.0f, 20000.0f, 8000.0f, false },
    { "band4Gain", -24.0f, 24.0f, 0.0f, false }, { "band4Q", 0.1f, 18.0f, 0.71f, false },
    { "outputGain", -24.0f, 24.0f, 0.0f, false },
    // Phase 2.8.3 additive: per-band enable (1=on). Older projects omit these → default 1.
    { "band1Enabled", 0.0f, 1.0f, 1.0f, true },
    { "band2Enabled", 0.0f, 1.0f, 1.0f, true },
    { "band3Enabled", 0.0f, 1.0f, 1.0f, true },
    { "band4Enabled", 0.0f, 1.0f, 1.0f, true },
};
const EffectParamSpec kCompParams[] = {
    { "threshold", -60.0f, 0.0f, -18.0f, false },
    { "ratio", 1.0f, 20.0f, 4.0f, false },
    { "attack", 0.1f, 200.0f, 10.0f, false },
    { "release", 5.0f, 2000.0f, 100.0f, false },
    { "makeup", 0.0f, 24.0f, 0.0f, false },
    // Phase 2.8.4 additive: soft-knee width in dB. 0 = hard knee (legacy projects).
    { "knee", 0.0f, 24.0f, 0.0f, false },
};
const EffectParamSpec kLimiterParams[] = {
    // Sample-peak stereo-linked brickwall (no lookahead / not true-peak).
    { "ceiling", -24.0f, 0.0f, -0.3f, false },
    { "release", 1.0f, 1000.0f, 50.0f, false },
    { "attack", 0.01f, 20.0f, 0.1f, false },
};
const EffectParamSpec kGateParams[] = {
    { "threshold", -80.0f, 0.0f, -50.0f, false },
    { "attack", 0.1f, 100.0f, 1.0f, false },
    { "hold", 0.0f, 500.0f, 20.0f, false },
    { "release", 5.0f, 2000.0f, 100.0f, false },
    { "range", -80.0f, 0.0f, -80.0f, false },
};
const EffectParamSpec kReverbParams[] = {
    { "roomSize", 0.0f, 1.0f, 0.5f, false },
    { "damping", 0.0f, 1.0f, 0.5f, false },
    { "mix", 0.0f, 1.0f, 0.3f, false },
};
const EffectParamSpec kDelayParams[] = {
    { "time", 1.0f, 2000.0f, 250.0f, false },
    { "feedback", 0.0f, kMaxDelayFeedback, 0.35f, false },
    { "mix", 0.0f, 1.0f, 0.3f, false },
};

const EffectSpec kSpecs[] = {
    { EffectType::eq, "eq", kEqParams, static_cast<int>(std::size(kEqParams)) },
    { EffectType::compressor, "compressor", kCompParams, static_cast<int>(std::size(kCompParams)) },
    { EffectType::gate, "gate", kGateParams, static_cast<int>(std::size(kGateParams)) },
    { EffectType::reverb, "reverb", kReverbParams, static_cast<int>(std::size(kReverbParams)) },
    { EffectType::delay, "delay", kDelayParams, static_cast<int>(std::size(kDelayParams)) },
    { EffectType::limiter, "limiter", kLimiterParams, static_cast<int>(std::size(kLimiterParams)) },
};

double dbToGain(double db) {
    return std::pow(10.0, db / 20.0);
}

void stepToward(float& value, float target, float step) {
    const float delta = target - value;
    value = delta > step ? value + step : (delta < -step ? value - step : target);
}

// One-pole smoothing that lands exactly on the target once it is close.
void glide(double& value, double target, double coefficient, double snap) {
    value = target + (value - target) * coefficient;
    if (std::fabs(value - target) <= snap)
        value = target;
}

// ---- Parametric EQ ----------------------------------------------------------------------
// Coefficients come from juce::dsp::IIR::ArrayCoefficients (RBJ cookbook shelves and bell).
// ArrayCoefficients returns a std::array, so recomputing them while smoothing never allocates.
struct Biquad {
    double b0 = 1.0, b1 = 0.0, b2 = 0.0, a1 = 0.0, a2 = 0.0;
};

Biquad designBand(EqBandType type, double sampleRate, double centre, double gainDb, double q) {
    const double nyquistSafe = sampleRate * 0.49;
    const double f = std::clamp(centre, 10.0, nyquistSafe);
    const double quality = std::max(q, 0.05);
    const double gain = dbToGain(gainDb);
    std::array<double, 6> c {};
    using Coefficients = juce::dsp::IIR::ArrayCoefficients<double>;
    switch (type) {
        case EqBandType::lowShelf: c = Coefficients::makeLowShelf(sampleRate, f, quality, gain); break;
        case EqBandType::highShelf: c = Coefficients::makeHighShelf(sampleRate, f, quality, gain); break;
        case EqBandType::bell: c = Coefficients::makePeakFilter(sampleRate, f, quality, gain); break;
    }
    Biquad out;
    const double a0 = c[3];
    out.b0 = c[0] / a0;
    out.b1 = c[1] / a0;
    out.b2 = c[2] / a0;
    out.a1 = c[4] / a0;
    out.a2 = c[5] / a0;
    return out;
}

} // namespace (keep designBand helpers file-local below)

EqBandType eqBandTypeFromParam(float value) {
    const int index = static_cast<int>(std::lround(value));
    return index <= 0 ? EqBandType::lowShelf : (index >= 2 ? EqBandType::highShelf : EqBandType::bell);
}

namespace {

class EqDsp final : public EffectDsp {
public:
    EqDsp(double sampleRate, const EffectParams& params) {
        kind = EffectType::eq;
        rate = sampleRate;
        reset(params);
    }

    void reset(const EffectParams& params) override {
        for (int b = 0; b < kEqBands; ++b) {
            auto& band = bands[b];
            band.type = eqBandTypeFromParam(params[fx::eqBandType(b)]);
            band.freq = params[fx::eqBandFreq(b)];
            band.gain = params[fx::eqBandGain(b)];
            band.q = params[fx::eqBandQ(b)];
            band.coefficients = designBand(band.type, rate, band.freq, band.gain, band.q);
            std::memset(band.z1, 0, sizeof(band.z1));
            std::memset(band.z2, 0, sizeof(band.z2));
        }
        output = static_cast<float>(dbToGain(params[fx::eqOutput]));
        smoothing = false;
        counter = 0;
    }

    float process(const EffectParams& params, float* left, float* right, int numSamples) override {
        bool changed = false;
        for (int b = 0; b < kEqBands; ++b) {
            auto& band = bands[b];
            const auto type = eqBandTypeFromParam(params[fx::eqBandType(b)]);
            if (type != band.type) {
                band.type = type;
                band.coefficients = designBand(band.type, rate, band.freq, band.gain, band.q);
            }
            band.targetFreq = params[fx::eqBandFreq(b)];
            band.targetGain = params[fx::eqBandGain(b)];
            band.targetQ = params[fx::eqBandQ(b)];
            changed = changed || band.targetFreq != band.freq || band.targetGain != band.gain || band.targetQ != band.q;
        }
        smoothing = smoothing || changed;
        const float outputTarget = static_cast<float>(dbToGain(params[fx::eqOutput]));
        const float outputStep = static_cast<float>(4.0 / (0.010 * rate));
        for (int i = 0; i < numSamples; ++i) {
            if (smoothing && (counter % kUpdateInterval) == 0)
                smoothStep();
            ++counter;
            double x[2] = { left[i], right[i] };
            for (int b = 0; b < kEqBands; ++b) {
                auto& band = bands[b];
                const bool enabled = params[fx::eqBandEnabled(b)] >= 0.5f;
                if (!enabled || (band.gain == 0.0 && band.targetGain == 0.0)) {
                    // Bypassed or 0 dB: exact pass-through; clear state so re-enable starts clean.
                    band.z1[0] = band.z1[1] = band.z2[0] = band.z2[1] = 0.0;
                    continue;
                }
                const auto& k = band.coefficients;
                for (int ch = 0; ch < 2; ++ch) {
                    const double y = k.b0 * x[ch] + band.z1[ch];
                    band.z1[ch] = k.b1 * x[ch] - k.a1 * y + band.z2[ch];
                    band.z2[ch] = k.b2 * x[ch] - k.a2 * y;
                    x[ch] = y;
                }
            }
            stepToward(output, outputTarget, outputStep);
            left[i] = static_cast<float>(x[0]) * output;
            right[i] = static_cast<float>(x[1]) * output;
        }
        return 0.0f;
    }

private:
    static constexpr int kUpdateInterval = 32;

    void smoothStep() {
        // About 10 ms to settle at 48 kHz: each update covers 32 samples.
        const double coefficient = std::exp(-static_cast<double>(kUpdateInterval) / (0.003 * rate));
        bool moving = false;
        for (auto& band : bands) {
            if (band.freq == band.targetFreq && band.gain == band.targetGain && band.q == band.targetQ)
                continue;
            double logFreq = std::log(band.freq);
            glide(logFreq, std::log(band.targetFreq), coefficient, 1.0e-5);
            band.freq = logFreq == std::log(band.targetFreq) ? band.targetFreq : std::exp(logFreq);
            glide(band.gain, band.targetGain, coefficient, 1.0e-4);
            double logQ = std::log(band.q);
            glide(logQ, std::log(band.targetQ), coefficient, 1.0e-5);
            band.q = logQ == std::log(band.targetQ) ? band.targetQ : std::exp(logQ);
            band.coefficients = designBand(band.type, rate, band.freq, band.gain, band.q);
            moving = moving || band.freq != band.targetFreq || band.gain != band.targetGain || band.q != band.targetQ;
        }
        smoothing = moving;
    }

    struct Band {
        EqBandType type = EqBandType::bell;
        double freq = 1000.0, gain = 0.0, q = 1.0;
        double targetFreq = 1000.0, targetGain = 0.0, targetQ = 1.0;
        Biquad coefficients;
        double z1[2] {};
        double z2[2] {};
    };
    Band bands[kEqBands];
    float output = 1.0f;
    bool smoothing = false;
    uint64_t counter = 0;
};

// Soft-knee gain computer (shared by CompressorDsp and transfer-curve API).
// knee == 0 → hard knee (identical to Phase ≤ 2.8.3).
double computeCompressorReduction(double levelDb, double threshold, double ratio, double knee) {
    const double slope = 1.0 - 1.0 / std::max(1.0, ratio);
    const double over = levelDb - threshold;
    const double width = std::max(0.0, knee);
    if (width <= 1.0e-9)
        return over > 0.0 ? over * slope : 0.0;
    const double half = width * 0.5;
    if (over <= -half)
        return 0.0;
    if (over >= half)
        return over * slope;
    const double x = over + half;
    return slope * x * x / (2.0 * width);
}

// ---- Compressor --------------------------------------------------------------------------
// Feed-forward, stereo-linked peak detector. The gain computer works in dB with an optional
// soft knee (additive `knee` param; default 0 = hard knee / legacy). Above the knee region,
// every dB of input becomes 1/ratio dB of output. Gain reduction is smoothed with separate
// attack and release time constants. Makeup is one-pole smoothed (~3 ms).
class CompressorDsp final : public EffectDsp {
public:
    CompressorDsp(double sampleRate, const EffectParams& params) {
        kind = EffectType::compressor;
        rate = sampleRate;
        reset(params);
    }

    void reset(const EffectParams& params) override {
        reduction = 0.0;
        makeup = params[fx::compMakeup];
    }

    float process(const EffectParams& params, float* left, float* right, int numSamples) override {
        const double threshold = params[fx::compThreshold];
        const double ratio = std::max(1.0, static_cast<double>(params[fx::compRatio]));
        const double knee = std::max(0.0, static_cast<double>(params[fx::compKnee]));
        const double attack = std::exp(-1.0 / (std::max(0.0001, params[fx::compAttack] * 0.001) * rate));
        const double release = std::exp(-1.0 / (std::max(0.001, params[fx::compRelease] * 0.001) * rate));
        const double makeupTarget = params[fx::compMakeup];
        const double makeupCoefficient = std::exp(-1.0 / (0.003 * rate));
        double most = 0.0;
        for (int i = 0; i < numSamples; ++i) {
            double l = static_cast<double>(left[i]);
            double r = static_cast<double>(right[i]);
            if (!std::isfinite(l)) l = 0.0;
            if (!std::isfinite(r)) r = 0.0;
            const double level = std::max(std::fabs(l), std::fabs(r));
            const double levelDb = level > 1.0e-9 ? 20.0 * std::log10(level) : -180.0;
            const double wanted = computeCompressorReduction(levelDb, threshold, ratio, knee);
            const double coefficient = wanted > reduction ? attack : release;
            reduction = wanted + (reduction - wanted) * coefficient;
            if (!std::isfinite(reduction) || reduction < 0.0)
                reduction = 0.0;
            glide(makeup, makeupTarget, makeupCoefficient, 1.0e-6);
            const double gain = dbToGain(makeup - reduction);
            const float g = std::isfinite(gain) ? static_cast<float>(gain) : 0.0f;
            left[i] = static_cast<float>(l) * g;
            right[i] = static_cast<float>(r) * g;
            most = std::max(most, reduction);
        }
        return static_cast<float>(most);
    }

private:
    double reduction = 0.0;
    double makeup = 0.0;
};

// ---- Sample-peak limiter -----------------------------------------------------------------
// Stereo-linked feed-forward peak limiter. Ceiling is absolute sample peak (linear);
// no lookahead → this is NOT true-peak / inter-sample peak limiting. Attack/release
// smooth the gain envelope; latency is 0 samples.
class LimiterDsp final : public EffectDsp {
public:
    LimiterDsp(double sampleRate, const EffectParams& params) {
        kind = EffectType::limiter;
        rate = sampleRate;
        reset(params);
    }

    void reset(const EffectParams& params) override {
        (void) params;
        gain = 1.0;
    }

    float process(const EffectParams& params, float* left, float* right, int numSamples) override {
        const double ceilingDb = std::min(0.0, static_cast<double>(params[fx::limCeiling]));
        const double ceiling = dbToGain(ceilingDb);
        const double attack = std::exp(-1.0 / (std::max(1.0e-5, params[fx::limAttack] * 0.001) * rate));
        const double release = std::exp(-1.0 / (std::max(0.0005, params[fx::limRelease] * 0.001) * rate));
        double most = 0.0;
        for (int i = 0; i < numSamples; ++i) {
            double l = static_cast<double>(left[i]);
            double r = static_cast<double>(right[i]);
            if (!std::isfinite(l)) l = 0.0;
            if (!std::isfinite(r)) r = 0.0;
            const double peak = std::max(std::fabs(l), std::fabs(r));
            const double wanted = (peak > ceiling && peak > 1.0e-12) ? (ceiling / peak) : 1.0;
            const double coefficient = wanted < gain ? attack : release;
            gain = wanted + (gain - wanted) * coefficient;
            if (!std::isfinite(gain) || gain < 0.0)
                gain = 0.0;
            else if (gain > 1.0)
                gain = 1.0;
            left[i] = static_cast<float>(l * gain);
            right[i] = static_cast<float>(r * gain);
            const double reductionDb = gain < 1.0 - 1.0e-12
                ? -20.0 * std::log10(std::max(gain, 1.0e-12))
                : 0.0;
            most = std::max(most, reductionDb);
        }
        return static_cast<float>(most);
    }

private:
    double gain = 1.0;
};

// ---- Noise gate --------------------------------------------------------------------------
// The detector follows the stereo peak with a 25 ms decay so it does not drop between the
// peaks of low notes. The gate opens at the threshold and closes only after the detector
// falls 6 dB below it (hysteresis) and the hold time has passed. Gain moves linearly: from
// closed to open in `attack`, from open to closed in `release`.
class GateDsp final : public EffectDsp {
public:
    GateDsp(double sampleRate, const EffectParams& params) {
        kind = EffectType::gate;
        rate = sampleRate;
        reset(params);
    }

    void reset(const EffectParams& params) override {
        envelope = 0.0;
        open = false;
        holdLeft = 0;
        gain = static_cast<float>(dbToGain(params[fx::gateRange]));
    }

    float process(const EffectParams& params, float* left, float* right, int numSamples) override {
        const double openLevel = dbToGain(params[fx::gateThreshold]);
        const double closeLevel = dbToGain(params[fx::gateThreshold] - kGateHysteresisDb);
        const float floor = static_cast<float>(dbToGain(params[fx::gateRange]));
        const float span = 1.0f - floor;
        const float attackStep = span / static_cast<float>(std::max(1.0, params[fx::gateAttack] * 0.001 * rate));
        const float releaseStep = span / static_cast<float>(std::max(1.0, params[fx::gateRelease] * 0.001 * rate));
        const int64_t holdSamples = static_cast<int64_t>(std::llround(params[fx::gateHold] * 0.001 * rate));
        const double decay = std::exp(-1.0 / (0.025 * rate));
        float most = 0.0f;
        for (int i = 0; i < numSamples; ++i) {
            const double level = std::max(std::fabs(static_cast<double>(left[i])), std::fabs(static_cast<double>(right[i])));
            envelope = std::max(level, envelope * decay);
            if (envelope >= openLevel) {
                open = true;
                holdLeft = holdSamples;
            } else if (open && envelope >= closeLevel) {
                holdLeft = holdSamples;
            } else if (open) {
                if (holdLeft > 0)
                    --holdLeft;
                else
                    open = false;
            }
            if (open)
                gain = std::min(1.0f, gain + attackStep);
            else if (gain > floor)
                gain = std::max(floor, gain - releaseStep);
            else
                gain = std::min(floor, gain + attackStep);   // the range was raised while closed: ramp up, do not jump
            left[i] *= gain;
            right[i] *= gain;
            const float reductionDb = gain > 0.0f ? -20.0f * std::log10(gain) : 120.0f;
            most = std::max(most, reductionDb);
        }
        return most;
    }

private:
    double envelope = 0.0;
    bool open = false;
    int64_t holdLeft = 0;
    float gain = 0.0f;
};

// ---- Reverb ------------------------------------------------------------------------------
// juce::Reverb (Freeverb: 8 parallel combs and 4 allpasses per channel). Its comb buffers are
// sized in setSampleRate(), which runs here on the control thread. Mix maps to dry = 1 - mix
// and wet = mix, using juce::Reverb's internal scale factors (dry x2, wet x3).
class ReverbDsp final : public EffectDsp {
public:
    ReverbDsp(double sampleRate, const EffectParams& params) {
        kind = EffectType::reverb;
        rate = sampleRate;
        apply(params);
        // setSampleRate() also jumps the parameter smoothers to the values just set.
        reverb.setSampleRate(sampleRate);
    }

    void reset(const EffectParams& params) override {
        reverb.reset();
        apply(params);
    }

    float process(const EffectParams& params, float* left, float* right, int numSamples) override {
        if (params[fx::reverbRoom] != applied[0] || params[fx::reverbDamping] != applied[1] || params[fx::reverbMix] != applied[2])
            apply(params);
        reverb.processStereo(left, right, numSamples);
        return 0.0f;
    }

private:
    void apply(const EffectParams& params) {
        juce::Reverb::Parameters p;
        p.roomSize = params[fx::reverbRoom];
        p.damping = params[fx::reverbDamping];
        p.wetLevel = params[fx::reverbMix] / 3.0f;
        p.dryLevel = (1.0f - params[fx::reverbMix]) / 2.0f;
        p.width = 1.0f;
        p.freezeMode = 0.0f;
        reverb.setParameters(p);
        applied[0] = params[fx::reverbRoom];
        applied[1] = params[fx::reverbDamping];
        applied[2] = params[fx::reverbMix];
    }

    juce::Reverb reverb;
    float applied[3] {};
};

// ---- Delay -------------------------------------------------------------------------------
// Stereo feedback delay with a buffer for kMaxDelaySeconds allocated up front. A delay time
// change crossfades from the old read position to the new one over 20 ms, so it neither clicks
// nor bends pitch. Feedback is limited to kMaxDelayFeedback, so echoes always decay.
// reset() is O(1): it forgets the history by counting how many samples were written since,
// and reads of older slots return silence, so the 2 s buffers are never cleared in a callback.
class DelayDsp final : public EffectDsp {
public:
    DelayDsp(double sampleRate, const EffectParams& params) {
        kind = EffectType::delay;
        rate = sampleRate;
        length = static_cast<int>(std::ceil(kMaxDelaySeconds * sampleRate)) + 4;
        bufferL.assign(static_cast<size_t>(length), 0.0f);
        bufferR.assign(static_cast<size_t>(length), 0.0f);
        reset(params);
    }

    void reset(const EffectParams& params) override {
        filled = 0;
        write = 0;
        delay = targetDelay(params);
        nextDelay = delay;
        fade = 0.0f;
        feedback = std::clamp(params[fx::delayFeedback], 0.0f, kMaxDelayFeedback);
        mix = std::clamp(params[fx::delayMix], 0.0f, 1.0f);
    }

    float process(const EffectParams& params, float* left, float* right, int numSamples) override {
        const double wantedDelay = targetDelay(params);
        const float wantedFeedback = std::clamp(params[fx::delayFeedback], 0.0f, kMaxDelayFeedback);
        const float wantedMix = std::clamp(params[fx::delayMix], 0.0f, 1.0f);
        const float step = static_cast<float>(1.0 / (0.010 * rate));
        const float fadeStep = static_cast<float>(1.0 / (0.020 * rate));
        for (int i = 0; i < numSamples; ++i) {
            const bool fading = nextDelay != delay;
            if (!fading && delay != wantedDelay) {
                nextDelay = wantedDelay;
                fade = 0.0f;
            }
            stepToward(feedback, wantedFeedback, step);
            stepToward(mix, wantedMix, step);
            float delayedL = 0.0f, delayedR = 0.0f;
            read(delay, delayedL, delayedR);
            if (nextDelay != delay) {
                float nextL = 0.0f, nextR = 0.0f;
                read(nextDelay, nextL, nextR);
                fade = std::min(1.0f, fade + fadeStep);
                delayedL += fade * (nextL - delayedL);
                delayedR += fade * (nextR - delayedR);
                if (fade >= 1.0f)
                    delay = nextDelay;
            }
            const float inL = left[i];
            const float inR = right[i];
            bufferL[static_cast<size_t>(write)] = inL + feedback * delayedL;
            bufferR[static_cast<size_t>(write)] = inR + feedback * delayedR;
            left[i] = inL * (1.0f - mix) + delayedL * mix;
            right[i] = inR * (1.0f - mix) + delayedR * mix;
            if (++write >= length)
                write = 0;
            if (filled < length)
                ++filled;
        }
        return 0.0f;
    }

private:
    // A slot holds valid history only if it was written since the last reset. The slot at
    // `write` is the oldest one (age = length).
    bool written(int slot) const {
        int age = write - slot;
        if (age <= 0)
            age += length;
        return age <= filled;
    }

    void read(double samplesBack, float& outL, float& outR) const {
        double readAt = static_cast<double>(write) - samplesBack;
        if (readAt < 0.0)
            readAt += length;
        const int i0 = std::min(static_cast<int>(readAt), length - 1);
        const int i1 = i0 + 1 >= length ? 0 : i0 + 1;
        const float frac = static_cast<float>(readAt - i0);
        const bool has0 = written(i0);
        const bool has1 = written(i1);
        const float l0 = has0 ? bufferL[static_cast<size_t>(i0)] : 0.0f;
        const float r0 = has0 ? bufferR[static_cast<size_t>(i0)] : 0.0f;
        const float l1 = has1 ? bufferL[static_cast<size_t>(i1)] : 0.0f;
        const float r1 = has1 ? bufferR[static_cast<size_t>(i1)] : 0.0f;
        outL = l0 + frac * (l1 - l0);
        outR = r0 + frac * (r1 - r0);
    }

    double targetDelay(const EffectParams& params) const {
        const double samples = std::clamp(static_cast<double>(params[fx::delayTime]), 1.0, kMaxDelaySeconds * 1000.0) * 0.001 * rate;
        return std::clamp(samples, 1.0, static_cast<double>(length - 2));
    }

    std::vector<float> bufferL;
    std::vector<float> bufferR;
    int length = 0;
    int write = 0;
    int filled = 0;           // samples written since reset(), at most length
    double delay = 1.0;
    double nextDelay = 1.0;
    float fade = 0.0f;
    float feedback = 0.0f;
    float mix = 0.0f;
};
} // namespace

const EffectSpec& effectSpec(EffectType type) {
    for (const auto& spec : kSpecs) {
        if (spec.type == type)
            return spec;
    }
    return kSpecs[0];
}

const char* effectTypeName(EffectType type) {
    return effectSpec(type).name;
}

bool effectTypeFromName(const std::string& name, EffectType& type) {
    for (const auto& spec : kSpecs) {
        if (name == spec.name) {
            type = spec.type;
            return true;
        }
    }
    return false;
}

int effectParamIndex(EffectType type, const std::string& name) {
    const auto& spec = effectSpec(type);
    for (int i = 0; i < spec.paramCount; ++i) {
        if (name == spec.params[i].name)
            return i;
    }
    return -1;
}

EffectParams defaultEffectParams(EffectType type) {
    EffectParams params {};
    const auto& spec = effectSpec(type);
    for (int i = 0; i < spec.paramCount; ++i)
        params[static_cast<size_t>(i)] = spec.params[i].defaultValue;
    return params;
}

std::vector<std::string> sanitizeEffectParams(EffectType type, EffectParams& params) {
    std::vector<std::string> changed;
    const auto& spec = effectSpec(type);
    for (int i = 0; i < kMaxEffectParams; ++i) {
        auto& value = params[static_cast<size_t>(i)];
        if (i >= spec.paramCount) {
            value = 0.0f;
            continue;
        }
        const auto& p = spec.params[i];
        float fixed = std::isfinite(value) ? std::clamp(value, p.minimum, p.maximum) : p.defaultValue;
        if (p.choice)
            fixed = static_cast<float>(std::lround(fixed));
        if (fixed != value)
            changed.push_back(p.name);
        value = fixed;
    }
    return changed;
}

ProjectEffect makeEffect(EffectType type, const std::string& id) {
    ProjectEffect effect;
    effect.id = id;
    effect.type = type;
    effect.enabled = true;
    effect.params = defaultEffectParams(type);
    return effect;
}

std::string checkTailSettings(const TailSettings& tail) {
    if (!(tail.maxSeconds >= 0.0 && tail.maxSeconds <= kMaxTailSeconds))
        return "Maximum tail length must be between 0 and 60 seconds.";
    if (!(tail.thresholdDb >= kMinTailThresholdDb && tail.thresholdDb <= kMaxTailThresholdDb))
        return "Tail silence threshold must be between -140 and -20 dBFS.";
    return {};
}

std::unique_ptr<EffectDsp> createEffectDsp(EffectType type, double sampleRate, const EffectParams& params) {
    switch (type) {
        case EffectType::eq: return std::make_unique<EqDsp>(sampleRate, params);
        case EffectType::compressor: return std::make_unique<CompressorDsp>(sampleRate, params);
        case EffectType::gate: return std::make_unique<GateDsp>(sampleRate, params);
        case EffectType::reverb: return std::make_unique<ReverbDsp>(sampleRate, params);
        case EffectType::delay: return std::make_unique<DelayDsp>(sampleRate, params);
        case EffectType::limiter: return std::make_unique<LimiterDsp>(sampleRate, params);
    }
    return nullptr;
}

double eqBandMagnitude(EqBandType type, double sampleRate, double centre, double gainDb, double q, double frequency) {
    const auto k = designBand(type, sampleRate, centre, gainDb, q);
    const double w = 2.0 * kPi * frequency / sampleRate;
    const double cos1 = std::cos(w), sin1 = std::sin(w), cos2 = std::cos(2.0 * w), sin2 = std::sin(2.0 * w);
    const double numRe = k.b0 + k.b1 * cos1 + k.b2 * cos2;
    const double numIm = -(k.b1 * sin1 + k.b2 * sin2);
    const double denRe = 1.0 + k.a1 * cos1 + k.a2 * cos2;
    const double denIm = -(k.a1 * sin1 + k.a2 * sin2);
    return std::sqrt((numRe * numRe + numIm * numIm) / (denRe * denRe + denIm * denIm));
}

double eqCompositeDb(const EffectParams& params, double sampleRate, double frequency) {
    double mag = 1.0;
    for (int b = 0; b < kEqBands; ++b) {
        if (params[fx::eqBandEnabled(b)] < 0.5f)
            continue;
        const double gainDb = params[fx::eqBandGain(b)];
        if (std::fabs(gainDb) < 1.0e-9)
            continue;
        mag *= eqBandMagnitude(eqBandTypeFromParam(params[fx::eqBandType(b)]), sampleRate,
                               params[fx::eqBandFreq(b)], gainDb, params[fx::eqBandQ(b)], frequency);
    }
    mag *= dbToGain(params[fx::eqOutput]);
    if (mag <= 1.0e-12)
        return -120.0;
    return 20.0 * std::log10(mag);
}

bool eqResponseCurve(const EffectParams& params, double sampleRate,
                     const double* hz, int count, double* outDb) {
    if (hz == nullptr || outDb == nullptr || count <= 0 || sampleRate <= 0.0)
        return false;
    for (int i = 0; i < count; ++i)
        outDb[i] = eqCompositeDb(params, sampleRate, hz[i]);
    return true;
}

double compressorGainReductionDb(const EffectParams& params, double inputDb) {
    if (!std::isfinite(inputDb))
        return 0.0;
    return computeCompressorReduction(inputDb,
                                      params[fx::compThreshold],
                                      std::max(1.0f, params[fx::compRatio]),
                                      std::max(0.0f, params[fx::compKnee]));
}

double compressorTransferDb(const EffectParams& params, double inputDb) {
    if (!std::isfinite(inputDb))
        return -120.0;
    return inputDb - compressorGainReductionDb(params, inputDb) + params[fx::compMakeup];
}

bool compressorTransferCurve(const EffectParams& params, const double* inDb, int count, double* outDb) {
    if (inDb == nullptr || outDb == nullptr || count <= 0)
        return false;
    for (int i = 0; i < count; ++i)
        outDb[i] = compressorTransferDb(params, inDb[i]);
    return true;
}

double limiterGainReductionDb(const EffectParams& params, double inputDb) {
    if (!std::isfinite(inputDb))
        return 0.0;
    const double ceiling = params[fx::limCeiling];
    return inputDb > ceiling ? (inputDb - ceiling) : 0.0;
}

double limiterTransferDb(const EffectParams& params, double inputDb) {
    if (!std::isfinite(inputDb))
        return -120.0;
    return inputDb - limiterGainReductionDb(params, inputDb);
}

bool limiterTransferCurve(const EffectParams& params, const double* inDb, int count, double* outDb) {
    if (inDb == nullptr || outDb == nullptr || count <= 0)
        return false;
    for (int i = 0; i < count; ++i)
        outDb[i] = limiterTransferDb(params, inDb[i]);
    return true;
}

} // namespace msp
