#pragma once

#include "msp/Fft.h"

#include <atomic>
#include <complex>
#include <cstdint>
#include <functional>
#include <string>
#include <vector>

namespace msp {

// Vocal pitch detection (YIN, de Cheveigné & Kawahara 2002) on mono audio. Analysis only: it
// never writes to the samples it reads and is not part of playback or export.

struct PitchParams {
    double minHz = 70.0;                // lowest detectable fundamental
    double maxHz = 1000.0;              // highest detectable fundamental
    int windowSize = 2048;              // analysis window in samples
    int hopSize = 512;                  // distance between window starts in samples
    double confidenceThreshold = 0.85;  // voiced when confidence >= this (YIN threshold = 1 - this)
    double silenceDb = -60.0;           // windows quieter than this (RMS, dBFS) are unvoiced
};

inline constexpr double kPitchMinSampleRate = 8000.0;
inline constexpr double kPitchMaxSampleRate = 192000.0;
inline constexpr double kPitchLowestHz = 30.0;
inline constexpr double kPitchHighestHz = 4000.0;
inline constexpr int kPitchMinWindow = 256;
inline constexpr int kPitchMaxWindow = 16384;
inline constexpr int kPitchMinHop = 16;

// Returns an error message, or "" when the parameters are usable at this sample rate.
std::string checkPitchParams(const PitchParams& params, double sampleRate);

// Fractional MIDI note (A4 = 440 Hz = 69). Returns 0 for frequencies <= 0.
double midiFromFrequency(double hz);
// "C4", "A#3", ... (sharps, middle C = C4). "" outside 0..127.
std::string noteName(int midi);

struct PitchFrame {
    double time = 0.0;        // centre of the analysis window, seconds from the start of the input
    double frequency = 0.0;   // Hz; 0 when unvoiced
    int midi = -1;            // nearest MIDI note; -1 when unvoiced
    double cents = 0.0;       // deviation from that note, -50..50; 0 when unvoiced
    double confidence = 0.0;  // 1 - YIN aperiodicity of the best period, 0..1 (0 for silence)
    double levelDb = -200.0;  // RMS of the window, dBFS
    bool voiced = false;
};

// One analysis window at a time. prepare() allocates; analyze() does not allocate, lock or
// perform I/O, so a prepared detector could run on any thread.
class PitchDetector {
public:
    std::string prepare(double sampleRate, const PitchParams& params);
    // Reads exactly windowSize() samples. `time` is copied into the result.
    PitchFrame analyze(const float* window, double time);

    int windowSize() const { return params.windowSize; }
    int hopSize() const { return params.hopSize; }
    double sampleRate() const { return rate; }

private:
    PitchParams params;
    double rate = 0.0;
    int tauMin = 0;
    int tauMax = 0;
    int integration = 0;   // YIN integration length W = windowSize - tauMax - 1
    int fftSize = 0;
    std::vector<std::complex<double>> spectrumA;
    std::vector<std::complex<double>> spectrumX;
    Fft fft;
    std::vector<double> energy;   // prefix sums of x^2
    std::vector<double> diff;
    std::vector<double> cmnd;
};

// Consecutive voiced frames on the same nearest MIDI note.
struct PitchNote {
    double start = 0.0;       // seconds
    double end = 0.0;
    int midi = -1;
    std::string name;
    double frequency = 0.0;   // mean of the frames
    double cents = 0.0;       // mean of the frames
    double confidence = 0.0;  // mean of the frames
    int frames = 0;
};

struct PitchAnalysis {
    std::string error;
    bool cancelled = false;
    double sampleRate = 0.0;
    PitchParams params;
    std::vector<PitchFrame> frames;
    std::vector<PitchNote> notes;
};

// Number of analysis windows for `count` samples (0 when shorter than one window).
int64_t pitchFrameCount(int64_t count, const PitchParams& params);

// Offline analysis of a mono buffer. `cancel` is polled before every window; on cancel the
// frames analysed so far are kept and `cancelled` is set. `progress(done, total)` is called
// after every window.
PitchAnalysis analyzePitch(const float* samples, int64_t count, double sampleRate, const PitchParams& params,
                           const std::atomic<bool>* cancel = nullptr,
                           const std::function<void(int64_t, int64_t)>& progress = {});

std::vector<PitchNote> pitchNotes(const std::vector<PitchFrame>& frames, double hopSeconds);

} // namespace msp
