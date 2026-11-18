#pragma once

#include "msp/Mixer.h"
#include "msp/Project.h"
#include "msp/Routing.h"
#include "msp/Timeline.h"
#include "msp/VocalComp.h"
#include "msp/WavIO.h"

#include <functional>
#include <string>
#include <utility>
#include <vector>

namespace msp {

struct RetiredAudio {
    std::vector<std::vector<float>> chunks;
    std::string error;
    int index = -1;
    std::vector<std::string> warnings;
};

class Session {
public:
    struct Track {
        bool used = false;
        std::string id;
        std::string path;
        double sourceSampleRate = 0.0;
        int sourceChannels = 0;
        std::string name;
        std::vector<float> sourceLeft;
        std::vector<float> sourceRight;
        std::vector<float> sourcePlayLeft;
        std::vector<float> sourcePlayRight;
        std::vector<float> playLeft;
        std::vector<float> playRight;
        std::vector<Clip> clips;
        struct ExtraSource {
            std::string id;
            std::string path;
            double sampleRate = 0.0;
            int channels = 0;
            bool missing = false;
            bool preview = false;   // loaded only for a pitch preview: not saved, dropped when it ends
            std::string error;
            std::vector<float> originalLeft;
            std::vector<float> originalRight;
            std::vector<float> playLeft;
            std::vector<float> playRight;
        };
        std::vector<ExtraSource> extras;
        float gain = 1.0f;
        float pan = 0.0f;
        bool mute = false;
        bool solo = false;
        bool missing = false;
        std::string error;
        std::string output = kMasterBusId;
        std::vector<ProjectSend> sends;
        std::vector<ProjectEffect> effects;
        std::vector<AutomationLane> automation;
        bool armed = false;
        RecordInput recordInput = RecordInput::first;
        RecordMode recordMode = RecordMode::dry;
        bool monitorInput = false;
        std::vector<Take> takes;
        bool takesExpanded = false;
        int64_t compCrossfadeSamples = 0;   // 0 = use default ms at current playbackRate
        // Phase 2.8.2 optional auto-crossfade on move/trim (off by default).
        bool autoCrossfadeEnabled = false;
        double autoCrossfadeMs = 20.0;
        FadeCurve autoCrossfadeCurve = FadeCurve::linear;
        // Phase 2.6.4 vocal presets (effect-chain metadata only).
        std::string vocalPresetId;
        bool vocalPresetBypassed = false;
        std::vector<ProjectEffect> vocalPresetPrevious;
    };

    double playbackRate = 48000.0;
    float masterGain = 1.0f;
    bool monitor = false;
    // Phase 2.9.1 — stable identity for autosave / recovery (not the on-disk path).
    std::string projectId = makeProjectId();
    std::string projectName = "Untitled";
    Clock clock;
    float lastPeakL = 0.0f;
    float lastPeakR = 0.0f;

    std::vector<Track> tracks;
    std::vector<ProjectBus> buses;
    int64_t nextBusNumber = 1;
    std::vector<ProjectEffect> masterEffects;
    std::vector<AutomationLane> masterAutomation;
    int64_t nextEffectNumber = 1;
    TailSettings renderTail;

    // Automation. `target` is "track", "bus" or "master" (ownerId is ignored for the master).
    // Point times are samples at playbackRate. Edits are not part of clip undo.
    std::vector<AutomationLane>* lanesFor(const std::string& target, const std::string& ownerId);
    std::string checkAutomation(const std::string& target, const std::string& ownerId, const std::string& param,
                                float& minimum, float& maximum);
    std::string setAutomation(const std::string& target, const std::string& ownerId, const std::string& param,
                              const bool* enabled, const std::vector<AutomationPoint>* points);
    std::string removeAutomation(const std::string& target, const std::string& ownerId, const std::string& param);
    std::string addAutomationPoint(const std::string& target, const std::string& ownerId, const std::string& param,
                                   const AutomationPoint& point, int& index);
    std::string moveAutomationPoint(const std::string& target, const std::string& ownerId, const std::string& param,
                                    int index, int64_t time, double value, const bool* step, int& newIndex);
    std::string deleteAutomationPoint(const std::string& target, const std::string& ownerId, const std::string& param, int index);
    // Drops lanes whose parameter no longer exists, sorts points and limits values. After loading.
    void repairAutomation(std::vector<std::string>& warnings);

    std::string setTrackRecord(const std::string& trackId, const bool* armed, const RecordInput* input,
                               const RecordMode* mode, const bool* monitorInput);

    struct EffectLocation {
        std::vector<ProjectEffect>* chain = nullptr;
        int index = -1;
    };
    // target is "track", "bus", or "master" (ownerId is ignored for the master).
    std::vector<ProjectEffect>* chainFor(const std::string& target, const std::string& ownerId);
    std::vector<AutomationLane>* lanesForChain(const std::vector<ProjectEffect>* chain);
    EffectLocation findEffect(const std::string& id);
    std::string freshEffectId();
    std::string addEffect(const std::string& target, const std::string& ownerId, EffectType type, int index, std::string& createdId);
    std::string removeEffect(const std::string& id);
    std::string setEffect(const std::string& id, const bool* enabled, const std::vector<std::pair<std::string, float>>& params);
    std::string moveEffect(const std::string& id, int index);
    void repairEffects(std::vector<std::string>& warnings);

    // Vocal processing presets (Phase 2.6.4). Replace the track insert chain; never touch WAV/comp/timing/breath.
    std::vector<VocalPresetDefinition> customVocalPresets;
    struct EffectHistory {
        std::string trackId;
        std::vector<ProjectEffect> effects;
        std::string vocalPresetId;
        bool vocalPresetBypassed = false;
        std::vector<ProjectEffect> vocalPresetPrevious;
    };
    std::vector<EffectHistory> effectUndoStack;
    std::vector<EffectHistory> effectRedoStack;
    struct VocalPresetPreview {
        std::string trackId;
        std::vector<ProjectEffect> previous;
        std::string previousPresetId;
        bool previousBypassed = false;
        std::vector<ProjectEffect> previousPresetPrevious;
    };
    VocalPresetPreview vocalPresetPreview;

    const VocalPresetDefinition* findVocalPreset(const std::string& id) const;
    std::vector<VocalPresetDefinition> listVocalPresets() const;
    void rememberEffectUndo(const std::string& trackId);
    std::string undoEffectEdit();
    std::string redoEffectEdit();
    std::string previewVocalPreset(const std::string& trackId, const std::string& presetId);
    std::string endVocalPresetPreview();
    std::string applyVocalPreset(const std::string& trackId, const std::string& presetId);
    std::string bypassVocalPreset(const std::string& trackId, bool bypassed);
    std::string revertVocalPreset(const std::string& trackId);
    std::string saveCustomVocalPreset(const std::string& name, const std::string& fromPresetId, std::string* createdId);
    std::string saveCustomVocalPresetFromTrack(const std::string& trackId, const std::string& name, std::string* createdId);
    std::string renameCustomVocalPreset(const std::string& id, const std::string& name);
    std::string deleteCustomVocalPreset(const std::string& id);
    std::string restoreFactoryVocalPresets(); // no-op for factory immutability; clears accidental custom id collisions

    int indexOf(const std::string& id) const;
    int busIndexOf(const std::string& id) const;

    std::string addBus(BusKind kind, const std::string& name, std::string& createdId);
    std::string removeBus(const std::string& id);
    std::string renameBus(const std::string& id, const std::string& name);
    std::string setBus(const std::string& id, const ProjectBus& values, bool setGain, bool setMute, bool setSolo, bool setOutput);
    std::string setTrackOutput(const std::string& trackId, const std::string& output);
    std::string setSend(const std::string& trackId, const std::string& busId, const float* level, const bool* preFader);
    std::string removeSend(const std::string& trackId, const std::string& busId);
    void repairRouting(std::vector<std::string>& warnings);
    std::vector<RouteTrack> routeTracks() const;
    MixPlan buildPlan(const MixPlan* previous) const;
    int64_t timeline() const;

    int64_t nextClipNumber = 1;
    int64_t nextTrackNumber = 1;
    int64_t nextTakeNumber = 1;
    int64_t nextTimingMarkerNumber = 1;
    int64_t nextBreathRegionNumber = 1;
    struct ClipHistory {
        std::string trackId;
        std::vector<Clip> clips;
        std::vector<Take> takes;
        bool takesExpanded = false;
        int64_t compCrossfadeSamples = 0;
    };
    std::vector<std::vector<ClipHistory>> undoStack;
    std::vector<std::vector<ClipHistory>> redoStack;

    RetiredAudio importFile(const std::string& id, const std::string& path);
    // `fade` (samples) is applied as the new clip's fade in and fade out, at most half its length.
    RetiredAudio importClip(const std::string& trackId, const std::string& path, int64_t timelineStart,
                            int64_t fade = 0, std::string* clipId = nullptr);
    RetiredAudio addTrack(const std::string& name);
    RetiredAudio removeTrack(const std::string& id);
    std::string renameTrack(const std::string& id, const std::string& name);
    RetiredAudio duplicateTrack(const std::string& id);
    RetiredAudio clearTrack(const std::string& id);
    RetiredAudio setPlaybackRate(double sampleRate);
    std::string setTrack(const std::string& id, const ProjectTrack& values, bool setGain, bool setPan, bool setMute, bool setSolo);
    std::string splitClipAt(const std::string& trackId, const std::string& clipId, int64_t position, RetiredAudio& retired);
    std::string moveClipTo(const std::string& trackId, const std::string& clipId, int64_t timelineStart, RetiredAudio& retired);
    std::string trimClipEdge(const std::string& trackId, const std::string& clipId, bool leftEdge, int64_t edge, RetiredAudio& retired);
    std::string deleteClipById(const std::string& trackId, const std::string& clipId, RetiredAudio& retired);
    std::string duplicateClipAt(const std::string& trackId, const std::string& clipId, int64_t timelineStart, RetiredAudio& retired);
    std::string setClipGainValue(const std::string& trackId, const std::string& clipId, float gain, RetiredAudio& retired);
    std::string setClipFadeValues(const std::string& trackId, const std::string& clipId, int64_t fadeIn, int64_t fadeOut, RetiredAudio& retired,
                                  const FadeCurve* fadeInCurve = nullptr, const FadeCurve* fadeOutCurve = nullptr);
    // Phase 2.8.2 — editable crossfade between two touching/overlapping clips.
    std::string previewCrossfade(const std::string& trackId, const std::string& leftClipId, const std::string& rightClipId,
                                 int64_t durationSamples, FadeCurve curve, RetiredAudio& retired);
    RetiredAudio endCrossfadePreview();
    std::string applyCrossfade(const std::string& trackId, const std::string& leftClipId, const std::string& rightClipId,
                               int64_t durationSamples, FadeCurve curve, RetiredAudio& retired);
    std::string revertCrossfade(const std::string& trackId, const std::string& leftClipId, const std::string& rightClipId,
                                RetiredAudio& retired);
    std::string setAutoCrossfade(const std::string& trackId, bool enabled, double ms, FadeCurve curve);
    std::string replaceClips(const std::string& trackId, std::vector<Clip> clips, RetiredAudio& retired);
    std::string addExtraFile(const std::string& trackId, const std::string& sourceId, const std::string& path);
    // Relink primary or extra source audio while preserving clips/takes/editing metadata.
    std::string relinkSource(const std::string& trackId, const std::string& sourceFileId, const std::string& path,
                             RetiredAudio& retired);
    // Registers a take for an already-loaded source (primary or extra). Does not change clips.
    std::string registerTake(const std::string& trackId, Take take);
    std::string renameTake(const std::string& trackId, const std::string& takeId, const std::string& name);
    std::string setTakeMuted(const std::string& trackId, const std::string& takeId, bool muted);
    std::string removeTake(const std::string& trackId, const std::string& takeId, RetiredAudio& retired);
    std::string setTakesExpanded(const std::string& trackId, bool expanded);
    std::string setCompCrossfadeMs(const std::string& trackId, double ms);
    int64_t compCrossfadeSamplesFor(const Track& track) const;
    // Promotes [timelineStart, timelineEnd) from a take into the active comp (track clips).
    std::string setCompRegion(const std::string& trackId, const std::string& takeId,
                              int64_t timelineStart, int64_t timelineEnd, RetiredAudio& retired);
    // Loads a WAV as an extra source and registers it as a take (no auto-place on the comp).
    RetiredAudio importTake(const std::string& trackId, const std::string& path, int64_t timelineStart,
                            std::string* takeId = nullptr);
    std::string freshTimingMarkerId();
    // Offline onset analysis into the clip's timingMarkers (comp clips only). Replaces detected markers;
    // keeps manual ones.
    std::string analyzeClipOnsets(const std::string& trackId, const std::string& clipId, RetiredAudio& retired);
    std::string addTimingMarker(const std::string& trackId, const std::string& clipId, int64_t sourceSample,
                                bool manual, std::string* markerId, RetiredAudio& retired);
    std::string removeTimingMarker(const std::string& trackId, const std::string& clipId, const std::string& markerId,
                                   RetiredAudio& retired);
    std::string moveTimingMarker(const std::string& trackId, const std::string& clipId, const std::string& markerId,
                                 int64_t sourceSample, RetiredAudio& retired);
    // Elastic warp: move marker to newSourceSample, stretch neighbours, keep clip duration. Writes a
    // new extra from the warped play-rate audio and points the clip at it.
    std::string applyTimingMarkerMove(const std::string& trackId, const std::string& clipId,
                                      const std::string& markerId, int64_t newSourceSample,
                                      RetiredAudio& retired);
    std::string applyTimingSource(const std::string& trackId, const std::string& clipId, const std::string& sourceId,
                                  const std::string& label, const std::vector<TimingMarker>& markers,
                                  RetiredAudio& retired);
    std::string revertTimingSource(const std::string& trackId, const std::string& clipId, RetiredAudio& retired);
    std::string freshBreathRegionId();
    // Offline silence + breath candidate analysis into clip.breathRegions (comp clips only).
    // Replaces non-manual regions; keeps manual ones. Does not bake audio.
    std::string analyzeClipBreath(const std::string& trackId, const std::string& clipId, RetiredAudio& retired);
    std::string addBreathRegion(const std::string& trackId, const std::string& clipId, BreathRegion region,
                                std::string* regionId, RetiredAudio& retired);
    std::string removeBreathRegion(const std::string& trackId, const std::string& clipId, const std::string& regionId,
                                   RetiredAudio& retired);
    std::string setBreathRegion(const std::string& trackId, const std::string& clipId, const BreathRegion& region,
                                RetiredAudio& retired);
    std::string setBreathRegionIgnored(const std::string& trackId, const std::string& clipId, const std::string& regionId,
                                       bool ignored, RetiredAudio& retired);
    // Preview: bake non-ignored region gains into a temporary extra and play it (no undo / no save).
    std::string previewBreathEdits(const std::string& trackId, const std::string& clipId, RetiredAudio& retired);
    RetiredAudio endBreathPreview();
    // Apply: bake gains into a durable extra, point the clip at it, keep provenance for revert.
    std::string applyBreathEdits(const std::string& trackId, const std::string& clipId, RetiredAudio& retired);
    std::string revertBreathEdits(const std::string& trackId, const std::string& clipId, RetiredAudio& retired);

    // Phase 2.8.1 — clip time stretch / speed (offline derived extra; changes clip duration).
    enum class ClipRateMode { timeStretch, speed };
    // Preview: process and temporarily point the clip at the result (no undo). Cancel restores.
    std::string previewClipStretch(const std::string& trackId, const std::string& clipId, ClipRateMode mode,
                                   double ratio, RetiredAudio& retired);
    RetiredAudio endClipStretchPreview();
    // Apply: process from stretch original when available (no cumulative degradation), commit with undo.
    std::string applyClipStretch(const std::string& trackId, const std::string& clipId, ClipRateMode mode,
                                 double ratio, RetiredAudio& retired);
    std::string revertClipStretch(const std::string& trackId, const std::string& clipId, RetiredAudio& retired);

    RetiredAudio createMissingTrack(const std::string& id, const std::string& path, const std::string& name);
    std::string undoEdit(RetiredAudio& retired);
    std::string redoEdit(RetiredAudio& retired);
    bool canUndo() const { return !undoStack.empty() || !effectUndoStack.empty(); }
    bool canRedo() const { return !redoStack.empty() || !effectRedoStack.empty(); }
    std::string primarySourceId(const Track& track) const;
    int64_t sourceLength(const Track& track, const std::string& sourceId) const;
    // Copies the clip's region of its original (not resampled) source as mono (L+R)/2, without
    // clip gain or fades. Fails for missing sources and when the region exceeds maxSeconds.
    std::string copyClipMono(const std::string& trackId, const std::string& clipId, double maxSeconds,
                             std::vector<float>& mono, double& sourceRate, Clip& clip) const;

    struct SourceAudio {
        const std::vector<float>* left = nullptr;    // original sample rate
        const std::vector<float>* right = nullptr;
        double sampleRate = 0.0;
        int channels = 0;
        bool missing = false;
    };
    std::string findSourceAudio(const Track& track, const std::string& sourceId, SourceAudio& audio) const;

    struct ClipRegion {
        Clip clip;
        double sampleRate = 0.0;      // of the source
        int channels = 0;             // 1 or 2
        std::vector<float> left;
        std::vector<float> right;     // empty for mono
        int64_t lead = 0;             // context samples before and after the clip's region
        int64_t tail = 0;
    };
    // Copies the clip's region of its original (not resampled) source with up to `context` source
    // samples on each side, without clip gain or fades.
    std::string copyClipRegion(const std::string& trackId, const std::string& clipId, double maxSeconds,
                               int64_t context, ClipRegion& region) const;

    // Pitch preview: while set, the clip plays `sourceId` from its start instead of its own source.
    // Playback only; clips, undo, export and saved projects are unaffected.
    struct PitchPreview {
        std::string trackId;
        std::string clipId;
        std::string sourceId;
        int resultId = 0;
    };
    PitchPreview pitchPreview;
    // Breath/silence preview (same arrangement override as pitch; extras marked preview=true).
    struct BreathPreview {
        std::string trackId;
        std::string clipId;
        std::string sourceId;
    };
    BreathPreview breathPreview;
    // Stretch/speed preview: temporary clip mutation (duration + source) without undo.
    struct StretchPreview {
        std::string trackId;
        std::string clipId;
        std::string sourceId;
        Clip previous;
    };
    StretchPreview stretchPreview;
    struct CrossfadePreview {
        std::string trackId;
        std::string leftClipId;
        std::string rightClipId;
        Clip previousLeft;
        Clip previousRight;
    };
    CrossfadePreview crossfadePreview;
    // Clears the preview, re-arranges its track and drops sources loaded only for the preview.
    RetiredAudio endPitchPreview();
    // Undoable. The clip plays `sourceId` (which must already be loaded on the track) from its
    // start; the source it played before is remembered so revertPitchSource can restore it.
    // `label` describes the processing; it is appended to the label of earlier processing.
    std::string applyPitchSource(const std::string& trackId, const std::string& clipId, const std::string& sourceId,
                                 double shiftCents, const std::string& label, RetiredAudio& retired);
    std::string revertPitchSource(const std::string& trackId, const std::string& clipId, RetiredAudio& retired);

    // Key, scale and target mapping settings (saved with the project; not part of clip undo).
    PitchMapping pitchMapping;
    // Undoable edit of a clip's note-target overrides. Overrides never reach playback, so the
    // track is not re-arranged and no audio buffer changes.
    std::string editNoteTargets(const std::string& trackId, const std::string& clipId,
                                const std::function<std::string(Clip&)>& edit);

    void render(float* outL, float* outR, int numSamples, const float* micL, const float* micR);
    // Renders the timeline plus the effect tail (renderTail, or `tail` when given) to a WAV file.
    // `frames` receives the written length; the tail is frames minus the timeline length.
    std::string exportMix(const std::string& path, double sampleRate, const TailSettings* tail = nullptr,
                          int64_t* frames = nullptr, int64_t* timelineFrames = nullptr) const;

    ProjectData toProject(const std::string& outputDevice,
                          const std::string& inputDevice,
                          int bufferSize) const;

    std::string applyClipHistory(const std::vector<ClipHistory>& snapshot, RetiredAudio& retired);
    std::string freshClipId();
    std::string freshTakeId();
    std::string freshTrackId();
    const Take* findTake(const Track& track, const std::string& takeId) const;
    Take* findTake(Track& track, const std::string& takeId);
    int claimTrack(const std::string& id);
    bool trackNameTaken(const std::string& name, int skipIndex) const;
    std::string uniqueTrackName(const std::string& base, int skipIndex) const;
    std::string autoTrackName(int preferredNumber, int skipIndex) const;
    void rememberUndo();
    std::vector<SourceSpan> spansFor(const Track& track, double rate) const;
    void arrangeInto(Track& track);
    RetiredAudio commitTrack(int index);
    std::string editClip(const std::string& trackId, const std::function<std::string(Track&)>& edit, RetiredAudio& retired);
};

} // namespace msp
