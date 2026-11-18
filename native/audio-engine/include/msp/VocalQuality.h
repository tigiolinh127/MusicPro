#pragma once

#include "msp/Fft.h"

#include <complex>
#include <cstdint>
#include <string>
#include <vector>

namespace msp {

// Vocal quality options shared by offline pitch shifting and automatic correction (not realtime).
//
// Both processors stretch the audio with a phase vocoder and then resample it by the pitch ratio r,
// which scales the whole spectrum - including the spectral envelope (formants) - by r. With
// formant handling on, every vocoder frame is multiplied by a real gain per bin so that, after the
// resampling, the envelope ends up at the source envelope scaled by `target`:
//   target = (preserveFormants ? 1 : r) * 2^(formantShiftSemitones / 12)
//   gain(k) = E(k * r / target) / E(k)
// where E is the frame's spectral envelope: the loudest bin of every harmonic-wide band joined in
// log magnitude (SEEVOC peak envelope) and smoothed by cepstral liftering below the pitch period;
// High quality refines it with "true envelope" iterations. The same gain is applied to every
// channel, so levels and inter-channel phase are kept.

inline constexpr double kFormantShiftMaxSemitones = 12.0;

struct VocalQuality {
    bool preserveFormants = false;
    double formantShiftSemitones = 0.0;   // -12..12, moves the envelope independently of the pitch
    bool high = false;                    // 8x vocoder overlap and true-envelope estimation
    bool protectTransients = false;       // attacks from near-silence are taken from the input
};

std::string checkVocalQuality(const VocalQuality& quality);
// r / target: the frequency scale at which the source envelope is read (1 = no envelope change).
double envelopeScale(const VocalQuality& quality, double ratio);
bool changesEnvelope(const VocalQuality& quality, double ratio);
inline int vocoderOverlap(const VocalQuality& quality) { return quality.high ? 8 : 4; }

// Per-frame spectral envelope estimation and compensation gains.
class EnvelopeShaper {
public:
    std::string prepare(int fftSize, double sampleRate, bool trueEnvelope);
    // `magnitude` (fftSize / 2 + 1 bins) is the frame magnitude summed over channels; the frame is
    // resampled by `ratio` afterwards. Fills `gain` (same size) and returns true, or returns false
    // when the envelope does not change. Gains are limited to -36..+18 dB, and the frame energy
    // that survives resampling is kept (within +-12 dB), so valleys are never boosted without bound.
    bool compute(const std::vector<double>& magnitude, double ratio, double scale, std::vector<double>& gain);
    int lifter() const { return static_cast<int>(smoothedLifter + 0.5); }
    int64_t bytes() const;

private:
    void smooth(int cutoff, std::vector<double>& envelope);   // lifters `cepstrum` into a log envelope

    Fft fft;
    int n = 0;
    int bins = 0;
    double rate = 0.0;
    bool iterate = false;
    int lowQuefrency = 0;
    int highQuefrency = 0;
    int minLifter = 0;
    int maxLifter = 0;
    int defaultLifter = 0;
    double smoothedLifter = 0.0;
    std::vector<double> logMagnitude;
    std::vector<double> fitted;
    std::vector<double> envelope;
    std::vector<std::complex<double>> cepstrum;
    std::vector<std::complex<double>> work;
};

// Attacks that rise from near-silence (at least 18 dB above the previous 20 ms and above -50 dBFS)
// are taken from the input instead of the vocoder output: from `preSamples` before the attack
// (where the vocoder window would smear it backwards as pre-echo) to 5 ms after it, with a 3 ms
// raised-cosine fade in and a 10 ms fade out. The input is quiet before such an attack, so the
// pre-echo is removed without adding silence.
class TransientGuard {
public:
    void prepare(const float* left, const float* right, int64_t frames, double sampleRate, int64_t preSamples);
    // Share of the input at sample n (0..1). Calls should be mostly increasing.
    float weight(int64_t n);
    const std::vector<int64_t>& onsets() const { return attacks; }

private:
    std::vector<int64_t> attacks;
    int64_t pre = 0;
    int64_t hold = 0;
    int64_t fadeIn = 0;
    int64_t fadeOut = 0;
    size_t cursor = 0;
};

} // namespace msp
