#pragma once

#include "msp/Timeline.h"

#include <cstdint>
#include <string>
#include <vector>

namespace msp {

inline constexpr double kDefaultAutoCrossfadeMs = 20.0;
inline constexpr double kMaxCrossfadeMs = 5000.0;

struct CrossfadePair {
    std::string leftClipId;
    std::string rightClipId;
    int64_t overlapStart = 0;   // timeline samples
    int64_t overlapEnd = 0;
    int64_t overlapSamples = 0;
};

// Neighbor overlaps and exact abuts (overlapSamples == 0).
std::vector<CrossfadePair> findClipOverlaps(const std::vector<Clip>& clips);

// Complementary fadeOut (left) / fadeIn (right). Duration clamped to overlap (if any)
// and half of each clip. Sample-accurate; non-destructive (metadata + envelopes only).
std::string applyCrossfadePair(std::vector<Clip>& clips,
                               const std::string& leftClipId,
                               const std::string& rightClipId,
                               int64_t durationSamples,
                               FadeCurve curve);

std::string clearCrossfadePair(std::vector<Clip>& clips,
                               const std::string& leftClipId,
                               const std::string& rightClipId);

// Drop partner metadata when clips no longer touch; does not change fade lengths.
void reconcileCrossfadeLinks(std::vector<Clip>& clips);

// Optional auto-crossfade for every overlapping/abutting neighbor pair.
std::string applyAutoCrossfades(std::vector<Clip>& clips, int64_t defaultDurationSamples, FadeCurve curve);

} // namespace msp
