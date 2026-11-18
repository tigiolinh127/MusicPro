#pragma once

#include "msp/Fft.h"

#include <atomic>
#include <cstdint>
#include <string>
#include <vector>

namespace msp {

// Phase 2.8.3 — realtime spectrum capture + control-thread FFT.
// Audio thread only writes into a preallocated ring (no alloc / locks / FFT).
// Control thread (timer) snapshots, windows, FFTs, and smooths magnitudes.

inline constexpr int kSpectrumFftSize = 2048;
inline constexpr int kSpectrumRingSize = 8192;   // power of two, > FFT
inline constexpr int kSpectrumDisplayBins = 128; // log-spaced display bins
inline constexpr float kSpectrumSmooth = 0.65f;  // EMA toward new frame (0..1, higher = stickier)

enum class SpectrumTapKind : int {
    none = 0,
    track = 1,
    bus = 2,
    master = 3
};

// Lock-free mono ring. Single producer (audio), single consumer (control).
struct SpectrumCapture {
    std::atomic<uint32_t> writeIndex { 0 };
    float buffer[kSpectrumRingSize] {};

    // Realtime-safe: push (L+R)/2 samples. Overwrites oldest when full.
    void writeStereo(const float* left, const float* right, int n) noexcept;
    // Control thread: copy the newest `count` samples into `out` (must be >= count).
    // Returns false if not enough history yet.
    bool latest(float* out, int count) const noexcept;
    void clear() noexcept;
};

class SpectrumAnalyzer {
public:
    std::string prepare(int fftSize = kSpectrumFftSize);
    int fftSize() const { return fft.size(); }

    // Control thread only. Fills `outDb` with kSpectrumDisplayBins dB values (or clears if silent).
    // `available` is false when the device/tap is off — caller should not invent data.
    bool process(const SpectrumCapture& capture, double sampleRate, bool available,
                 std::vector<float>& outDb, std::vector<float>& outHz);

private:
    Fft fft;
    std::vector<std::complex<double>> spectrum;
    std::vector<float> window;
    std::vector<float> timeDomain;
    std::vector<float> magDb;
    bool primed = false;
};

} // namespace msp
