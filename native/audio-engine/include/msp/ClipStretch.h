#pragma once

#include "msp/TimeStretch.h"

#include <atomic>
#include <cstdint>
#include <functional>
#include <string>
#include <vector>

namespace msp {

// Phase 2.8.1 — clip-level duration/speed controls.
// Duration ratio = output_duration / original_duration (0.5 = half length, 2.0 = double).
// Speed multiplier: 2.0 = twice as fast → half duration; pitch follows speed (resample).
inline constexpr double kClipDurationRatioMin = 0.5;
inline constexpr double kClipDurationRatioMax = 2.0;
inline constexpr double kClipSpeedMin = 0.5;
inline constexpr double kClipSpeedMax = 2.0;

enum class ClipStretchMode {
    timeStretch, // pitch-preserving (phase vocoder, multi-pass within validated 0.75–1.25)
    speed        // pitch changes with rate (resample)
};

std::string clipStretchModeName(ClipStretchMode mode);
ClipStretchMode clipStretchModeFromName(const std::string& name, bool* ok = nullptr);

std::string checkClipDurationRatio(double ratio);
std::string checkClipSpeed(double speed);

// Expected output frames for a duration ratio (time stretch) or speed multiplier.
int64_t expectedFramesForDurationRatio(int64_t inputFrames, double durationRatio);
int64_t expectedFramesForSpeed(int64_t inputFrames, double speed);

// Pitch-preserving stretch over [kClipDurationRatioMin, kClipDurationRatioMax].
// Single-pass uses msp::timeStretch when ratio is inside [0.75, 1.25]. Outside that
// validated window, chains multiple passes — does not widen the vocoder's single-pass range.
TimeStretchResult timeStretchClip(const float* left, const float* right, int64_t frames, int channels,
                                  double sampleRate, double durationRatio,
                                  const std::atomic<bool>* cancel = nullptr,
                                  const std::function<void(double)>& progress = {});

// Speed change via resampling (pitch follows). Identity when |speed-1| < 1e-9.
TimeStretchResult speedChangeClip(const float* left, const float* right, int64_t frames, int channels,
                                  double sampleRate, double speed,
                                  const std::atomic<bool>* cancel = nullptr);

} // namespace msp
