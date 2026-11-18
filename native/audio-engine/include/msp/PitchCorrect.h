#pragma once

#include "msp/NoteSegments.h"
#include "msp/Pitch.h"
#include "msp/VocalQuality.h"

#include <atomic>
#include <cstdint>
#include <functional>
#include <string>
#include <vector>

namespace msp {

// Offline automatic pitch correction with a pitch ratio that changes over time (not realtime).
//
// A correction curve (cents per point, one point every kCorrectionControlStep samples) defines
// the ratio r(t) = 2^(cents / 1200) and a time warp tau(t) = integral of r. A phase vocoder with
// identity phase locking places each analysis frame, taken at an integer input position a, at the
// warped position tau(a) (fractional placement through a linear phase ramp; overlap-add is
// normalised by the summed window). This stretches each stretch of audio by its own r with
// continuous phase across ratio changes. A windowed-sinc resampler with a per-sample cutoff then
// reads the warped signal at tau(n) for every output sample n, which scales the local spectrum by
// r(n) and returns to the original timing, so the output has exactly as many samples as the input.
// Where the curve's mix weight is 0 (outside corrected notes) the input samples are copied.
// Vocal quality options (VocalQuality.h) compensate each vocoder frame's spectral envelope for the
// local ratio, and protected attacks lower the mix weight to 0 around attacks from near-silence.

inline constexpr double kRetuneMaxMs = 200.0;
inline constexpr double kCorrectionMaxCents = 1200.0;
inline constexpr int kCorrectionControlStep = 32;      // samples per curve point
inline constexpr double kCorrectionFadeSeconds = 0.010; // crossfade between original and corrected
inline constexpr double kCorrectionReleaseSeconds = 0.005; // time constant back to no correction after a note

struct CorrectionNote {
    double start = 0.0;       // corrected span, seconds from the start of the analysed audio
    double end = 0.0;
    int firstFrame = 0;       // analysis frames whose pitch is measured (inclusive)
    int lastFrame = -1;
    int targetMidi = 60;
};

struct CorrectionSettings {
    double retuneMs = 20.0;   // 0..200: time for the correction to reach 95% of a change
    double strength = 1.0;    // 0..1: fraction of the way to the target note
    VocalQuality quality;     // all off: the Phase 2.4.4 processing
};

inline constexpr double kOctaveRejectSemitones = 5.0;   // frames this far from the note's median are ignored
inline constexpr double kGlideMinSeconds = 0.15;        // shorter notes are never treated as glides
inline constexpr double kGlideMinSlope = 3.0;           // semitones per second
inline constexpr double kGlideMinTravel = 1.0;          // semitones across the note
inline constexpr double kGlideMinFit = 0.7;             // share of the pitch variance explained by the line

std::string checkCorrectionSettings(const CorrectionSettings& settings);

// Turns note segments and their target notes (-1 = leave alone) into corrected spans. Spans are
// widened by `edgeSeconds` on each side (the part of the analysis window outside the first and
// last voiced frame) but never past the midpoint to a neighbouring note.
std::vector<CorrectionNote> correctionNotes(const std::vector<NoteSegment>& segments, const std::vector<int>& targets,
                                            double edgeSeconds);

struct CorrectionCurve {
    double sampleRate = 0.0;
    int64_t frames = 0;           // samples covered: the whole processed buffer
    std::vector<float> cents;     // pitch change at each point
    std::vector<float> goal;      // unsmoothed wanted change at each point inside a note (x strength)
    std::vector<float> mix;       // 0 = original audio, 1 = corrected; raised-cosine ramps
    bool identity = true;         // nothing changes: the output is a copy of the input
    double maxAbsCents = 0.0;
    VocalQuality quality;
    std::vector<size_t> glideNotes;   // indices into the notes: left uncorrected as glides
    int octaveFrames = 0;             // frames ignored as octave (or larger) detection errors
};

// `frames` are YIN frames of the analysed audio, which starts `offsetSeconds` into a buffer of
// `totalFrames` samples. Inside a note the wanted correction is target - measured pitch, where the
// measured pitch is the median of five neighbouring voiced frames (isolated detection errors are
// ignored) interpolated over time. Frames more than kOctaveRejectSemitones from the note's median
// are dropped first (octave errors). It is smoothed in audio time by a one-pole filter with time
// constant retuneMs / 3 (at least 1 ms); after a note it returns to 0 with a 5 ms time constant.
// Strength scales the result. Unvoiced audio outside notes gets no correction and mix 0.
// A note of at least kGlideMinSeconds whose pitch follows a straight line (fit >= kGlideMinFit) at
// >= kGlideMinSlope st/s over >= kGlideMinTravel semitones is a glide: forcing it to one note
// would turn it into a step, so it is left uncorrected and listed in glideNotes.
// With a formant shift, every note's span is processed even when its pitch needs no change.
CorrectionCurve buildCorrectionCurve(const std::vector<PitchFrame>& frames, const std::vector<CorrectionNote>& notes,
                                     const CorrectionSettings& settings, double sampleRate, int64_t totalFrames,
                                     double offsetSeconds);

struct PitchCorrectResult {
    std::string error;
    bool cancelled = false;
    bool identity = false;            // copied without processing
    std::vector<float> left;
    std::vector<float> right;         // empty for mono
    double gainReductionDb = 0.0;     // > 0 when the whole output was scaled down to avoid clipping
    int64_t repairedSamples = 0;      // NaN or infinite input samples, treated as silence
    double inputPeak = 0.0;
    double outputPeak = 0.0;
    int64_t vocoderFrames = 0;        // analysed and resynthesised
    int64_t skippedFrames = 0;        // far from any correction, not computed
    int64_t copiedSamples = 0;        // output samples copied from the input (mix 0)
    int64_t workingBytes = 0;         // peak size of the curve, vocoder and resampler buffers
    int64_t envelopeFrames = 0;       // vocoder frames whose spectral envelope was compensated
    int transients = 0;               // protected attacks
};

// Corrects `frames` samples per channel along `curve` (which must cover `frames`). The first `lead`
// and last `tail` samples are context and are cropped from the output. Never modifies the input.
PitchCorrectResult pitchCorrect(const float* left, const float* right, int64_t frames, int channels, double sampleRate,
                                const CorrectionCurve& curve, int64_t lead = 0, int64_t tail = 0,
                                const std::atomic<bool>* cancel = nullptr,
                                const std::function<void(double)>& progress = {});

} // namespace msp
