#pragma once

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace msp {

// Real-time DSP foundation (Phase 2.5.1).
//
// Threading: prepare() runs on a control thread while no audio thread can reach the object.
// process() and reset() run on one audio thread. setBypassed(), requestReset(),
// requestStatisticsReset() and statistics() may be called from any thread (atomics only).
// After prepare(), process() never allocates, locks, waits, logs, performs I/O or throws, and
// every loop in it is bounded by the number of samples it was given.

constexpr int kRealtimeMaxChannels = 2;
constexpr int kRealtimeMaxBlock = 8192;          // largest block size that can be prepared
constexpr int kRealtimeMaxKernelBlock = 4096;    // largest fixed processing block (block adapter)
constexpr int kRealtimeMaxLatency = 65536;       // largest total processor latency, in samples
constexpr double kRealtimeMaxFadeMs = 100.0;

// Fixed-capacity multichannel sample FIFO. It is used by one thread only (the audio thread);
// it is not a cross-thread queue. RecordQueue (Recording.h) is the engine's SPSC queue.
// - Overflow: write() stores at most space() frames; the rest of the request (the newest
//   frames) is dropped and counted in overflowFrames().
// - Underflow: read() returns at most available() frames; the rest of the destination is
//   filled with zeros and counted in underflowFrames().
// Positions are 64-bit counters, so wraparound of the storage never needs special cases.
class AudioRing {
public:
    // Control thread. Allocates channels x capacity samples and empties the ring.
    std::string allocate(int channels, int capacity);
    // Empties the ring without freeing memory. The overflow/underflow counters are kept.
    void clear() noexcept;
    void clearCounters() noexcept;
    int channels() const noexcept { return channelCount; }
    int capacity() const noexcept { return frameCapacity; }
    int available() const noexcept { return static_cast<int>(writePos - readPos); }
    int space() const noexcept { return frameCapacity - available(); }
    // `source` holds channels() pointers; a null `source` or channel pointer writes silence.
    int write(const float* const* source, int frames) noexcept;
    int writeSilence(int frames) noexcept;
    // `dest` holds channels() pointers; a null channel pointer discards that channel.
    int read(float* const* dest, int frames) noexcept;
    int64_t overflowFrames() const noexcept { return overflow; }
    int64_t underflowFrames() const noexcept { return underflow; }
    size_t bytes() const noexcept { return storage.capacity() * sizeof(float); }

private:
    std::vector<float> storage;   // channel c occupies [c * capacity, (c + 1) * capacity)
    int channelCount = 0;
    int frameCapacity = 0;
    uint64_t readPos = 0;
    uint64_t writePos = 0;
    int64_t overflow = 0;
    int64_t underflow = 0;
};

struct RealtimeSpec {
    double sampleRate = 48000.0;
    int channels = 2;
    int maxFrames = 512;   // process() is never called with more frames than this
    bool fixedBlock = false;   // when set, every process() call has exactly maxFrames frames
};

// The extension point for real-time algorithms (future live pitch detection and correction).
// prepare() allocates everything the algorithm needs (buffers, FFT plans). process() works in
// place and must follow the process() rules above. latencySamples() is the algorithmic delay
// of the output and must stay constant between prepare() calls.
class RealtimeKernel {
public:
    virtual ~RealtimeKernel() = default;
    virtual std::string prepare(const RealtimeSpec& spec) = 0;
    virtual void process(float* const* data, int frames) noexcept = 0;
    virtual void reset() noexcept = 0;
    virtual int latencySamples() const noexcept = 0;
};

// Transparent kernel. With delaySamples 0 it leaves the audio untouched; otherwise it delays
// every channel by exactly delaySamples (used to verify latency accounting and alignment).
class PassThroughKernel final : public RealtimeKernel {
public:
    explicit PassThroughKernel(int delaySamples = 0) : delay(delaySamples) {}
    std::string prepare(const RealtimeSpec& spec) override;
    void process(float* const* data, int frames) noexcept override;
    void reset() noexcept override;
    int latencySamples() const noexcept override { return delay; }
    size_t bytes() const noexcept { return ring.bytes(); }

private:
    int delay = 0;
    AudioRing ring;
};

struct RealtimeOptions {
    // 0: the kernel processes each host block (or chunk) directly and adds no buffering.
    // N > 0: a block adapter feeds the kernel fixed blocks of N frames, adding N samples latency.
    int blockSize = 0;
    double fadeMs = 10.0;   // bypass crossfade length; 0 switches on the next sample
};

// Snapshot of the processor's counters. Times are execution time of process() measured with a
// steady clock; load is execution time divided by the audio duration of the block (1.0 = the
// whole real-time budget). These are DSP-only figures, not device or end-to-end latency.
struct RealtimeStats {
    int64_t calls = 0;
    int64_t samples = 0;
    double lastMs = 0.0;
    double averageMs = 0.0;
    double peakMs = 0.0;
    double averageLoad = 0.0;
    double peakLoad = 0.0;
    int64_t overBudgetCalls = 0;    // calls that took longer than the audio they processed
    int64_t oversizeCalls = 0;      // calls larger than maxBlockSize (processed in chunks)
    int64_t sanitizedSamples = 0;   // non-finite input or kernel output samples replaced by 0
    int64_t underflowFrames = 0;    // internal ring underflows (0 by construction)
    int64_t overflowFrames = 0;     // internal ring overflows (0 by construction)
    int64_t resets = 0;
};

// Hosts one kernel for the audio callback: block-size adaptation, a latency-aligned dry path,
// click-free bypass, input sanitizing and timing statistics.
//
// Latency: latencySamples() = blockSize + kernel latency, constant for a prepared processor.
// Bypass: the dry path is delayed by the same latency, so enabled and bypassed outputs are
// time-aligned; switching crossfades linearly over fadeMs and never changes the latency.
// The kernel keeps running while bypassed, so re-enabling crossfades into a current signal.
class RealtimeProcessor {
public:
    explicit RealtimeProcessor(std::unique_ptr<RealtimeKernel> kernel, RealtimeOptions options = {});
    RealtimeProcessor(const RealtimeProcessor&) = delete;
    RealtimeProcessor& operator=(const RealtimeProcessor&) = delete;

    // Control thread, while process() cannot run. Allocates every buffer and prepares the
    // kernel. Returns an error message, or an empty string. May be called again to reconfigure.
    std::string prepare(double sampleRate, int maxBlockSize, int channels);

    // Audio thread. `input` and `output` hold channels() pointers of numSamples samples each and
    // may alias (in-place processing). A null input (or input channel) is silence; a null
    // output channel is skipped. Blocks larger than maxBlockSize() are processed in chunks.
    // Before prepare() succeeds, process() leaves the output untouched.
    void process(const float* const* input, float* const* output, int numSamples) noexcept;

    // Audio thread (or while process() cannot run): clears all audio history. The output then
    // restarts from silence with the same latency, and the bypass mix jumps to its target.
    void reset() noexcept;

    void requestReset() noexcept { resetPending.store(true, std::memory_order_release); }
    void requestStatisticsReset() noexcept { statsResetPending.store(true, std::memory_order_release); }
    void setBypassed(bool bypassed) noexcept { bypassTarget.store(bypassed, std::memory_order_release); }
    bool bypassed() const noexcept { return bypassTarget.load(std::memory_order_acquire); }

    bool prepared() const noexcept { return ready; }
    double sampleRate() const noexcept { return rate; }
    int maxBlockSize() const noexcept { return maxBlock; }
    int channels() const noexcept { return channelCount; }
    int blockSize() const noexcept { return options.blockSize; }
    int fadeSamples() const noexcept { return fadeLength; }
    int kernelLatencySamples() const noexcept { return kernelLatency; }
    int latencySamples() const noexcept { return latency; }
    double latencyMs() const noexcept { return rate > 0.0 ? 1000.0 * latency / rate : 0.0; }
    size_t bytes() const noexcept;
    RealtimeStats statistics() const noexcept;

private:
    void processChunk(const float* const* input, float* const* output, int offset, int n) noexcept;
    void clearStatistics() noexcept;

    std::unique_ptr<RealtimeKernel> dsp;
    RealtimeOptions options;
    double rate = 0.0;
    int maxBlock = 0;
    int channelCount = 0;
    int kernelLatency = 0;
    int latency = 0;
    int fadeLength = 1;
    bool ready = false;

    // Scratch: input copy, aligned dry, wet and one adapter block, each channels x frames.
    std::vector<float> scratch;
    float* inputBuf[kRealtimeMaxChannels] {};
    float* dryBuf[kRealtimeMaxChannels] {};
    float* wetBuf[kRealtimeMaxChannels] {};
    float* blockBuf[kRealtimeMaxChannels] {};
    AudioRing dryRing;      // latency + maxBlock frames, primed with `latency` zeros
    AudioRing inRing;       // blockSize frames: input waiting for a full kernel block
    AudioRing outRing;      // blockSize + maxBlock frames, primed with blockSize zeros

    float mix = 1.0f;       // audio thread: 1 = processed, 0 = dry
    std::atomic<bool> bypassTarget { false };
    std::atomic<bool> resetPending { false };
    std::atomic<bool> statsResetPending { false };

    // Statistics: written by the audio thread only, read anywhere.
    std::atomic<int64_t> statCalls { 0 };
    std::atomic<int64_t> statSamples { 0 };
    std::atomic<int64_t> statTotalNs { 0 };
    std::atomic<int64_t> statBudgetNs { 0 };
    std::atomic<int64_t> statLastNs { 0 };
    std::atomic<int64_t> statPeakNs { 0 };
    std::atomic<int64_t> statPeakLoadPpm { 0 };
    std::atomic<int64_t> statOverBudget { 0 };
    std::atomic<int64_t> statOversize { 0 };
    std::atomic<int64_t> statSanitized { 0 };
    std::atomic<int64_t> statUnderflow { 0 };
    std::atomic<int64_t> statOverflow { 0 };
    std::atomic<int64_t> statResets { 0 };
};

} // namespace msp
