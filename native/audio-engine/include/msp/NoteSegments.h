#pragma once

#include "msp/Pitch.h"
#include "msp/Timeline.h"

#include <string>
#include <vector>

namespace msp {

// Groups stable voiced YIN frames into note segments for target mapping and preview. Reads the
// frames only; they are never changed. A heuristic: it is not a perfect transcription of singing.
struct SegmentParams {
    int minFrames = 5;              // segments with fewer voiced frames are dropped
    int maxGapFrames = 2;           // unvoiced runs up to this long are bridged inside a segment
    double splitSemitones = 0.7;    // a frame this far from the segment's recent median deviates
    int splitFrames = 3;            // this many consecutive deviating frames start a new segment
};

std::string checkSegmentParams(const SegmentParams& params);

struct NoteSegment {
    int index = 0;
    int firstFrame = 0;             // first and last voiced frames (inclusive)
    int lastFrame = 0;
    double start = 0.0;             // seconds from the start of the analysed audio
    double end = 0.0;
    int voicedFrames = 0;           // frames used for the pitch (glitch frames are excluded)
    double medianMidi = 0.0;        // fractional
    double medianFrequency = 0.0;
    double confidence = 0.0;        // mean of the used frames
};

std::vector<NoteSegment> segmentPitch(const std::vector<PitchFrame>& frames, double hopSeconds,
                                      const SegmentParams& params = {});

// Overrides match a segment when clip id and source agree, both segment edges (in source seconds)
// lie within `toleranceSeconds`, and the original pitch differs by at most half a semitone.
inline constexpr double kOverridePitchTolerance = 0.5;
bool overrideMatches(const NoteTarget& target, const std::string& clipId, const std::string& sourceFileId,
                     double sourceStart, double sourceEnd, double medianMidi, double toleranceSeconds);

struct OverrideMatch {
    std::vector<int> segmentOverride;   // per segment: index into the overrides, or -1
    std::vector<bool> matched;          // per override: attached to a segment
};

// `sourceOffsetSeconds` converts segment times to source seconds. When several overrides match a
// segment, the last one wins; each override attaches to at most one segment.
OverrideMatch matchOverrides(const std::vector<NoteTarget>& targets, const std::string& clipId, const std::string& sourceFileId,
                             const std::vector<NoteSegment>& segments, double sourceOffsetSeconds, double toleranceSeconds);

} // namespace msp
