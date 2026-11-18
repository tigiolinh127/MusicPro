#include "msp/Timing.h"

#include <algorithm>

namespace msp {

std::string validateTimingMarker(const TimingMarker& marker, int64_t sourceOffset, int64_t duration) {
    if (marker.id.empty())
        return "A timing marker needs an id.";
    if (duration <= 0)
        return "The clip has no length for timing markers.";
    if (marker.sourceSample < sourceOffset || marker.sourceSample > sourceOffset + duration)
        return "A timing marker must lie inside the clip.";
    return {};
}

void sortTimingMarkers(std::vector<TimingMarker>& markers) {
    std::sort(markers.begin(), markers.end(), [](const TimingMarker& a, const TimingMarker& b) {
        if (a.sourceSample != b.sourceSample)
            return a.sourceSample < b.sourceSample;
        if (a.manual != b.manual)
            return a.manual && !b.manual;   // manual wins ties for stable user edits
        return a.id < b.id;
    });
}

void dedupeTimingMarkers(std::vector<TimingMarker>& markers, int64_t minSeparation) {
    if (markers.empty())
        return;
    sortTimingMarkers(markers);
    std::vector<TimingMarker> kept;
    kept.reserve(markers.size());
    for (const auto& marker : markers) {
        if (!kept.empty() && marker.sourceSample - kept.back().sourceSample < std::max<int64_t>(1, minSeparation)) {
            if (marker.manual && !kept.back().manual)
                kept.back() = marker;
            continue;
        }
        kept.push_back(marker);
    }
    markers = std::move(kept);
}

} // namespace msp
