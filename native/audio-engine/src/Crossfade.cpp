#include "msp/Crossfade.h"

#include <algorithm>

namespace msp {
namespace {

Clip* findMutable(std::vector<Clip>& clips, const std::string& id) {
    for (auto& clip : clips) {
        if (clip.id == id)
            return &clip;
    }
    return nullptr;
}

bool clipsTouch(const Clip& left, const Clip& right) {
    const int64_t leftEnd = left.timelineStart + left.duration;
    const int64_t rightEnd = right.timelineStart + right.duration;
    // Ordered as left then right by start; still valid if swapped.
    return !(right.timelineStart >= leftEnd || left.timelineStart >= rightEnd);
}

} // namespace

std::vector<CrossfadePair> findClipOverlaps(const std::vector<Clip>& clips) {
    std::vector<const Clip*> ordered;
    ordered.reserve(clips.size());
    for (const auto& clip : clips)
        ordered.push_back(&clip);
    std::sort(ordered.begin(), ordered.end(), [](const Clip* a, const Clip* b) {
        if (a->timelineStart != b->timelineStart)
            return a->timelineStart < b->timelineStart;
        return a->id < b->id;
    });
    std::vector<CrossfadePair> pairs;
    for (size_t i = 0; i + 1 < ordered.size(); ++i) {
        const Clip* left = ordered[i];
        const Clip* right = ordered[i + 1];
        const int64_t leftEnd = left->timelineStart + left->duration;
        const int64_t rightStart = right->timelineStart;
        const int64_t rightEnd = right->timelineStart + right->duration;
        if (rightStart > leftEnd)
            continue;
        CrossfadePair pair;
        pair.leftClipId = left->id;
        pair.rightClipId = right->id;
        pair.overlapStart = rightStart;
        pair.overlapEnd = std::min(leftEnd, rightEnd);
        pair.overlapSamples = std::max<int64_t>(0, pair.overlapEnd - pair.overlapStart);
        pairs.push_back(pair);
    }
    return pairs;
}

std::string applyCrossfadePair(std::vector<Clip>& clips,
                               const std::string& leftClipId,
                               const std::string& rightClipId,
                               int64_t durationSamples,
                               FadeCurve curve) {
    auto* left = findMutable(clips, leftClipId);
    auto* right = findMutable(clips, rightClipId);
    if (left == nullptr || right == nullptr)
        return "Both clips must exist on the track for a crossfade.";
    if (left->id == right->id)
        return "A clip cannot crossfade with itself.";
    if (durationSamples < 0)
        return "Crossfade duration cannot be negative.";

    // Ensure left is the earlier clip by timeline start.
    if (right->timelineStart < left->timelineStart)
        std::swap(left, right);

    const int64_t leftEnd = left->timelineStart + left->duration;
    const int64_t rightStart = right->timelineStart;
    if (rightStart > leftEnd)
        return "Those clips do not touch or overlap — move them together before crossfading.";

    const int64_t overlap = std::max<int64_t>(0, std::min(leftEnd, right->timelineStart + right->duration) - rightStart);
    int64_t duration = durationSamples;
    if (overlap > 0)
        duration = std::min(duration, overlap);
    duration = std::min({ duration, left->duration / 2, right->duration / 2 });
    if (durationSamples > 0 && duration <= 0)
        return "The overlap is too short for a crossfade. Lengthen the overlap or reduce the duration.";
    if (duration < 0)
        duration = 0;

    left->fadeOut = duration;
    right->fadeIn = duration;
    left->fadeOutCurve = curve;
    right->fadeInCurve = curve;
    left->crossfadePartnerId = right->id;
    right->crossfadePartnerId = left->id;
    left->crossfadeCurve = curve;
    right->crossfadeCurve = curve;
    left->crossfadeDuration = duration;
    right->crossfadeDuration = duration;
    return {};
}

std::string clearCrossfadePair(std::vector<Clip>& clips,
                               const std::string& leftClipId,
                               const std::string& rightClipId) {
    auto* left = findMutable(clips, leftClipId);
    auto* right = findMutable(clips, rightClipId);
    if (left == nullptr || right == nullptr)
        return "Both clips must exist to clear a crossfade.";
    if (left->crossfadePartnerId == right->id) {
        left->fadeOut = 0;
        left->crossfadePartnerId.clear();
        left->crossfadeDuration = 0;
        left->crossfadeCurve = FadeCurve::linear;
        left->fadeOutCurve = FadeCurve::linear;
    }
    if (right->crossfadePartnerId == left->id) {
        right->fadeIn = 0;
        right->crossfadePartnerId.clear();
        right->crossfadeDuration = 0;
        right->crossfadeCurve = FadeCurve::linear;
        right->fadeInCurve = FadeCurve::linear;
    }
    return {};
}

void reconcileCrossfadeLinks(std::vector<Clip>& clips) {
    for (auto& clip : clips) {
        if (clip.crossfadePartnerId.empty())
            continue;
        const auto* partner = static_cast<const Clip*>(nullptr);
        for (const auto& other : clips) {
            if (other.id == clip.crossfadePartnerId) {
                partner = &other;
                break;
            }
        }
        if (partner == nullptr || !clipsTouch(clip, *partner)
            || partner->crossfadePartnerId != clip.id) {
            clip.crossfadePartnerId.clear();
            clip.crossfadeDuration = 0;
            clip.crossfadeCurve = FadeCurve::linear;
        }
    }
}

std::string applyAutoCrossfades(std::vector<Clip>& clips, int64_t defaultDurationSamples, FadeCurve curve) {
    if (defaultDurationSamples < 0)
        return "Auto-crossfade duration cannot be negative.";
    reconcileCrossfadeLinks(clips);
    const auto pairs = findClipOverlaps(clips);
    for (const auto& pair : pairs) {
        int64_t duration = defaultDurationSamples;
        if (pair.overlapSamples > 0)
            duration = std::min(duration, pair.overlapSamples);
        // Skip vanishing overlaps (< 2 samples) when a positive default was requested.
        if (defaultDurationSamples > 0 && pair.overlapSamples > 0 && pair.overlapSamples < 2)
            continue;
        if (duration <= 0 && pair.overlapSamples == 0)
            duration = defaultDurationSamples;
        const auto error = applyCrossfadePair(clips, pair.leftClipId, pair.rightClipId, duration, curve);
        if (!error.empty() && pair.overlapSamples >= 2)
            return error;
    }
    return {};
}

} // namespace msp
