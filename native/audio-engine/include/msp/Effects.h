#pragma once

#include <array>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace msp {

enum class EffectType { eq, compressor, gate, reverb, delay, limiter };

constexpr int kMaxEffectParams = 21; // Phase 2.8.3: +4 EQ band enable flags (additive)
constexpr int kMaxEffectsPerChain = 8;
constexpr int kEqBands = 4;
constexpr double kMaxDelaySeconds = 2.0;
constexpr float kMaxDelayFeedback = 0.95f;
constexpr float kGateHysteresisDb = 6.0f;

enum class EqBandType { lowShelf = 0, bell = 1, highShelf = 2 };

struct EffectParamSpec {
    const char* name;
    float minimum;
    float maximum;
    float defaultValue;
    bool choice;   // integer index (EQ band type)
};

struct EffectSpec {
    EffectType type;
    const char* name;
    const EffectParamSpec* params;
    int paramCount;
};

using EffectParams = std::array<float, kMaxEffectParams>;

const EffectSpec& effectSpec(EffectType type);
const char* effectTypeName(EffectType type);
bool effectTypeFromName(const std::string& name, EffectType& type);
int effectParamIndex(EffectType type, const std::string& name);
EffectParams defaultEffectParams(EffectType type);
// Clamps every parameter into its range, rounds choices, and replaces non-finite values with
// the default. Returns the names of parameters that had to be changed.
std::vector<std::string> sanitizeEffectParams(EffectType type, EffectParams& params);

struct ProjectEffect {
    std::string id;
    EffectType type = EffectType::eq;
    bool enabled = true;
    EffectParams params {};
};

// How playback and export render reverb and delay tails after the last clip. Saved with the project.
constexpr double kMaxTailSeconds = 60.0;
constexpr double kMinTailThresholdDb = -140.0;
constexpr double kMaxTailThresholdDb = -20.0;
struct TailSettings {
    bool enabled = true;
    double maxSeconds = 10.0;
    double thresholdDb = -90.0;
};
// Returns an error for out-of-range values, or an empty string.
std::string checkTailSettings(const TailSettings& tail);

ProjectEffect makeEffect(EffectType type, const std::string& id);

// Parameter indexes used by the DSP code.
namespace fx {
constexpr int eqBandType(int band) { return band * 4; }
constexpr int eqBandFreq(int band) { return band * 4 + 1; }
constexpr int eqBandGain(int band) { return band * 4 + 2; }
constexpr int eqBandQ(int band) { return band * 4 + 3; }
constexpr int eqOutput = 16;
constexpr int eqBandEnabled(int band) { return 17 + band; } // 1 = on, 0 = bypass (additive, default 1)

constexpr int compThreshold = 0;
constexpr int compRatio = 1;
constexpr int compAttack = 2;
constexpr int compRelease = 3;
constexpr int compMakeup = 4;
constexpr int compKnee = 5; // dB soft knee width; 0 = hard knee (legacy / default)

constexpr int limCeiling = 0;
constexpr int limRelease = 1;
constexpr int limAttack = 2;

constexpr int gateThreshold = 0;
constexpr int gateAttack = 1;
constexpr int gateHold = 2;
constexpr int gateRelease = 3;
constexpr int gateRange = 4;

constexpr int reverbRoom = 0;
constexpr int reverbDamping = 1;
constexpr int reverbMix = 2;

constexpr int delayTime = 0;
constexpr int delayFeedback = 1;
constexpr int delayMix = 2;
} // namespace fx

// One prepared effect processor. prepare() runs on the control thread and does every
// allocation. reset() and process() are realtime-safe: no allocation, locks, or I/O.
class EffectDsp {
public:
    virtual ~EffectDsp() = default;
    EffectType type() const { return kind; }
    double sampleRate() const { return rate; }
    // Clears all audio history and jumps parameter smoothing to `params`.
    virtual void reset(const EffectParams& params) = 0;
    // Processes in place. Parameters may change between calls; they are smoothed inside.
    // Returns the largest gain reduction in dB during the block (0 for effects without one).
    virtual float process(const EffectParams& params, float* left, float* right, int numSamples) = 0;

protected:
    EffectType kind = EffectType::eq;
    double rate = 48000.0;
};

std::unique_ptr<EffectDsp> createEffectDsp(EffectType type, double sampleRate, const EffectParams& params);

// Linear magnitude of one EQ band at `frequency`, from the same coefficients the DSP uses.
double eqBandMagnitude(EqBandType type, double sampleRate, double centre, double gainDb, double q, double frequency);

// Composite EQ magnitude in dB at `frequency` (product of enabled bands × outputGain).
// Disabled bands (enabled < 0.5) and 0 dB bands are unity.
double eqCompositeDb(const EffectParams& params, double sampleRate, double frequency);

// Fills `outDb` for each frequency in `hz` (same length). Returns false on empty inputs.
bool eqResponseCurve(const EffectParams& params, double sampleRate,
                     const double* hz, int count, double* outDb);

// Steady-state compressor gain reduction in dB for a mono peak at `inputDb` (matches CompressorDsp
// gain computer including soft knee). Makeup is not included.
double compressorGainReductionDb(const EffectParams& params, double inputDb);

// Output level in dBFS for a steady input: inputDb - GR + makeup.
double compressorTransferDb(const EffectParams& params, double inputDb);

// Fills output dBFS for each input level in `inDb`. Returns false on empty inputs.
bool compressorTransferCurve(const EffectParams& params, const double* inDb, int count, double* outDb);

// Steady-state sample-peak limiter gain reduction for a mono peak at `inputDb` (ceiling only;
// attack/release are dynamic and not represented on the static curve).
double limiterGainReductionDb(const EffectParams& params, double inputDb);

double limiterTransferDb(const EffectParams& params, double inputDb);

bool limiterTransferCurve(const EffectParams& params, const double* inDb, int count, double* outDb);

} // namespace msp
