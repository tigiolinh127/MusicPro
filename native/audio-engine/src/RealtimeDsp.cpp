#include "msp/RealtimeDsp.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>

namespace msp {

std::string AudioRing::allocate(int channels, int capacity) {
    if (channels < 1 || channels > kRealtimeMaxChannels)
        return "A ring buffer needs 1 or 2 channels.";
    if (capacity < 1 || capacity > kRealtimeMaxLatency + kRealtimeMaxBlock + kRealtimeMaxKernelBlock)
        return "Ring buffer capacity is out of range.";
    storage.assign(static_cast<size_t>(channels) * static_cast<size_t>(capacity), 0.0f);
    channelCount = channels;
    frameCapacity = capacity;
    readPos = 0;
    writePos = 0;
    overflow = 0;
    underflow = 0;
    return {};
}

void AudioRing::clear() noexcept {
    readPos = 0;
    writePos = 0;
}

void AudioRing::clearCounters() noexcept {
    overflow = 0;
    underflow = 0;
}

int AudioRing::write(const float* const* source, int frames) noexcept {
    if (frames <= 0)
        return 0;
    const int n = std::min(frames, space());
    overflow += frames - n;
    if (n <= 0)
        return 0;
    const auto cap = static_cast<uint64_t>(frameCapacity);
    const int start = static_cast<int>(writePos % cap);
    const int first = std::min(n, frameCapacity - start);
    for (int c = 0; c < channelCount; ++c) {
        float* base = storage.data() + static_cast<size_t>(c) * static_cast<size_t>(frameCapacity);
        const float* src = source != nullptr ? source[c] : nullptr;
        if (src != nullptr) {
            std::memcpy(base + start, src, sizeof(float) * static_cast<size_t>(first));
            std::memcpy(base, src + first, sizeof(float) * static_cast<size_t>(n - first));
        } else {
            std::fill(base + start, base + start + first, 0.0f);
            std::fill(base, base + (n - first), 0.0f);
        }
    }
    writePos += static_cast<uint64_t>(n);
    return n;
}

int AudioRing::writeSilence(int frames) noexcept {
    return write(nullptr, frames);
}

int AudioRing::read(float* const* dest, int frames) noexcept {
    if (frames <= 0)
        return 0;
    const int n = std::min(frames, available());
    underflow += frames - n;
    const auto cap = static_cast<uint64_t>(std::max(1, frameCapacity));
    const int start = static_cast<int>(readPos % cap);
    const int first = std::min(n, frameCapacity - start);
    for (int c = 0; c < channelCount; ++c) {
        float* dst = dest != nullptr ? dest[c] : nullptr;
        if (dst == nullptr)
            continue;
        const float* base = storage.data() + static_cast<size_t>(c) * static_cast<size_t>(frameCapacity);
        if (n > 0) {
            std::memcpy(dst, base + start, sizeof(float) * static_cast<size_t>(first));
            std::memcpy(dst + first, base, sizeof(float) * static_cast<size_t>(n - first));
        }
        std::fill(dst + n, dst + frames, 0.0f);
    }
    readPos += static_cast<uint64_t>(n);
    return n;
}

std::string PassThroughKernel::prepare(const RealtimeSpec& spec) {
    if (delay < 0 || delay > kRealtimeMaxLatency)
        return "Pass-through delay is out of range.";
    if (delay == 0)
        return {};
    const auto error = ring.allocate(spec.channels, delay + spec.maxFrames);
    if (!error.empty())
        return error;
    ring.writeSilence(delay);
    return {};
}

void PassThroughKernel::process(float* const* data, int frames) noexcept {
    if (delay == 0 || frames <= 0)
        return;
    ring.write(data, frames);
    ring.read(data, frames);
}

void PassThroughKernel::reset() noexcept {
    if (delay == 0)
        return;
    ring.clear();
    ring.writeSilence(delay);
}

RealtimeProcessor::RealtimeProcessor(std::unique_ptr<RealtimeKernel> kernel, RealtimeOptions settings)
    : dsp(std::move(kernel)), options(settings) {}

std::string RealtimeProcessor::prepare(double sampleRate, int maxBlockSize, int channels) {
    ready = false;
    if (dsp == nullptr)
        return "The real-time processor has no kernel.";
    if (!(sampleRate >= 8000.0 && sampleRate <= 384000.0))
        return "Sample rate must be between 8000 and 384000 Hz.";
    if (maxBlockSize < 1 || maxBlockSize > kRealtimeMaxBlock)
        return "Maximum block size must be between 1 and " + std::to_string(kRealtimeMaxBlock) + " samples.";
    if (channels < 1 || channels > kRealtimeMaxChannels)
        return "The real-time processor supports 1 or 2 channels.";
    if (options.blockSize < 0 || options.blockSize > kRealtimeMaxKernelBlock)
        return "Processing block size must be 0 (direct) or 1 to " + std::to_string(kRealtimeMaxKernelBlock) + " samples.";
    if (!(options.fadeMs >= 0.0 && options.fadeMs <= kRealtimeMaxFadeMs))
        return "Bypass fade must be between 0 and 100 ms.";

    RealtimeSpec spec;
    spec.sampleRate = sampleRate;
    spec.channels = channels;
    spec.fixedBlock = options.blockSize > 0;
    spec.maxFrames = spec.fixedBlock ? options.blockSize : maxBlockSize;
    const auto kernelError = dsp->prepare(spec);
    if (!kernelError.empty())
        return kernelError;
    const int kernelDelay = dsp->latencySamples();
    if (kernelDelay < 0 || kernelDelay + options.blockSize > kRealtimeMaxLatency)
        return "Processor latency is out of range.";

    rate = sampleRate;
    maxBlock = maxBlockSize;
    channelCount = channels;
    kernelLatency = kernelDelay;
    latency = options.blockSize + kernelDelay;
    fadeLength = std::max(1, static_cast<int>(std::lround(options.fadeMs * sampleRate / 1000.0)));

    const size_t frames = static_cast<size_t>(maxBlock);
    const size_t blockFrames = static_cast<size_t>(std::max(1, options.blockSize));
    scratch.assign(static_cast<size_t>(channels) * (3 * frames + blockFrames), 0.0f);
    float* cursor = scratch.data();
    for (int c = 0; c < kRealtimeMaxChannels; ++c) {
        inputBuf[c] = dryBuf[c] = wetBuf[c] = blockBuf[c] = nullptr;
    }
    for (int c = 0; c < channels; ++c) {
        inputBuf[c] = cursor;
        cursor += frames;
        dryBuf[c] = cursor;
        cursor += frames;
        wetBuf[c] = cursor;
        cursor += frames;
        blockBuf[c] = cursor;
        cursor += blockFrames;
    }
    auto error = dryRing.allocate(channels, latency + maxBlock);
    if (error.empty() && options.blockSize > 0)
        error = inRing.allocate(channels, options.blockSize);
    if (error.empty() && options.blockSize > 0)
        error = outRing.allocate(channels, options.blockSize + maxBlock);
    if (!error.empty())
        return error;
    clearStatistics();
    reset();
    statResets.store(0, std::memory_order_relaxed);
    ready = true;
    return {};
}

void RealtimeProcessor::reset() noexcept {
    if (dsp == nullptr)
        return;
    dryRing.clear();
    dryRing.writeSilence(latency);
    if (options.blockSize > 0) {
        inRing.clear();
        outRing.clear();
        outRing.writeSilence(options.blockSize);
    }
    dsp->reset();
    mix = bypassTarget.load(std::memory_order_acquire) ? 0.0f : 1.0f;
    statResets.fetch_add(1, std::memory_order_relaxed);
}

void RealtimeProcessor::clearStatistics() noexcept {
    statCalls.store(0, std::memory_order_relaxed);
    statSamples.store(0, std::memory_order_relaxed);
    statTotalNs.store(0, std::memory_order_relaxed);
    statBudgetNs.store(0, std::memory_order_relaxed);
    statLastNs.store(0, std::memory_order_relaxed);
    statPeakNs.store(0, std::memory_order_relaxed);
    statPeakLoadPpm.store(0, std::memory_order_relaxed);
    statOverBudget.store(0, std::memory_order_relaxed);
    statOversize.store(0, std::memory_order_relaxed);
    statSanitized.store(0, std::memory_order_relaxed);
    statUnderflow.store(0, std::memory_order_relaxed);
    statOverflow.store(0, std::memory_order_relaxed);
    dryRing.clearCounters();
    inRing.clearCounters();
    outRing.clearCounters();
}

void RealtimeProcessor::process(const float* const* input, float* const* output, int numSamples) noexcept {
    if (!ready || output == nullptr || numSamples <= 0)
        return;
    const auto started = std::chrono::steady_clock::now();
    if (statsResetPending.exchange(false, std::memory_order_acq_rel))
        clearStatistics();
    if (resetPending.exchange(false, std::memory_order_acq_rel))
        reset();
    for (int done = 0; done < numSamples;) {
        const int n = std::min(maxBlock, numSamples - done);
        processChunk(input, output, done, n);
        done += n;
    }
    if (numSamples > maxBlock)
        statOversize.fetch_add(1, std::memory_order_relaxed);
    statUnderflow.store(dryRing.underflowFrames() + inRing.underflowFrames() + outRing.underflowFrames(), std::memory_order_relaxed);
    statOverflow.store(dryRing.overflowFrames() + inRing.overflowFrames() + outRing.overflowFrames(), std::memory_order_relaxed);

    const auto elapsed = std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now() - started).count();
    const auto budget = static_cast<int64_t>(static_cast<double>(numSamples) * 1.0e9 / rate);
    statCalls.fetch_add(1, std::memory_order_relaxed);
    statSamples.fetch_add(numSamples, std::memory_order_relaxed);
    statTotalNs.fetch_add(elapsed, std::memory_order_relaxed);
    statBudgetNs.fetch_add(budget, std::memory_order_relaxed);
    statLastNs.store(elapsed, std::memory_order_relaxed);
    if (elapsed > statPeakNs.load(std::memory_order_relaxed))
        statPeakNs.store(elapsed, std::memory_order_relaxed);
    const auto loadPpm = budget > 0 ? static_cast<int64_t>(static_cast<double>(elapsed) * 1.0e6 / static_cast<double>(budget)) : 0;
    if (loadPpm > statPeakLoadPpm.load(std::memory_order_relaxed))
        statPeakLoadPpm.store(loadPpm, std::memory_order_relaxed);
    if (elapsed > budget)
        statOverBudget.fetch_add(1, std::memory_order_relaxed);
}

void RealtimeProcessor::processChunk(const float* const* input, float* const* output, int offset, int n) noexcept {
    // Sanitized copy of the input first, so input and output may be the same buffers.
    int64_t sanitized = 0;
    for (int c = 0; c < channelCount; ++c) {
        const float* src = input != nullptr && input[c] != nullptr ? input[c] + offset : nullptr;
        float* in = inputBuf[c];
        if (src == nullptr) {
            std::fill(in, in + n, 0.0f);
            continue;
        }
        for (int i = 0; i < n; ++i) {
            const float v = src[i];
            if (std::isfinite(v)) {
                in[i] = v;
            } else {
                in[i] = 0.0f;
                ++sanitized;
            }
        }
    }

    // Dry path, delayed by the processor latency so it lines up with the wet path.
    float* const* dry = inputBuf;
    if (latency > 0) {
        dryRing.write(inputBuf, n);
        dryRing.read(dryBuf, n);
        dry = dryBuf;
    }

    // Wet path.
    if (options.blockSize == 0) {
        for (int c = 0; c < channelCount; ++c)
            std::memcpy(wetBuf[c], inputBuf[c], sizeof(float) * static_cast<size_t>(n));
        dsp->process(wetBuf, n);
    } else {
        const int block = options.blockSize;
        for (int fed = 0; fed < n;) {
            const int take = std::min(n - fed, block - inRing.available());
            const float* part[kRealtimeMaxChannels] {};
            for (int c = 0; c < channelCount; ++c)
                part[c] = inputBuf[c] + fed;
            inRing.write(part, take);
            fed += take;
            if (inRing.available() == block) {
                inRing.read(blockBuf, block);
                dsp->process(blockBuf, block);
                outRing.write(blockBuf, block);
            }
        }
        outRing.read(wetBuf, n);
    }
    for (int c = 0; c < channelCount; ++c) {
        float* wet = wetBuf[c];
        for (int i = 0; i < n; ++i) {
            if (!std::isfinite(wet[i])) {
                wet[i] = 0.0f;
                ++sanitized;
            }
        }
    }
    if (sanitized > 0)
        statSanitized.fetch_add(sanitized, std::memory_order_relaxed);

    // Output: wet, dry, or a linear crossfade between the two aligned paths.
    const float target = bypassTarget.load(std::memory_order_acquire) ? 0.0f : 1.0f;
    if (mix == target) {
        float* const* from = target == 1.0f ? wetBuf : dry;
        for (int c = 0; c < channelCount; ++c) {
            if (output[c] != nullptr && output[c] + offset != from[c])
                std::memcpy(output[c] + offset, from[c], sizeof(float) * static_cast<size_t>(n));
        }
        return;
    }
    const float step = 1.0f / static_cast<float>(fadeLength);
    for (int i = 0; i < n; ++i) {
        mix = target > mix ? std::min(target, mix + step) : std::max(target, mix - step);
        for (int c = 0; c < channelCount; ++c) {
            if (output[c] != nullptr)
                output[c][offset + i] = dry[c][i] + mix * (wetBuf[c][i] - dry[c][i]);
        }
    }
}

size_t RealtimeProcessor::bytes() const noexcept {
    return scratch.capacity() * sizeof(float) + dryRing.bytes() + inRing.bytes() + outRing.bytes();
}

RealtimeStats RealtimeProcessor::statistics() const noexcept {
    RealtimeStats stats;
    stats.calls = statCalls.load(std::memory_order_relaxed);
    stats.samples = statSamples.load(std::memory_order_relaxed);
    const auto total = statTotalNs.load(std::memory_order_relaxed);
    const auto budget = statBudgetNs.load(std::memory_order_relaxed);
    stats.lastMs = static_cast<double>(statLastNs.load(std::memory_order_relaxed)) * 1.0e-6;
    stats.peakMs = static_cast<double>(statPeakNs.load(std::memory_order_relaxed)) * 1.0e-6;
    stats.averageMs = stats.calls > 0 ? static_cast<double>(total) * 1.0e-6 / static_cast<double>(stats.calls) : 0.0;
    stats.averageLoad = budget > 0 ? static_cast<double>(total) / static_cast<double>(budget) : 0.0;
    stats.peakLoad = static_cast<double>(statPeakLoadPpm.load(std::memory_order_relaxed)) * 1.0e-6;
    stats.overBudgetCalls = statOverBudget.load(std::memory_order_relaxed);
    stats.oversizeCalls = statOversize.load(std::memory_order_relaxed);
    stats.sanitizedSamples = statSanitized.load(std::memory_order_relaxed);
    stats.underflowFrames = statUnderflow.load(std::memory_order_relaxed);
    stats.overflowFrames = statOverflow.load(std::memory_order_relaxed);
    stats.resets = statResets.load(std::memory_order_relaxed);
    return stats;
}

} // namespace msp
