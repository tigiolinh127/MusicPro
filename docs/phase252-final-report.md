# Phase 2.5.2 — Real-Time Pitch Detection & Target Tracking: final report

Status: implemented and verified with targeted tests. Native group `realtimepitch`: **20 PASS,
0 FAIL**. Live pitch GUI check: **4 PASS, 0 FAIL**, 1 NOT RUN (microphone).

This phase is **detection only**. The live input, monitoring, recorded takes, clips, mixer output
and export are not changed; there is no pitch shifting and no added audio latency. Real-time
safety is shown by design, code structure and targeted tests on this machine. It is not claimed
for every device or system load.

## 1. Audit and reuse

| Existing piece | Used as |
| --- | --- |
| `PitchDetector` (YIN, `Pitch.h`): `prepare()` allocates; `analyze(window)` does not allocate, lock or do I/O, and returns unvoiced for non-finite windows | The per-window detector, unchanged. It already works on any window, so it was not duplicated. |
| `checkPitchParams`, `midiFromFrequency`, `noteName` | Settings validation (window ≥ 2·(rate/minHz + 1), maxHz ≤ rate/4), MIDI and names |
| `mapPitch` + `MusicalKey`/`MappingSettings` (Phase 2.4.3 scale module) | Nearest allowed target and correction for 12 roots × 7 scales. The live key is the project key (`session.pitchMapping`). |
| `RecordQueue` (SPSC slots, audio thread → worker, drops and counts when full) | The callback → worker queue. Extended with an optional per-slot `stamp` (default 0; recording passes nothing). |
| Phase 2.5.1 live-stage pattern (`liveDspLive` + `liveDspUsers`, retire then free) | Same ownership for the detector (`livePitchLive` + `livePitchUsers`) |
| `AudioRing` (single-thread FIFO) | Not used. The worker needs a contiguous window for `analyze()`, so the analyzer keeps a small linear buffer (window + 1024 samples). |
| Input paths: callback `in1`/`in2` (device input or the virtual test signal), then the live DSP stage, then record inputs and monitoring; `micL`/`micR` read the device directly | The tap reads `in1`/`in2` **before** the live DSP stage and never writes them. |

## 2. Architecture

```
audio callback (RT)                     worker thread (std::thread)          control thread (IPC)
in1/in2 ──► LivePitchDetector::write()  RecordQueue ──► LivePitchAnalyzer     getLivePitch
            (copy into staging,          (64 slots)      push(): mono mix     setLivePitch
             push slot + timestamp)                      next(): YIN window   setPitchMapping ──► packed key atomic
                                                         NoteTracker          ▲
                                                         mapPitch(key)        │ mutex-protected result
                                                         publish() ───────────┘ history (256)
```

- `LivePitchAnalyzer` (`LivePitch.h/.cpp`) is the streaming core. It is single-threaded and
  deterministic, so tests drive it directly.
  - `push(frames, channels, firstIndex, arrivalNs, dequeueNs)` takes 1 or 2 interleaved channels
    (2 are averaged).
  - `next()` returns every complete window: `windowSize` samples every `hopSize` samples
    (overlapping), whatever the block sizes.
  - It needs no complete file. A first index that does not follow on from the last block is a
    gap: buffered audio and the tracker are reset.
- `NoteTracker` makes the frame-by-frame note decision (section 5).
- `LivePitchDetector` is the threaded wrapper: the callback-side `write()`, a worker thread, the
  key atomic, reset requests and the result history and statistics.
- Defaults: 80–1000 Hz, hop 256, confidence 0.85, silence −55 dBFS, input "mix". The window is
  automatic: the shortest window holding two periods of `minHz`, rounded up to 64 samples. That
  gives 1216 samples (25.3 ms) at 48 kHz, 1152 at 44.1 kHz, and 512 for a 200–2000 Hz range.

## 3. Threading, queue ownership and capacity

- **Audio thread** (`write()`):
  - Copies the selected channels into preallocated staging (2 × 1024 floats) and pushes slots
    into the `RecordQueue`.
  - Stamps each slot with `steady_clock` (QueryPerformanceCounter).
  - No allocation, lock, file I/O, logging, IPC or syscall-based wakeup. Bounded work: one copy
    of the block.
  - Blocks under 256 frames are coalesced; a slot is pushed once 256 frames have been staged.
- **Queue:** 64 slots × 1024 frames = 65,536 frames (1.37 s at 48 kHz), allocated in
  `start()`. The detector owns it. The audio thread is the only producer and the worker the only
  consumer.
- **Overflow behaviour:** when the queue is full, the rest of that block (the newest audio) is
  dropped and counted (`droppedFrames`, `overflows`). The callback never waits. The worker sees
  the index gap, restarts its window and tracker, and flags the first result after it `gap`.
- **Worker:**
  - Drains the queue, then sleeps 1 ms when it is empty (polling, so the callback needs no
    wakeup call).
  - Applies key changes (one packed 64-bit atomic) and reset requests (atomic flag) between
    slots.
  - Publishes results into a 256-entry ring under a mutex. Only the worker and the control
    thread take that mutex; never the audio thread.
- **Lifecycle:**
  - `configureLivePitch()` retires the old detector: it clears `livePitchLive`, waits for
    `livePitchUsers == 0`, then stops and joins the worker. It then starts a new detector at the
    device rate and publishes it.
  - The detector is restarted when the device reopens, stopped in `shutdown()`, and joined by
    its destructor.

## 4. Engine integration, IPC and UI

- **Callback:**
  - Four lines before the live DSP stage pass `in1`/`in2` (device or test signal) to
    `write()`.
  - A missing channel is treated as silence; input 2 falls back to input 1 on mono devices.
  - The pointers and samples are left untouched.
- **IPC (read-only diagnostics):**
  - `getLivePitch {recent?: 0..256}` returns:
    - the settings, the key, the resolved window/hop and the latest result;
    - optionally the last N results;
    - statistics: frames, drops, overflows, windows, gaps, resets, queue capacity and depth,
      memory, latency means/max/p95, and worker load.
  - `setLivePitch` accepts `enabled`, `input` (`input1`/`input2`/`mix`), `minHz`, `maxHz`,
    `windowSize` (0 = automatic), `hopSize`, `confidenceThreshold`, `silenceDb`, `reset` and
    `resetStatistics`. Invalid values are rejected with a message.
  - Detection is off by default and not saved in the project.
- **Key:** `setPitchMapping` and `loadProject` push the project key into the running detector.
  Live targets always use the key; the offline "Suggest targets" flag does not gate them.
- **UI:**
  - A compact "Live pitch" panel in the inspector between Pitch analysis and Recording.
  - Controls: Detect, Input, and Key/Scale (shared with the project key).
  - Readout: note, Hz, cents, confidence, target, correction, and a detection-latency line.
  - It polls `getLivePitch` (latest result only) every 100 ms while Detect is on, and skips a
    poll while the previous one is still pending. No samples cross IPC.

## 5. Note tracking

Per window, voiced = YIN voiced and no non-finite sample in the window. `NoteTracker`
defaults:

- **Hysteresis:** the pitch must move more than ±0.85 semitone (0.5 + 0.35) from the note to
  leave it, so vibrato and wavering across a semitone boundary do not flicker.
- **Onset:** 2 consistent voiced frames (about 5 ms after the first full window). The note is
  the one nearest their mean.
- **Note change:** 3 consistent frames away from the note.
- **Octave errors:** a jump of ±12 or ±24 semitones lasting fewer than 5 frames is folded back
  to the note's octave (`octaveCorrected`). From 5 frames (26.7 ms) on it is believed.
- **Gaps:** up to 8 unvoiced frames (42.7 ms) are bridged (`held`); the note continues but has
  no target. After that the note is released, and the next voiced audio starts a new onset.
- **No heavy smoothing:** the reported pitch is the frame's own pitch (folded only for isolated
  octave jumps).
- **Targets:** only voiced frames with a tracked note get `targetMidi`, `correctionCents` and
  `inTune` from `mapPitch`. Unvoiced, invalid and onset-pending frames have `targetMidi = -1`.

## 6. Timestamps and latency model

Each result carries:

- the input sample indices: window start and end (centre = `inputTime`);
- four timestamps: `arrivalNs` (the callback that handed over the window's last sample),
  `dequeueNs` (the worker took that slot), `startedNs` and `completedNs`;
- the measurement: frequency, MIDI, cents, confidence and level;
- the tracked note and flags, then the target, correction and in-tune flag.

Latency is reported in separate parts:

| Part | Definition |
| --- | --- |
| window delay (lookahead) | window/2 ÷ rate: the window centre to its last sample (12.67 ms at 48 kHz) |
| worker scheduling | dequeue − arrival |
| computation | completed − started |
| availability | window delay + (completed − arrival) |

These are **not device latency**. The device input latency and the host buffer before the
callback are not included. The tracker's confirmation (2–5 frames) comes on top for a new note,
and is measured separately as "tone start to confirmed note".

## 7. Commands executed and results

Before each native build I checked for running processes (`Get-CimInstance Win32_Process` for
`MusicStudioEngine*`, or Electron with `MusicStudioPro` in its command line). Nothing was
running; nothing was closed.

| Command | Result |
| --- | --- |
| `powershell -ExecutionPolicy Bypass -File scripts\build-engine.ps1` (1) | compile error C2513: test lambda named `near` (a Windows macro); renamed `closeTo` |
| `scripts\build-engine.ps1` (2) | built, no errors or warnings shown |
| `build\audio_engine_tests.exe realtimepitch` (1) | 18 PASS, 2 FAIL (below) |
| `scripts\build-engine.ps1` (3) | built |
| `build\audio_engine_tests.exe realtimepitch` (2) | 20 PASS, 0 FAIL |
| `scripts\build-engine.ps1` (4, hold 6 → 8 frames) | built |
| `build\audio_engine_tests.exe realtimepitch` (3, final) | **20 PASS, 0 FAIL, 0 NOT RUN** |
| `npx tsc -p tsconfig.json --noEmit` + `npx tsc -p tsconfig.electron.json --noEmit` (3 times, `apps\desktop`) | exit 0 each time |
| `npm run build` (3 times) | exit 0 each time |
| live pitch GUI check run (1): `MSP_LIVEPITCH_CHECK=<temp dir>`, `npx electron .` | 3 PASS, 1 FAIL: panel height 170 px over my 160 px bound; footer hint shortened to one line |
| live pitch GUI check run (2) | 4 PASS, 0 FAIL, 1 NOT RUN |
| live pitch GUI check run (3, after the "−0" display fix and a stricter check) | **4 PASS, 0 FAIL, 1 NOT RUN** |

The first native run had two failures; both expectations were adjusted and one tracker detail
improved:

- `realtimepitch-no-flicker`: frames alternating 69.45/69.62 started on note 70, because the
  onset rounded the last frame. The tracker now uses the mean of the agreeing frames (product
  change). The test values became 69.38/69.58, whose mean is clearly note 69. There was still
  exactly one note, with no flicker.
- `realtimepitch-octave-errors`: the audio fixture used a **40 ms** real 440 Hz burst. That
  covers about 8 windows, so it is a genuine short octave jump, and the tracker correctly
  believed it after 5 frames. The fixture now uses a 15 ms burst (2–3 windows). The tracker test
  of isolated 1-, 2- and 4-frame jumps passed unchanged.

After those runs I raised the default hold from 6 to 8 frames: the 30 ms gap fixture produced
exactly 6 unvoiced windows, at the limit. The final run used hold 8.

### Native tests (`realtimepitch`, final run)

| Test | Evidence |
| --- | --- |
| realtimepitch-sine-accuracy | 82–988 Hz at 44.1 and 48 kHz, 480-frame blocks: worst error 0.021 cents, 100 % voiced, notes correct; 200–2000 Hz range: window 512, 1500 Hz worst 0.007 cents |
| realtimepitch-variable-blocks | blocks of 1, 7, 64, 128, 256, 480, 512, 1000 and random 1–1024 frames: all 146 windows identical to 1024-frame blocks |
| realtimepitch-mono-stereo | stereo L=R identical to mono; L only: same frequency, level −6.02 dB; L=−R mixes to silence (0 voiced) |
| realtimepitch-silence-noise-invalid | silence and white noise: 0 voiced, 0 notes; −70 dBFS sine unvoiced; NaN and +inf: exactly the 10 overlapping windows flagged invalid, unvoiced, no target, note held (1 onset) |
| realtimepitch-note-transitions | A3 C4 (rest) E4: onsets [57, 60, 64], tracked [−1, 57, 60, −1, 64]; confirmed 30.7 / 34.7 / 30.7 ms of audio after each start; 30 ms gap bridged; 200 ms rest releases |
| realtimepitch-vibrato | ±50 cents at 5.5 Hz and ±30 cents at 6 Hz: one note (A4), tracked pitch spans 99.2 / 59.4 cents (input 100 / 60), target A4 throughout |
| realtimepitch-octave-errors | 2-frame +12, 1-frame −12 and 4-frame +24 jumps folded back (note stays 57); sustained +12 accepted after 5 frames; 15 ms 440 Hz blip in 220 Hz → notes [57]; 300 ms 440 Hz → [57, 69] |
| realtimepitch-no-flicker | 200 frames alternating 69.38/69.58: one note (69) |
| realtimepitch-key-scale-targets | 12,852 targets over 12 roots × 7 scales equal `mapPitch` and lie in the key; key change mid-stream: A4 in C major → A4 0 cents, then C minor pentatonic → A#4 +100 cents |
| realtimepitch-queue-overflow | index gap flagged and tracker restarted; 10 s written at once into the 65,536-frame queue: 414,464 frames dropped in 405 overflows, slowest write 7.1 µs; worker saw the gap and recovered (A4), no drops at real-time pace |
| realtimepitch-timestamps | 183 of 183 results: window 1216 / hop 256 exact; arrival ≤ dequeue ≤ start ≤ completion; arrival lies inside the write() call that delivered the window's last sample; delay formulas exact |
| realtimepitch-detection-latency | see section 8 |
| realtimepitch-reset-reconfigure | reset restarts sequence, window and onset; invalid range/window/hop/tracker/confidence/rate rejected; input1 440 Hz, input2 300 Hz, mono mix, input2 missing → input1; requestReset counted; restart at 44.1 kHz/100–800 Hz (window 896) |
| realtimepitch-no-allocations | 20,000 `write()` calls with 1–8192-frame blocks, mono and stereo: **0 allocations**, input buffers unchanged; worker `push()`/`next()` over 371 windows: 0 allocations |
| ipc-livepitch-defaults-and-errors | off by default (input mix, 80–1000 Hz); 6 invalid requests rejected with messages |
| ipc-livepitch-audio-unchanged | real WASAPI callback: detection on vs off, monitored output max difference **0** over 36,960 frames, recorded take max difference **0** over 36,480 frames |
| ipc-livepitch-detects-live-input | 440 Hz test signal: A4 439.999 Hz (−0.004 cents), target A4 0.01 cents, 93 windows, 0 dropped, 0 gaps |
| ipc-livepitch-unvoiced-after-stop | 150 ms after stop: unvoiced, note −1, target −1 |
| ipc-livepitch-key-change | `setPitchMapping` C minor pentatonic: A4 → A#4, +100.01 cents |
| ipc-livepitch-input-select | input2 (the test signal's 200-frame ramp, 240 Hz): 240.000 Hz; output still identical to the off run; disable works |

### GUI check (`MSP_LIVEPITCH_CHECK`, final run)

Input was injected only with `webContents.sendInputEvent`; the desktop mouse was not used.

- PASS: compact panel between Pitch analysis and Recording, off by default, 155 px, no overflow.
- PASS: live readout of the 440 Hz test signal: A4, 440.0 Hz, +0 cents, 100 %, target A4,
  +0 c, "Detection 14.1 ms (window 12.7 + worker 1.2 + compute 0.10)".
- PASS: Scale → Minor pentatonic in the panel: target A#4, +100 c.
- PASS: after stop, note/target/correction "—"; Detect off stops the engine detector and hides
  the readout.
- NOT RUN: live microphone input (no hardware).

Screenshots: `%TEMP%\msp-livepitch-check-20261108121541\livepitch-0{1,2,3}-*.png`.

### NOT RUN

- full regression and `scripts\run-regression.ps1`;
- all other native groups: `automation` (contains the recording/monitoring IPC tests),
  `master-gain`, `pitch`, `pitchshift`, `pitchmap`, `autocorrect`, `vocalquality`,
  `realtimedsp`, and the full native list;
- all other GUI checks;
- installer and packaging (not built).

Microphone: NOT RUN — NO HARDWARE.

Note: `RecordSlot` gained an 8-byte `stamp` field and `RecordQueue::push` a defaulted `stamp`
parameter. Recording passes nothing, so it writes 0. The change is additive, and
`ipc-livepitch-audio-unchanged` shows identical takes with detection on and off. That compares
the new binary with itself, though, not with the previous one. The existing recording tests in
`automation` were not run per policy; running them needs your approval.

## 8. Accuracy, latency, CPU and memory (Release build, this PC)

| Measure | Unit test (480-frame writes every 10 ms, 48 kHz) | Real callback (IPC, WASAPI 48 kHz / 480) |
| --- | --- | --- |
| window delay | 12.67 ms | 12.67 ms |
| worker scheduling mean / max | 1.57 / 2.01 ms | 1.04 / 1.99 ms |
| computation mean / max | 89.7 / 215 µs | 110.5 µs mean |
| availability mean / p95 / max | 14.37 / 14.94 / 15.00 ms | 13.87 / 14.77 / 14.86 ms |
| tone start → first voiced result | 22.8 ms | — |
| tone start → confirmed note | 28.2 ms | — |
| worker load (compute ÷ hop) | 1.9–2.5 % of one core | 2.07 % |

- **Accuracy (synthetic):** pure sines within 0.021 cents (82–988 Hz) and 0.007 cents
  (1500 Hz). Live test signal −0.004 cents. Sawtooth 240 Hz exact.
- **Callback cost:** `write()` is one copy of the block plus a queue push. The slowest call in
  the overflow test (4096 frames) took 7.1 µs. Its cost was not timed separately inside the
  real callback.
- **Memory:** 579 KiB preallocated and reported by `getLivePitch` (queue 64 × 8,224 B, staging
  8 KiB, window buffer 9 KiB, history 256 results). The YIN detector's own FFT buffers add about
  80 KiB at the default window and are not counted.

These are measurements on one PC with synthetic signals. Scheduling depends on OS timer
resolution and load.

## 9. Files changed

New:

- `native/audio-engine/include/msp/LivePitch.h` and `native/audio-engine/src/LivePitch.cpp`
- `apps/desktop/renderer/src/LivePitchPanel.tsx`
- `apps/desktop/electron/livePitchCheck.ts`
- `docs/phase252-final-report.md`

Modified:

- `native/audio-engine/CMakeLists.txt`: adds `src/LivePitch.cpp`.
- `native/audio-engine/include/msp/Recording.h` and `src/Recording.cpp`: `RecordSlot::stamp`
  and the defaulted `push(..., stamp)`.
- `native/audio-engine/include/msp/Engine.h` and `src/Engine.cpp`:
  - the callback tap;
  - start on device open, stop on shutdown;
  - key updates from `setPitchMapping` and `loadProject`;
  - IPC `getLivePitch` and `setLivePitch`;
  - `livePitchVar`.
- `native/audio-engine/tests/test_main.cpp`: the `realtimepitch` group (14 unit and 6 IPC
  tests), registered in `main()` and the full list.
- `packages/shared/src/protocol.ts`: `LivePitchInput`, `LivePitchResult`,
  `LivePitchStatistics` and `LivePitchStatus`.
- `apps/desktop/renderer/src/App.tsx` and `styles.css`: the panel.
- `apps/desktop/electron/main.ts`: the `MSP_LIVEPITCH_CHECK` hook.

## 10. Known limitations

- **Evidence:** synthetic signals, one device configuration (WASAPI shared, 48 kHz, 480) and one
  PC. No real voice or microphone was tested. Real voices (breath, consonants, formants) will
  give more unvoiced and uncertain windows than sines.
- **YIN limits:** the window must hold two periods of `minHz`, so lowering `minHz` raises the
  window delay. Below 80 Hz the default window grows past 25 ms.
- **Tracker trade-offs:**
  - Vibrato wider than about ±85 cents (including detector noise) is treated as note movement.
  - A real octave jump shorter than 5 frames (about 27 ms) is folded back as if it were an
    error.
  - Note confirmation adds 2–3 hops.
- **Coalescing:** host buffers under 256 frames are coalesced. The last staged frames wait for
  later callbacks (up to 256 frames, 5.3 ms), and that wait happens before `arrivalNs`, so it is
  not in the reported availability.
- **Polling:** the worker polls with a 1 ms sleep. The scheduling delay depends on timer
  resolution; it measured about 1–2 ms here.
- **Overflow:** dropped audio is lost to detection only (never to recording or monitoring).
  The worker restarts after a gap.
- **UI:** the 10 Hz polling and its in-flight guard are by design; there is no automated test
  of the request rate. The panel shows the latest result only, with no history plot.
- **Persistence:** detection settings other than the key are not saved with the project. The
  minHz/maxHz/window/hop/confidence controls are available over IPC only, not in the UI.
- **Callback size:** the callback tap handles blocks of any size (copied in 1024-frame pieces).
  A virtual-input block over 8192 frames is passed as silence, like recording.

## 11. Stop

Phase 2.5.2 is complete. Not implemented, as instructed: real-time pitch shifting, live
correction, real-time formants, AI voice, VST3, livestream and installer. ProfilePilot was not
touched. Work stops here pending your approval.
