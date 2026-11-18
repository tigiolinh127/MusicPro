#pragma once

#include "msp/Pitch.h"
#include "msp/Recording.h"
#include "msp/Scale.h"

#include <atomic>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace msp {

// Real-time pitch detection and target tracking of live input. Detection only: it reads a copy
// of the input and never changes what is monitored, recorded, mixed or exported.
//
// The audio callback hands each block to LivePitchDetector::write(), which copies it into a
// preallocated single-producer/single-consumer RecordQueue and returns. A dedicated worker
// thread drains the queue into a LivePitchAnalyzer: overlapping YIN windows (PitchDetector), a
// NoteTracker and the key/scale mapping (mapPitch). Results are published for the control thread.

enum class LivePitchInput { left, right, mix };   // mix = (input 1 + input 2) / 2
const char* livePitchInputName(LivePitchInput input);
bool livePitchInputFromName(const std::string& name, LivePitchInput& input);

inline constexpr int kLivePitchQueueSlots = 64;     // slots of kRecordSlotFrames: 65536 frames
inline constexpr int kLivePitchFlushFrames = 256;   // smaller callbacks are coalesced up to this
inline constexpr int kLivePitchHistory = 256;       // results kept for the control thread

struct NoteTrackerSettings {
    double hysteresis = 0.35;   // semitones beyond +-0.5 before the pitch leaves the current note
    int onsetFrames = 2;        // consistent voiced frames before a note starts
    int changeFrames = 3;       // consistent frames away from the note before it changes
    int octaveFrames = 5;       // frames an octave jump must last before it is believed
    int holdFrames = 8;         // unvoiced frames bridged without ending the note
};

struct TrackedPitch {
    int note = -1;                  // tracked note; -1 when no note is active
    double pitch = 0.0;             // fractional MIDI of this frame, an isolated octave jump folded back; 0 when unvoiced
    bool onset = false;             // a note starts on this frame
    bool held = false;              // unvoiced frame inside a bridged gap; the note continues
    bool octaveCorrected = false;   // this frame was an isolated octave jump
    bool pending = false;           // voiced, but a note start or change is not yet confirmed
};

// Frame-by-frame note decision with hysteresis, octave-error suppression and gap bridging.
// No allocation; one update() per analysis window.
class NoteTracker {
public:
    explicit NoteTracker(const NoteTrackerSettings& settings = {});
    void configure(const NoteTrackerSettings& settings);
    void reset();
    TrackedPitch update(bool voiced, double midi);
    int note() const { return current; }

private:
    NoteTrackerSettings cfg;
    int current = -1;
    double candidate = 0.0;
    double candidateSum = 0.0;
    int candidateFrames = 0;
    int octaveRun = 0;
    int unvoicedRun = 0;
};

std::string checkNoteTrackerSettings(const NoteTrackerSettings& settings);

struct LivePitchSettings {
    double minHz = 80.0;
    double maxHz = 1000.0;
    int windowSize = 0;                // 0 = the shortest window that holds two periods of minHz
    int hopSize = 256;
    double confidenceThreshold = 0.85;
    double silenceDb = -55.0;
    LivePitchInput input = LivePitchInput::mix;
    NoteTrackerSettings tracker;
};

std::string checkLivePitchSettings(const LivePitchSettings& settings, double sampleRate);
// The detector parameters for these settings at this rate (window size resolved).
PitchParams livePitchParams(const LivePitchSettings& settings, double sampleRate);

struct LivePitchResult {
    int64_t sequence = 0;            // results since start or reset
    int64_t windowStart = 0;         // input sample index of the window's first sample
    int64_t windowEnd = 0;           // one past its last sample
    int64_t arrivalNs = 0;           // steady clock: the callback handed over the window's last sample
    int64_t dequeueNs = 0;           // the worker took that audio from the queue
    int64_t startedNs = 0;           // analysis of this window began
    int64_t completedNs = 0;         // result available
    double frequency = 0.0;          // Hz; 0 when unvoiced
    double midi = 0.0;               // fractional MIDI; 0 when unvoiced
    int nearestMidi = -1;
    double cents = 0.0;              // from nearestMidi
    double confidence = 0.0;
    double levelDb = -200.0;
    bool voiced = false;
    bool invalid = false;            // the window held non-finite samples (reported unvoiced)
    bool gap = false;                // first window after lost input or a reset
    TrackedPitch tracked;
    int targetMidi = -1;             // nearest allowed note of the key; -1 without a voiced tracked note
    double correctionCents = 0.0;    // (target - tracked pitch) * 100
    bool inTune = false;             // |correction| within the mapping tolerance
    double windowDelayMs = 0.0;      // window centre to window end (lookahead of the analysis)
    double schedulingMs = 0.0;       // arrival to dequeue
    double computeMs = 0.0;          // started to completed
    double availabilityMs = 0.0;     // windowDelay + (completed - arrival)
};

int64_t livePitchNowNs();

// The streaming core, single-threaded and deterministic: push input, then take every complete
// window with next(). prepare() allocates; push() and next() do not.
class LivePitchAnalyzer {
public:
    std::string prepare(double sampleRate, const LivePitchSettings& settings);
    void reset();   // forgets buffered audio and the tracker; the next push starts a new stream
    void setKey(const MusicalKey& key, const MappingSettings& mapping);
    // Off: next() leaves targetMidi/correctionCents/inTune empty and never calls mapPitch (which
    // builds note-name strings), so push() and next() are safe on the audio thread. On by default.
    void setTargetMapping(bool enabled) { mapTargets = enabled; }
    // Appends up to kRecordSlotFrames frames of 1 or 2 interleaved channels (2 are averaged)
    // starting at input sample `first`. A first index other than the expected one is a gap:
    // buffered audio and the tracker are reset. Returns false if nothing could be accepted.
    bool push(const float* data, int channels, int frames, int64_t first, int64_t arrivalNs, int64_t dequeueNs);
    // Analyses the next complete window, if any.
    bool next(LivePitchResult& result);

    bool prepared() const { return rate > 0.0; }
    double sampleRate() const { return rate; }
    const PitchParams& parameters() const { return params; }
    int64_t windows() const { return windowCount; }
    int64_t gaps() const { return gapCount; }
    int64_t invalidWindows() const { return invalidCount; }
    size_t bytes() const { return buffer.size() * sizeof(float); }

private:
    PitchDetector detector;
    PitchParams params;
    double rate = 0.0;
    NoteTracker tracker;
    MusicalKey key;
    MappingSettings mapping;
    std::vector<float> buffer;   // samples from bufferStart; the next window starts at buffer[0]
    int count = 0;
    int64_t bufferStart = 0;
    int64_t expected = -1;       // next input index; -1 before the first push
    int64_t lastInvalid = -1;
    int64_t arrival = 0;
    int64_t dequeue = 0;
    int64_t sequence = 0;
    bool gapPending = true;
    bool mapTargets = true;
    int64_t windowCount = 0;
    int64_t gapCount = 0;
    int64_t invalidCount = 0;
};

struct LivePitchStats {
    int64_t inputFrames = 0;      // frames handed over by the callback
    int64_t droppedFrames = 0;    // frames lost because the queue was full
    int64_t overflows = 0;        // pushes that hit a full queue
    int64_t windows = 0;
    int64_t voicedWindows = 0;
    int64_t invalidWindows = 0;
    int64_t gaps = 0;
    int64_t resets = 0;
    int64_t maxQueuedFrames = 0;  // deepest queue the worker found
    int queueSlots = 0;
    int queueFrames = 0;          // capacity in frames
    size_t bytes = 0;             // preallocated queue, staging, window and history memory
    int64_t latencyCount = 0;
    double windowDelayMs = 0.0;
    double meanSchedulingMs = 0.0;
    double maxSchedulingMs = 0.0;
    double meanComputeMs = 0.0;
    double maxComputeMs = 0.0;
    double meanAvailabilityMs = 0.0;
    double maxAvailabilityMs = 0.0;
};

// The threaded detector. start()/stop() belong to the control thread; write() to the audio thread.
class LivePitchDetector {
public:
    LivePitchDetector();
    ~LivePitchDetector();
    LivePitchDetector(const LivePitchDetector&) = delete;
    LivePitchDetector& operator=(const LivePitchDetector&) = delete;

    std::string start(double sampleRate, const LivePitchSettings& settings, const MusicalKey& key, const MappingSettings& mapping);
    void stop();
    bool running() const { return worker.joinable(); }

    // Audio thread. Never blocks, allocates, locks, logs or performs I/O. A null `left` is
    // silence; a null `right` is mono. When the queue is full the block is dropped and counted;
    // the worker sees the index gap and restarts its window.
    void write(const float* left, const float* right, int frames) noexcept;

    void setKey(const MusicalKey& key, const MappingSettings& mapping);   // any thread
    void requestReset();                                                // any thread

    bool latest(LivePitchResult& result) const;
    std::vector<LivePitchResult> recent(int count) const;   // oldest first
    LivePitchStats statistics() const;
    void resetStatistics();
    double sampleRate() const { return rate; }
    const LivePitchSettings& settings() const { return config; }
    const PitchParams& parameters() const { return params; }

private:
    void run();
    void flush(int64_t stampNs) noexcept;
    void applyKey(uint64_t packed);
    void publish(const LivePitchResult& result);

    LivePitchSettings config;
    PitchParams params;
    double rate = 0.0;
    std::unique_ptr<RecordQueue> queue;
    LivePitchAnalyzer analyzer;
    std::thread worker;
    std::atomic<bool> stopping { false };
    std::atomic<bool> resetRequested { false };
    std::atomic<uint64_t> packedKey { 0 };
    uint64_t appliedKey = ~0ull;

    // Audio thread only.
    std::vector<float> stageL;
    std::vector<float> stageR;
    int staged = 0;
    int stageChannels = 1;
    int64_t tapFrames = 0;
    std::atomic<int64_t> inputFrames { 0 };

    mutable std::mutex resultMutex;
    std::vector<LivePitchResult> history;
    int64_t published = 0;
    LivePitchStats totals;
    double sumScheduling = 0.0;
    double sumCompute = 0.0;
    double sumAvailability = 0.0;
    int64_t droppedBase = 0;
    int64_t overflowBase = 0;
    int64_t inputBase = 0;
};

} // namespace msp
