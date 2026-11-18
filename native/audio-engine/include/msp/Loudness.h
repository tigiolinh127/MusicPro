#pragma once

#include <atomic>
#include <cstdint>
#include <functional>
#include <string>
#include <vector>

namespace msp {

// ITU-R BS.1770-4 / EBU R128 offline loudness of a rendered WAV (control / worker thread only).
constexpr int kTruePeakOversample = 4;          // documented oversampling for dBTP
constexpr double kMomentarySeconds = 0.400;     // BS.1770 momentary
constexpr double kShortTermSeconds = 3.0;       // BS.1770 short-term
constexpr double kBlockHopSeconds = 0.100;      // 75% overlap on 400 ms blocks
constexpr double kAbsGateLufs = -70.0;          // absolute gate
constexpr double kRelGateLu = -10.0;            // relative gate (integrated)
constexpr double kLraRelGateLu = -20.0;         // EBU Tech 3342 relative gate for LRA

struct LoudnessReport {
    bool available = false;           // false → measurements undefined (silence / too short / error)
    bool cancelled = false;
    std::string error;
    std::string path;
    double sampleRate = 0.0;
    int channels = 0;
    int64_t frames = 0;
    double durationSeconds = 0.0;

    bool integratedValid = false;
    double integratedLufs = 0.0;

    bool momentaryValid = false;
    double momentaryLufs = 0.0;       // last / overall max momentary (documented as max over file)

    bool shortTermValid = false;
    double shortTermLufs = 0.0;       // max short-term over file

    bool lraValid = false;
    double lraLu = 0.0;

    bool samplePeakValid = false;
    double samplePeakDbFs = 0.0;      // max |sample| over channels

    bool truePeakValid = false;
    double truePeakDbTp = 0.0;        // 4× oversampled peak

    bool clippingSample = false;      // sample peak ≥ 0 dBFS (−0.001 dB tol)
    bool clippingTruePeak = false;    // true peak ≥ 0 dBTP
};

// Analyzes interleaved-free L/R buffers (mono: pass same pointer or nullptr right with channels=1).
// Progress callback optional; cancel may be null. Returns unavailable report for silence / short files.
LoudnessReport analyzeLoudness(const float* left,
                               const float* right,
                               int64_t frames,
                               double sampleRate,
                               int channels,
                               std::atomic<bool>* cancel = nullptr,
                               const std::function<void(int64_t done, int64_t total)>& progress = {});

// Loads a WAV via WavIO then analyzes. Empty / missing / corrupt files set error.
LoudnessReport analyzeLoudnessFile(const std::string& path,
                                   std::atomic<bool>* cancel = nullptr,
                                   const std::function<void(int64_t done, int64_t total)>& progress = {});

// Analytic K-weighting magnitude at `hz` (same biquads as the analyzer) for fixture tolerances.
double kWeightingMagnitudeDb(double sampleRate, double hz);

} // namespace msp
