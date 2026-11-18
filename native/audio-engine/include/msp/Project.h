#pragma once

#include "msp/Automation.h"
#include "msp/BreathSilence.h"
#include "msp/Effects.h"
#include "msp/Scale.h"
#include "msp/Timeline.h"
#include "msp/Timing.h"
#include "msp/VocalComp.h"
#include "msp/VocalPresets.h"

#include <string>
#include <vector>

namespace msp {

struct ProjectClip {
    std::string id;
    std::string sourceFileId;
    int64_t timelineStart = 0;
    int64_t sourceOffset = 0;
    int64_t duration = 0;
    int64_t fadeIn = 0;
    int64_t fadeOut = 0;
    std::string fadeInCurve;   // empty = linear (backward compatible)
    std::string fadeOutCurve;
    std::string crossfadePartnerId;
    std::string crossfadeCurve;
    int64_t crossfadeDuration = 0;
    float gain = 1.0f;
    std::string originalSourceFileId;   // optional: pitch-processed clips only
    int64_t originalSourceOffset = 0;
    double pitchShiftCents = 0.0;
    std::string pitchLabel;               // optional, only with originalSourceFileId
    std::vector<NoteTarget> noteTargets;  // optional
    // Phase 2.6.2 optional timing fields (still project version 6 — additive).
    std::vector<TimingMarker> timingMarkers;
    std::string timingOriginalSourceFileId;
    int64_t timingOriginalSourceOffset = 0;
    int64_t timingOriginalDuration = 0;
    std::string timingLabel;
    // Phase 2.6.3 optional breath/silence fields (still project version 6 — additive).
    std::vector<BreathRegion> breathRegions;
    std::string breathOriginalSourceFileId;
    int64_t breathOriginalSourceOffset = 0;
    int64_t breathOriginalDuration = 0;
    std::string breathLabel;
    // Phase 2.8.1 optional stretch/speed fields (still project version 6 — additive).
    std::string stretchMode;
    double stretchRatio = 1.0;
    std::string stretchOriginalSourceFileId;
    int64_t stretchOriginalSourceOffset = 0;
    int64_t stretchOriginalDuration = 0;
    std::string stretchLabel;
};

struct ProjectSource {
    std::string id;
    std::string path;
};

constexpr const char* kMasterBusId = "master";
// v6 adds optional vocal take lanes + comp crossfade settings per track (backward compatible).
constexpr int kCurrentProjectVersion = 6;

struct ProjectTake {
    std::string id;
    std::string name;
    std::string sourceFileId;
    int64_t timelineStart = 0;
    int64_t duration = 0;
    bool muted = false;
};

enum class BusKind { group, ret };

struct ProjectSend {
    std::string bus;
    float level = 1.0f;
    bool preFader = false;
};

struct ProjectBus {
    std::string id;
    std::string name;
    BusKind kind = BusKind::group;
    float gain = 1.0f;
    bool mute = false;
    bool solo = false;
    std::string output = kMasterBusId;
    std::vector<ProjectEffect> effects;
    std::vector<AutomationLane> automation;   // "volume" and effect parameters
};

// Which input channels a track records: input 1 or 2 (mono), or 1 and 2 as a stereo pair.
enum class RecordInput { first, second, stereo };
// Dry records the raw input. Processed records the input after the track's insert effects.
enum class RecordMode { dry, processed, both };

const char* recordInputName(RecordInput input);
bool recordInputFromName(const std::string& name, RecordInput& input);
const char* recordModeName(RecordMode mode);
bool recordModeFromName(const std::string& name, RecordMode& mode);

struct ProjectTrack {
    std::string id;
    std::string name;
    std::string path;
    float gain = 1.0f;
    float pan = 0.0f;
    bool mute = false;
    bool solo = false;
    bool explicitClips = false;
    std::vector<ProjectClip> clips;
    std::vector<ProjectSource> extras;
    std::string output = kMasterBusId;
    std::vector<ProjectSend> sends;
    std::vector<ProjectEffect> effects;
    std::vector<AutomationLane> automation;   // "volume", "pan" and effect parameters
    bool armed = false;
    RecordInput recordInput = RecordInput::first;
    RecordMode recordMode = RecordMode::dry;
    bool monitorInput = false;
    std::vector<ProjectTake> takes;           // optional (v6+); empty on older projects
    bool takesExpanded = false;
    double compCrossfadeMs = kDefaultCompCrossfadeMs;
    // Phase 2.8.2 optional auto-crossfade (still project version 6 — additive).
    bool autoCrossfadeEnabled = false;
    double autoCrossfadeMs = 20.0;
    std::string autoCrossfadeCurve; // empty = linear
    // Phase 2.6.4 optional vocal preset state (still project version 6 — additive).
    std::string vocalPresetId;
    bool vocalPresetBypassed = false;
    std::vector<ProjectEffect> vocalPresetPrevious; // chain before last Apply (for Revert)
};

struct ProjectData {
    int version = 1;
    float masterGain = 1.0f;
    bool monitorEnabled = false;
    double sampleRate = 48000.0;
    int bufferSize = 512;
    std::string outputDevice;
    std::string inputDevice;
    // Phase 2.9.1 additive identity (still project version 6).
    std::string projectId;    // stable UUID; generated when missing
    std::string projectName;  // display name; empty → Untitled
    std::vector<ProjectTrack> tracks;
    std::vector<ProjectBus> buses;
    std::vector<ProjectEffect> masterEffects;
    std::vector<AutomationLane> masterAutomation;   // master effect parameters
    TailSettings renderTail;              // optional "renderTail" object; older files use the defaults
    PitchMapping pitchMapping;            // optional "pitchMapping" object; older files use the defaults
    // Optional custom vocal presets (factory presets are never stored; they live in code).
    std::vector<VocalPresetDefinition> customVocalPresets;
    std::vector<std::string> warnings;
    std::string error;
};

const char* busKindName(BusKind kind);

// Fresh dashed UUID for new / recovered project identity.
std::string makeProjectId();

ProjectData loadProjectFile(const std::string& path);
// Atomic write: temp file in the same folder, then replace. Validates JSON parse of payload first.
std::string saveProjectFile(const std::string& path, const ProjectData& project);

} // namespace msp
