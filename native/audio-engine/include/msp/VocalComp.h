#pragma once

#include "msp/Timeline.h"

#include <cstdint>
#include <functional>
#include <string>
#include <vector>

namespace msp {

// One recorded or imported vocal take. The WAV is referenced by sourceFileId (primary or extra).
// Take lanes are display/selection only — playback uses the track's clip list (the comp).
struct Take {
    std::string id;
    std::string name;
    std::string sourceFileId;
    int64_t timelineStart = 0;   // session-rate samples where the take starts on the timeline
    int64_t duration = 0;        // session-rate samples
    bool muted = false;          // lane display only; does not silence the comp
};

inline constexpr double kDefaultCompCrossfadeMs = 5.0;
inline constexpr double kMaxCompCrossfadeMs = 100.0;

using SourceLengthFn = std::function<int64_t(const std::string& sourceFileId)>;
using FreshIdFn = std::function<std::string()>;

// Clears [start, end) from `clips` (trim/split/delete overlapping clips).
std::string cutCompHole(std::vector<Clip>& clips,
                        int64_t start,
                        int64_t end,
                        const FreshIdFn& freshId,
                        const SourceLengthFn& sourceLengthOf);

// Clears the region, inserts a clip from `take`, and applies abutting complementary fades with
// neighbors (no overlap — no gain doubling). Crossfade is clamped to half each clip.
std::string setCompRegion(std::vector<Clip>& clips,
                          const Take& take,
                          int64_t regionStart,
                          int64_t regionEnd,
                          int64_t crossfade,
                          const std::string& newClipId,
                          const FreshIdFn& freshId,
                          const SourceLengthFn& sourceLengthOf);

} // namespace msp
