# Phase 2.4.4 — Automatic Pitch Correction (Offline): final report

Date: 2026-11-08. Scope: offline automatic pitch correction of one clip towards the note targets of
Phase 2.4.3, with retune speed, correction strength, A/B preview, apply/undo/redo, revert and
project persistence. Realtime Auto-Tune, formant preservation, AI voice conversion, vocal
separation, VST3, livestreaming and installers were not touched. ProfilePilot was not touched.

## 1. Architecture audit (what is reused)

| Existing piece (phase) | Reused for |
| --- | --- |
| YIN detector `analyzePitch` (2.4.1) | measured pitch per frame; also re-run on the result to verify it |
| Note segmentation `segmentPitch` (2.4.3) | note spans and frame ranges to correct |
| Key/scale mapping `mapPitch` + manual overrides `matchOverrides` (2.4.3) | the target of each note; one shared helper `Engine::segmentTargets` now feeds both the note list (`getPitchMapping`) and the correction, so they cannot disagree |
| Analysis cache `PitchSegments` + `segmentsOutdated` (2.4.3) | now also stores the YIN frames and parameters; stale-analysis detection |
| `Fft`, `pitchShiftFrameSize` (2.4.2) | FFT and frame size of the new variable vocoder |
| `copyClipRegion`, processed-audio folder, `PitchProcessed`, `previewPitch`, `applyPitch`, `revertPitch`, `processedClipError`, `cancelPitchProcess`, `PitchJob` (2.4.2) | the whole non-destructive workflow (copy with context, separate WAV, preview, undoable apply, revert, cancel) |

The fixed-ratio `pitchShift` of 2.4.2 was **not** changed: manual shifting keeps its own code path.
Automatic correction needs a ratio that changes over time, so it got a bounded independent DSP path
(`PitchCorrect.cpp`). The clip is **not** split into pieces with separate global shifts: the whole
region is processed in one pass with one continuous phase state.

## 2. DSP: the time-varying method

Files: `native/audio-engine/include/msp/PitchCorrect.h`, `native/audio-engine/src/PitchCorrect.cpp`.

1. **Correction curve.** One point every 32 samples (`kCorrectionControlStep`), holding the wanted
   change in cents and a mix weight (0 = original audio, 1 = corrected).
2. **Time warp.** Ratio \(r(t) = 2^{c(t)/1200}\); warp \(\tau(x) = \int_0^x r\), piecewise linear
   (one ratio per curve point), with an inverse that uses a moving hint.
3. **Variable-hop phase vocoder** (Hann, N = `pitchShiftFrameSize(rate)`, synthesis hop N/4).
   - Frame k is analysed at the integer input position \(a_k = \mathrm{round}(\tau^{-1}(k\,N/4))\)
     and synthesised at the fractional warped position \(s_k = \tau(a_k)\).
   - Each stretch of audio is therefore stretched by its own local ratio, and the phase stays
     continuous across ratio changes.
   - Phase update: the true frequency per peak is measured over the integer analysis hop, then
     advanced over the fractional synthesis hop. Identity phase locking uses one rotation per peak
     region, computed from the louder channel and shared by all channels, so the stereo image is
     kept.
   - Fractional placement: a linear phase ramp \(e^{-i2\pi k f/N}\) delays the frame by f samples,
     and the synthesis window is shifted by the same amount.
   - Overlap-add is normalised by the accumulated \(\sum w^2\), so variable hops do not modulate
     the level.
   - Onsets (energy rising more than 6 dB) and the first frame after a skipped stretch take the
     analysis phases unchanged.
4. **Variable-cutoff resampler.** A Kaiser-windowed sinc (β 9, 24 zero crossings, one 512-step
   table) reads the warped signal at \(\tau(n)\) for every output sample n, with cutoff
   \(0.97\cdot\min(1, 1/r(n))\) and normalised weights. This scales the local spectrum by r(n) and
   returns to the original timing.
5. **Output.**
   - The output has exactly as many samples as the input region, at the source sample rate.
   - Where mix = 0, input samples are copied bit-exactly. Elsewhere the output is
     `mix·corrected + (1 − mix)·original`.
   - If the peak would exceed 0.999, the whole output is scaled once (reported as gain reduction).
     Non-finite input samples are treated as silence and counted.
   - Vocoder frames farther than 2N + 128 samples from any corrected point are skipped. Buffers are
     trimmed once more than 64 k samples lie behind and restarted after long gaps, so memory stays
     bounded.
6. **Curve construction** (`buildCorrectionCurve`).
   - Measured pitch inside a note: the median of five neighbouring voiced YIN frames, so isolated
     detection errors and octave glitches are ignored. It is interpolated linearly and held at the
     note edges.
   - Goal = (target − measured)·100 cents, clamped to ±1200.
   - **Retune speed:** a one-pole smoother stepped once per curve point, i.e. in audio time and
     never GUI time. Its time constant is retune/3 (at least 1 ms), so 95 % of a change is
     reached after the retune time. After a note it returns to 0 with a 5 ms time constant.
   - **Strength** multiplies the smoothed curve. It is a pitch fraction, not a gain. Strength 0, or
     a curve that is zero everywhere, sets `identity`, and the region is copied **bit-identically**.
   - Spans (`correctionNotes`): each segment widened by (window − hop)/2, the part of the YIN
     window outside the first and last voiced frame, but never past the midpoint to a neighbouring
     note.
7. **Crossfades at unvoiced boundaries.**
   - The mix rises with a 10 ms raised cosine that ends at the span start. It holds through the span
     plus 30 ms (6 × the 5 ms release), then falls with a 10 ms raised cosine.
   - Outside these ramps unvoiced audio (breaths, consonants, noise, silence) is the original,
     sample for sample.
   - Inside a ramp the corrected and the original signal are mixed. They are time-aligned, and the
     correction there is small because the curve starts from 0 and releases back to 0.
   - No pitch is ever created where the detector found none; notes without a target are left alone.
8. **Legato note changes.** The curve moves from one note's correction to the next at the retune
   speed (no jump), and the vocoder keeps one phase state through the change.

No formant preservation is claimed: like any resampling-based shifter, the spectral envelope moves
with the pitch (only small for corrections of a few tens of cents).

## 3. Engine, IPC, persistence

- **New command `processAutoCorrection {jobId, retuneMs 0–200, strength 0–100, root?, scale?, targets?, frameDelayMs?}`.**
  - Refused when another job runs, or when the analysis is unknown. Unknown includes analyses from
    before a project load, because the cache is cleared and the generation bumped.
  - Refused when the clip changed (source, offset, duration or sample rate), or when `root`/`scale`
    differ from the engine's key.
  - Refused when `targets` (the list the UI showed) differ from the engine's current effective
    targets after key/scale/override edits, undo or redo, or when no note has a target.
  - Targets come only from the analysed clip, via the clip-id and source-matched overrides of 2.4.3.
- **Worker thread.**
  - Steps: copy the clip with 16384 samples of context per side, build the curve, run
    `pitchCorrect`, verify with YIN using the analysis parameters, then write a new 32-bit float WAV
    to the processed-audio folder.
  - Events: `pitchCorrectProgress` (throttled to 100 ms) and `pitchCorrectResult`. The result
    carries, per note: original, target, expected and corrected pitch, remaining cents measured away
    from the edges, and transition time. It also carries peaks, gain reduction, frame counts,
    correction time, real-time factor, working-buffer MB and process working set.
  - The job is a `PitchJob` with `processing = true`, so the existing `cancelPitchProcess` cancels it.
- **Preview, apply and revert** are the 2.4.2 commands, unchanged. The new `PitchProcessed.label`
  (for example "Auto correction 100% 30 ms (C Major)") is stored on the clip as `pitchLabel` when
  applied. It is chained with " + " when processed audio is processed again, and cleared by
  revert. Manual shifts now store their shift text as their label.
- **Project.** Optional `"pitchLabel"` next to the existing `originalSourceFileId`. The version stays
  5; older projects load unchanged (no label). Source files are never modified or deleted.
- **Realtime callback.** Untouched; no new locks or allocations in playback.

## 4. UI (Pitch Analysis panel)

A new **Automatic correction** section sits between "Key and target notes" and the manual section,
which is now titled **Manual pitch shift**. It contains:

- the "Auto correct" checkbox, off by default; Retune speed (ms) and Strength (%) are disabled
  until it is on;
- a hint with the number of notes that have targets, or why processing is blocked (no analysis,
  the clip changed, no targets);
- "Process auto correction" with a progress bar and Cancel;
- a result summary plus a per-note list (original → corrected cents, transition ms);
- the **Original/Corrected** A/B buttons, which change playback only;
- **Apply to clip** and **Revert to original**;
- a state line "This clip plays processed audio (label)".

The section uses its own class names, so the 2.4.2/2.4.3 GUI checks keep addressing the manual
section.

## 5. Files changed

New:
- `native/audio-engine/include/msp/PitchCorrect.h`, `native/audio-engine/src/PitchCorrect.cpp` — the correction DSP
- `native/audio-engine/include/msp/ProcessMemory.h`, `native/audio-engine/src/ProcessMemory.cpp` — working-set query (keeps `windows.h` out of `Engine.cpp`)
- `apps/desktop/electron/autoCorrectionCheck.ts` — GUI check `MSP_AUTOCORRECT_CHECK`
- `docs/phase244-final-report.md`

Modified:
- `native/audio-engine/CMakeLists.txt` — two sources
- `native/audio-engine/include/msp/Timeline.h` — `Clip::pitchLabel`
- `native/audio-engine/include/msp/Project.h`, `src/Project.cpp` — optional `pitchLabel` save/load
- `native/audio-engine/include/msp/Session.h`, `src/Session.cpp` — `applyPitchSource(..., label, ...)`, revert clears the label, `toProject`
- `native/audio-engine/include/msp/Engine.h`, `src/Engine.cpp`:
  - `PitchProcessed.label`;
  - `PitchSegments` frames, params and window;
  - `SegmentTargets` / `segmentTargets`;
  - `startPitchCorrection` and the `processAutoCorrection` command (also on the preview allow-list);
  - `pitchLabel` in state and in project load.
- `native/audio-engine/tests/test_main.cpp` — new group `autocorrect` (unit + IPC), also in the full list
- `packages/shared/src/protocol.ts` — `pitchLabel`, `retuneMaxMs`, `PitchCorrectStart`, `CorrectedNote`, `PitchCorrect*Event`
- `apps/desktop/renderer/src/PitchPanel.tsx`, `apps/desktop/renderer/src/styles.css` — the section
- `apps/desktop/electron/main.ts` — `MSP_AUTOCORRECT_CHECK` hook

## 6. Commands executed and results

Process check before both native builds (no Music Studio Pro engine or Electron process was running):
`Get-CimInstance Win32_Process | Where-Object { MusicStudioEngine* or electron*MusicStudioPro* }` → empty.

| Command | Result |
| --- | --- |
| `scripts\build-engine.ps1` (1st) | built, no errors |
| `build\audio_engine_tests.exe autocorrect` (1st) | 19 PASS, 2 FAIL (see below) |
| `scripts\build-engine.ps1` (2nd, tests only) | built, no errors |
| `build\audio_engine_tests.exe autocorrect` (2nd) | **21 PASS, 0 FAIL** |
| `build\audio_engine_tests.exe pitchshift` | **18 PASS, 0 FAIL** — run because `applyPitchSource` (manual shift apply) changed signature/label |
| `build\audio_engine_tests.exe pitchmap` | **19 PASS, 0 FAIL** — run because `pitchMappingVar` was refactored onto `segmentTargets` |
| `npx tsc -p tsconfig.json --noEmit` + `npx tsc -p tsconfig.electron.json --noEmit` | exit 0 |
| `npm run build` | exit 0 |
| GUI `MSP_AUTOCORRECT_CHECK` | **8 PASS, 0 FAIL, 2 NOT RUN** (no audio output / no microphone) |

The two first-run failures were test-fixture errors, fixed in the tests. No DSP or engine code
changed between the runs.

- `autocorrect-smooth-transition`: the click bound ignored the input's own kink. An instant legato
  frequency step in the synthetic input already has a second difference of 0.0027; the corrected
  output had 0.0015. The bound is now max(steady bound, input's own value).
- `autocorrect-nan-inf`: the damaged samples make YIN windows unvoiced, which splits the note into
  three segments. The test had given a target to the first segment only, so the measured third
  segment was (correctly) left alone. All segments now use their nearest note.

NOT RUN:
- full regression and `scripts\run-regression.ps1`;
- the native groups `automation` and `master-gain`, the `pitch` group, and the full native list;
- all other GUI checks (`MSP_LAYOUT/WORKFLOW/MIXER/FX/AUTO/PITCH/PITCHFIX/PITCHMAP_CHECK`);
- listening test of the preview on speakers (NOT RUN — NO HARDWARE).

Microphone: NOT RUN — NO HARDWARE.

Note: `MSP_PITCHFIX_CHECK` (2.4.2) addresses the manual section, whose heading text and hint
contents changed slightly. It was not run, per policy. Its selectors (`.pitch-correction`,
`.pitch-ab`, `.pitch-clip-state`, `+12 st` in the hint) were kept compatible on purpose.

## 7. Quality measurements (synthetic test tones, measured away from note edges)

All at 48 kHz unless noted. Pitch measured with YIN medians over the steady centre of each note
(the retune transition and the last window are skipped). These are synthetic sine tones; they show
the DSP is correct, **not** that it sounds professional on real vocals.

| Case | Original detected | Target | Corrected detected | Remaining |
| --- | --- | --- | --- | --- |
| Sustained A3+40c (225.14 Hz), retune 20 ms | +40.00 c | A3 | −0.00 c | 0.00 c |
| Two notes: A3+40c / D4−20c | +40.00 / −20.00 c | A3 / D4 | −0.00 / −0.00 c | 0.00 / 0.00 c (curve −40.00 / +20.00 c) |
| Manual target B3 on A3+40c | +40 c from A3 | B3 (+160 c) | −0.00 c from B3 | 0.00 c |
| Strength 0 % | — | A3 | bit-identical copy | — |
| Strength 50 % | +40 c | A3 | +20.00 c (expected +20) | 0.00 c; RMS ratio 1.000 (not a gain) |
| 44.1 kHz mono A3+40c | | A3 | 0.00 c | |
| 48 kHz stereo (R = 0.6·L) with lead/tail | | A3 | L −0.00 / R −0.00 c | balance 0.6000 kept |
| IPC, stereo clip, C major, retune 20 ms | +40.00 / −20.00 c | A3 / D4 | 0.00 / −0.00 c | 0.00 / 0.00 c |
| IPC, manual B3 + D4 | −160.00 / −20.00 c (vs target) | B3 / D4 | 0.00 / −0.00 c | 0.00 / 0.00 c |
| GUI, retune 30 ms | +40.0 / −20.0 c | A3 / D4 | +0.0 / +0.0 c | worst 0.0 c |

**Retune speed (curve, audio time):**

| Retune setting | 95 % of the change reached after | Pitch 60–100 ms after onset |
| --- | --- | --- |
| 0 ms | 2.0 ms | −0.0 c |
| 50 ms | 46.7 ms | +0.2 c |
| 100 ms | 98.0 ms | +2.7 c |
| 200 ms | 198.7 ms | +10.5 c |

The original note is +40 c. IPC transition times: 18.0 ms (A3) and 42.0 ms (D4) at a 20 ms
setting, and 30 / 31 ms at 30 ms in the GUI run.

The transition metric measures from the widened span start until the curve reaches 95 % of its
value at the note centre. A likely cause of the longer D4 value is that its onset frames measure a
slightly different pitch than its centre, so the curve keeps moving after the retune time. This
was not investigated further. The steady-state pitch of that note was exact (0.00 c remaining).

**Smooth transitions, vibrato and glides:**
- Legato A3+40c → D4−20c with no silence between: both notes −0.00 c.
  - Largest second difference in the output: 0.0015 at the note change. The input's own step is
    0.0027, so no click was added.
  - Largest curve step: 5.7 c per 32 samples at retune 20 ms (no jump).
- Vibrato ±30 c at 5.5 Hz around A3+40c:
  - input median +37.3 c, depth (SD) 20.3 c;
  - retune 200 ms: median −2.6 c, depth 19.7 c (vibrato kept);
  - retune 0 ms: median −0.4 c, depth 4.4 c (fast retune flattens vibrato, the expected
    "hard-tune" behaviour).
- Glide A3+40c → D4−20c: 4 segments, max second difference 0.0006, below the 0.0014 bound.

**Silence, noise and damage:**
- 1 s silence gives no notes and exact zeros out.
- Noise between two notes: noise at 0.75–0.95 s copied bit-exactly; 20 129 samples copied.
- 3 NaN/Inf input samples: output finite, 3 repaired, pitch 0.00 c.
- 0.98 peak input: output peak 0.98982 (≤ 0.999), no gain reduction needed.
- Exact duration in every case. For example, 44.1 kHz 48 510 → 48 510 samples, and 48 kHz stereo
  67 200 with 4 800 + 2 400 context → 60 000 + 60 000.

**Stale protection** (IPC). Each case is refused with a clear message:
- key changed;
- targets changed;
- clip trimmed;
- an old result applied to a changed clip;
- an analysis from before a project load.

## 8. Performance

`pitchCorrect` alone, stereo 48 kHz, legato detuned notes with vibrato (test `autocorrect-performance`):

| Audio | Notes | Correction time | Speed | Working buffers (curve + warp + vocoder + resampler) | Process peak working set |
| --- | --- | --- | --- | --- | --- |
| 10.2 s | 18 | 368 ms | 27.7× real time | 1.59 MB | 21.5 MB (+10.1 MB during the run) |
| 60.2 s | 104 | 2 208 ms | 27.3× real time | 3.59 MB | 95.6 MB (+65.8 MB during the run) |

- The working buffers grow only with the curve (about 20 bytes per 32 samples). The vocoder and
  resampler buffers are bounded.
- The growth of the working set comes from the unavoidable whole-clip copies: the test's own
  fixtures, the input copy and the output.
- In the engine (IPC test, 2.3 s stereo clip): correction 69.6 ms (33× real time); total 95.6 ms
  including the YIN verification pass; working buffers 1.22 MB; engine peak working set 21.8 MB.
- Processing runs on the worker thread. The UI stayed responsive and Cancel worked during a 60 s
  correction in the GUI check.

## 9. Limitations

- Synthetic tones only. No real vocal recordings were available (microphone NOT RUN — NO
  HARDWARE), so the sound on real singing, breathy voices and polyphonic material is not verified.
- No formant preservation. Larger corrections (several semitones) change the timbre the same way
  the 2.4.2 shifter does.
- Correction follows the analysis.
  - If YIN misdetects a whole note (for example an octave error over the full note), that note's
    target is wrong. The five-frame median only removes isolated errors.
  - Notes are corrected only where segmentation found a steady note. Very short notes (fewer than
    5 voiced frames) are left alone.
- At retune 0 ms vibrato is flattened. That is the intended hard-tune effect; use a slower retune
  to keep vibrato.
- Peak protection scales the whole output once, rather than limiting locally.
- After Apply the clip plays a new source.
  - Manual targets on the clip refer to the original source, so they do not attach to a
    re-analysis of the corrected audio. After Revert they attach again.
  - Re-correcting already corrected audio requires a new analysis.
- The verification pass roughly adds the cost of one YIN analysis to each job.

## 10. Remaining work (not started; needs approval)

- Listening tests on real vocal takes and tuning of the defaults (retune and crossfade lengths).
- Optional formant handling, realtime/low-latency correction, and a per-note retune/strength
  override — all out of scope for 2.4.4.
- Broader regression (full native run and the other GUI checks) only with explicit approval.

**Phase 2.4.4 stops here. Waiting for user approval before any further phase.**
