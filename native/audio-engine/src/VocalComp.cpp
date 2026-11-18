#include "msp/VocalComp.h"

#include <algorithm>

namespace msp {
namespace {

Clip* findById(std::vector<Clip>& clips, const std::string& id) {
    for (auto& clip : clips)
        if (clip.id == id)
            return &clip;
    return nullptr;
}

void sortClips(std::vector<Clip>& clips) {
    std::sort(clips.begin(), clips.end(), [](const Clip& a, const Clip& b) {
        if (a.timelineStart != b.timelineStart)
            return a.timelineStart < b.timelineStart;
        return a.id < b.id;
    });
}

void applyAbuttingFades(std::vector<Clip>& clips, int64_t crossfade) {
    if (crossfade <= 0 || clips.size() < 2)
        return;
    sortClips(clips);
    for (size_t i = 0; i + 1 < clips.size(); ++i) {
        auto& left = clips[i];
        auto& right = clips[i + 1];
        if (left.timelineStart + left.duration != right.timelineStart)
            continue;
        const int64_t fade = std::min({ crossfade, left.duration / 2, right.duration / 2 });
        if (fade <= 0)
            continue;
        left.fadeOut = fade;
        right.fadeIn = fade;
    }
}

} // namespace

std::string cutCompHole(std::vector<Clip>& clips,
                        int64_t start,
                        int64_t end,
                        const FreshIdFn& freshId,
                        const SourceLengthFn& sourceLengthOf) {
    if (end <= start)
        return "The comp region must have a positive length.";
    if (freshId == nullptr || sourceLengthOf == nullptr)
        return "Internal error: missing clip helpers.";
    std::vector<Clip> next;
    next.reserve(clips.size() + 2);
    for (const auto& clip : clips) {
        const int64_t clipEnd = clip.timelineStart + clip.duration;
        if (clipEnd <= start || clip.timelineStart >= end) {
            next.push_back(clip);
            continue;
        }
        if (clip.timelineStart < start) {
            Clip left = clip;
            left.duration = start - clip.timelineStart;
            left.fadeOut = std::min(left.fadeOut, left.duration);
            left.fadeIn = std::min(left.fadeIn, left.duration);
            const auto error = validateClip(left, sourceLengthOf(left.sourceFileId));
            if (!error.empty())
                return error;
            next.push_back(left);
        }
        if (clipEnd > end) {
            Clip right = clip;
            right.id = freshId();
            const int64_t skip = end - clip.timelineStart;
            right.timelineStart = end;
            right.sourceOffset = clip.sourceOffset + skip;
            right.duration = clipEnd - end;
            right.fadeIn = std::min(right.fadeIn, right.duration);
            right.fadeOut = std::min(right.fadeOut, right.duration);
            const auto error = validateClip(right, sourceLengthOf(right.sourceFileId));
            if (!error.empty())
                return error;
            next.push_back(right);
        }
    }
    clips = std::move(next);
    return {};
}

std::string setCompRegion(std::vector<Clip>& clips,
                          const Take& take,
                          int64_t regionStart,
                          int64_t regionEnd,
                          int64_t crossfade,
                          const std::string& newClipId,
                          const FreshIdFn& freshId,
                          const SourceLengthFn& sourceLengthOf) {
    if (take.id.empty() || take.sourceFileId.empty())
        return "That take is missing.";
    if (regionEnd <= regionStart)
        return "The comp region must have a positive length.";
    if (regionStart < 0)
        return "A comp region cannot start before the timeline.";
    if (newClipId.empty() || findById(clips, newClipId) != nullptr)
        return "The new clip id is missing or already used.";
    if (freshId == nullptr || sourceLengthOf == nullptr)
        return "Internal error: missing clip helpers.";

    const int64_t sourcePlayLength = sourceLengthOf(take.sourceFileId);
    if (sourcePlayLength <= 0)
        return "The take's audio source is missing or empty.";

    const int64_t takeEnd = take.timelineStart + take.duration;
    if (regionStart < take.timelineStart || regionEnd > takeEnd)
        return "The selected region must lie inside the take.";

    const int64_t sourceOffset = regionStart - take.timelineStart;
    if (sourceOffset < 0 || sourceOffset + (regionEnd - regionStart) > sourcePlayLength)
        return "The selected region does not fit inside the take's audio.";

    const auto holeError = cutCompHole(clips, regionStart, regionEnd, freshId, sourceLengthOf);
    if (!holeError.empty())
        return holeError;

    Clip clip;
    clip.id = newClipId;
    clip.sourceFileId = take.sourceFileId;
    clip.timelineStart = regionStart;
    clip.sourceOffset = sourceOffset;
    clip.duration = regionEnd - regionStart;
    const int64_t fade = std::max<int64_t>(0, std::min({ crossfade, clip.duration / 2 }));
    clip.fadeIn = fade;
    clip.fadeOut = fade;
    const auto error = validateClip(clip, sourcePlayLength);
    if (!error.empty())
        return error;
    clips.push_back(clip);
    applyAbuttingFades(clips, std::max<int64_t>(0, crossfade));
    sortClips(clips);
    return {};
}

} // namespace msp
