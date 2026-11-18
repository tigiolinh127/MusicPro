#pragma once

#include "msp/LivePitch.h"
#include "msp/RealtimeDsp.h"
#include "msp/Recording.h"
#include "msp/Scale.h"

#include <atomic>
#include <cstdint>
#include <memory>
#include <string>
#include <thread>
#include <vector>

namespace msp {

// Real-time pitch correction of live input (Phase 2.5.3). PitchCorrectionKernel is a RealtimeKernel
// for the live input stage, so RealtimeProcessor supplies input sanitizing, the latency-aligned dry
// path, click-free bypass and timing statistics around it.
//
// Timeline. Every input sample has an index on the kernel's own monotonic timeline: samples handed
// to process() since prepare(). Indices never restart; reset() starts a new epoch instead.
//
// Analysis. A mono copy of the input (LivePitchInput selects input 1, input 2 or their mix) goes to
// a LivePitchAnalyzer: YIN windows of windowSize samples every kLiveCorrectionHop samples, the
// NoteTracker for octave-error folding and gap bridging. Every result is stamped with its window's
// first and one-past-last input index and the epoch. Placement (LiveAnalysisMode):
//   inCallback  the audio thread analyses each block right after storing it; results can never be
//               late. Bounded work: at most ceil(block / hop) + 1 windows per call.
//   worker      a thread drains a RecordQueue (slot frame = input index, stream = epoch) and posts
//               results to a bounded single-producer/single-consumer result ring.
//   manual      as worker, but the analysis runs only when pumpAnalysis() is called (tests).
//
// Synchronization. The correction for the audio read at input position p comes from the two
// results whose window centres lie on either side of p (pitch interpolated between them), never
// from "the newest result". Output is delayed by a fixed latency L, set by prepare():
//   detection  windowSize / 2 + hop      the window centred one hop after p ends this far after p
//   delivery   inCallback: 0; worker/manual: maxFrames + workerMarginMs   (late-result allowance)
//   shifter    J                          the read position moves within L +- J (see below)
// so a result that arrives within `delivery` samples of its window end is always there before it is
// needed, and the output then does not depend on when results arrived or on the block sizes.
//   Late result    (arrives after a position that needed it was read): counted, kept for later.
//   Missing result (needed, not there): the last correction is held for kLiveMissingHoldMs, then
//                  released to 0 with kLiveReleaseMs.
//   Analysis queue overflow: the analyzer sees the index gap and restarts; the gap counts as missing.
//   Result ring full: the result is dropped and counted; the hole counts as missing.
//   reset(): history cleared, epoch incremented, results of older epochs discarded (stale); the
//            output restarts from silence with the same latency.
//
// Correction. Target = nearest note of the key to the interpolated pitch (the Scale.h rules, with
// kLiveTargetHysteresis semitones of hysteresis against flip-flopping between two notes). Wanted
// change = target - pitch (cents, clamped to +-kLiveCorrectionMaxCents), smoothed by a one-pole
// filter with time constant max(retuneMs / 3, 1 ms) (95% of a change in about retuneMs), scaled by
// the smoothed strength. Unvoiced or silent audio releases the correction to 0 (kLiveReleaseMs);
// frames the tracker bridges (short gaps) hold it. Retune 0 ms means the 1 ms minimum smoothing; it
// does not make detection instantaneous: pitch is still measured over windowSize-sample windows.
//
// Shifter. A delay line read by a tap that advances `ratio` input samples per output sample
// (linear interpolation), ratio = 2^(cents / 1200). The tap's delay drifts by (ratio - 1)
// per sample; once it leaves L +- S/2 the tap jumps by S = a whole number of detected periods
// (at least kLiveMinJumpMs; 10 ms when unvoiced) with a raised-cosine crossfade of S samples, so
// a periodic input continues in phase. With no correction (ratio exactly 1) the tap returns to
// delay L exactly (crossfade of kLiveRecentreMs); from then on the output is the input delayed by
// L, bit for bit. Strength 0 from the start never moves the tap. Formants move with the pitch:
// formant preservation is not implemented for live processing.
//
// Threading. prepare() and the destructor: control thread, while process() cannot run (they start
// and stop the worker). process() and reset(): the audio thread; after prepare() they never
// allocate, lock, wait, log or perform I/O, and every loop is bounded by the block size or a fixed
// capacity. setParams(), params(), statistics(), requestStatisticsReset(): any thread (atomics).
// pumpAnalysis() and deliverResult(): one producer thread (manual mode). setTrace(): only while
// process() cannot run.

enum class LiveAnalysisMode { inCallback, worker, manual };
const char* liveAnalysisModeName(LiveAnalysisMode mode);
bool liveAnalysisModeFromName(const std::string& name, LiveAnalysisMode& mode);

inline constexpr double kLiveCorrectionMaxCents = 200.0;   // applied correction is clamped to this
inline constexpr double kLiveRetuneMaxMs = 200.0;
inline constexpr double kLiveCorrectionMinHz = 80.0;
inline constexpr double kLiveCorrectionMaxHz = 1000.0;
inline constexpr int kLiveCorrectionHop = 128;
inline constexpr int kLiveAnalysisSlots = 128;          // worker/manual input queue (slots of up to kRecordSlotFrames)
inline constexpr int kLiveResultRing = 1024;            // worker -> audio thread results (power of two)
inline constexpr int kLiveResultWindow = 256;           // results kept by the audio thread (power of two)
inline constexpr double kLiveStrengthSmoothingMs = 20.0;
inline constexpr double kLiveReleaseMs = 5.0;
inline constexpr double kLiveMinRetuneTauMs = 1.0;
inline constexpr double kLiveMissingHoldMs = 20.0;
inline constexpr double kLiveTargetHysteresis = 0.15;   // semitones
inline constexpr double kLiveMinJumpMs = 5.0;
inline constexpr double kLiveUnvoicedJumpMs = 10.0;
inline constexpr double kLiveRecentreMs = 10.0;
inline constexpr double kLiveDefaultWorkerMarginMs = 6.0;
inline constexpr double kLiveMaxWorkerMarginMs = 200.0;

struct LiveCorrectionParams {
    int root = 0;                         // pitch class 0..11
    ScaleType scale = ScaleType::major;
    double retuneMs = 20.0;               // 0..200
    double strength = 1.0;                // 0..1
};
std::string checkLiveCorrectionParams(const LiveCorrectionParams& params);

// Pitch classes of the scale relative to its root as a 12-bit mask (bit 0 = the root).
unsigned scaleMask(ScaleType scale);
// The nearest allowed note to a fractional MIDI pitch, by the mapPitch rules (lower note on an exact
// tie, kept inside 0..127). No allocation. `mask` must contain bit 0.
int nearestAllowedNote(double midi, int root, unsigned mask);

struct LiveCorrectionSettings {
    LiveAnalysisMode analysis = LiveAnalysisMode::inCallback;
    LivePitchInput input = LivePitchInput::mix;
    double workerMarginMs = kLiveDefaultWorkerMarginMs;   // worker/manual: allowance beyond one block
};
std::string checkLiveCorrectionSettings(const LiveCorrectionSettings& settings);

// Fixed after prepare(). All in samples at the prepared rate.
struct LiveCorrectionLatency {
    int windowSize = 0;
    int hopSize = 0;
    int maxPeriod = 0;          // longest period the analysis reports (rate / minHz)
    int detection = 0;          // windowSize / 2 + hopSize
    int delivery = 0;           // late-result allowance (0 in the callback)
    int shifter = 0;            // J, the splice headroom
    int total = 0;              // detection + delivery + shifter = latencySamples()
};

// One analysis result on the kernel timeline.
struct PitchStamp {
    int64_t windowStart = 0;    // input index of the window's first sample
    int64_t windowEnd = 0;      // one past its last sample
    int64_t centre = 0;         // windowStart + windowSize / 2
    float pitch = 0.0f;         // fractional MIDI (tracker pitch, isolated octave jumps folded); 0 when unvoiced
    uint32_t epoch = 0;
    bool voiced = false;
    bool held = false;          // unvoiced, but inside a gap the tracker bridges
    bool gap = false;           // first window after an analysis restart
};

struct LiveCorrectionStats {
    int64_t samples = 0;            // processed by the kernel
    int64_t windows = 0;            // analysed
    int64_t voicedWindows = 0;
    int64_t analysisDroppedFrames = 0;   // worker/manual input queue overflow
    int64_t analysisGaps = 0;            // analyzer restarts after lost input
    int64_t resultsReceived = 0;    // accepted by the audio thread
    int64_t resultsDropped = 0;     // result ring full
    int64_t resultsWithheld = 0;    // pumpAnalysis(false)
    int64_t lateResults = 0;
    int64_t staleResults = 0;       // older epoch (or out of order)
    int64_t missingSamples = 0;     // output samples whose read position had no result yet
    int64_t correctedSamples = 0;   // output samples with a non-zero applied correction
    int64_t jumps = 0;              // period splices
    int64_t recentres = 0;          // returns to delay L
    int64_t recoveries = 0;         // read tap outside L +- J (0 by construction)
    int64_t resets = 0;
    int64_t maxDeliveryLag = 0;     // block start - window end at acceptance, samples (<= 0 in the callback)
    double meanDeliveryLag = 0.0;
    double maxWindowMs = 0.0;       // analysis compute time of one window
    double meanWindowMs = 0.0;
    double inputMidi = 0.0;         // at the last output sample; 0 when unvoiced
    int targetMidi = -1;
    double appliedCents = 0.0;
    double ratio = 1.0;
    size_t bytes = 0;               // everything allocated by prepare()
};

// Test diagnostics: per output sample, when set. Vectors are sized by the caller; recording stops
// when they are full.
struct LiveCorrectionTrace {
    std::vector<double> readPos;    // primary tap position (input index)
    std::vector<float> inputMidi;   // pitch used (0 when none)
    std::vector<float> cents;       // applied correction
    std::vector<int8_t> kind;       // 0 none, 1 voiced, 2 unvoiced, 3 held, 4 missing
    size_t count = 0;
};

class PitchCorrectionKernel final : public RealtimeKernel {
public:
    explicit PitchCorrectionKernel(const LiveCorrectionSettings& settings = {}, const LiveCorrectionParams& params = {});
    ~PitchCorrectionKernel() override;
    PitchCorrectionKernel(const PitchCorrectionKernel&) = delete;
    PitchCorrectionKernel& operator=(const PitchCorrectionKernel&) = delete;

    std::string prepare(const RealtimeSpec& spec) override;
    void process(float* const* data, int frames) noexcept override;
    void reset() noexcept override;
    int latencySamples() const noexcept override { return lat.total; }

    // Any thread. Invalid values are clamped (validate with checkLiveCorrectionParams first).
    void setParams(const LiveCorrectionParams& params) noexcept;
    LiveCorrectionParams params() const noexcept;
    const LiveCorrectionSettings& settings() const noexcept { return config; }
    const LiveCorrectionLatency& latency() const noexcept { return lat; }
    double sampleRate() const noexcept { return rate; }
    LiveCorrectionStats statistics() const noexcept;
    void requestStatisticsReset() noexcept { statsResetPending.store(true, std::memory_order_release); }
    size_t bytes() const noexcept;
    uint32_t epoch() const noexcept { return currentEpoch.load(std::memory_order_acquire); }

    // Manual mode: analyses everything queued so far; with deliver false the results are discarded
    // (withheld). Returns the number of windows analysed.
    int pumpAnalysis(bool deliver = true) noexcept;
    // Manual mode: posts a result as the worker would (tests of late, missing and stale results).
    bool deliverResult(const PitchStamp& stamp) noexcept;
    // Worker mode, tests: a paused worker leaves its queue alone.
    void pauseWorker(bool paused) noexcept { workerPaused.store(paused, std::memory_order_release); }
    void setTrace(LiveCorrectionTrace* trace) noexcept { tracePtr = trace; }

private:
    struct Tap {
        int64_t i = 0;
        double f = 0.0;
    };
    enum Kind : int8_t { kindNone = 0, kindVoiced = 1, kindUnvoiced = 2, kindHeld = 3, kindMissing = 4 };
    struct Info {
        Kind kind = kindNone;
        double midi = 0.0;
    };

    void stopWorker() noexcept;
    void runWorker() noexcept;
    int analyse(const float* mono, int frames, int64_t first, uint32_t epoch, int64_t stampNs, bool deliver, bool direct) noexcept;
    bool postResult(const PitchStamp& stamp) noexcept;
    void accept(const PitchStamp& stamp, int64_t blockStart) noexcept;
    Info lookup(double position) noexcept;
    void applyParams(uint64_t packed) noexcept;
    float sample(int channel, int64_t index) const noexcept;
    float read(int channel, const Tap& tap) const noexcept;
    void clearAudioStats() noexcept;

    LiveCorrectionSettings config;
    double rate = 0.0;
    int channelCount = 0;
    int maxFrames = 0;
    bool ready = false;
    LiveCorrectionLatency lat;
    double minJump = 0.0;          // samples
    double unvoicedJump = 0.0;
    int recentreLength = 1;
    int minPeriod = 2;
    size_t analysisBytes = 0;      // analyzer window and YIN working buffers (from their sizes)

    // Audio thread.
    std::vector<float> history;    // channelCount x histCap, power-of-two ring indexed by input index
    int histCap = 0;
    int64_t histMask = 0;
    std::vector<float> mono;       // maxFrames
    int64_t inIndex = 0;
    int64_t epochStart = 0;
    uint32_t audioEpoch = 0;
    std::atomic<uint32_t> currentEpoch { 0 };
    std::vector<PitchStamp> window;   // kLiveResultWindow, by sequence number
    uint64_t winFirst = 0;
    uint64_t winEnd = 0;
    uint64_t cursor = 0;
    double maxReadPos = -1.0e300;
    bool started = false;
    Tap tapA;
    Tap tapB;
    bool fading = false;
    int fadePos = 0;
    int fadeLen = 1;
    double smoothedCents = 0.0;
    double smoothedStrength = 0.0;
    double lastGoal = 0.0;
    double lastPeriod = 0.0;       // samples; 0 when no voiced pitch is known
    int missingRun = 0;
    int missingHold = 0;
    int target = -1;
    // Decoded parameters (audio thread).
    uint64_t appliedPacked = ~0ull;
    int root = 0;
    unsigned mask = 1;
    double strengthTarget = 1.0;
    double alphaRetune = 1.0;
    double alphaRelease = 1.0;
    double alphaStrength = 1.0;
    LiveCorrectionTrace* tracePtr = nullptr;

    std::atomic<uint64_t> packedParams { 0 };
    std::atomic<bool> statsResetPending { false };

    // Analysis (audio thread in the callback mode, otherwise the worker or pump caller).
    LivePitchAnalyzer analyzer;
    uint32_t analysisEpoch = ~0u;
    std::unique_ptr<RecordQueue> queue;
    std::vector<PitchStamp> ring;     // kLiveResultRing
    std::atomic<uint64_t> ringHead { 0 };
    std::atomic<uint64_t> ringTail { 0 };
    std::thread worker;
    std::atomic<bool> workerStop { false };
    std::atomic<bool> workerPaused { false };

    // Statistics. Audio-thread counters are published once per block.
    struct AudioCounters {
        int64_t samples = 0, resultsReceived = 0, lateResults = 0, staleResults = 0, missingSamples = 0;
        int64_t correctedSamples = 0, jumps = 0, recentres = 0, recoveries = 0, resets = 0;
        int64_t maxLag = INT64_MIN, lagSum = 0, lagCount = 0;
    } counters;
    std::atomic<int64_t> statSamples { 0 }, statReceived { 0 }, statLate { 0 }, statStale { 0 }, statMissing { 0 };
    std::atomic<int64_t> statCorrected { 0 }, statJumps { 0 }, statRecentres { 0 }, statRecoveries { 0 }, statResets { 0 };
    std::atomic<int64_t> statMaxLag { INT64_MIN }, statLagSum { 0 }, statLagCount { 0 };
    std::atomic<double> statInputMidi { 0.0 }, statAppliedCents { 0.0 }, statRatio { 1.0 };
    std::atomic<int> statTarget { -1 };
    std::atomic<int64_t> statWindows { 0 }, statVoiced { 0 }, statDropped { 0 }, statWithheld { 0 }, statGaps { 0 };
    std::atomic<int64_t> statWindowNs { 0 }, statMaxWindowNs { 0 };
};

} // namespace msp
