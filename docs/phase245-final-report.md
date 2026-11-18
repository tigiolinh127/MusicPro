# Phase 2.4.5 — Vocal Quality & Formant Preservation: final report

Status: implemented and verified with targeted tests on **synthetic vowel-like signals**. No
listening test and no real vocal recording was used, so this report does **not** claim
professional vocal quality. Formant preservation is approximate (see Limitations).

## 1. Audit (what is reused)

- `PitchShift.cpp` — the phase-vocoder `Stretcher` (Hann, phase locking, sanitising reads) plus
  the resampler of the manual shift. The envelope correction is inserted into its synthesis loop.
- `PitchCorrect.cpp` — the time-varying `VarStretcher` + `Warp` of automatic correction; the
  per-frame ratio already known there (`warp->ratioAt`) gives the per-frame envelope scale.
- `Fft` (shared FFT used by both) — also used for the cepstrum.
- Onset detection: the energy-ratio idea of `PitchAnalysis` segmentation is reused as a dedicated
  sample-domain detector (`TransientGuard`) because the analysis hop (10.7 ms) is too coarse to
  keep an attack crisp.
- Engine job model (async thread, progress, cancel, `processedFolder`, preview/apply/revert,
  undo/redo, project save/load, source WAV protection) — unchanged; the new settings are simply
  additional request fields and label suffixes.
- The realtime audio callback is **not** touched.

## 2. DSP

### 2.1 Formant preservation (spectral envelope compensation)

For each vocoder frame:

1. Log magnitude `logM` (floored at loudest bin · 1e-5).
2. Envelope `E`:
   - **Standard**: cepstral pitch period P (first peak ≥ 0.6 × max, voicing threshold 0.1) → lifter
     0.6·P (clamped, smoothed 0.7/0.3 across frames). A SEEVOC-style peak envelope (maximum of each
     harmonic-wide band, linearly interpolated in log magnitude) is then cepstrally smoothed with
     that lifter. Pure cepstral averaging under-estimated formant peaks by ~10%; the peak envelope
     brought the envelope error down to 0.8–1.5 dB.
   - **High**: Standard plus true-envelope refinement (start max(logM, E), up to 16 iterations,
     stop within 2 dB) and 8× vocoder overlap instead of 4×.
3. Target scale: `target = (preserve ? 1 : r) · 2^(formantShift/12)`, `scale = r / target`
   (r = pitch ratio). Gain per bin `g(k) = exp(E(k·scale) − E(k))`, clamped to −36…+18 dB, so the
   resampler's later frequency move by r leaves the envelope at `target`.
4. Energy normalisation over the bins that survive the resampler (±12 dB clamp).
5. The **same gain is applied to all channels** (stereo coherence: level panning is preserved
   exactly; R = 0.7·L stays 0.7·L within 1.2e-7).

Preserve OFF with formant shift 0 skips the shaper entirely: output is identical to the Phase 2.4.4
path (tested bit-exact via default settings).

### 2.2 Transient protection

`TransientGuard`: 2.5 ms blocks; onset when energy > 4× the prior 20 ms maximum, the next 10 ms
reach ≥ 1e-5 and ≥ 18 dB above the prior; refractory 50 ms. A weight is 1 from (onset − pre) to
onset + 5 ms with a 3 ms raised-cosine fade-in and 10 ms fade-out.
- Manual shift: pre = ceil(N/2 / min(1, r)); output = (1−w)·shifted + w·input.
- Auto correction: pre = N/2; effective dry/wet mix = mix·(1−w).

This removes vocoder pre-echo before plosives/onsets and keeps the attack unsmeared; no attacks are
detected inside legato note changes or vibrato (tested).

### 2.3 Vibrato, glides, octave errors (automatic correction curve)

- Frames > 5 st from the note median are dropped before smoothing (`octaveFrames`), so a short
  octave mis-detection cannot cause an octave jump.
- Glide detection: span ≥ 0.15 s, ≥ 5 frames, |slope| ≥ 3 st/s, travel ≥ 1 st, linear fit R² ≥ 0.7.
  Such notes are left uncorrected (`glideNotes`) instead of being snapped stepwise. Vibrato (no net
  slope), short scoops into held notes and short notes are still corrected.
- Vibrato at slow retune is kept (200 ms: depth 20.3 → 19.7 c). Fast retune (0 ms) flattens it by
  design (depth 4.3 c).

### 2.4 The "20 ms retune → 42 ms transition" investigation

Measured, not assumed (test `vocal-retune-timing`, IPC test `ipc-vocal-defaults-retune-timing`):

| Note | transitionMs (old metric) | responseMs (curve vs its goal) | goal settles after | output lag vs curve |
| --- | --- | --- | --- | --- |
| A3 +40 c | 18.0 ms | 19.3 ms | 0.0 ms | −2.00 ms |
| D4 −20 c | 42.0 ms | 19.3 ms | 34.7 ms | +0.75 ms |

The first YIN frames of D4 straddle the onset and read 4.5 c and 2.4 c (true −20 c), so the
**goal** (target − detected pitch) at the span start is 17.6 c instead of 20.0 c, and only settles
after 34.7 ms. The curve itself follows its goal in 19.3 ms (≈ the 20 ms setting), and the output
pitch follows the curve within ±2 ms. **Conclusion: an analysis-window measurement effect at the
note onset, not DSP latency and not an engine bug.** The engine now reports `responseMs` and
`goalSettleMs` per note alongside `transitionMs` so the two effects can be told apart.

## 3. Engine, IPC, UI

- Request fields (both `startPitchProcess` and `startPitchCorrection`): `preserveFormants` (bool),
  `formantShift` (−12…+12), `quality` (`"standard"`/`"high"`), `protectTransients` (bool).
  **Omitted = all off = Phase 2.4.4 behaviour.** Invalid values are rejected with clear errors.
- Labels gain suffixes: `, formants kept`, `, formants +3 st`, `, formants follow pitch +3 st`,
  `, High quality` (stored as `pitchLabel`, saved/loaded with the project).
- Result events add `envelopeFrames`, `transients`, `processSeconds`, `realtimeFactor`,
  `workingMB`, `workingSetMB`/`peakWorkingSetMB`; correction adds `glideNotes`, `octaveFrames`, and
  per-note `glide`, `responseMs`, `goalSettleMs`.
- UI: compact **Vocal quality** section in the Pitch Analysis panel (between key/targets and
  Automatic correction, 159 px high, no overflow): *Preserve formants* (default on), *Formant shift
  (st)* (default 0, disabled when preserve is off), *Quality* Standard / High (slower), and a hint.
  The settings apply to both automatic correction and the manual shift; the UI always sends
  `protectTransients: true`. The notes list marks glides as "glide, kept".

## 4. Files changed

- New `native/audio-engine/include/msp/VocalQuality.h`, `native/audio-engine/src/VocalQuality.cpp`
  (`VocalQuality`, `EnvelopeShaper`, `TransientGuard`); `CMakeLists.txt`.
- `PitchShift.h/.cpp` — quality settings, shaped stretcher, guard blend, no input copy, metrics.
- `PitchCorrect.h/.cpp` — quality settings, shaped `VarStretcher`, octave/glide guards, `goal`,
  guard mix, no input copy.
- `Engine.cpp` — parsing, labels, memory/speed metrics, per-note timing fields, region copy removed.
- `native/audio-engine/tests/test_main.cpp` — new group `vocalquality` (unit + IPC), also in the
  full list; `runAutoCorrect` gained an optional quality parameter (existing callers unchanged).
- `packages/shared/src/protocol.ts` — `VocalQualitySettings` and the new event fields.
- `apps/desktop/renderer/src/PitchPanel.tsx`, `styles.css` — the section.
- New `apps/desktop/electron/vocalQualityCheck.ts`; `main.ts` — `MSP_VOCALQUALITY_CHECK` hook.

## 5. Commands executed and results

Process check before every native build (`Get-CimInstance Win32_Process` for `MusicStudioEngine*`
or Electron with `MusicStudioPro` in the command line) → empty each time; nothing was closed.

| Command | Result |
| --- | --- |
| `scripts\build-engine.ps1` (several iterations while fixing) | built, no errors |
| `build\audio_engine_tests.exe vocalquality` (first run) | 14 PASS, 8 FAIL (see below) |
| `build\audio_engine_tests.exe vocalquality` (final, re-run for this report) | **22 PASS, 0 FAIL** |
| `build\audio_engine_tests.exe pitchshift` — the manual shift DSP changed | **18 PASS, 0 FAIL** |
| `build\audio_engine_tests.exe autocorrect` — the correction DSP changed | **21 PASS, 0 FAIL** |
| `npx tsc -p tsconfig.json --noEmit` + `npx tsc -p tsconfig.electron.json --noEmit` | exit 0 |
| `npm run build` | exit 0 |
| GUI `MSP_VOCALQUALITY_CHECK` (the one GUI check) | **6 PASS, 0 FAIL, 2 NOT RUN** |

First-run failures and fixes:
- Down-shift envelope error 31 dB — the fit measured above the shifted source bandwidth; the
  measurement is now limited to 4400·r Hz (test fix).
- Standard F1/F2 ~10% off — real DSP weakness of cepstral averaging; fixed with the SEEVOC peak
  envelope (High refines from it).
- F1 755 vs 689 Hz — resolution of harmonic sampling; tolerance is max(8%, 0.5·f0) (test fix).
- Stereo lag 24 → 18 samples — inherent (lag/r), identical with formants off; the test now
  expects d/r and equality with the off path.
- Legato/vibrato expected 0 attacks — the note starts after silence, so 1 is correct (test fix).
- Pitch-lag measurement bias — replaced by a simulated reference measured identically (test fix).
- IPC −6.94 c — the engine's whole-clip median mixes two notes; the test uses per-note medians.

GUI check `MSP_VOCALQUALITY_CHECK` (48 kHz stereo two-note vowel take, injected input only):
1. Section present, order and defaults correct, preserve off disables the formant shift — PASS
2. Formant shift 13 rejected; +5 st, formants kept, High processed into a new file; clip and
   source unchanged — PASS (`+5 st, formants kept, High quality · 290.3 → 387.2 Hz (expected
   387.5, −1.4 c) · 2.30 s in 755 ms`)
3. Original/Processed preview, Apply (label + hint), Undo, Redo — PASS
4. Save/load keeps the label; Revert restores the original — PASS
5. Auto correction with formants kept: `Auto correction 100% 20 ms (C Major), formants kept`,
   both notes −0.0/+0.0 c, new file — PASS
6. Source WAV never modified — PASS
- Listening test — NOT RUN — NO HARDWARE; real voice recording — NOT RUN — NO HARDWARE.

Screenshots: `%TEMP%\msp-vocal-20261108-112629\vocal-0[1-4]-*.png`.

**NOT RUN:**
- full regression and `scripts\run-regression.ps1`;
- native groups `automation`, `master-gain`, `pitch`, `pitchmap`, and the full native list;
- all other GUI checks (`MSP_LAYOUT/WORKFLOW/MIXER/FX/AUTO/PITCH/PITCHFIX/PITCHMAP/AUTOCORRECT_CHECK`);
- listening tests on real recordings.

Microphone: NOT RUN — NO HARDWARE.

Note: because the UI now sends *Preserve formants* on by default, the manual-shift and
auto-correction workflows of `MSP_PITCHFIX_CHECK` and `MSP_AUTOCORRECT_CHECK` now produce labels
with `, formants kept` and slightly different audio. A code read shows both checks match labels
by prefix/substring (`startsWith('Auto correction…')`, `hint.includes('+12 st')`), so the suffix
should not break their label assertions; their pitch measurements were not re-verified with
formants kept. They were not run, per policy — running them needs your approval.

## 6. Quality measurements (synthetic vowels: harmonics under a 3-formant envelope)

Envelope error = RMS dB difference between the output harmonic amplitudes and the reference
envelope (below 4400·r Hz). Pitch = YIN median over the steady part.

| Case | Formants off | Preserve (Standard) | Preserve (High) |
| --- | --- | --- | --- |
| +5 st (150 → 200 Hz) | 10.07 dB, F1 901 (ref 689) | 1.00 dB, F1 755, F2 1173 (ref 1192) | 0.87 dB, F2 1183 |
| −5 st | 9.69 dB | 1.31 dB, F1 689 (ref 689) | — |
| +12 st (f0 300 Hz) | 6.66 dB | 0.98 dB, F1 573 (ref 591) | — |
| Formant shift +3 st, pitch 0 | — | 0.82 dB, F1 818 (ref 840) | — |
| Pitch +5, formants −3 st | — | 1.22 dB, F1 591 (ref 594) | — |
| Auto correction A3+40c → C4 | 6.37 dB | 1.49 dB | — |
| IPC, +5 st High, two-note take | — | — | 1.69 dB, F1 628 (ref 591) |

Pitch accuracy is unchanged by formant processing (all within ±0.02 c). Other results:
- 44.1 kHz mono and 48 kHz stereo: exact durations (52920 → 52920; 60000 + 60000).
- Silence → exact zeros; NaN/Inf input → finite output (2 repaired); a 0.98 peak input → peak
  0.999 after limiting (1.54 dB gain reduction); no clipping.
- Transients, energy before the attack relative to after:

  | Path | Unprotected | Protected |
  | --- | --- | --- |
  | Manual shift | −27.9 dB | −109.4 dB |
  | Auto correction | −52.3 dB | −200 dB |

  The level after the attack changes by only −0.36 / −0.05 dB, and the vowel body is unchanged.
- Legato note change, max second difference (click measure): input 0.333, off 0.219, Standard
  0.220, High 0.109; no attack falsely detected.
- An octave glitch (3 frames an octave up): dropped, largest curve step 4.99 c.

## 7. Performance and memory (10 s stereo 48 kHz vowel)

| Mode | Shift +3 st | Auto correction | Working buffers (shift / auto) |
| --- | --- | --- | --- |
| Formants off | 24.1× real time | 24.4× | 0.76 / 1.65 MB |
| Kept, Standard | 18.2× | 19.0× | 0.84 / 1.74 MB |
| Kept, High | 3.6× | 4.2× | 0.84 / 1.74 MB |

- Bounded: a 60 s clip in Standard uses the same 0.84 MB of working buffers as 10 s (excluding the
  output itself).
- IPC engine peak working set during a High process: 23.2 MB. The input copies in
  `pitchShift`/`pitchCorrect` and the engine's copy of the original region were removed.
- Cancellable: both paths stop within a few progress calls and write no file.
- High costs about 5× Standard (8× overlap plus true-envelope iterations); it keeps duration.

## 8. Limitations

- Validated on synthetic vowels only; **no real recordings and no listening tests**. Formant
  preservation is an approximation, not perfect: errors of about 1–1.7 dB remain, and the formant
  peaks cannot be located more finely than the harmonic spacing (F1 755 vs 689 Hz at f0 200 Hz).
- Monophonic vocals only. Polyphonic material, breath noise, and strongly unvoiced sounds are not
  modelled specially; the unvoiced frames use a fixed lifter.
- The inter-channel time difference scales by 1/ratio (24 → 18 samples at +5 st). This is
  inherent to vocoder plus resampling and identical with formants off; level panning is kept exactly.
- The attack guard leaves about the first 15 ms of each detected attack unshifted/uncorrected
  (by design, to keep it crisp).
- Glide notes are left uncorrected.
- For automatic correction, the formant shift applies only inside corrected notes.
- Engine default (fields omitted) is all off for compatibility; the UI default is preserve on.
  The other GUI checks were not re-run with this new default (see section 5).

## 9. Stop

Phase 2.4.5 is complete. Work stops here pending your approval. ProfilePilot was not touched.
