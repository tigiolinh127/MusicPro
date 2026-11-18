# Phase 2.4.1 final report: vocal pitch detection foundation

Date: 2026-11-07.

**Status: PASS within the targeted testing scope.** Every new function listed below was verified by targeted tests that were executed. Microphone input is **NOT RUN — NO HARDWARE**.

This phase adds pitch *detection* (analysis) only.
- **Not implemented:** pitch correction, Auto-Tune, formant shifting, AI vocal separation, VST3 hosting and livestream processing.
- **Not built:** no installer or release package.
- ProfilePilot was not touched.
- No Music Studio Pro window was running when the native engine was rebuilt (checked before the build).

## 1. Architecture and algorithm

### Independent DSP component

`include/msp/Pitch.h` and `src/Pitch.cpp` are written in C++20 and are part of the JUCE-based engine build. They depend only on the standard library: no session, mixer or device code.
- `PitchDetector` analyses one window of mono samples.
  - `prepare(sampleRate, params)` validates the settings and allocates every buffer.
  - `analyze(window, time)` does not allocate, lock or perform I/O.
- `analyzePitch(samples, count, rate, params, cancel, progress)` runs offline over a whole buffer.
  - It polls a cancel flag before every window.
  - It reports progress after every window.
  - It returns frames plus note segments.
- `midiFromFrequency`, `noteName` and `pitchNotes` handle the musical conversions.
- `checkPitchParams` is the single validation point. The engine and the tests both use it.

### Algorithm: YIN (de Cheveigné and Kawahara, 2002)

1. **Difference function** \(d(\tau)=\sum_{j<W}(x_j-x_{j+\tau})^2\), for lags 0 to \(\tau_{max}+1\).
   - It is computed as energy terms (prefix sums of \(x^2\)) minus twice a cross-correlation.
   - The cross-correlation uses a radix-2 FFT in double precision, with twiddles and bit reversal precomputed in `prepare`.
   - The integration length is \(W = \text{window} - \tau_{max} - 1\). The zero padding is sized so the circular correlation never wraps.
2. **Cumulative mean normalized difference** \(d'(\tau)=d(\tau)\,\tau/\sum_{k\le\tau}d(k)\).
3. **Absolute threshold** \(1-\text{confidenceThreshold}\).
   - The detector takes the first lag in \([\lfloor f_s/\text{maxHz}\rfloor, \lceil f_s/\text{minHz}\rceil]\) that dips below the threshold, then follows it down to its local minimum.
   - If no lag dips below the threshold, it uses the global minimum, which is then reported as unvoiced.
4. **Parabolic interpolation** of \(d\) around that lag gives the sub-sample period, and \(f_0 = f_s / \text{period}\).
5. **Confidence** is \(1 - d'(\text{best lag})\), clamped to 0..1.

### Voiced and unvoiced decisions

A frame is **unvoiced** in any of these cases:
- its RMS is below `silenceDb` (silence gate, confidence 0);
- it contains NaN or Inf samples;
- the confidence is below the threshold;
- the pitch lies outside minHz..maxHz. This is detected when the best lag sits at the edge of the range while the curve keeps falling past it, or when the half period below the range is also periodic. Without this check, out-of-range pitches would fold onto another octave.

Unvoiced frames report frequency 0, MIDI −1, note "" and cents 0. **No pitch value is invented.**

### Note conversion

- MIDI = \(69 + 12\log_2(f/440)\).
- The note is the nearest MIDI note. Cents are the deviation from it, −50 to +50.
- Names use sharps, with middle C = C4 (MIDI 60).
- `pitchNotes` merges consecutive voiced frames on the same nearest note into segments: start, end, name, mean frequency, mean cents, mean confidence and frame count.

### Engine integration (offline, asynchronous)

**`Session::copyClipMono`** reads the clip's region of its **original** source buffer, so a 44.1 kHz file is analysed at 44.1 kHz without resampling.
- The audio is downmixed to mono as (L+R)/2 and copied into a private buffer.
- Clip gain and fades are not applied.
- The source file, the session buffers and the timeline are only read.

**IPC `analyzePitch {trackId, clipId, minHz?, maxHz?, windowSize?, hopSize?, confidenceThreshold?, silenceDb?}`:**
- It validates everything on the control thread and answers immediately with `{jobId, sampleRate, frames, duration, clipStart, params}`.
- Only then does it start one worker `std::thread`, which owns the copy.
- The worker emits `pitchProgress {jobId, done, total}` at most every 100 ms, then `pitchResult` with:
  - `status`: done, cancelled or error;
  - parallel frame arrays: `time`, `frequency`, `midi`, `note`, `cents`, `confidence`, `voiced`;
  - `notes` and `summary`;
  - timing: `elapsedSeconds`, `hopSeconds`, `windowSeconds`.
- Events go through `writeJson`, which `outMutex` already serializes.
- `frameDelayMs` is a test-only option, like the recording's `writerDelayMs`.

**IPC `cancelPitchAnalysis`** sets the job's atomic cancel flag. The worker stops before its next window and reports `cancelled` with the frames it has analysed.

**Limits:**
- one analysis at a time; a second request is refused with a clear message;
- clips up to 600 s;
- at most 200,000 frames.

**Lifetime:** `Engine::shutdown` and `~Engine` cancel and join the worker before the process exits.

### Audio safety

The audio callback, `mixRoute`, the master gain and the playback and export paths were **not modified**.
- Analysis never runs in the callback. Live analysis was not added.
- It reads a private copy of the audio and cannot alter samples.
- The tests verify that the input buffer, the source WAV bytes and the clip list are unchanged.

### UI

The compact **Pitch analysis** panel is in the inspector, between Clip and Recording (`renderer/src/PitchPanel.tsx`). The editor and mixer layouts are otherwise unchanged.
- **Clip list:** all existing clips; it follows the timeline selection.
- **Detection settings** (collapsed): Min Hz, Max Hz, Window, Hop and Confidence.
- **Analyze / Cancel**, with a progress bar while the analysis runs.
- **Errors** appear in a red alert box, showing the engine's message.
- **Result:**
  - a summary: median note, voiced percentage, windows and analysis time;
  - a plot of pitch over time: dots shaded by confidence, unvoiced windows as grey columns, C gridlines labelled with note names;
  - a pointer readout: time, note, Hz, cents and confidence, or "unvoiced";
  - a scrollable list of detected notes.
- The renderer handles a `pitchResult` that arrives before the `analyzePitch` reply.

### Default parameters (vocal analysis)

| Parameter | Default | Valid range |
|---|---|---|
| minHz | 70 | 30 Hz or more, below maxHz |
| maxHz | 1000 | up to 4000 Hz and up to sample rate / 4 |
| windowSize | 2048 samples (46.4 ms at 44.1 kHz, 42.7 ms at 48 kHz) | 256–16384, and at least 2 × (⌈rate/minHz⌉ + 1) |
| hopSize | 512 samples (11.6 / 10.7 ms) | 16 to windowSize |
| confidenceThreshold | 0.85 (YIN threshold 0.15) | 0.1–0.99 |
| silenceDb | −60 dBFS | −120 to −20 |

Sample rates from 8 to 192 kHz are accepted; 44.1 and 48 kHz were tested.

## 2. Implemented functionality

| Requirement | Status |
|---|---|
| Mono input; 44.1 and 48 kHz; f0 in Hz; MIDI note; note name; cents; confidence; voiced/unvoiced | Done, tested |
| Silence and noisy input handled safely; out-of-range pitches unvoiced; NaN/Inf input unvoiced | Done, tested |
| Parameters (min/max Hz, window, hop, confidence threshold, plus silence gate) with validation | Done, tested |
| API: timestamp, frequency, MIDI, note name, cents, confidence, voiced state; explicit unvoiced results | Done, tested (native and IPC) |
| Offline asynchronous clip analysis; cancellation; responsive app; bounded memory; short, silent and invalid files handled; source and timeline untouched | Done, tested |
| Pitch Analysis panel: select clip, analyze, notes over time, frequency and confidence, voiced/unvoiced regions, cancel, errors | Done, tested (GUI check) |
| Works on imported WAV files without a microphone | Done, tested |
| Live (realtime) analysis | Not implemented (optional in the brief) |

## 3. Files changed

**New:**
- `native/audio-engine/include/msp/Pitch.h`, `native/audio-engine/src/Pitch.cpp`: the pitch detection DSP component.
- `apps/desktop/renderer/src/PitchPanel.tsx`: the Pitch analysis panel.
- `apps/desktop/electron/pitchCheck.ts`: the pitch GUI check (`MSP_PITCH_CHECK`).
- `docs/phase241-final-report.md`.

**Changed:**
- `native/audio-engine/CMakeLists.txt`: `src/Pitch.cpp` added to the sources.
- `native/audio-engine/include/msp/Session.h`, `src/Session.cpp`: `copyClipMono`, a read-only copy of the clip's source region.
- `native/audio-engine/include/msp/Engine.h`, `src/Engine.cpp`:
  - the `analyzePitch` and `cancelPitchAnalysis` commands;
  - the worker job;
  - `pitchProgress` / `pitchResult` events;
  - joining the worker on shutdown.
- `native/audio-engine/tests/test_main.cpp`:
  - `testPitch` (11 tests) and `testIpcPitch` (4 tests);
  - a `pitch` group argument.
  - Without an argument the binary still runs everything, now including these tests.
- `packages/shared/src/protocol.ts`: pitch types (`PitchParams`, `defaultPitchParams`, `PitchStart`, `PitchProgressEvent`, `PitchResultEvent`, `PitchFrames`, `PitchNote`) and the `EngineEvent` union.
- `apps/desktop/renderer/src/App.tsx`: renders `PitchPanel` in the inspector (one import, one line).
- `apps/desktop/renderer/src/styles.css`: `.pitch-*` styles.
- `apps/desktop/electron/main.ts`: the `MSP_PITCH_CHECK` hook, and the variable added to the GUI-check rendering switches.

Not changed: `Mixer.cpp`, `Routing.cpp`, the audio callback, `Project` (nothing is saved to the project), recording and automation.

## 4. Commands and tests executed

In `D:\MusicStudioPro` (a process check showed no Music Studio Pro running):
```
powershell -ExecutionPolicy Bypass -File scripts\build-engine.ps1     -> exit 0 (Release; engine + test binary)
build\audio_engine_tests.exe pitch                                   -> 15 pass, 0 fail, 0 not run
```
In `D:\MusicStudioPro\apps\desktop`:
```
npx tsc -p tsconfig.json --noEmit           -> first run: 1 error (unused parameter in PitchPanel.tsx), fixed; then exit 0
npx tsc -p tsconfig.electron.json --noEmit  -> exit 0
npm run build                               -> exit 0
MUSICSTUDIO_ENGINE=build\MusicStudioEngine.exe, MSP_PITCH_CHECK=build\phase241-pitch1, npx electron .   -> 7 pass, 0 fail, 1 not run
npm run build:renderer                      -> exit 0 (after a CSS fix for the note list)
MSP_PITCH_CHECK=build\phase241-pitch2, npx electron .                                                   -> 7 pass, 0 fail, 1 not run
```
The pitch GUI check ran twice. The second run followed a CSS-only fix, so the note-list screenshot could be checked again.

## 5. PASS / FAIL / NOT RUN

### Native DSP (`testPitch`)

| Test | Result | Measured |
|---|---|---|
| `pitch-sine-accuracy-48k` | PASS | 82.4, 110, 196, 261.6, 440, 659.3 and 987.8 Hz: every window voiced, on the right note; worst error 0.010 cents; lowest confidence 0.9986 |
| `pitch-sine-accuracy-44k` | PASS | same tones: worst error 0.020 cents; lowest confidence 0.9987 |
| `pitch-frequency-to-note-conversion` | PASS | 440 Hz is MIDI 69; C4, A#4, A0, C8, C-1 and G9 named correctly; out-of-range MIDI gives ""; 452 Hz gives A4 +46.59 c (expected +46.58) |
| `pitch-silence-unvoiced` | PASS | 90 silent and 90 quiet (−83 dBFS) windows, all unvoiced, frequency 0, MIDI −1, confidence 0 |
| `pitch-noise-handling` | PASS | white noise voiced in 0.0% of 184 windows; a 220 Hz sine at 20 dB SNR voiced in 100%, median error 1.22 c, worst 7.04 c |
| `pitch-out-of-range-unvoiced` | PASS | 1500 Hz and 50 Hz (range 70–1000 Hz): 0 voiced windows, no octave folding |
| `pitch-notes-over-time` | PASS | A3 for 0.016–0.496 s, then E4 for 0.517–0.976 s (change at 0.5 s) |
| `pitch-parameters-validated` | PASS | 12 invalid settings rejected; defaults valid at 44.1 and 48 kHz |
| `pitch-short-damaged-input-safe` | PASS | 20.8 ms of audio gives "shorter than one analysis window (42.7 ms)"; the 8 windows touching NaN/Inf are unvoiced, the other 82 voiced; input buffer bit-identical |
| `pitch-cancel-stops-analysis` | PASS | cancelled during window 10: 10 of 184 windows kept |
| `pitch-analysis-speed-and-latency` | PASS | see section 6 |

### Engine process (`testIpcPitch`)

| Test | Result | Measured |
|---|---|---|
| `ipc-pitch-imported-wav-workflow` | PASS | generated 44.1 kHz WAV (A3, silence, C5): `sampleRate` 44100; 108 frames as announced; notes A3 220.000 Hz and C5 523.252 Hz; 0 voiced windows in the silence; 79/79 tone windows voiced; progress events received |
| `ipc-pitch-source-and-timeline-unchanged` | PASS | WAV bytes identical; clip list identical |
| `ipc-pitch-errors-reported` | PASS | unknown clip; 22.7 ms clip ("shorter than one analysis window"); window 512 too short for 70 Hz; min > max |
| `ipc-pitch-cancel` | PASS | cancelled after 11 of 108 frames; a second analysis was refused while one ran; the next analysis completed |

### GUI (`MSP_PITCH_CHECK`, second run, `build\phase241-pitch2`)

| Scenario | Result | Measured |
|---|---|---|
| Pitch panel lists the existing clips; editor unchanged | PASS | 2 clips listed; 2 track headers |
| Analyze an imported 44.1 kHz WAV clip: notes over time | PASS | 0.02–0.51 s A3 220.0 Hz; 0.80–1.27 s C5 523.3 Hz; median A3, voiced 77%, 108 windows, 11 ms |
| Pitch plot drawn | PASS | 599 note pixels on the canvas |
| Frequency and confidence shown; silence is unvoiced | PASS | at 0.25 s "A3 220.00 Hz · +0.0 c · confidence 1.00"; at 0.65 s "unvoiced" |
| Analysis errors displayed | PASS | the engine's window-too-short message, shown in the panel |
| Analysis cancelled from the panel; app responsive while it runs | PASS | Cancel pressed during a 30 s clip with a 16-sample hop: "Cancelled after 3655 windows"; `getState` took 0 ms and a UI frame 1 ms during the analysis |
| Source files and timeline unchanged by analysis | PASS | SHA-256 of both WAVs and the clip list identical |
| Live microphone pitch analysis | NOT RUN | NO HARDWARE (live analysis is not part of this phase) |

The first GUI run (`build\phase241-pitch1`) had the same 7 PASS and 1 NOT RUN.

![Pitch analysis result](../build/phase241-pitch2/pitch-01-result.png)
![Settings error shown in the panel](../build/phase241-pitch2/pitch-02-error.png)
![Cancelled analysis](../build/phase241-pitch2/pitch-03-cancelled.png)

### NOT RUN

- **Microphone:** NOT RUN — NO HARDWARE.
- **Full native regression** (`audio_engine_tests.exe` with no argument) and `scripts/run-regression.ps1`: NOT RUN. The policy forbids them without approval.
- **All other native groups and all other GUI checks** (layout, workflow, mixer, fx, auto, smoke, phase0): NOT RUN.
- **Real singing voices:** NOT RUN. Accuracy was measured with generated sines, noise and note changes only.

## 6. Accuracy and latency measurements

All figures come from the runs above (Release build, this machine).

**Accuracy:**
- Pure sines from 82 Hz to 988 Hz: worst error **0.010 cents at 48 kHz** and **0.020 cents at 44.1 kHz**.
- Sine at 20 dB SNR in white noise: median error **1.22 cents**, worst **7.04 cents**, 100% voiced.
- White noise alone: **0%** false voicing.
- Imported 44.1 kHz WAV over IPC: 220.000 Hz and 523.252 Hz measured, for 220.000 and 523.251 Hz generated.

**Time resolution:**
- One estimate per hop: 10.7 ms at 48 kHz, 11.6 ms at 44.1 kHz.
- Each estimate describes a 42.7 / 46.4 ms window and is timestamped at the window centre.
- A note change is located to within about half a window; the 0.5 s change was found at 0.496 / 0.517 s.

**Latency** (relevant for a later live mode, not used now):
- The analysis needs one full window: 42.7 ms at 48 kHz with the defaults. The algorithmic delay is about half of that (21 ms), counted to the window centre.

**Processing speed:**
- 10 s at 48 kHz: 934 windows in 111.4 ms. That is **90× real time**, or 119 µs per window.
- In the app, the 1.3 s clip took 10–14 ms.

**Responsiveness:** during a running analysis, an engine `getState` answered in 0–1 ms and a renderer frame took 1 ms.

**Memory:**
- The analysis copy is mono float: 4 bytes per sample, at most 600 s. That is about 106 MB at 44.1 kHz and 115 MB at 48 kHz; higher-rate sources need proportionally more.
- Results take about 56 bytes per frame natively; frames are limited to 200,000.

## 7. Known limitations

- Offline clip analysis only. There is no live or realtime analysis of the input or of playback.
- One fundamental per window (monophonic). Chords, harmonies and overlapping voices give unreliable or unvoiced results.
- YIN can still make octave errors on real voices with a weak fundamental (breathy or vocal-fry tones). It was not evaluated on recorded singing.
- The window must hold two periods of `minHz`. Lowering `minHz` requires a larger window, which lowers the time resolution.
- The analysis uses the clip's source region without clip gain or fades. A faded edge is analysed at full level. The silence gate uses the raw source level.
- Note segments are not smoothed. Vibrato across a semitone boundary, and windows that straddle a note change, produce short fragments of 1–2 frames.
- Results are not saved in the project. They are kept in the panel until the next analysis or a reload.
- The cancelled-result plot keeps the full clip's time axis. The analysed part is at its left.
- The reference pitch is fixed at A4 = 440 Hz.
- Clips are limited to 600 s and 200,000 frames, and only one analysis can run at a time.
- The window title label still reads "Phase 2.3". Other GUI checks assert that label, so it was left unchanged.

## 8. Remaining work

- Evaluate accuracy on recorded vocal material: octave errors, breathy voice, vibrato.
- Optional live analysis through a bounded, preallocated ring buffer feeding a worker (not started).
- Note smoothing and minimum note length, and an adjustable reference pitch.
- With approval: the full native suite and the full GUI regression, to confirm nothing else changed. Existing code paths were not modified, but these suites were not run.
- **Phase 2.4.2 and later** (pitch correction and so on) are not started and wait for approval.
