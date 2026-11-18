#pragma once

#include <atomic>
#include <cstdint>
#include <functional>
#include <string>
#include <vector>

namespace msp {

// Offline pitch-preserving time stretch (phase vocoder). Changes duration; does not resample
// afterward (unlike pitchShift). Conservative ratio range for vocal timing edits.
inline constexpr double kTimeStretchMinRatio = 0.75;
inline constexpr double kTimeStretchMaxRatio = 1.25;

struct TimeStretchResult {
    std::string error;
    bool cancelled = false;
    bool identity = false;
    std::vector<float> left;
    std::vector<float> right;       // empty for mono
    double ratio = 1.0;
    int64_t inputFrames = 0;
    int64_t outputFrames = 0;
    int64_t repairedSamples = 0;
    double inputPeak = 0.0;
    double outputPeak = 0.0;
    double gainReductionDb = 0.0;
};

std::string checkTimeStretch(double ratio, double sampleRate, int channels);

// Stretches by `ratio` (output_duration ≈ input_duration * ratio). Lead/tail context frames are
// analysed then cropped so the returned region aligns with the caller's region of interest.
TimeStretchResult timeStretch(const float* left, const float* right, int64_t frames, int channels,
                              double sampleRate, double ratio,
                              int64_t lead = 0, int64_t tail = 0,
                              const std::atomic<bool>* cancel = nullptr,
                              const std::function<void(double)>& progress = {});

// Piecewise stretch of contiguous segments so warp destination lengths replace source lengths.
// `breaks` are strictly increasing sample indices inside the region [lead, frames-tail), including
// the region start and end. `destLengths` has breaks.size()-1 positive lengths. Total dest length
// may differ from the source region. Short crossfades join segments.
struct WarpBreak {
    int64_t source = 0;
    int64_t destLength = 0;   // length of the segment that starts at this break (ignored on last)
};

TimeStretchResult timeWarpSegments(const float* left, const float* right, int64_t frames, int channels,
                                   double sampleRate, const std::vector<int64_t>& sourceBreaks,
                                   const std::vector<int64_t>& destLengths,
                                   int64_t lead = 0, int64_t tail = 0,
                                   const std::atomic<bool>* cancel = nullptr,
                                   const std::function<void(double)>& progress = {});

} // namespace msp
