#pragma once

#include "msp/NoteSegments.h"
#include "msp/Pitch.h"
#include "msp/PitchCorrect.h"
#include "msp/PitchShift.h"
#include "msp/LivePitch.h"
#include "msp/LiveCorrection.h"
#include "msp/RealtimeDsp.h"
#include "msp/Scale.h"
#include "msp/LatencyCalibration.h"
#include "msp/Recording.h"
#include "msp/Session.h"
#include "msp/SpectrumAnalyzer.h"
#include "msp/Loudness.h"

#include <juce_audio_devices/juce_audio_devices.h>
#include <juce_events/juce_events.h>

#include <atomic>
#include <deque>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace msp {

struct PublishedAudio {
    const float* left = nullptr;
    const float* right = nullptr;
    int64_t length = 0;
};

// The plan is immutable after publication. The state (ramps, bus buffers, peak atomics) is
// written only by the audio thread, except the peak atomics, which the timer exchanges.
struct MixSnapshot {
    MixPlan plan;
    std::unique_ptr<MixState> state;
    int64_t timeline = 0;
    uint64_t seq = 0;
};

struct MeterLevel {
    float levelL = 0.0f;
    float levelR = 0.0f;
    bool clip = false;
};

struct PeakHoldState {
    float holdL = 0.0f;
    float holdR = 0.0f;
    int ticks = 0;
};

// A pitch-processed rendering of a clip, and the clip state it was made from (playback samples).
struct PitchProcessed {
    std::string trackId;
    std::string clipId;
    std::string path;
    std::string sourceFileId;
    int64_t sourceOffset = 0;
    int64_t duration = 0;
    double shiftCents = 0.0;
    std::string label;      // stored on the clip when applied
    std::string loadedId;   // track source id once loaded for preview or apply
};

// Note segments of a finished pitch analysis, and the clip state they were found in.
struct PitchSegments {
    int jobId = 0;
    int generation = 0;            // Engine::projectGeneration when the analysis started
    std::string trackId;
    std::string clipId;
    std::string sourceFileId;
    int64_t sourceOffset = 0;      // playback samples
    int64_t duration = 0;
    double playbackRate = 0.0;
    double clipStart = 0.0;        // timeline seconds
    double sourceStart = 0.0;      // source seconds at the start of the analysed audio
    double hopSeconds = 0.0;
    double windowSeconds = 0.0;
    PitchParams params;
    std::vector<PitchFrame> frames;   // the analysis frames, for automatic correction
    std::vector<NoteSegment> segments;
};

// Target note per segment as shown by getPitchMapping (-1 = none).
struct SegmentTargets {
    std::vector<int> target;
    std::vector<bool> manual;
    int unmatchedOverrides = 0;
};

class Engine final : private juce::AudioIODeviceCallback, private juce::Timer {
public:
    Engine();
    ~Engine() override;

    void start();
    void handleLine(const std::string& line);
    void shutdown(bool respond);

private:
    void audioDeviceIOCallbackWithContext(const float* const* inputChannelData,
                                          int numInputChannels,
                                          float* const* outputChannelData,
                                          int numOutputChannels,
                                          int numSamples,
                                          const juce::AudioIODeviceCallbackContext& context) override;
    void audioDeviceAboutToStart(juce::AudioIODevice* device) override;
    void audioDeviceStopped() override;
    void audioDeviceError(const juce::String& errorMessage) override;
    void timerCallback() override;

    void openDevices(const juce::String& outputName, const juce::String& inputName, double sampleRate, int bufferSize);
    void publishMix();
    void reclaimSnapshots();
    void settleAudio();
    void waitForAudioSnapshot();
    void detachAudioCallback();
    void holdRetired(RetiredAudio retired);
    juce::String startRecording(const juce::var& options);
    juce::var finishRecording();
    // Answers the request itself on success (before the worker starts); returns an error otherwise.
    juce::String startPitchAnalysis(const juce::String& requestId, const juce::var& options);
    juce::String startPitchProcess(const juce::String& requestId, const juce::var& options);
    void stopPitchAnalysis();
    // Offline loudness of an exported WAV (BS.1770 / R128). Answers then runs on a worker thread.
    juce::String startLoudnessAnalysis(const juce::String& requestId, const juce::var& options);
    void stopLoudnessAnalysis();
    void endPitchPreview();
    juce::String processedClipError(const PitchProcessed& info) const;
    juce::String loadProcessed(int resultId, bool preview, std::string& sourceId);
    bool findPitchSegments(int jobId, PitchSegments& out) const;
    // The clip's current state differs from the analysed one (or the clip is gone).
    bool segmentsOutdated(const PitchSegments& info, const Clip** clip) const;
    juce::var pitchMappingVar(const PitchSegments& info) const;
    SegmentTargets segmentTargets(const PitchSegments& info, const Clip* clip, bool outdated) const;
    juce::String startPitchCorrection(const juce::String& requestId, const juce::var& options);
    int64_t displayTimeline() const;
    // Rebuilds the live input stage from liveDspConfig at the current sample rate and buffer
    // size, or removes it when disabled. Control thread.
    juce::String configureLiveDsp();
    void retireLiveDsp();
    juce::var liveDspVar() const;
    juce::var liveCorrectionVar() const;
    // Starts the live pitch detector from livePitchConfig at the current sample rate, or stops
    // it when disabled. Control thread.
    juce::String configureLivePitch();
    void retireLivePitch();
    juce::var livePitchVar(int recentCount) const;
    void captureRecording(TakeRecorder& recorder, const MixPlan& plan, int processedCount,
                          const float* in1, const float* in2, float* const* processedL, float* const* processedR,
                          int64_t position, int frames);
    juce::var stateVar() const;
    juce::var meterVar(bool decay);
    void resolveSpectrumTapLocked(); // maps ownerId → plan index; call after publishMix / setSpectrumTap
    juce::var recordingLatencyVar() const;
    std::string currentLatencyProfileKey() const;
    void loadRecordingLatencyProfiles();
    void saveRecordingLatencyProfiles() const;
    void applyLatencyProfileForDevices();
    void writeJson(const juce::var& value);
    void succeed(const juce::String& id, const juce::var& result);
    void fail(const juce::String& id, const juce::String& message);

    juce::AudioDeviceManager devices;
    Session session;
    std::vector<std::vector<float>> retired;
    std::deque<std::unique_ptr<MixSnapshot>> mixHistory;
    std::atomic<MixSnapshot*> mixHead { nullptr };
    // Sequence number of the snapshot the audio thread has switched to. Snapshots older than
    // this can no longer be touched by the callback and are freed on the control thread.
    std::atomic<uint64_t> audioSeq { 0 };
    uint64_t nextSeq = 1;
    bool callbackAttached = false;
    MixSnapshot* audioCurrent = nullptr;   // audio thread only, while the callback is attached
    std::map<std::string, MeterLevel> meterLevels;
    MeterLevel masterMeter;
    std::map<std::string, PeakHoldState> stripPeakHolds;
    PeakHoldState masterPeakHold;
    // Master bus RMS (post master fader / inserts). Accumulated in the audio callback.
    std::atomic<float> masterSumSqL { 0.0f };
    std::atomic<float> masterSumSqR { 0.0f };
    std::atomic<int> masterMeterSamples { 0 };

    std::atomic<int> transport { static_cast<int>(TransportMode::stopped) };
    std::atomic<int64_t> position { 0 };
    std::atomic<int64_t> timelineSamples { 0 };
    std::atomic<int> sampleRate { 48000 };
    std::atomic<int> bufferSize { 512 };
    std::atomic<int> inputChannels { 0 };
    std::atomic<int> outputChannels { 0 };
    std::atomic<int> outputLatencySamples { 0 };
    std::atomic<bool> deviceOpen { false };
    std::atomic<bool> monitor { false };
    std::atomic<float> masterGain { 1.0f };
    std::atomic<float> peakL { 0.0f };
    std::atomic<float> peakR { 0.0f };
    // Software input gain (Phase 2.7.2): applied after device/virtual capture, before Live DSP
    // and recording. Independent of track fader / master / Mic monitor. Unity = 0 dB.
    std::atomic<float> inputGainTarget { 1.0f };   // linear
    std::atomic<float> inputGainDb { 0.0f };
    float inputGainCurrent = 1.0f;                 // audio thread only (smoothed)
    // Input meters: measured on post-gain samples (what recording/Live DSP see).
    std::atomic<float> inputPeakL { 0.0f };
    std::atomic<float> inputPeakR { 0.0f };
    std::atomic<float> inputSumSqL { 0.0f };
    std::atomic<float> inputSumSqR { 0.0f };
    std::atomic<int> inputMeterSamples { 0 };
    std::atomic<bool> inputMeterAvailable { false };
    MeterLevel inputMeter;
    float inputPeakHoldL = 0.0f;
    float inputPeakHoldR = 0.0f;
    int inputPeakHoldTicks = 0;
    // Phase 2.8.3 spectrum analyzer (post-insert / pre-fader tap).
    SpectrumCapture spectrumCapture;
    SpectrumAnalyzer spectrumAnalyzer;
    std::atomic<int> spectrumKind { 0 };   // SpectrumTapKind
    std::atomic<int> spectrumIndex { 0 };
    std::string spectrumTarget;            // "track" | "bus" | "master" | ""
    std::string spectrumOwnerId;
    std::vector<float> spectrumDb;
    std::vector<float> spectrumHz;
    bool spectrumPrepared = false;
    std::atomic<bool> deviceFault { false };
    std::atomic<bool> shuttingDown { false };

    std::vector<float> scratchL;
    std::vector<float> scratchR;
    // Diagnostic capture of the callback's stereo output, indexed by timeline position. The
    // buffers are allocated on the control thread before captureOn is set; the callback only
    // writes into them, and the control thread reads them after captureWriters drops to 0.
    std::vector<float> captureL;
    std::vector<float> captureR;
    std::atomic<bool> captureOn { false };
    std::atomic<int> captureWriters { 0 };
    std::atomic<int64_t> captureEnd { 0 };
    std::atomic<int64_t> captureWritten { 0 };
    void endCapture();

    // Recording. The recorder and its files belong to the control thread; the audio thread only
    // pushes into its queue while recordLive points at it. A stop is requested with
    // recordStopRequest and acknowledged by the next callback, after which the audio thread
    // never touches the recorder again.
    std::unique_ptr<TakeRecorder> recorder;
    std::atomic<TakeRecorder*> recordLive { nullptr };
    std::atomic<bool> recordStopRequest { false };
    std::atomic<bool> recordStopAck { false };
    std::atomic<int64_t> recordStart { 0 };
    std::atomic<int64_t> recordEnd { 0 };
    std::atomic<int64_t> recordCaptured { 0 };
    std::atomic<int64_t> recordSkipped { 0 };        // frames of oversized blocks that could not be captured
    std::atomic<bool> virtualOn { false };
    std::atomic<double> virtualFrequency { 440.0 };
    std::atomic<float> virtualLevel { 0.5f };
    juce::File recordFolder;
    juce::var lastTake;
    // Phase 2.7.4 — recording placement offset (ms). Positive = place new takes later on the
    // timeline; negative = earlier. Does not rewrite existing takes. Persisted per device profile.
    // Does NOT include Live Auto-Tune DSP latency (already present in recorded samples).
    static constexpr double kMaxRecordingOffsetMs = 500.0;
    double recordingOffsetMs = 0.0;
    std::map<std::string, double> recordingOffsetProfiles;
    LatencyEstimate lastLatencyEstimate {};
    bool hasLatencyEstimate = false;
    juce::String latencyEstimateMethod { "none" }; // none | manual | loopback-estimate
    juce::File recordingLatencyPrefsFile;
    std::vector<float> virtualL;
    std::vector<float> virtualR;
    std::vector<float> inputGainL;
    std::vector<float> inputGainR;
    std::vector<float> silentInput;
    std::vector<std::vector<float>> processedL;
    std::vector<std::vector<float>> processedR;
    std::vector<float*> processedPtrL;
    std::vector<float*> processedPtrR;
    // Live input DSP stage (Phase 2.5.1, off by default, not saved with the project). When
    // enabled, the callback runs the live input channels (device or test signal) through a
    // prepared RealtimeProcessor before they reach record inputs and track input monitoring.
    // The control thread owns the processor; the callback reaches it only through liveDspLive,
    // counted in liveDspUsers, so retireLiveDsp() can free it once no callback holds it.
    struct LiveDspConfig {
        bool enabled = false;
        bool bypassed = false;
        int latencySamples = 0;   // pass-through delay (kernel latency)
        int blockSize = 0;        // 0 = direct; N = fixed kernel blocks of N samples
        double fadeMs = 10.0;
        // Live pitch correction (Phase 2.5.3) uses the same stage with a PitchCorrectionKernel
        // instead of the pass-through kernel (direct blocks; latencySamples/blockSize unused).
        bool correction = false;
        LiveCorrectionSettings correctionSettings;
        LiveCorrectionParams correctionParams;
        // Track input monitoring feed while correction is on (Phase 2.5.4). Recording always uses
        // the post-stage (corrected) signal; this only selects what armed-track monitoring hears.
        // "corrected" = post-stage; "raw" = pre-stage delayed by the same DSP latency (aligned).
        enum class MonitorMode { corrected, raw };
        MonitorMode monitorMode = MonitorMode::corrected;
    };
    LiveDspConfig liveDspConfig;
    std::unique_ptr<RealtimeProcessor> liveDsp;
    PitchCorrectionKernel* liveCorrection = nullptr;   // owned by liveDsp; control thread only
    std::atomic<RealtimeProcessor*> liveDspLive { nullptr };
    std::atomic<int> liveDspUsers { 0 };
    std::atomic<int64_t> liveDspSkipped { 0 };     // callbacks too large for the stage buffers
    std::vector<float> liveL;
    std::vector<float> liveR;
    // Latency-aligned raw copy for RAW track monitoring while recording stays corrected.
    AudioRing monitorRawDelay;
    std::vector<float> monitorRawL;
    std::vector<float> monitorRawR;
    std::vector<float> monitorMixL;
    std::vector<float> monitorMixR;
    std::atomic<int> liveMonitorMode { 0 };          // 0 = corrected, 1 = raw (audio thread)
    float monitorMix = 1.0f;                         // audio thread: 1 = corrected, 0 = raw
    int monitorFadeSamples = 1;
    // Live pitch detection (Phase 2.5.2, off by default, not saved with the project). The
    // callback copies the live input (device or test signal, before the live DSP stage) into the
    // detector's queue; its worker thread does the analysis. Read-only: the input is not changed.
    // Same ownership as the live DSP stage: livePitchLive, counted in livePitchUsers.
    struct LivePitchConfig {
        bool enabled = false;
        LivePitchSettings settings;
    };
    LivePitchConfig livePitchConfig;
    std::unique_ptr<LivePitchDetector> livePitch;
    std::atomic<LivePitchDetector*> livePitchLive { nullptr };
    std::atomic<int> livePitchUsers { 0 };
    // Offline pitch analysis: one job at a time on its own thread. The job owns a copy of the
    // clip's audio and never touches the session or the audio callback; it only writes events
    // through writeJson, which outMutex serializes.
    struct PitchJob {
        std::thread thread;
        std::atomic<bool> cancel { false };
        std::atomic<bool> finished { false };
        int id = 0;
        bool processing = false;   // pitch shifting rather than analysis
    };
    std::unique_ptr<PitchJob> pitchJob;
    int nextPitchJob = 1;
    struct LoudnessJob {
        std::thread thread;
        std::atomic<bool> cancel { false };
        std::atomic<bool> finished { false };
        int id = 0;
    };
    std::unique_ptr<LoudnessJob> loudnessJob;
    int nextLoudnessJob = 1;
    // Finished pitch-processing results by job id. The worker adds entries; the control thread
    // reads them for preview and apply. Processed files are never overwritten or deleted.
    std::map<int, PitchProcessed> pitchProcessed;
    mutable std::mutex pitchProcessedMutex;
    juce::File processedFolder;
    // Segments of the most recent analyses (the worker adds, the control thread reads).
    std::deque<PitchSegments> pitchSegments;
    mutable std::mutex pitchSegmentsMutex;
    int projectGeneration = 0;     // bumped by loadProject, so old analyses never match new clips

    juce::String outputDeviceName;
    juce::String inputDeviceName;
    juce::String deviceError;
    juce::String faultMessage;
    std::mutex outMutex;
};

} // namespace msp
