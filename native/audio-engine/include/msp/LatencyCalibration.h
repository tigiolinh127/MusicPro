#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace msp {

// Result of a cross-correlation delay estimate between a known reference pulse and a recording.
// delaySamples > 0 means the recorded signal lags the reference (recording arrived late).
struct LatencyEstimate {
    int64_t delaySamples = 0;
    double delayMs = 0.0;
    double peakCorrelation = 0.0;   // normalized |r| at the chosen lag, 0…1
    double confidence = 0.0;        // 0…1 quality score (peak sharpness × correlation)
    bool reliable = false;          // true only when confidence clears the product threshold
    std::string message;
};

// Cross-correlate `recorded` against `reference` for lags in [-maxLag, +maxLag] samples.
// Uses the mono mix of each buffer (L, or (L+R)/2 when stereo). No heap beyond the working
// vectors allocated by the caller-facing wrapper; safe on the control thread only.
LatencyEstimate estimateLatencySamples(const float* reference, size_t referenceFrames,
                                       const float* recorded, size_t recordedFrames,
                                       double sampleRate, int64_t maxLagSamples);

// Convenience: estimate from interleaved or planar stereo by mixing to mono first.
LatencyEstimate estimateLatencyMono(const std::vector<float>& reference,
                                    const std::vector<float>& recorded,
                                    double sampleRate, double maxLagMs = 500.0);

// Convert milliseconds ↔ samples at a rate. Round to nearest sample; clamp offsetMs to ±maxMs.
int64_t recordingOffsetSamples(double offsetMs, double sampleRate, double maxMs = 500.0);
double recordingOffsetMsFromSamples(int64_t samples, double sampleRate);

// Device-profile key for persisting offsets (output + input + rate + buffer).
std::string recordingLatencyProfileKey(const std::string& outputDevice,
                                       const std::string& inputDevice,
                                       int sampleRate, int bufferSize);

} // namespace msp
