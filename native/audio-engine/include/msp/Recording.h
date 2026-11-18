#pragma once

#include <atomic>
#include <cstdint>
#include <memory>
#include <string>
#include <thread>
#include <vector>

namespace msp {

constexpr int kMaxRecordTracks = 16;
constexpr int kRecordSlotFrames = 1024;
constexpr int kDefaultRecordSlots = 1024;                    // about 21 s of one stereo take at 48 kHz
constexpr int64_t kMaxRecordFrames = 48000LL * 60LL * 30LL;  // the same limit as WAV import

// Deterministic stand-in for a microphone, used by tests and the "Test signal" input.
// Both channels are pure functions of the timeline frame: channel 0 is a sine at `frequency`,
// channel 1 a ramp that rises from -level to just below +level every 200 frames.
struct VirtualInput {
    bool enabled = false;
    double frequency = 440.0;
    float level = 0.5f;
};
float virtualInputSample(const VirtualInput& input, double sampleRate, int64_t frame, int channel);

struct RecordSlot {
    int stream = 0;
    int channels = 0;
    int frames = 0;
    int64_t frame = 0;                       // position of data[0] in the take
    int64_t stamp = 0;                       // caller-defined time of the push (0 for recording)
    float data[kRecordSlotFrames * 2] {};    // interleaved
};

// Bounded single-producer (audio thread), single-consumer (writer thread) ring of fixed slots,
// all allocated by the constructor. push() never blocks or allocates: when the ring is full the
// rest of that block is dropped and counted, and the writer later fills the gap with silence so
// the take stays aligned with the timeline.
class RecordQueue {
public:
    explicit RecordQueue(int slots);
    void push(int stream, int64_t frame, const float* left, const float* right, int channels, int frames, int64_t stamp = 0);
    RecordSlot* front();
    void pop();
    int capacity() const { return static_cast<int>(slots.size()); }
    int64_t droppedFrames() const { return dropped.load(std::memory_order_acquire); }
    int64_t overflows() const { return overflowCount.load(std::memory_order_acquire); }

private:
    std::vector<RecordSlot> slots;
    std::atomic<uint64_t> head { 0 };        // slots written (producer)
    std::atomic<uint64_t> tail { 0 };        // slots read (consumer)
    std::atomic<int64_t> dropped { 0 };
    std::atomic<int64_t> overflowCount { 0 };
};

// A 32-bit float WAV written while recording. Data goes to "<path>.part"; the header sizes are
// rewritten now and then so a crash leaves a readable partial file, and finish() renames it.
class TakeFile {
public:
    TakeFile();
    ~TakeFile();
    std::string open(const std::string& path, double sampleRate, int channels);
    // Writes `frames` interleaved frames at take position `frame`. A gap before it is filled with
    // silence; frames before the current end are ignored.
    std::string write(int64_t frame, const float* interleaved, int frames);
    std::string updateHeader();
    std::string finish();
    void abandon();
    int64_t frames() const { return written; }
    int64_t gapFrames() const { return gaps; }
    int channels() const { return channelCount; }
    const std::string& path() const { return finalPath; }

private:
    struct Impl;
    std::unique_ptr<Impl> impl;
    std::string finalPath;
    double rate = 48000.0;
    int channelCount = 1;
    int64_t written = 0;
    int64_t gaps = 0;
};

struct TakeSpec {
    std::string trackId;
    uint64_t key = 0;          // MixInput::key of the track
    bool processed = false;    // record the input after the track's inserts (stereo)
    int input = 0;             // 0 = input 1, 1 = input 2, 2 = inputs 1 and 2
    int channels = 1;
    std::string path;
};

struct TakeResult {
    TakeSpec spec;
    int64_t frames = 0;
    int64_t gapFrames = 0;
    std::string error;
};

// Owns the take files, the queue and the writer thread for one recording.
class TakeRecorder {
public:
    TakeRecorder() = default;
    ~TakeRecorder();
    // Control thread. Opens every file and starts the writer. `writerDelayMs` holds the writer
    // back at the start (tests use it to force a queue overflow).
    std::string begin(const std::vector<TakeSpec>& specs, double sampleRate, int queueSlots, int writerDelayMs);
    // Audio thread: the spec list does not change while recording.
    const std::vector<TakeSpec>& specs() const { return takeSpecs; }
    RecordQueue& queue() { return *ring; }
    // Control thread, once the audio thread has stopped pushing: writes what is queued,
    // finalizes every file and stops the writer.
    std::vector<TakeResult> finish();

private:
    void run();
    void drain();
    std::vector<TakeSpec> takeSpecs;
    std::vector<std::unique_ptr<TakeFile>> files;
    std::vector<std::string> errors;
    std::unique_ptr<RecordQueue> ring;
    std::thread writer;
    std::atomic<bool> stopping { false };
    int delayMs = 0;
    bool finished = false;
};

} // namespace msp
