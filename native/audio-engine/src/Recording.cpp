#include "msp/Recording.h"

#include <juce_core/juce_core.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>

namespace msp {
namespace {
constexpr double kPi = 3.14159265358979323846;
constexpr int kHeaderBytes = 58;   // RIFF + fmt (18-byte IEEE float) + fact + data headers

void putU16(uint8_t* at, uint32_t value) {
    at[0] = static_cast<uint8_t>(value & 0xff);
    at[1] = static_cast<uint8_t>((value >> 8) & 0xff);
}

void putU32(uint8_t* at, uint32_t value) {
    for (int i = 0; i < 4; ++i)
        at[i] = static_cast<uint8_t>((value >> (8 * i)) & 0xff);
}
} // namespace

float virtualInputSample(const VirtualInput& input, double sampleRate, int64_t frame, int channel) {
    if (channel == 0) {
        const double cycles = static_cast<double>(frame) * input.frequency / (sampleRate > 0.0 ? sampleRate : 48000.0);
        const double phase = cycles - std::floor(cycles);
        return static_cast<float>(static_cast<double>(input.level) * std::sin(2.0 * kPi * phase));
    }
    const int64_t step = ((frame % 200) + 200) % 200;
    return static_cast<float>(static_cast<double>(input.level) * (static_cast<double>(step) / 100.0 - 1.0));
}

RecordQueue::RecordQueue(int count) : slots(static_cast<size_t>(std::max(2, count))) {}

void RecordQueue::push(int stream, int64_t frame, const float* left, const float* right, int channels, int frames, int64_t stamp) {
    const int width = channels >= 2 ? 2 : 1;
    int done = 0;
    while (done < frames) {
        const int n = std::min(kRecordSlotFrames, frames - done);
        const uint64_t h = head.load(std::memory_order_relaxed);
        if (h - tail.load(std::memory_order_acquire) >= slots.size()) {
            dropped.fetch_add(frames - done, std::memory_order_acq_rel);
            overflowCount.fetch_add(1, std::memory_order_acq_rel);
            return;
        }
        auto& slot = slots[static_cast<size_t>(h % slots.size())];
        slot.stream = stream;
        slot.channels = width;
        slot.frames = n;
        slot.frame = frame + done;
        slot.stamp = stamp;
        if (width == 1) {
            std::memcpy(slot.data, left + done, sizeof(float) * static_cast<size_t>(n));
        } else {
            for (int i = 0; i < n; ++i) {
                slot.data[i * 2] = left[done + i];
                slot.data[i * 2 + 1] = right[done + i];
            }
        }
        head.store(h + 1, std::memory_order_release);
        done += n;
    }
}

RecordSlot* RecordQueue::front() {
    const uint64_t t = tail.load(std::memory_order_relaxed);
    if (t == head.load(std::memory_order_acquire))
        return nullptr;
    return &slots[static_cast<size_t>(t % slots.size())];
}

void RecordQueue::pop() {
    tail.store(tail.load(std::memory_order_relaxed) + 1, std::memory_order_release);
}

struct TakeFile::Impl {
    juce::File part;
    std::unique_ptr<juce::FileOutputStream> stream;
};

TakeFile::TakeFile() : impl(std::make_unique<Impl>()) {}

TakeFile::~TakeFile() {
    if (impl->stream != nullptr)
        abandon();
}

std::string TakeFile::open(const std::string& path, double sampleRate, int channels) {
    finalPath = path;
    rate = sampleRate;
    channelCount = channels >= 2 ? 2 : 1;
    written = 0;
    gaps = 0;
    impl->part = juce::File(juce::String::fromUTF8((path + ".part").c_str()));
    impl->part.deleteFile();
    impl->stream = std::make_unique<juce::FileOutputStream>(impl->part);
    if (!impl->stream->openedOk()) {
        impl->stream.reset();
        return "Could not create the recording file " + path + ".part.";
    }
    return updateHeader();
}

std::string TakeFile::write(int64_t frame, const float* interleaved, int frames) {
    if (impl->stream == nullptr)
        return "The recording file is not open.";
    if (frame > written) {
        static const float silence[kRecordSlotFrames * 2] {};
        int64_t gap = frame - written;
        gaps += gap;
        while (gap > 0) {
            const int n = static_cast<int>(std::min<int64_t>(gap, kRecordSlotFrames));
            if (!impl->stream->write(silence, sizeof(float) * static_cast<size_t>(n * channelCount)))
                return "Writing the recording file failed. The disk may be full.";
            written += n;
            gap -= n;
        }
    }
    const int64_t skip = std::clamp<int64_t>(written - frame, 0, frames);
    const int64_t count = frames - skip;
    if (count > 0) {
        if (!impl->stream->write(interleaved + skip * channelCount, sizeof(float) * static_cast<size_t>(count * channelCount)))
            return "Writing the recording file failed. The disk may be full.";
        written += count;
    }
    return {};
}

std::string TakeFile::updateHeader() {
    if (impl->stream == nullptr)
        return "The recording file is not open.";
    const uint32_t blockAlign = static_cast<uint32_t>(channelCount * 4);
    const uint64_t dataBytes64 = static_cast<uint64_t>(written) * blockAlign;
    const uint32_t dataBytes = static_cast<uint32_t>(std::min<uint64_t>(dataBytes64, 0xffffffffull - kHeaderBytes));
    uint8_t header[kHeaderBytes] {};
    std::memcpy(header, "RIFF", 4);
    putU32(header + 4, static_cast<uint32_t>(kHeaderBytes - 8) + dataBytes);
    std::memcpy(header + 8, "WAVE", 4);
    std::memcpy(header + 12, "fmt ", 4);
    putU32(header + 16, 18);
    putU16(header + 20, 3);                                     // WAVE_FORMAT_IEEE_FLOAT
    putU16(header + 22, static_cast<uint32_t>(channelCount));
    putU32(header + 24, static_cast<uint32_t>(std::lround(rate)));
    putU32(header + 28, static_cast<uint32_t>(std::lround(rate)) * blockAlign);
    putU16(header + 32, blockAlign);
    putU16(header + 34, 32);
    putU16(header + 36, 0);                                     // cbSize
    std::memcpy(header + 38, "fact", 4);
    putU32(header + 42, 4);
    putU32(header + 46, static_cast<uint32_t>(std::min<int64_t>(written, 0xffffffffLL)));
    std::memcpy(header + 50, "data", 4);
    putU32(header + 54, dataBytes);
    const auto end = impl->stream->getPosition();
    if (!impl->stream->setPosition(0) || !impl->stream->write(header, sizeof(header)))
        return "Updating the recording file header failed.";
    if (end > kHeaderBytes && !impl->stream->setPosition(end))
        return "Updating the recording file header failed.";
    impl->stream->flush();
    return {};
}

std::string TakeFile::finish() {
    if (impl->stream == nullptr)
        return "The recording file is not open.";
    auto error = updateHeader();
    impl->stream.reset();
    if (!error.empty())
        return error;
    juce::File target(juce::String::fromUTF8(finalPath.c_str()));
    if (target.exists())
        return "A file already exists at " + finalPath + ". The take was kept as " + finalPath + ".part.";
    if (!impl->part.moveFileTo(target))
        return "Could not rename the finished take to " + finalPath + ". It was kept as " + finalPath + ".part.";
    return {};
}

void TakeFile::abandon() {
    impl->stream.reset();
    impl->part.deleteFile();
}

TakeRecorder::~TakeRecorder() {
    if (writer.joinable()) {
        stopping.store(true, std::memory_order_release);
        writer.join();
    }
    if (!finished) {
        for (auto& file : files)
            file->abandon();
    }
}

std::string TakeRecorder::begin(const std::vector<TakeSpec>& specs, double sampleRate, int queueSlots, int writerDelayMs) {
    takeSpecs = specs;
    delayMs = std::max(0, writerDelayMs);
    errors.assign(specs.size(), {});
    for (const auto& spec : specs) {
        auto file = std::make_unique<TakeFile>();
        const auto error = file->open(spec.path, sampleRate, spec.channels);
        if (!error.empty()) {
            for (auto& opened : files)
                opened->abandon();
            files.clear();
            return error;
        }
        files.push_back(std::move(file));
    }
    ring = std::make_unique<RecordQueue>(queueSlots);
    writer = std::thread([this] { run(); });
    return {};
}

void TakeRecorder::drain() {
    while (auto* slot = ring->front()) {
        const auto index = static_cast<size_t>(slot->stream);
        if (index < files.size() && errors[index].empty())
            errors[index] = files[index]->write(slot->frame, slot->data, slot->frames);
        ring->pop();
    }
}

void TakeRecorder::run() {
    using clock = std::chrono::steady_clock;
    if (delayMs > 0) {
        const auto until = clock::now() + std::chrono::milliseconds(delayMs);
        while (clock::now() < until && !stopping.load(std::memory_order_acquire))
            std::this_thread::sleep_for(std::chrono::milliseconds(2));
    }
    auto lastHeader = clock::now();
    while (true) {
        const bool last = stopping.load(std::memory_order_acquire);
        drain();
        if (last)
            break;
        if (clock::now() - lastHeader > std::chrono::seconds(1)) {
            for (size_t i = 0; i < files.size(); ++i) {
                if (errors[i].empty())
                    errors[i] = files[i]->updateHeader();
            }
            lastHeader = clock::now();
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }
}

std::vector<TakeResult> TakeRecorder::finish() {
    std::vector<TakeResult> results;
    if (writer.joinable()) {
        stopping.store(true, std::memory_order_release);
        writer.join();
    }
    if (ring != nullptr)
        drain();
    for (size_t i = 0; i < files.size(); ++i) {
        TakeResult result;
        result.spec = takeSpecs[i];
        result.frames = files[i]->frames();
        result.gapFrames = files[i]->gapFrames();
        result.error = errors[i];
        const auto error = files[i]->finish();
        if (result.error.empty())
            result.error = error;
        results.push_back(result);
    }
    finished = true;
    return results;
}

} // namespace msp
