#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace msp {

// Offline vocal onset suggestions (not phoneme-accurate). Uses short-time energy rises and
// spectral flux with an adaptive threshold, then merges nearby peaks.
struct OnsetSettings {
    double minSeparationMs = 40.0;   // merge window
    double sensitivity = 0.55;       // 0..1, higher = more markers
    double minLevelDb = -48.0;       // ignore frames quieter than this
};

struct OnsetResult {
    std::string error;
    std::vector<int64_t> samples;    // absolute sample indices in the analysed buffer
    int64_t repairedSamples = 0;
};

std::string checkOnsetSettings(const OnsetSettings& settings, double sampleRate, int channels);

// Analyses `frames` samples per channel. `right` may be null for mono. Does not modify input.
// Positions are absolute in the buffer (0 .. frames). Call outside the audio callback.
OnsetResult detectOnsets(const float* left, const float* right, int64_t frames, int channels,
                         double sampleRate, const OnsetSettings& settings = {});

} // namespace msp
