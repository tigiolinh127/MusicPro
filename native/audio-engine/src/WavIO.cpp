#include "msp/WavIO.h"

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_formats/juce_audio_formats.h>

#include <cmath>
#include <memory>

namespace msp {
namespace {
constexpr int64_t kMaxFrames = 48000LL * 60LL * 30LL;

class MemorySource final : public juce::AudioSource {
public:
    MemorySource(const float* leftIn, const float* rightIn, int64_t framesIn)
        : left(leftIn), right(rightIn), frames(framesIn) {}

    void prepareToPlay(int, double) override {}
    void releaseResources() override {}

    void getNextAudioBlock(const juce::AudioSourceChannelInfo& info) override {
        for (int ch = 0; ch < info.buffer->getNumChannels(); ++ch) {
            float* dst = info.buffer->getWritePointer(ch, info.startSample);
            const float* src = ch == 0 ? left : right;
            for (int i = 0; i < info.numSamples; ++i) {
                const int64_t p = position + i;
                dst[i] = (src != nullptr && p >= 0 && p < frames) ? src[p] : 0.0f;
            }
        }
        position += info.numSamples;
    }

    const float* left = nullptr;
    const float* right = nullptr;
    int64_t frames = 0;
    int64_t position = 0;
};
} // namespace

WavInfo probeWavFile(const std::string& path) {
    WavInfo info;
    juce::File file(juce::String::fromUTF8(path.c_str()));
    info.fileBytes = file.existsAsFile() ? file.getSize() : 0;
    if (!file.existsAsFile()) {
        info.error = "Audio file not found: " + path;
        return info;
    }
    if (info.fileBytes <= 0) {
        info.error = "The audio file is empty.";
        return info;
    }
    if (!file.getFileExtension().equalsIgnoreCase(".wav")) {
        info.error = "Only WAV files are supported.";
        return info;
    }
    juce::AudioFormatManager formats;
    formats.registerBasicFormats();
    std::unique_ptr<juce::AudioFormatReader> reader(formats.createReaderFor(file));
    if (reader == nullptr) {
        info.error = "Could not read this WAV file. It may be corrupt or use an unsupported encoding.";
        return info;
    }
    if (!reader->getFormatName().containsIgnoreCase("WAV")) {
        info.error = "Only WAV files are supported.";
        return info;
    }
    if (reader->sampleRate <= 0.0 || reader->numChannels < 1) {
        info.error = "The WAV file does not contain a usable sample rate or channel count.";
        return info;
    }
    if (reader->lengthInSamples <= 0) {
        info.error = "The WAV file contains no audio samples.";
        return info;
    }
    info.sampleRate = reader->sampleRate;
    info.sourceChannels = static_cast<int>(reader->numChannels);
    info.bitsPerSample = static_cast<int>(reader->bitsPerSample);
    info.frames = reader->lengthInSamples;
    info.durationSeconds = static_cast<double>(reader->lengthInSamples) / reader->sampleRate;
    return info;
}

PcmStereo readWavFile(const std::string& path) {
    PcmStereo pcm;
    juce::File file(juce::String::fromUTF8(path.c_str()));
    if (!file.existsAsFile()) {
        pcm.error = "Audio file not found: " + path;
        return pcm;
    }
    if (!file.getFileExtension().equalsIgnoreCase(".wav")) {
        pcm.error = "Only WAV files can be imported in Phase 0.";
        return pcm;
    }

    juce::AudioFormatManager formats;
    formats.registerBasicFormats();
    std::unique_ptr<juce::AudioFormatReader> reader(formats.createReaderFor(file));
    if (reader == nullptr) {
        pcm.error = "Could not decode this WAV file. It may be corrupt or use an unsupported encoding.";
        return pcm;
    }
    if (!reader->getFormatName().containsIgnoreCase("WAV")) {
        pcm.error = "Only WAV files can be imported in Phase 0.";
        return pcm;
    }
    if (reader->sampleRate <= 0.0 || reader->numChannels < 1) {
        pcm.error = "The WAV file does not contain a usable sample rate or channel count.";
        return pcm;
    }
    if (reader->lengthInSamples <= 0) {
        pcm.error = "The WAV file contains no audio samples.";
        return pcm;
    }
    if (reader->lengthInSamples > kMaxFrames) {
        pcm.error = "This WAV file is longer than 30 minutes. Phase 0 loads the whole file into memory.";
        return pcm;
    }

    const int frames = static_cast<int>(reader->lengthInSamples);
    juce::AudioBuffer<float> buffer(static_cast<int>(reader->numChannels), frames);
    if (!reader->read(&buffer, 0, frames, 0, true, true)) {
        pcm.error = "Failed while decoding the WAV file.";
        return pcm;
    }

    pcm.sampleRate = reader->sampleRate;
    pcm.sourceChannels = static_cast<int>(reader->numChannels);
    pcm.bitsPerSample = static_cast<int>(reader->bitsPerSample);
    pcm.left.assign(static_cast<size_t>(frames), 0.0f);
    pcm.right.assign(static_cast<size_t>(frames), 0.0f);
    const float* srcL = buffer.getReadPointer(0);
    const float* srcR = buffer.getNumChannels() > 1 ? buffer.getReadPointer(1) : srcL;
    for (int i = 0; i < frames; ++i) {
        pcm.left[static_cast<size_t>(i)] = srcL[i];
        pcm.right[static_cast<size_t>(i)] = srcR[i];
    }
    return pcm;
}

std::string writeWavFile(const std::string& path,
                         double sampleRate,
                         const float* left,
                         const float* right,
                         int64_t frames,
                         int bitsPerSample,
                         int channels) {
    if (sampleRate < 8000.0 || sampleRate > 192000.0)
        return "Export sample rate must be between 8000 and 192000 Hz.";
    if (channels != 1 && channels != 2)
        return "WAV files can be written as mono or stereo only.";
    if (frames < 0 || (frames > 0 && (left == nullptr || (channels == 2 && right == nullptr))))
        return "Export was given an empty mix buffer.";
    if (bitsPerSample != 16 && bitsPerSample != 24 && bitsPerSample != 32)
        return "Export bit depth must be 16, 24, or 32.";

    juce::File file(juce::String::fromUTF8(path.c_str()));
    auto parent = file.getParentDirectory();
    if (!parent.exists() && !parent.createDirectory())
        return "Could not create the export folder.";

    std::unique_ptr<juce::OutputStream> stream = std::make_unique<juce::FileOutputStream>(file);
    auto* fileStream = static_cast<juce::FileOutputStream*>(stream.get());
    if (fileStream == nullptr || !fileStream->openedOk())
        return "Could not open the export file for writing.";
    fileStream->setPosition(0);
    fileStream->truncate();

    juce::WavAudioFormat wav;
    auto writer = wav.createWriterFor(stream,
                                      juce::AudioFormatWriterOptions {}
                                          .withSampleRate(sampleRate)
                                          .withNumChannels(channels)
                                          .withBitsPerSample(bitsPerSample));
    if (writer == nullptr)
        return channels == 2 ? "Could not create a stereo WAV writer for that path." : "Could not create a mono WAV writer for that path.";

    constexpr int kBlock = 2048;
    juce::AudioBuffer<float> block(channels, kBlock);
    int64_t done = 0;
    while (done < frames) {
        const int n = static_cast<int>(std::min<int64_t>(kBlock, frames - done));
        for (int i = 0; i < n; ++i) {
            block.setSample(0, i, left[done + i]);
            if (channels == 2)
                block.setSample(1, i, right[done + i]);
        }
        if (!writer->writeFromAudioSampleBuffer(block, 0, n))
            return "Writing the WAV file failed before it finished.";
        done += n;
    }
    writer.reset();
    return {};
}

PcmStereo resampleStereo(const float* left,
                         const float* right,
                         int64_t frames,
                         double sourceRate,
                         double destRate) {
    PcmStereo out;
    if (frames < 0 || sourceRate <= 0.0 || destRate <= 0.0) {
        out.error = "Cannot resample audio with an invalid length or sample rate.";
        return out;
    }
    out.sampleRate = destRate;
    out.sourceChannels = 2;
    if (frames == 0)
        return out;

    if (std::abs(sourceRate - destRate) < 0.5) {
        out.left.assign(left, left + frames);
        out.right.assign(right, right + frames);
        return out;
    }

    const double ratio = sourceRate / destRate;
    const int64_t outFrames64 = std::max<int64_t>(1, static_cast<int64_t>(std::llround(static_cast<double>(frames) / ratio)));
    if (outFrames64 > kMaxFrames) {
        out.error = "Resampling this file would exceed the 30 minute memory limit.";
        return out;
    }
    const int outFrames = static_cast<int>(outFrames64);
    out.left.assign(static_cast<size_t>(outFrames), 0.0f);
    out.right.assign(static_cast<size_t>(outFrames), 0.0f);

    MemorySource memory(left, right, frames);
    juce::ResamplingAudioSource resampler(&memory, false, 2);
    resampler.setResamplingRatio(ratio);
    resampler.prepareToPlay(512, destRate);

    juce::AudioBuffer<float> block(2, 512);
    int done = 0;
    while (done < outFrames) {
        const int n = std::min(512, outFrames - done);
        block.clear();
        juce::AudioSourceChannelInfo info(&block, 0, n);
        resampler.getNextAudioBlock(info);
        for (int i = 0; i < n; ++i) {
            out.left[static_cast<size_t>(done + i)] = block.getSample(0, i);
            out.right[static_cast<size_t>(done + i)] = block.getSample(1, i);
        }
        done += n;
    }
    resampler.releaseResources();
    return out;
}

} // namespace msp
