#include "msp/Timeline.h"

#include <algorithm>
#include <cmath>

namespace msp {
namespace {
Clip* findClip(std::vector<Clip>& clips, const std::string& id) {
    for (auto& clip : clips) {
        if (clip.id == id)
            return &clip;
    }
    return nullptr;
}

const Clip* findClipConst(const std::vector<Clip>& clips, const std::string& id) {
    for (const auto& clip : clips) {
        if (clip.id == id)
            return &clip;
    }
    return nullptr;
}
} // namespace

int64_t scaleSamples(int64_t samples, double fromRate, double toRate) {
    if (samples <= 0 || fromRate <= 0.0 || toRate <= 0.0)
        return std::max<int64_t>(0, samples);
    if (std::abs(fromRate - toRate) < 0.5)
        return samples;
    return std::max<int64_t>(0, std::llround(static_cast<double>(samples) * toRate / fromRate));
}

const char* fadeCurveName(FadeCurve curve) {
    switch (curve) {
        case FadeCurve::equalPower: return "equalPower";
        case FadeCurve::sCurve: return "sCurve";
        case FadeCurve::linear:
        default: return "linear";
    }
}

FadeCurve fadeCurveFromName(const std::string& name, bool* ok) {
    if (name.empty() || name == "linear") {
        if (ok) *ok = true;
        return FadeCurve::linear;
    }
    if (name == "equalPower" || name == "equal-power" || name == "eqpower") {
        if (ok) *ok = true;
        return FadeCurve::equalPower;
    }
    if (name == "sCurve" || name == "s-curve" || name == "scurve") {
        if (ok) *ok = true;
        return FadeCurve::sCurve;
    }
    if (ok) *ok = false;
    return FadeCurve::linear;
}

float shapeFadeIn(float t, FadeCurve curve) {
    t = std::clamp(t, 0.0f, 1.0f);
    switch (curve) {
        case FadeCurve::equalPower:
            // sin(π/2 · t): complementary cos fade-out → constant power for uncorrelated signals
            return std::sin(1.5707963267948966f * t);
        case FadeCurve::sCurve:
            return t * t * (3.0f - 2.0f * t); // smoothstep
        case FadeCurve::linear:
        default:
            return t;
    }
}

float shapeFadeOut(float t, FadeCurve curve) {
    // t = progress through fade-out (0 at start of fade-out, 1 at clip end)
    t = std::clamp(t, 0.0f, 1.0f);
    switch (curve) {
        case FadeCurve::equalPower:
            return std::cos(1.5707963267948966f * t);
        case FadeCurve::sCurve: {
            const float u = 1.0f - t;
            return u * u * (3.0f - 2.0f * u);
        }
        case FadeCurve::linear:
        default:
            return 1.0f - t;
    }
}

float fadeEnvelope(int64_t index, int64_t duration, int64_t fadeIn, int64_t fadeOut,
                   FadeCurve fadeInCurve, FadeCurve fadeOutCurve) {
    if (duration <= 0 || index < 0 || index >= duration)
        return 0.0f;
    float gain = 1.0f;
    if (fadeIn > 0 && index < fadeIn) {
        const float t = static_cast<float>(index) / static_cast<float>(fadeIn);
        gain *= shapeFadeIn(t, fadeInCurve);
    }
    if (fadeOut > 0 && index >= duration - fadeOut) {
        const int64_t into = index - (duration - fadeOut);
        const float t = static_cast<float>(into) / static_cast<float>(fadeOut);
        gain *= shapeFadeOut(t, fadeOutCurve);
    }
    return std::clamp(gain, 0.0f, 1.0f);
}

int64_t arrangementLength(const std::vector<Clip>& clips) {
    int64_t end = 0;
    for (const auto& clip : clips)
        end = std::max(end, clip.timelineStart + std::max<int64_t>(0, clip.duration));
    return end;
}

std::string validateClip(const Clip& clip, int64_t sourceLength) {
    if (clip.id.empty())
        return "A clip needs an id.";
    if (clip.sourceFileId.empty())
        return "A clip needs a source file.";
    if (clip.timelineStart < 0 || clip.sourceOffset < 0 || clip.duration <= 0)
        return "Clip position and duration must stay inside the timeline, and duration must be positive.";
    if (clip.fadeIn < 0 || clip.fadeOut < 0 || clip.fadeIn > clip.duration || clip.fadeOut > clip.duration)
        return "Fade length cannot be negative or longer than the clip.";
    if (!std::isfinite(clip.gain) || clip.gain < 0.0f || clip.gain > 4.0f)
        return "Clip gain must be between 0 and 4.";
    if (sourceLength >= 0 && clip.sourceOffset + clip.duration > sourceLength)
        return "That edit would read past the end of the source WAV.";
    return {};
}

const SourceSpan* findSource(const std::vector<SourceSpan>& sources, const std::string& id) {
    for (const auto& source : sources) {
        if (source.id == id)
            return &source;
    }
    return nullptr;
}

void renderArrangement(const std::vector<Clip>& clips,
                       const std::vector<SourceSpan>& sources,
                       std::vector<float>& left,
                       std::vector<float>& right) {
    const int64_t frames = arrangementLength(clips);
    left.assign(static_cast<size_t>(frames), 0.0f);
    right.assign(static_cast<size_t>(frames), 0.0f);
    for (const auto& clip : clips) {
        if (clip.duration <= 0 || clip.timelineStart < 0)
            continue;
        const auto* source = findSource(sources, clip.sourceFileId);
        const bool audible = source != nullptr && !source->missing && source->left != nullptr && source->right != nullptr;
        for (int64_t index = 0; index < clip.duration; ++index) {
            const int64_t destination = clip.timelineStart + index;
            if (destination < 0 || destination >= frames)
                continue;
            const int64_t sourceIndex = clip.sourceOffset + index;
            if (!audible || sourceIndex < 0 || sourceIndex >= source->length)
                continue;
            const float gain = clip.gain * fadeEnvelope(index, clip.duration, clip.fadeIn, clip.fadeOut,
                                                        clip.fadeInCurve, clip.fadeOutCurve);
            left[static_cast<size_t>(destination)] += source->left[sourceIndex] * gain;
            right[static_cast<size_t>(destination)] += source->right[sourceIndex] * gain;
        }
    }
}

std::string splitClip(std::vector<Clip>& clips,
                      const std::string& clipId,
                      int64_t position,
                      const std::string& newId,
                      int64_t sourceLength) {
    auto* clip = findClip(clips, clipId);
    if (clip == nullptr)
        return "No clip is selected.";
    if (newId.empty() || findClip(clips, newId) != nullptr)
        return "The new clip id is missing or already used.";
    if (position <= clip->timelineStart || position >= clip->timelineStart + clip->duration)
        return "The playhead is not inside that clip.";
    const int64_t leftDuration = position - clip->timelineStart;
    Clip left = *clip;
    Clip right = *clip;
    right.id = newId;
    right.timelineStart = position;
    right.sourceOffset = clip->sourceOffset + leftDuration;
    right.duration = clip->duration - leftDuration;
    right.fadeIn = std::min(right.fadeIn, right.duration);
    left.duration = leftDuration;
    left.fadeOut = std::min(left.fadeOut, left.duration);
    const auto leftError = validateClip(left, sourceLength);
    const auto rightError = validateClip(right, sourceLength);
    if (!leftError.empty() || !rightError.empty())
        return leftError.empty() ? rightError : leftError;
    *clip = left;
    clips.push_back(right);
    return {};
}

std::string moveClip(std::vector<Clip>& clips, const std::string& clipId, int64_t timelineStart) {
    auto* clip = findClip(clips, clipId);
    if (clip == nullptr)
        return "No clip is selected.";
    if (timelineStart < 0)
        return "A clip cannot move before the start of the timeline.";
    clip->timelineStart = timelineStart;
    return {};
}

std::string trimClip(std::vector<Clip>& clips,
                     const std::string& clipId,
                     bool leftEdge,
                     int64_t edgeSample,
                     int64_t sourceLength) {
    auto* clip = findClip(clips, clipId);
    if (clip == nullptr)
        return "No clip is selected.";
    const int64_t end = clip->timelineStart + clip->duration;
    Clip next = *clip;
    if (leftEdge) {
        if (edgeSample < 0)
            edgeSample = 0;
        if (edgeSample <= clip->timelineStart || edgeSample >= end)
            return "The left trim must stay inside the clip.";
        const int64_t delta = edgeSample - clip->timelineStart;
        next.timelineStart = edgeSample;
        next.sourceOffset += delta;
        next.duration -= delta;
    } else {
        const int64_t available = sourceLength >= 0 ? sourceLength - clip->sourceOffset : clip->duration;
        if (edgeSample <= clip->timelineStart || edgeSample > clip->timelineStart + std::max<int64_t>(0, available))
            return "The right trim is outside the available source audio.";
        next.duration = edgeSample - clip->timelineStart;
    }
    next.fadeIn = std::min(next.fadeIn, next.duration);
    next.fadeOut = std::min(next.fadeOut, next.duration);
    const auto error = validateClip(next, sourceLength);
    if (!error.empty())
        return error;
    *clip = next;
    return {};
}

std::string deleteClip(std::vector<Clip>& clips, const std::string& clipId) {
    const auto sizeBefore = clips.size();
    clips.erase(std::remove_if(clips.begin(), clips.end(), [&](const Clip& clip) { return clip.id == clipId; }), clips.end());
    if (clips.size() == sizeBefore)
        return "No clip is selected.";
    return {};
}

std::string duplicateClip(std::vector<Clip>& clips,
                          const std::string& clipId,
                          int64_t timelineStart,
                          const std::string& newId,
                          int64_t sourceLength) {
    const auto* clip = findClipConst(clips, clipId);
    if (clip == nullptr)
        return "No clip is selected.";
    Clip copy = *clip;
    copy.id = newId;
    copy.timelineStart = timelineStart;
    const auto error = validateClip(copy, sourceLength);
    if (!error.empty())
        return error;
    clips.push_back(copy);
    return {};
}

std::string setClipGain(std::vector<Clip>& clips, const std::string& clipId, float gain) {
    auto* clip = findClip(clips, clipId);
    if (clip == nullptr)
        return "No clip is selected.";
    if (!std::isfinite(gain) || gain < 0.0f || gain > 4.0f)
        return "Clip gain must be between 0 and 4.";
    clip->gain = gain;
    return {};
}

std::string setClipFades(std::vector<Clip>& clips, const std::string& clipId, int64_t fadeIn, int64_t fadeOut,
                         const FadeCurve* fadeInCurve, const FadeCurve* fadeOutCurve) {
    auto* clip = findClip(clips, clipId);
    if (clip == nullptr)
        return "No clip is selected.";
    if (fadeIn < 0 || fadeOut < 0 || fadeIn > clip->duration || fadeOut > clip->duration)
        return "Fade length cannot be negative or longer than the clip.";
    clip->fadeIn = fadeIn;
    clip->fadeOut = fadeOut;
    if (fadeInCurve != nullptr)
        clip->fadeInCurve = *fadeInCurve;
    if (fadeOutCurve != nullptr)
        clip->fadeOutCurve = *fadeOutCurve;
    return {};
}

WavePeaks buildPeaks(const float* left,
                     const float* right,
                     int64_t length,
                     int64_t start,
                     int64_t end,
                     int buckets) {
    WavePeaks peaks;
    if (buckets < 1 || buckets > 2048) {
        peaks.error = "Waveform bucket count must be between 1 and 2048.";
        return peaks;
    }
    if (start < 0)
        start = 0;
    if (end < start)
        end = start;
    peaks.minimum.assign(static_cast<size_t>(buckets), 0.0f);
    peaks.maximum.assign(static_cast<size_t>(buckets), 0.0f);
    if (left == nullptr || right == nullptr || length <= 0 || end == start)
        return peaks;
    const double span = static_cast<double>(end - start);
    for (int bucket = 0; bucket < buckets; ++bucket) {
        const int64_t bucketStart = start + static_cast<int64_t>(std::floor(span * bucket / buckets));
        const int64_t bucketEnd = start + static_cast<int64_t>(std::floor(span * (bucket + 1) / buckets));
        float minimum = 0.0f;
        float maximum = 0.0f;
        const int64_t first = std::clamp(bucketStart, static_cast<int64_t>(0), length);
        const int64_t last = std::clamp(std::max(bucketEnd, bucketStart + 1), static_cast<int64_t>(0), length);
        for (int64_t index = first; index < last; ++index) {
            const float sample = std::max(left[index], right[index]);
            const float low = std::min(left[index], right[index]);
            minimum = std::min(minimum, low);
            maximum = std::max(maximum, sample);
        }
        peaks.minimum[static_cast<size_t>(bucket)] = minimum;
        peaks.maximum[static_cast<size_t>(bucket)] = maximum;
    }
    return peaks;
}

} // namespace msp
