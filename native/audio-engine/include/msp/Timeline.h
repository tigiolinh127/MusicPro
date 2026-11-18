#pragma once

#include "msp/BreathSilence.h"
#include "msp/Timing.h"

#include <cstdint>
#include <string>
#include <vector>

namespace msp {

// A manual target note for one detected note segment of a clip. It applies only to the clip with
// this id while that clip plays `sourceFileId`, and only to a segment found at the same source
// time with the same original note, so it never attaches to another clip or segment.
struct NoteTarget {
    std::string clipId;
    std::string sourceFileId;
    double sourceStart = 0.0;   // seconds in the source file
    double sourceEnd = 0.0;
    double originalMidi = 0.0;  // the segment's median pitch when the override was made
    int targetMidi = 60;
};

// Phase 2.8.2 — mathematically defined fade / crossfade curves.
enum class FadeCurve {
    linear = 0,
    equalPower = 1,
    sCurve = 2
};

const char* fadeCurveName(FadeCurve curve);
FadeCurve fadeCurveFromName(const std::string& name, bool* ok = nullptr);
float shapeFadeIn(float t, FadeCurve curve);
float shapeFadeOut(float t, FadeCurve curve);

struct Clip {
    std::string id;
    std::string sourceFileId;
    int64_t timelineStart = 0;
    int64_t sourceOffset = 0;
    int64_t duration = 0;
    float gain = 1.0f;
    int64_t fadeIn = 0;
    int64_t fadeOut = 0;
    FadeCurve fadeInCurve = FadeCurve::linear;
    FadeCurve fadeOutCurve = FadeCurve::linear;
    // Linked crossfade metadata (optional). Envelope is still fadeIn/fadeOut — no second gain path.
    std::string crossfadePartnerId;
    FadeCurve crossfadeCurve = FadeCurve::linear;
    int64_t crossfadeDuration = 0;
    // Set while the clip plays pitch-processed audio: the source it was processed from, the offset
    // in that source where the processed audio begins, and the total shift in cents.
    std::string originalSourceFileId;
    int64_t originalSourceOffset = 0;
    double pitchShiftCents = 0.0;
    std::string pitchLabel;                 // what produced the processed audio, for display
    std::vector<NoteTarget> noteTargets;   // manual target overrides; playback ignores them
    // Phase 2.6.2: timing markers + provenance after a timing apply (comp clips only).
    std::vector<TimingMarker> timingMarkers;
    std::string timingOriginalSourceFileId;
    int64_t timingOriginalSourceOffset = 0;
    int64_t timingOriginalDuration = 0;
    std::string timingLabel;
    // Phase 2.6.3: breath/silence regions + provenance after apply (comp clips only).
    // Positions refer to the clip's current audible source (post-timing if applied).
    std::vector<BreathRegion> breathRegions;
    std::string breathOriginalSourceFileId;
    int64_t breathOriginalSourceOffset = 0;
    int64_t breathOriginalDuration = 0;
    std::string breathLabel;
    // Phase 2.8.1: clip time stretch / speed (comp clips). Duration changes with processing.
    // stretchMode: "timeStretch" (pitch preserve) or "speed" (pitch follows).
    std::string stretchMode;
    double stretchRatio = 1.0; // duration ratio or speed multiplier depending on mode
    std::string stretchOriginalSourceFileId;
    int64_t stretchOriginalSourceOffset = 0;
    int64_t stretchOriginalDuration = 0;
    std::string stretchLabel;
};

struct SourceSpan {
    std::string id;
    const float* left = nullptr;
    const float* right = nullptr;
    int64_t length = 0;
    bool missing = false;
};

struct WavePeaks {
    std::vector<float> minimum;
    std::vector<float> maximum;
    std::string error;
};

int64_t scaleSamples(int64_t samples, double fromRate, double toRate);
float fadeEnvelope(int64_t index, int64_t duration, int64_t fadeIn, int64_t fadeOut,
                   FadeCurve fadeInCurve = FadeCurve::linear,
                   FadeCurve fadeOutCurve = FadeCurve::linear);
int64_t arrangementLength(const std::vector<Clip>& clips);
std::string validateClip(const Clip& clip, int64_t sourceLength);
const SourceSpan* findSource(const std::vector<SourceSpan>& sources, const std::string& id);

void renderArrangement(const std::vector<Clip>& clips,
                       const std::vector<SourceSpan>& sources,
                       std::vector<float>& left,
                       std::vector<float>& right);

std::string splitClip(std::vector<Clip>& clips,
                      const std::string& clipId,
                      int64_t position,
                      const std::string& newId,
                      int64_t sourceLength);
std::string moveClip(std::vector<Clip>& clips, const std::string& clipId, int64_t timelineStart);
std::string trimClip(std::vector<Clip>& clips,
                     const std::string& clipId,
                     bool leftEdge,
                     int64_t edgeSample,
                     int64_t sourceLength);
std::string deleteClip(std::vector<Clip>& clips, const std::string& clipId);
std::string duplicateClip(std::vector<Clip>& clips,
                          const std::string& clipId,
                          int64_t timelineStart,
                          const std::string& newId,
                          int64_t sourceLength);
std::string setClipGain(std::vector<Clip>& clips, const std::string& clipId, float gain);
std::string setClipFades(std::vector<Clip>& clips, const std::string& clipId, int64_t fadeIn, int64_t fadeOut,
                         const FadeCurve* fadeInCurve = nullptr, const FadeCurve* fadeOutCurve = nullptr);

WavePeaks buildPeaks(const float* left,
                     const float* right,
                     int64_t length,
                     int64_t start,
                     int64_t end,
                     int buckets);

} // namespace msp
