#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace msp {

// Timing marker on a comp clip. Positions are session-rate samples in the clip's current source
// (same domain as Clip::sourceOffset / duration). Detected markers are suggestions; manual ones
// are user-authored. Timing edits attach to comp clips (not takes) — only clips play/export.
struct TimingMarker {
    std::string id;
    int64_t sourceSample = 0;
    bool manual = false;
};

inline constexpr double kDefaultTimingCrossfadeMs = 3.0;

std::string validateTimingMarker(const TimingMarker& marker, int64_t sourceOffset, int64_t duration);
void sortTimingMarkers(std::vector<TimingMarker>& markers);
// Removes markers within `minSeparation` samples of a stronger/earlier neighbour.
void dedupeTimingMarkers(std::vector<TimingMarker>& markers, int64_t minSeparation);

} // namespace msp
