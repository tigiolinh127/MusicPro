#pragma once

#include "msp/VocalQuality.h"

#include <atomic>
#include <cstdint>
#include <functional>
#include <string>
#include <vector>

namespace msp {

// Offline, duration-preserving pitch shifting of whole buffers (not realtime).
//
// A phase vocoder with identity phase locking (Laroche & Dolson 1999) and a phase reset on
// energy onsets stretches the audio in time by the pitch ratio p; a windowed-sinc resampler then
// reads the stretched signal at p samples per output sample. The output has exactly as many
// samples as the input and its spectrum is scaled by p. Resampling alone would change the
// duration; the stretch is what keeps it.

inline constexpr int kPitchShiftMaxSemitones = 12;
inline constexpr double kPitchShiftMaxCents = 100.0;

struct PitchShiftSettings {
    int semitones = 0;    // -12..12
    double cents = 0.0;   // -100..100, added to the semitones
    VocalQuality quality; // all off: the Phase 2.4.2 processing
};

// Returns an error message, or "" when the settings can be processed.
std::string checkPitchShift(const PitchShiftSettings& settings, double sampleRate, int channels);
// 2^((semitones + cents / 100) / 12).
double pitchShiftRatio(const PitchShiftSettings& settings);
// No pitch change and no formant shift: the audio is copied.
bool isIdentityShift(const PitchShiftSettings& settings);
// Phase-vocoder frame size used at this sample rate (2048 up to 50 kHz, doubled per octave above).
int pitchShiftFrameSize(double sampleRate);

struct PitchShiftResult {
    std::string error;
    bool cancelled = false;
    bool identity = false;          // zero shift: the input was copied without processing
    std::vector<float> left;
    std::vector<float> right;       // empty for mono
    double ratio = 1.0;
    double gainReductionDb = 0.0;   // > 0 when the whole output was scaled down to avoid clipping
    int64_t repairedSamples = 0;    // NaN or infinite input samples, treated as silence
    double inputPeak = 0.0;         // of the returned region, before and after processing
    double outputPeak = 0.0;
    int64_t envelopeFrames = 0;     // vocoder frames whose spectral envelope was compensated
    int transients = 0;             // attacks taken from the input
    int64_t workingBytes = 0;       // vocoder, envelope and resampler buffers (not input/output)
};

// Shifts `frames` samples per channel (`right` is ignored when channels == 1). The first `lead`
// and last `tail` frames are context: they are analysed so the region edges are clean, then
// cropped, so each output channel holds frames - lead - tail samples aligned with the input.
// `cancel` is polled between vocoder frames; `progress(fraction)` is called every few thousand
// output samples. Never modifies the input.
PitchShiftResult pitchShift(const float* left, const float* right, int64_t frames, int channels,
                            double sampleRate, const PitchShiftSettings& settings,
                            int64_t lead = 0, int64_t tail = 0,
                            const std::atomic<bool>* cancel = nullptr,
                            const std::function<void(double)>& progress = {});

} // namespace msp
