#include "msp/NoteSegments.h"

#include <algorithm>
#include <cmath>
#include <deque>

namespace msp {
namespace {
double median(std::vector<double> values) {
    if (values.empty())
        return 0.0;
    const size_t mid = values.size() / 2;
    std::nth_element(values.begin(), values.begin() + static_cast<std::ptrdiff_t>(mid), values.end());
    double result = values[mid];
    if (values.size() % 2 == 0) {
        std::nth_element(values.begin(), values.begin() + static_cast<std::ptrdiff_t>(mid) - 1, values.end());
        result = 0.5 * (result + values[mid - 1]);
    }
    return result;
}

struct Building {
    bool active = false;
    int first = 0;
    int last = 0;
    std::vector<int> used;                 // frame indices that set the pitch
    std::deque<double> recent;             // last accepted pitches, for the deviation test
    int gap = 0;
    std::vector<int> deviating;            // consecutive frames far from `recent`
};

constexpr size_t kRecentFrames = 15;
} // namespace

std::string checkSegmentParams(const SegmentParams& p) {
    if (p.minFrames < 1 || p.minFrames > 1000)
        return "The minimum segment length must be between 1 and 1000 frames.";
    if (p.maxGapFrames < 0 || p.maxGapFrames > 100)
        return "The bridged gap must be between 0 and 100 frames.";
    if (!std::isfinite(p.splitSemitones) || p.splitSemitones < 0.1 || p.splitSemitones > 12.0)
        return "The split distance must be between 0.1 and 12 semitones.";
    if (p.splitFrames < 1 || p.splitFrames > 100)
        return "The split confirmation must be between 1 and 100 frames.";
    return {};
}

std::vector<NoteSegment> segmentPitch(const std::vector<PitchFrame>& frames, double hopSeconds, const SegmentParams& params) {
    std::vector<NoteSegment> segments;
    if (!checkSegmentParams(params).empty() || !(hopSeconds > 0.0))
        return segments;
    auto pitchOf = [&](int k) { return midiFromFrequency(frames[static_cast<size_t>(k)].frequency); };
    Building b;

    auto close = [&]() {
        if (b.active && static_cast<int>(b.used.size()) >= params.minFrames) {
            NoteSegment s;
            s.index = static_cast<int>(segments.size());
            s.firstFrame = b.first;
            s.lastFrame = b.last;
            s.start = std::max(0.0, frames[static_cast<size_t>(b.first)].time - hopSeconds / 2.0);
            s.end = frames[static_cast<size_t>(b.last)].time + hopSeconds / 2.0;
            s.voicedFrames = static_cast<int>(b.used.size());
            std::vector<double> pitches, hz;
            double confidence = 0.0;
            for (const int k : b.used) {
                pitches.push_back(pitchOf(k));
                hz.push_back(frames[static_cast<size_t>(k)].frequency);
                confidence += frames[static_cast<size_t>(k)].confidence;
            }
            s.medianMidi = median(pitches);
            s.medianFrequency = median(hz);
            s.confidence = confidence / static_cast<double>(b.used.size());
            segments.push_back(s);
        }
        b = Building {};
    };
    auto open = [&](int k) {
        b.active = true;
        b.first = k;
        b.last = k;
        b.used.assign(1, k);
        b.recent.assign(1, pitchOf(k));
        b.gap = 0;
        b.deviating.clear();
    };

    for (int k = 0; k < static_cast<int>(frames.size()); ++k) {
        const auto& frame = frames[static_cast<size_t>(k)];
        const bool voiced = frame.voiced && frame.frequency > 0.0 && std::isfinite(frame.frequency);
        if (!voiced) {
            if (b.active && ++b.gap > params.maxGapFrames)
                close();
            continue;
        }
        if (!b.active) {
            open(k);
            continue;
        }
        b.gap = 0;
        const double pitch = pitchOf(k);
        const double reference = median(std::vector<double>(b.recent.begin(), b.recent.end()));
        if (std::fabs(pitch - reference) > params.splitSemitones) {
            b.deviating.push_back(k);
            if (static_cast<int>(b.deviating.size()) >= params.splitFrames) {
                const auto moved = b.deviating;
                close();
                open(moved.front());
                for (size_t i = 1; i < moved.size(); ++i) {
                    b.used.push_back(moved[i]);
                    b.recent.push_back(pitchOf(moved[i]));
                    b.last = moved[i];
                }
            }
            continue;
        }
        b.deviating.clear();
        b.used.push_back(k);
        b.last = k;
        b.recent.push_back(pitch);
        if (b.recent.size() > kRecentFrames)
            b.recent.pop_front();
    }
    close();
    return segments;
}

bool overrideMatches(const NoteTarget& target, const std::string& clipId, const std::string& sourceFileId,
                     double sourceStart, double sourceEnd, double medianMidi, double toleranceSeconds) {
    return target.clipId == clipId && target.sourceFileId == sourceFileId
        && std::fabs(target.sourceStart - sourceStart) <= toleranceSeconds
        && std::fabs(target.sourceEnd - sourceEnd) <= toleranceSeconds
        && std::fabs(target.originalMidi - medianMidi) <= kOverridePitchTolerance;
}

OverrideMatch matchOverrides(const std::vector<NoteTarget>& targets, const std::string& clipId, const std::string& sourceFileId,
                             const std::vector<NoteSegment>& segments, double sourceOffsetSeconds, double toleranceSeconds) {
    OverrideMatch out;
    out.segmentOverride.assign(segments.size(), -1);
    out.matched.assign(targets.size(), false);
    for (size_t s = 0; s < segments.size(); ++s) {
        const auto& segment = segments[s];
        for (int t = static_cast<int>(targets.size()) - 1; t >= 0; --t) {
            if (out.matched[static_cast<size_t>(t)])
                continue;
            if (overrideMatches(targets[static_cast<size_t>(t)], clipId, sourceFileId, sourceOffsetSeconds + segment.start,
                                sourceOffsetSeconds + segment.end, segment.medianMidi, toleranceSeconds)) {
                out.segmentOverride[s] = t;
                out.matched[static_cast<size_t>(t)] = true;
                break;
            }
        }
    }
    return out;
}

} // namespace msp
