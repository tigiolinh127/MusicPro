#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace msp {

// Phase 2.6.3 — offline breath / silence region editing on comp clips.
// Detection is heuristic; candidates need manual review. Never modifies source WAVs.

enum class BreathKind { silence, breath, manual };

inline constexpr float kDefaultBreathGainDb = -6.0f;
inline constexpr float kDefaultSilenceGainDb = -40.0f;
inline constexpr float kBreathGainMinDb = -60.0f;
inline constexpr float kBreathGainMaxDb = 12.0f;
inline constexpr double kDefaultBreathFadeMs = 5.0;

struct BreathRegion {
    std::string id;
    int64_t sourceStart = 0;   // session-rate samples in the clip's current source
    int64_t sourceEnd = 0;     // exclusive
    BreathKind kind = BreathKind::manual;
    float confidence = 1.0f;   // 0..1 suggestion strength
    float gainDb = 0.0f;
    int64_t fadeIn = 0;        // session-rate samples
    int64_t fadeOut = 0;
    bool ignored = false;
    bool manual = false;
};

struct SilenceSettings {
    double thresholdDb = -40.0;     // absolute floor when adaptiveFloor is false
    double minDurationMs = 80.0;
    double hangMs = 40.0;           // hysteresis / hangover
    bool adaptiveFloor = true;
    double adaptiveMarginDb = 8.0;  // threshold = floor + margin when adaptive
};

struct BreathDetectSettings {
    double minDurationMs = 50.0;
    double maxDurationMs = 450.0;
    double minConfidence = 0.35;
    double silencePadMs = 30.0;     // prefer candidates near silence edges
};

struct SilenceDetectResult {
    std::string error;
    std::vector<std::pair<int64_t, int64_t>> regions; // [start, end) in buffer samples
    int64_t repairedSamples = 0;
    double noiseFloorDb = -90.0;
    double thresholdDb = -40.0;
};

struct BreathDetectResult {
    std::string error;
    struct Candidate {
        int64_t start = 0;
        int64_t end = 0;
        float confidence = 0.0f;
    };
    std::vector<Candidate> candidates;
    int64_t repairedSamples = 0;
};

const char* breathKindName(BreathKind kind);
BreathKind breathKindFromName(const std::string& name);

std::string checkSilenceSettings(const SilenceSettings& settings, double sampleRate, int channels);
std::string checkBreathDetectSettings(const BreathDetectSettings& settings, double sampleRate, int channels);
std::string validateBreathRegion(const BreathRegion& region, int64_t sourceOffset, int64_t duration);
std::string validateBreathGainDb(float gainDb);
void sortBreathRegions(std::vector<BreathRegion>& regions);
// Rejects overlapping non-ignored regions. Returns an error string or empty.
std::string checkBreathRegionOverlaps(const std::vector<BreathRegion>& regions);

// Offline silence detection on a mono/stereo buffer. Does not modify input.
SilenceDetectResult detectSilence(const float* left, const float* right, int64_t frames, int channels,
                                  double sampleRate, const SilenceSettings& settings = {});

// Conservative breath *candidates* (not reliable recognition). Frames that look broadband,
// weakly harmonic, and sit near silence edges score higher. Does not modify input.
BreathDetectResult detectBreathCandidates(const float* left, const float* right, int64_t frames, int channels,
                                          double sampleRate, const SilenceSettings& silence = {},
                                          const BreathDetectSettings& settings = {});

// Apply region gains into buffers (in place). Regions are in absolute source samples; `sourceOffset`
// is the buffer's absolute start. Uses raised-cosine fades; enforces a minimum fade (~3 ms) so
// gain steps never click. Ignored regions and 0 dB regions are skipped.
std::string applyBreathGains(float* left, float* right, int64_t frames, int channels,
                             double sampleRate, int64_t sourceOffset,
                             const std::vector<BreathRegion>& regions);

} // namespace msp
