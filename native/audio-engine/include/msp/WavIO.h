#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace msp {

struct PcmStereo {
    double sampleRate = 0.0;
    int sourceChannels = 0;
    int bitsPerSample = 0;
    std::vector<float> left;
    std::vector<float> right;
    std::string error;
};

// Header/metadata only — does not decode sample data into memory.
struct WavInfo {
    double sampleRate = 0.0;
    int sourceChannels = 0;
    int bitsPerSample = 0;
    int64_t frames = 0;
    double durationSeconds = 0.0;
    int64_t fileBytes = 0;
    std::string error;
};

WavInfo probeWavFile(const std::string& path);
PcmStereo readWavFile(const std::string& path);
std::string writeWavFile(const std::string& path,
                         double sampleRate,
                         const float* left,
                         const float* right,
                         int64_t frames,
                         int bitsPerSample,
                         int channels = 2);   // 1 writes `left` only; 32 bits is IEEE float

// Allocates. Call only from the control thread or tests.
PcmStereo resampleStereo(const float* left,
                         const float* right,
                         int64_t frames,
                         double sourceRate,
                         double destRate);

} // namespace msp
