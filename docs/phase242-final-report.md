# Phase 2.4.2 — Offline Pitch Correction Engine: final report

Status: implemented and verified within the targeted scope. Not realtime pitch correction and not Auto-Tune: there is no
scale quantization, no automatic note correction, no formant handling, and no evaluation on real voice recordings yet.

## 1. What was built

Non-destructive, offline, duration-preserving pitch shifting of an existing audio clip:

- Shift range −12..+12 semitones plus −100..+100 cents. The ratio is \(p = 2^{(st + c/100)/12}\).
- Mono and stereo, at any sample rate from 8 to 192 kHz; tested at 44.1 kHz and 48 kHz.
- Processing runs asynchronously on a worker thread, with progress and Cancel.
- Before/after pitch is measured with the Phase 2.4.1 YIN detector. YIN is used only for measuring, never for shifting.
- Processed audio goes to a **new** 32-bit float WAV file in the processed-audio folder (default `Documents\Music Studio Pro\Processed`). The source WAV is never written to.
- **Original/Processed A/B preview** goes through the normal playback engine. It changes playback only.
- **Apply to clip** and **Revert to original** are both undoable, and save/load keeps the processed audio reference.

## 2. Algorithm and rationale

`native/audio-engine/src/PitchShift.cpp` (module `msp/PitchShift.h`) chains two independent stages.

1. **Phase-vocoder time stretch by p.** The input is stretched in time by the pitch ratio, without changing pitch.
   - Frames: Hann analysis and synthesis windows. Frame size N = 2048 up to 50 kHz, doubled per octave above. Synthesis hop N/4; analysis hop N/(4p).
   - Normalization: the overlap-add sum is exactly 1.5 for this window and hop, so normalization is a constant.
   - **Identity phase locking** (Laroche & Dolson 1999). Spectral peaks get their phase advanced from the measured instantaneous frequency. Every other bin in a peak's region gets the same phase rotation as the peak, which keeps each partial's shape (less "phasiness" than a plain vocoder).
   - **Stereo:** peaks are found on the summed magnitude of both channels. The louder channel at a peak supplies the frequency estimate, and both channels get the **same** rotation, so inter-channel phase (the stereo image) is kept and channels cannot swap.
   - **Transients:** a frame whose energy rises more than 6 dB over the previous frame resets to the analysis phases, so attacks are not smeared by phase propagation.
   - **Memory:** the stretch is streamed. Synthesis frames are produced only as the resampler needs them, and consumed samples are discarded, so memory does not grow with p × duration.
2. **Windowed-sinc resampling by p.** The stretched signal is read back at p samples per output sample.
   - Kernel: Kaiser window (β = 9), 24 zero crossings, interpolated from a table.
   - Anti-aliasing: cutoff 0.97 · min(1, 1/p) of Nyquist.
   - The weights are normalized to unity DC gain at every fractional position.

The output has **exactly** as many samples as the input, and its spectrum is scaled by p. Resampling alone would change the duration; the vocoder stretch is what keeps it. Output sample n corresponds to input sample n with no latency, so the processed audio stays sample-aligned with the original.

Why this design: a phase vocoder with phase locking and onset handling is the standard validated offline method for duration-preserving shifts of ±1 octave. It needs only an FFT, which is already in the engine. PSOLA and WSOLA are alternatives, but they depend on reliable pitch marks or waveform similarity, which degrade on breathy or noisy vocal material. The two stages are separate classes (`Stretcher`, `SincResampler`), so either can be replaced later, for example by a formant-preserving stage, without touching the engine integration.

Safety rules:
- **Zero shift:** returns a bit-exact copy without processing (`identity: true`).
- **Invalid input:** NaN/Inf samples are treated as silence and counted (`repairedSamples`).
- **Silence:** an all-zero input gives an exactly zero output.
- **Clipping:** if the output would exceed −0.01 dBFS (0.999), the whole processed clip is scaled down uniformly and the reduction is reported (`gainReductionDb`). Otherwise no gain is changed.
- **Clip edges:** up to 16384 source samples of context on each side of the clip are processed, then cropped, so the edges are clean. A clip of a single sample is handled.

## 3. Integration (reused components)

- **FFT:** the radix-2 FFT was moved out of `PitchDetector` into `msp/Fft.h`, and YIN and the shifter now share it. The `pitch` test group was re-run to confirm detection is unchanged.
- **Clip data:** new optional `Clip` fields `originalSourceFileId`, `originalSourceOffset` and `pitchShiftCents`. They are saved as optional JSON fields, and the project version stays **5**, so older files and existing tests are unaffected. Device-rate changes and project loading scale `originalSourceOffset` like the other clip times.
- **Sources:** processed audio is loaded as an ordinary extra source of the track (existing `addExtraFile` / `extras` persistence). The original source stays loaded, so it remains recoverable.
- **Undo/redo:** Apply and Revert go through `Session::editClip`, the same undo snapshots as every other clip edit.
  - Apply: the clip plays the processed file from offset 0, and its timeline position, duration, fades and gain are kept.
  - Revert: `sourceFileId = original`, `sourceOffset = originalSourceOffset + current offset`, so later trims and splits stay aligned.
- **Preview:** `Session::pitchPreview` substitutes the processed source for that one clip, inside `arrangeInto`, which only builds the realtime playback buffer.
  - Clips, the undo history, export (which renders from the clip list) and saved projects never see it.
  - Sources loaded only for a preview are marked `preview`. They are excluded from saving and dropped when the preview ends.
  - Any command that edits clips, undoes, loads or changes devices ends the preview first, using an allow-list in `Engine::handleLine`.
- **Jobs:** processing shares the single analysis job slot, so analysis and processing never run at once and each gets a clear busy message.
  - The worker owns a copy of the clip region and writes only events and its own new file.
  - Finished results are kept in memory by job id. Preview and Apply check that the clip's source, offset and duration are unchanged since processing; otherwise they fail with "The clip has changed since it was processed. Process it again."
- **WAV output:** `writeWavFile` gained an optional channel count (default 2, so existing exports are unchanged). Processed files keep the source's channel count and sample rate.

IPC (protocol v1, additive):

| Command | Result |
|---|---|
| `processPitch {trackId, clipId, semitones, cents}` | answers at once with `jobId`; then `pitchProcessProgress {fraction}` and `pitchProcessResult {status, path, originalHz, processedHz, expectedHz, deviationCents, gainReductionDb, …}` |
| `cancelPitchProcess` | cancels a running processing job; no file is written |
| `previewPitch {resultId, enabled}` | state with `pitch.preview` |
| `applyPitch {resultId}` / `revertPitch {trackId, clipId}` | state (undoable) |
| `setProcessedFolder {path}` | state with `pitch.processedFolder` |

UI: a **Pitch correction** section in the existing Pitch Analysis panel.
- Inputs: semitone and cent fields.
- Processing: Process, a progress bar, Cancel, and a result line with the measured before/after pitch and deviation.
- Preview: an Original/Processed toggle.
- Clip actions: Apply to clip and Revert to original, plus a note when the clip plays processed audio.
- Errors appear in the section. The editor layout is otherwise unchanged.

## 4. Files changed

New:
- `native/audio-engine/include/msp/Fft.h`, `native/audio-engine/src/Fft.cpp`
- `native/audio-engine/include/msp/PitchShift.h`, `native/audio-engine/src/PitchShift.cpp`
- `apps/desktop/electron/pitchCorrectionCheck.ts` (GUI check `MSP_PITCHFIX_CHECK`)
- `docs/phase242-final-report.md`

Modified:
- `native/audio-engine/CMakeLists.txt`: new sources.
- `native/audio-engine/include/msp/Pitch.h`, `src/Pitch.cpp`: use the shared FFT; no behaviour change.
- `native/audio-engine/include/msp/Timeline.h`: optional pitch fields on `Clip`.
- `native/audio-engine/include/msp/Project.h`, `src/Project.cpp`: optional clip fields saved and loaded.
- `native/audio-engine/include/msp/Session.h`, `src/Session.cpp`:
  - added `findSourceAudio`, `copyClipRegion`, the preview substitution, `endPitchPreview`, `applyPitchSource`, `revertPitchSource`;
  - preview sources excluded from saving; rate scaling of the new offset.
- `native/audio-engine/include/msp/WavIO.h`, `src/WavIO.cpp`: optional mono output.
- `native/audio-engine/include/msp/Engine.h`, `src/Engine.cpp`: processing job, results registry, new commands, preview allow-list, `pitch` state, loading of the new clip fields.
- `native/audio-engine/tests/test_main.cpp`: `testPitchShift`, `testIpcPitchShift`, group `pitchshift`.
- `packages/shared/src/protocol.ts`: clip fields, `PitchState`, processing types and events.
- `apps/desktop/renderer/src/PitchPanel.tsx`, `App.tsx`, `styles.css`: the Pitch correction section.
- `apps/desktop/electron/main.ts`: the `MSP_PITCHFIX_CHECK` hook.

## 5. Results

All figures are from generated sine and noise fixtures on this machine (Release build).

### Pitch accuracy (YIN median of the processed output)

| Case | Measured | Error |
|---|---|---|
| 220 Hz mono 48 kHz, +12 st | 440.000 Hz | 0.00 cents |
| 440 Hz stereo 44.1 kHz, −12 st | 220.000 Hz (both channels) | 0.00 cents |
| 300 Hz, +50 cents | 308.791 Hz (target 308.791) | 0.00 cents |
| IPC: 1.25 s trimmed stereo 48 kHz clip, +12 st | 220.000 → 440.000 Hz | deviation 0.00 cents |
| IPC: 300 Hz mono 44.1 kHz file, −12 st | 150.000 Hz | deviation −0.00 cents |
| GUI: 2 s stereo 44.1 kHz clip, +12 st | 220.0 → 440.0 Hz | +0.0 cents |

These are steady sines. Real voices (vibrato, breath, consonants) were **not** measured.

### Duration preservation

The output length equals the input length in every case:
- 48001, 44100, 1000, 100 and 1 samples;
- 60000 samples with 8000/4000 samples of context, which gives the 48000-sample region exactly;
- 72000 and 96000-sample tones;
- the processed IPC file: 60000 frames for a 1.25 s clip at 48 kHz.

After Apply, the clip's timeline position, duration, fades and gain are unchanged, and nothing plays before the clip start.

### Audio quality checks

- **Level:** the steady-state level of a shifted sine is within 0.001 dB of the input.
- **Discontinuities:** the largest sample-to-sample step equals the analytic maximum of the shifted sine (0.0288 for 440 Hz at 0.5).
- **Stereo:** L = 220 Hz, R = 330 Hz shifted +12 st gives L = 440 Hz and R = 660 Hz, with cross-channel leakage of −106 dB and −108 dB. Identical channels stay bit-identical.
- **Silence:** an all-zero input stays exactly zero. The middle of a 1 s gap between tones measures −240 dBFS (exact zero).
- **NaN/Inf:** two damaged samples were repaired; the output is finite.
- **Clipping guard:** a full-scale square wave shifted +7 st overshoots, as any band-limited shift of an ideal square does. The whole clip was lowered 5.13 dB to a 0.999 peak, and the reduction was reported.
- **Zero shift:** a bit-exact copy, flagged `identity`.

### Processing performance

- 10 s stereo 48 kHz, +5 st: 516–529 ms, about 19× real time (DSP only).
- 2 s mono 48 kHz, +12 st: 96–108 ms.
- IPC, 1.25 s stereo clip, end to end: 127–141 ms. This includes the context, both YIN measurements and writing the float WAV.
- GUI, 2 s stereo 44.1 kHz clip: 191 ms.
- Cancellation responds within one progress step: the IPC job reported `cancelled` 311 ms after starting, with a 100 ms test delay per step.
- Memory: the stretch buffer is streamed and small. The clip region is copied about three times (engine copy, sanitized copy, output), so a 10-minute stereo 48 kHz clip (the 600 s limit) needs roughly 0.7 GB at peak.

## 6. Tests executed

Native build: `scripts\build-engine.ps1`. Before each build I checked that no Music Studio Pro window or engine was running; none were.

```
Executed:
- scripts\build-engine.ps1: exit 0 (MusicStudioEngine.exe, audio_engine_tests.exe)
- build\audio_engine_tests.exe pitchshift: 18 PASS, 0 FAIL
- build\audio_engine_tests.exe pitch: 15 PASS, 0 FAIL (re-run because Pitch.cpp now uses the shared FFT)
- npx tsc -p tsconfig.json --noEmit && npx tsc -p tsconfig.electron.json --noEmit: exit 0
- npm run build: exit 0
- MSP_PITCHFIX_CHECK GUI check: 8 PASS, 0 FAIL, 2 NOT RUN (no hardware)
Not run: full regression, all other native test groups, all other GUI checks (layout, workflow, mixer, fx, auto, pitch)
Microphone: NOT RUN — NO HARDWARE
```

### Native group `pitchshift` (18 PASS)

DSP:
- `pitchshift-plus12-sine`
- `pitchshift-minus12-sine`
- `pitchshift-plus50-cents`
- `pitchshift-zero-identity`
- `pitchshift-duration-preserved`
- `pitchshift-silence-preserved`
- `pitchshift-stereo-channels-preserved`
- `pitchshift-cancel`
- `pitchshift-safety`
- `pitchshift-speed`

IPC (engine process):
- `ipc-pitchshift-process`
- `ipc-pitchshift-ab-preview`: renders of the realtime plan show 220 Hz for Original and 440 Hz for Processed. During the preview the clip is unchanged, a project saved has no preview source, and the export stays at 220 Hz. After switching back, playback is bit-identical to before.
- `ipc-pitchshift-apply-undo-redo`
- `ipc-pitchshift-project-save-load`
- `ipc-pitchshift-revert`
- `ipc-pitchshift-cancel`
- `ipc-pitchshift-mono-44k`
- `ipc-pitchshift-errors`

While the tests were being written, three intermediate runs failed because of the tests themselves:
- a missing final clamp at the 0.999 limit, which I fixed in the engine;
- a second, unmuted track mixed into the A/B renders;
- a presence threshold of −12 dB, when the measured tone level after clip gain and pan law is −13.7 dB (now −20 dB).

The leakage limits (−50 dB) were not changed.

### GUI check `MSP_PITCHFIX_CHECK` (8 PASS, 2 NOT RUN)

1. The section is present, Apply and Revert start disabled, and the editor is unchanged ("Phase 2.3", 2 track headers).
2. Invalid semitones and cents show clear errors.
3. Process +12 st from the panel: 220.0 → 440.0 Hz, one new file, clip and source unchanged.
4. The Original/Processed toggle switches the engine preview on and off without changing the clip.
5. Apply keeps timing, fades and gain, and shows the processed-clip note. Toolbar Undo and Redo restore exactly.
6. Revert to original restores the original clip, and Revert becomes disabled.
7. A 60 s job is cancelled from the panel and no file is written.
8. The source WAV files are byte-identical afterwards.

- NOT RUN: listening test on speakers (no monitored audio output; the preview audio is verified numerically by `ipc-pitchshift-ab-preview`).
- NOT RUN — NO HARDWARE: real voice recording.

Screenshots are in the check's output folder (`pitchfix-01-processed-preview.png`, `pitchfix-02-applied.png`, `pitchfix-03-cancelled.png`).

## 7. PASS / FAIL / NOT RUN summary

| Requirement | Result |
|---|---|
| +12 / −12 semitones on a sine | PASS |
| +50 cents | PASS |
| Zero-shift identity | PASS |
| Duration preservation | PASS |
| Silence handling | PASS |
| Stereo channel preservation | PASS |
| Cancellation (engine and UI) | PASS |
| Apply / Undo / Redo | PASS |
| Project save/load of a processed clip | PASS |
| Original/Processed A/B preview | PASS (numeric render check and UI check) |
| Revert to original | PASS |
| Listening evaluation (speakers) | NOT RUN — NO HARDWARE |
| Real-voice quality evaluation | NOT RUN — NO HARDWARE |
| Microphone | NOT RUN — NO HARDWARE |
| Full regression | NOT RUN (not approved) |

## 8. Known audio-quality limitations

- **Not evaluated on real voices.** Every measurement uses synthetic sines and noise. No claim of studio quality is made.
- **No formant preservation.** Formants move with the pitch, so large shifts sound "chipmunk"-like (up) or "giant"-like (down). This is expected for this phase.
- **Phase-vocoder character.** Phase locking reduces but does not remove phasiness and a slight reverberant smear on complex material, especially at large shifts. Transient handling is a simple 6 dB energy-onset reset; sharp consonants may still soften.
- **Clipping guard is a whole-clip gain change.** When a shift would exceed the peak limit, the entire processed clip is lowered (reported in the result line), rather than limited locally.
- **Repeated processing compounds artefacts.** Processing an already processed clip works from the processed audio, not the original. Revert first for the cleanest result.
- **Results are session-only.** Unapplied results cannot be previewed after a restart. Applied clips persist, and so do their files.
- **Results go stale on any change.** A processing result is invalidated by any change to the clip's source, offset or duration, including a device sample-rate change. Process again in that case.
- **Files accumulate.** Processed files are never deleted automatically; they build up in the processed-audio folder.
- **Memory.** About three copies of the clip region at peak (roughly 0.7 GB for the 600 s stereo 48 kHz limit).

## 9. Remaining work (not started; needs approval)

- Real-voice listening tests and quality metrics on sung material.
- Formant preservation, for example a spectral-envelope correction stage between the vocoder and the resampler.
- Pitch-curve-driven, time-varying correction (Phase 2.4.3+); scale quantization only when specified.
- Cleanup of unreferenced processed files.
- Optional persistence of unapplied results.

Phase 2.4.2 stops here. Waiting for approval before Phase 2.4.3.
