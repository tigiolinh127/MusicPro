# Phase 2.2.1 final report: DSP stabilization and export tail support

Status: **PASS**, with the items listed under "Not run" below.

Date: 2026-11-06. Every result below comes from a command that was actually executed on the final build (`build\phase221-final`). Microphone tests are **NOT RUN — NO HARDWARE**. No installer was created. Nothing from Phase 2.3 was started. The desktop mouse and keyboard were not used. All GUI checks drive the app window with Chromium input events injected into the page (`webContents.sendInputEvent`). ProfilePilot was not touched.

## Status by requirement

| Requirement | Status |
|---|---|
| 1. Configurable reverb/delay tail after the last clip: exact timeline length kept, optional tail, maximum length, silence threshold, bounded feedback, deterministic | PASS |
| 2. Effect changes during real playback (add, remove, reorder, bypass/unbypass, delay time), click-free by numerical test with the transport playing | PASS (engine callback output captured on the real device) |
| 3. No expensive delay-buffer clearing in the audio callback | PASS (no effect `reset()` on the audio thread; delay reset is now O(1)) |
| 4. Routing, mixer, effects, timeline editing and project compatibility preserved | PASS (all Phase 0–2.2 checks pass) |
| 5. Native tests, TypeScript checks, Vite build, regression | PASS |
| 6. Playback/export consistency for the same interval, including tails | PASS (bit-identical offline; live capture identical over the export length) |
| 7. Microphone | NOT RUN — NO HARDWARE |
| 8. This report | Done |
| Listening by ear, real OS-mouse use | NOT RUN |

## Baseline (before any Phase 2.2.1 change)

`build\phase221-baseline`, unchanged Phase 2.2 binaries:
- native tests **308 pass, 0 fail, 7 not run**, which matches the Phase 2.2 report;
- every other step passed except `layout-check`, where two 960x700 checks failed with "track area scrolls horizontally". The log shows Chromium "Unable to move the cache: Access is denied" errors. This means a second instance was running at the time; a Music Studio Pro window was open during this session. This is the same environmental failure that was seen and explained in the Phase 2.2 baseline. With no instance running, both checks pass in the final run below.

## 1. Effect tails after the last clip

### Behaviour

- **Settings** (`TailSettings`, per project):
  - `enabled` (default on);
  - `maxSeconds` (default 10 s, allowed range 0–60 s);
  - `thresholdDb` (default −90 dBFS, allowed range −140 to −20 dBFS).
- **Activation:** the tail is only active when the plan contains at least one *enabled* reverb or delay (`applyRenderTail`). Projects without them, or with tails off, render exactly the timeline length, as before.
- **Rendering:** after the timeline end, sources are silent and every effect chain keeps running. The tail ends at whichever comes first:
  - the master signal has stayed below the threshold for a hold window. The window is max(200 ms, longest enabled delay time + 50 ms), so the gaps between delay echoes do not end the tail early;
  - `maxSeconds` is reached.
- **Feedback safety:** delay feedback is already limited to 0.95. The maximum tail length is a hard stop, so no setting can render forever (`tail-max-stops-feedback-delay`).
- **Measurement point:** the master signal after the master inserts, before the mic monitor and the master gain. Tail length therefore does not depend on the master fader.
- **Export length:** export and `renderPlayback` trim the file to the last sample above the threshold + 1. A file is never shorter than the timeline, and "Off" gives exactly the timeline length.
- **Determinism:** detection is per sample, so the length and content do not depend on the block size (`tail-render-deterministic-any-block-size`).
- **Live playback:** the transport keeps playing through the tail, then stops by itself. The reported position stays clamped to the timeline duration while the tail plays.

### Interface

- **IPC:**
  - New op `setRenderTail { enabled?, maxSeconds?, thresholdDb? }`. It is validated; invalid values are rejected with "Maximum tail length must be between 0 and 60 seconds." or "Tail silence threshold must be between -140 and -20 dBFS.".
  - `getState` returns `renderTail`.
  - `exportWav` and `renderPlayback` accept an optional `tail` override.
  - `exportWav` returns `frames`, `timelineFrames`, `tailFrames` and `tail`.
  - Diagnostic ops `startCapture` / `stopCapture` record the buffers the audio callback renders during playback. They are used only by the tests.
- **Project:**
  - Saved as a `renderTail` object. The schema stays **v4**; older files load with the defaults.
  - Invalid values are reset to the defaults with the warning "Some effect tail settings were invalid and were reset to their defaults (on, 10 s, -90 dBFS)."
- **UI:**
  - Two selects in the device panel after "Export rate". "Effect tail" offers Off and Up to 2/5/10/30/60 s. "Tail floor" offers −60/−80/−90/−100/−120 dBFS.
  - Header label "Phase 2.2.1".
  - Nothing else in the layout changed.

![Tail controls](../build/phase221-final/fx/build-fx-tail-controls.png)

## 2 and 3. Realtime-safe effect state during playback

Phase 2.2 had two audio-thread resets: re-enabling an effect from full bypass, and transport stop. Both cleared effect history in the callback; for a delay, that is a fill of its 2 s buffer. Phase 2.2.1 removes both and replaces them with state prepared on the control thread:

- **Fresh processors come from the control thread.** `publishMix` already builds a new `MixState` with clean processors for every snapshot. On snapshot pickup, `inheritMixState` now carries an old processor over only if it is still audible, meaning its effect mix is greater than 0. A fully bypassed processor has a frozen, stale tail, so it is *not* carried. The clean processor that was prepared in advance is used instead, and the stale one is freed later on the control thread with the old snapshot. The existing `audioSeq` acknowledgement rule covers this.
- **Input warm-up.** Every processor that was not carried starts with `effectWarm = 0`. Its input ramps from 0 to 1 over 10 ms, the same rate as the bypass crossfade. A delay line or reverb comb therefore never starts from a step. Without the warm-up, `add-delay-and-reverb-while-playing-click-free` measures 6.96e-4; with it, 3.6e-5.
- **Stop and Play.** While the transport is stopped, nothing is carried. Play from stop publishes a fresh snapshot and waits until the audio thread has picked it up (`waitForAudioSnapshot`). Every Play therefore starts with clean effects, without any clearing in the callback (`live-stop-then-play-starts-clean`: max difference to an export 0.000000).
- **No effect `reset()` on the audio thread any more.** `DelayDsp::reset` is also O(1) now. A `filled` counter tracks how much of the buffer holds valid history, and reads of unwritten slots return 0. The buffer is never cleared. Measured: 0.005 µs per reset, against 10.0 µs to clear both 2 s buffers, with no stale history (`delay-reset-constant-time-no-stale-history`).
- Unchanged from Phase 2.2: bypass/enable crossfades of 10 ms; remove and move first fade the effect out (`settleAudio`); smoothed parameters; a delay time change crossfades between read positions over 20 ms.

### Click measurement

The metric is the largest absolute second difference of the output, max |x[i+1] − 2x[i] + x[i−1]|.
- A clean 100 Hz sine at amplitude 0.3 measures 5.1e-5.
- An abrupt switch measures roughly its amplitude; in the live capture, a deliberate splice measured 0.215.
- The pass limit is 5e-3.

| Test | Worst second difference |
|---|---|
| `add-delay-and-reverb-while-playing-click-free` (simulated `mixRoute`) | 3.6e-5 |
| `reorder-and-delay-time-while-playing-click-free` (simulated) | 8.62e-4 |
| `live-effect-changes-while-playing-click-free` (real device, transport playing) | 8.36e-4 |

`live-effect-changes-while-playing-click-free` plays a 12 s, 100 Hz tone on the real output device (Speakers, 2- Realtek, 48 kHz, 480-sample buffer). While the transport is playing, it sends this sequence through the engine IPC:
1. add EQ, then EQ +6 dB shelf;
2. add delay, delay time 40 ms;
3. add compressor, then compressor settings;
4. add master reverb;
5. bypass and quickly unbypass the EQ;
6. bypass the EQ, wait 600 ms, unbypass;
7. delay time 120 ms, then 300 ms;
8. move the compressor first, then the delay first;
9. remove the EQ, delay, compressor and reverb.

The callback output was captured for all 313,440 frames, and every frame was written. `live-effect-changes-take-effect` confirms that the changes were really applied: dry RMS 0.150, ×1.995 with the EQ, ×0.99995 after removing everything.

This also resolves two Phase 2.2 limitations. First, click-free remove and move during playback are now verified with the transport actually playing, not only in simulation. Second, the audio-thread resets are gone.

During development, the live test found a real click (4.5e-3, 300 ms after "move delay first"). It came from a delay that had been fully bypassed resuming its frozen buffer. The carry-only-if-audible rule and the input warm-up fix it.

## 6. Playback/export consistency including tails

- `ipc-playback-render-equals-export-with-tail`: the published realtime plan rendered through `mixRoute` (`renderPlayback`) equals the export. 89,086 frames (timeline 24,000 + tail 65,086), max difference **0.000000**.
- `live-playback-equals-export-with-tail`: the callback output captured during real playback is 98,686 frames. That is the export's 89,086 frames plus the 9,600-sample hold window. Over the export length the max difference is **0.000000**. Everything after it peaks at −80.009 dBFS, below the −80 dBFS threshold used in that test.
- GUI (fx-build): every scenario's realtime playback render equals its export (worst difference 0.00e+0), as in Phase 2.2.

## Build and test results (final run: `build\phase221-final`)

Command: `$env:MSP_RUN_FX='1'; powershell -ExecutionPolicy Bypass -File scripts\run-regression.ps1 -OutDir build\phase221-final`

| Step | Result |
|---|---|
| native-build (CMake + Ninja, VS 2026, JUCE 8.0.17) | exit 0 |
| native-tests (`audio_engine_tests.exe`) | exit 0 — **328 pass, 0 fail, 7 not run** (baseline 308 / 0 / 7) |
| phase0-script | exit 0 |
| tsc-renderer, tsc-electron | exit 0 |
| desktop-build (Vite) | exit 0 |
| smoke | exit 0 |
| layout-check (Phase 1) | exit 0 — 33 pass |
| workflow-edit / workflow-reload (Phase 1) | exit 0 — 31 / 5 pass |
| mixer-build / mixer-reload (Phase 2.1) | exit 0 — 28 / 5 pass |
| fx-build / fx-reload (Phase 2.2 + 2.2.1) | exit 0 — 28 / 6 pass (Phase 2.2: 26 / 5) |

Totals: **328 native + 136 GUI checks pass, 0 fail**. The 7 native tests that were not run are unchanged from earlier phases:
- `mic-monitor-switch` (no input device is enumerated);
- six manual items: listening by ear, microphone with headphones, physical device switching, 30-minute soak, CPU/glitch listening, round-trip latency.

### New native tests (20, all PASS; values from the final log)

- **Tails:**
  - `tail-export-includes-reverb-tail`: timeline 24,000 samples, tail 77,168 samples (1.61 s), first 100 ms RMS 0.061.
  - `tail-off-keeps-exact-timeline-length`: 24,000 = timeline.
  - `tail-threshold-controls-length`: −60 dBFS tail 44,593 samples, −90 dBFS tail 77,168. The peak after the −60 dBFS end is −60.2 dBFS.
  - `tail-render-deterministic-any-block-size`: tail 77,168 for every block size.
  - `tail-only-for-enabled-reverb-and-delay`: no tail with only a bypassed reverb or delay, or with other effects (24,000 frames).
  - `tail-max-stops-feedback-delay`: 0.95 feedback stops at exactly timeline + 96,000 (the 2 s maximum) while still ringing at −19.8 dBFS RMS.
  - `tail-hold-spans-delay-gaps`: 311,995 frames (about 312,000 expected). The quiet gaps between echoes do not end the tail.
  - `tail-settings-project-roundtrip`: save/load, plus the invalid-values warning.
- **Realtime state:**
  - `delay-reset-constant-time-no-stale-history`: stale output 0, reset 0.005 µs against a 10.0 µs buffer clear.
  - `reenable-after-full-bypass-uses-clean-processor`: old echo after a full bypass 0.000000; for an unbypass during the fade, where the processor is kept, it is 0.707.
  - `add-delay-and-reverb-while-playing-click-free`.
  - `reorder-and-delay-time-while-playing-click-free`.
- **Engine process (IPC):**
  - `ipc-render-tail-settings`: validation messages.
  - `ipc-playback-render-equals-export-with-tail`.
  - `ipc-export-tail-override-off`: 24,000 frames.
- **Live (real output device):**
  - `live-playback-continues-through-tail-then-stops`: the transport is still playing at the timeline end, then stops by itself.
  - `live-playback-equals-export-with-tail`.
  - `live-stop-then-play-starts-clean`.
  - `live-effect-changes-while-playing-click-free`.
  - `live-effect-changes-take-effect`.

Tests changed by design:
- `stop-clears-effect-tails` is replaced by `stopped-snapshot-gives-clean-effects`. Leak with fresh processors 0.000000; with carried processors 0.707, which shows the test can detect a leak.
- `export-applies-effects` now expects the tail: 5,040 frames for a 4,800-frame timeline, difference 0.000000.
- `sample-rate-change-reprepares-effects` accounts for the 10 ms input warm-up.

### New GUI checks (fx-build / fx-reload)

All controls were operated through the app window:
- **Effect tail control:** with master delay feedback 0.60, "Off" exports exactly the timeline (288,000 frames). "Up to 2 s" stops at exactly timeline + 2 s (384,000). "Up to 10 s" renders the tail out to 643,680 frames, within the 10 s limit.
- **Tail floor control:** −60 dBFS ends at 477,696 frames, against 643,680 for −90 dBFS.
- **Reload:** the effect tail settings are restored after reopening the app and loading the project.
- At the 960x700 minimum window, the device panel wraps its new selects onto a second row. The existing rack and layout checks still pass.

## Files changed

- `native/audio-engine/include/msp/Effects.h`, `src/Effects.cpp`: `TailSettings`, limits and `checkTailSettings`; O(1) `DelayDsp::reset` with a valid-history counter.
- `include/msp/Mixer.h`, `src/Mixer.cpp`:
  - `applyRenderTail`; tail rendering and per-sample end detection in `mixRoute`; `MixResult.played` / `end`;
  - the carry-only-if-audible rule and `effectWarm` warm-up in `inheritMixState` / `runChain`; no resets in the callback.
- `include/msp/Session.h`, `src/Session.cpp`: `renderTail`; tail in `buildPlan` and `exportMix`.
- `include/msp/Project.h`, `src/Project.cpp`: `renderTail` save/load and repair; still schema v4.
- `include/msp/Engine.h`, `src/Engine.cpp`:
  - `setRenderTail`; tail overrides and result fields for `exportWav` and `renderPlayback`;
  - `startCapture` / `stopCapture`; a fresh snapshot on Play from stop; the position clamp during the tail.
- `src/Routing.cpp`: edited during development and restored; no functional change.
- `tests/test_main.cpp`: 20 new tests, 3 updated; PASS lines now print their measured values.
- `packages/shared/src/protocol.ts`: `RenderTail`, `ExportResult`, `EngineState.renderTail`.
- `apps/desktop/renderer/src/App.tsx`: the Effect tail / Tail floor selects and the header label.
- `apps/desktop/electron/fxCheck.ts`: the tail control and reload checks; the delay identity loop is guarded against unequal lengths.
- `docs/phase221-final-report.md`.

## Known limitations

- **Live playback plays the hold window.** After the last sample above the threshold, playback continues for the hold window (at least 200 ms, or the longest delay + 50 ms) of below-threshold audio before stopping. Export trims it, so live output is the export followed by near-silence.
- **Position display during the tail.** The position stays at the timeline end, for example 0:06.0 / 0:06.0, while the transport is still playing.
- **Pause during a tail.** Pause, then Play, during a tail resumes the tail, because effects are kept while paused.
- **Quick bypass toggles.** Unbypassing within the 10 ms bypass fade keeps the running processor, so its tail continues. This is intended and is covered by `reenable-after-full-bypass-uses-clean-processor`.
- **What triggers a tail.** Only enabled reverb and delay effects. A compressor release or gate release past the timeline end is cut as before.
- **Long feedback tails.** With high feedback and long delay times, the tail can run to the maximum length (up to 60 s).
- **Undo.** Tail settings are not part of the undo history.
- **Live capture scope.** It records the buffers the engine callback renders, not the analog output. A device-level dropout would not appear in it, and nobody listened.
- **Unchanged from Phase 2.2:**
  - `settleAudio` still blocks the engine's control thread for the fade when removing or moving an effect during playback;
  - the effect-scope limits are the same.

## Not run

- Listening to tails and effect changes by ear (requires a person).
- Operating the controls with the real OS mouse. All GUI interaction used injected Chromium events.
- Microphone through effects: **NOT RUN — NO HARDWARE** (no input device is enumerated).
- 30-minute soak, glitch listening and round-trip latency, as in earlier phases.
