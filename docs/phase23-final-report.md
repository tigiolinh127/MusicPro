# Phase 2.3 final report: automation and recording foundation

Date: 2026-11-06, updated 2026-11-07.

**Status: Phase 2.3 is accepted within the targeted functional testing scope.** The functionality is implemented and its targeted tests PASS. Microphone recording is **NOT RUN — NO HARDWARE**. Section 5 includes the final targeted coverage assessment of the master gain signal path.

The full regression was **not** run after the last changes, and neither were all native tests, as the testing policy requires. Earlier full runs (labelled "earlier evidence" below) predate two additions: master volume automation and typed point editing. Those two were verified only by the targeted tests listed here.

- No installer or release package was built.
- Phase 2.4 was not started.
- ProfilePilot was not touched.
- The desktop mouse and keyboard were not used. GUI checks inject Chromium input into the app window (`webContents.sendInputEvent`).
- No Music Studio Pro window was running when the native engine was rebuilt (checked before each build).

## 1. Implemented functionality

### Part 1: Automation engine

- **Targets:**
  - track volume and pan;
  - bus volume;
  - **master bus volume** (added in this session);
  - continuous effect parameters on tracks, buses and the master, written as `fx:<effectId>:<parameter>`.
  - Choice parameters (EQ band type) cannot be automated.
  - Values are validated against the parameter's range: volume 0–4 (+12 dB), pan −1…1, effect parameters their own min/max. `automationRange` in `Routing.cpp` is the single check used by edits, project load and repair.
- **Data model** (`Automation.h`):
  - `AutomationLane { param, enabled, points }`.
  - Each point is `{ time in samples, value, step }`, kept sorted. A point added at the time of an existing point goes after it, so the later point wins.
  - Limit: 10,000 points per lane.
- **Interpolation:** linear, or step (the value is held until the next point). Before the first point the lane holds the first value; after the last point, the last value.
- **Enable/disable and the manual-override rule:**
  - A lane is *active* when it is enabled and has points.
  - An active lane replaces the manual value in playback, recording and export.
  - A manual set is rejected, for example "Master volume is automated. Turn off its automation lane to set it by hand."
  - Turning the lane off, or deleting its points, returns to the stored manual value, which automation never changes.
- **Sample-accurate evaluation:**
  - Active lanes are flattened into `MixPlan::lanes` / `points` on the control thread.
  - Volume and pan (track, bus and master) are evaluated at every sample's timeline position, through the existing 10 ms gain ramp, so a step is ramped rather than clicked.
  - Effect parameters are evaluated at absolute 32-sample positions, then smoothed. The values are therefore identical at any device buffer size and in export.
  - Lanes keep running through effect tails.
- **Safe updates during playback:** every edit rebuilds the plan on the control thread and publishes an immutable snapshot through the existing `mixHead` / `audioSeq` path.
- **Playback and export** use the same `mixRoute` code. Export at another sample rate scales point times.
- **IPC:**
  - operations: `setAutomation`, `addAutomationPoint`, `moveAutomationPoint`, `deleteAutomationPoint`, `removeAutomation`;
  - `getState` returns `automation` for each track and bus, and `masterAutomation`.

### Part 2: Automation editor (no redesign)

- **Show/hide lanes:** the **A** button in each track header shows or hides that track's lane. "Bus lanes" adds the bus and master lanes. The lanes are in the same scroller as the clips, so scrolling and zoom stay synchronized.
- **Select parameter:** a list in the lane header, with ● for an active lane and ○ for a lane that is off. The master lane now offers Volume as well as its effect parameters.
- **Points:**
  - click to add a point (snap applies when it is on);
  - drag to move a point horizontally and vertically;
  - double-click or Delete removes it;
  - Linear/Step sets the selected point's interpolation.
- **Edit point values (added in this session):**
  - With a point selected, the lane header shows its time (s) and value fields. The value unit is dB for volume, L/R −100…100 for pan, and the parameter's unit for effects (dB, Hz, ms, %).
  - The edit is applied on Enter or when the field loses focus; Escape reverts.
  - Typing in a field never triggers the editor's Delete or Space shortcuts.
- **Enable/disable:** the On/Off button.
- **Automated controls are marked and locked:**
  - the track sliders show "Gain auto" / "Pan auto";
  - the transport master slider shows "Master auto" (new);
  - mixer faders, including the master fader (new), and effect parameters show "A · Auto".

### Part 3: Recording foundation

- **Per track:** arm/disarm, input `1` / `2` / `1+2`, mode `dry` / `processed` / `both`, and monitoring, which is **off** by default.
- **Transport:**
  - Record / Stop rec. While recording, Play and seek are disabled and "● REC m:ss" is shown.
  - Recording stops on the record button, transport Stop, device failure or the 30-minute limit.
- **Input routing:** dry takes come from the input channels; processed takes come from the track signal after its inserts.
- **Virtual source:** "Test signal (virtual)" is deterministic (a sine on channel 0, a ramp on channel 1) and runs in the real audio callback. No microphone is needed.
- **Safe WAV writing:**
  - A writer thread writes 32-bit float WAV to `<name>.wav.part` and refreshes the header periodically.
  - On stop, the control thread waits for the callback to acknowledge (or detaches it), drains the writer, finalizes the file and renames it to `.wav`.
- **Automatic clip placement:** the take is imported at the take start with 2 ms fades.
- The record folder is an engine setting, chosen in the Recording panel.

### Part 4: Persistence

- `kCurrentProjectVersion` is 5. It saves:
  - lanes, points (in samples), interpolation and enable states for tracks, buses and the master;
  - each track's record configuration.
- Recorded clips are ordinary clip references.
- Versions 1–4 load unchanged; their Phase 2.3 fields are ignored.
- **Repair of damaged lanes:**
  - unknown parameters and lanes for missing effects are removed with a warning;
  - values are clamped and points sorted.

### Part 5: Realtime safety

| Concern | How it is handled |
|---|---|
| Allocation in the callback | Lane values, record buffers and queue slots are preallocated on the control thread. Plans are immutable snapshots; the callback only indexes them. |
| File I/O in the callback | None. Files are opened on start and finalized on stop (control thread). Writes happen on the writer thread. |
| Blocking locks | None. `RecordQueue` is single-producer/single-consumer (1,024 slots × 1,024 frames) with atomic indices. The recorder pointer and the stop handshake are atomics. |
| Overflow | `push` never blocks. Dropped frames are counted, the writer fills the gap with silence at the correct position, and a warning is reported. |
| Finalization | Only after the callback has acknowledged the stop. |
| Glitches | Gain and pan go through the 10 ms ramp, effect parameters through the existing smoothing, and recorded clips get 2 ms fades. |

This was not measured with an allocation or lock tracker. The evidence is the structure above and the numeric tests.

## 2. Files changed

**Changed in this session** (master volume automation, typed point editing, targeted test support):

- `native/audio-engine/src/Routing.cpp`: master `volume` is accepted by `automationRange`; `buildMixPlan` sets `plan.masterLane`.
- `native/audio-engine/include/msp/Mixer.h`: `MixPlan::masterLane`.
- `native/audio-engine/src/Mixer.cpp`: `mixRoute` follows the master lane per sample through the master ramp.
- `native/audio-engine/src/Session.cpp`: the error text names master volume.
- `native/audio-engine/src/Engine.cpp`: `setMaster` is rejected while master volume is automated.
- `native/audio-engine/tests/test_main.cpp`:
  - six new tests: five for master volume automation, and `testMasterGainManual` for manual master gain with automation off;
  - two existing checks moved from master volume to master pan, because master volume is now allowed;
  - optional group argument. `automation` runs only the automation groups; `master-gain` runs only `testMasterGainManual`. Without an argument it runs everything, as before.
- `apps/desktop/renderer/src/automation.ts`: Volume for the master; display units and input conversion for the point fields.
- `apps/desktop/renderer/src/App.tsx`: master lane parameters, the "Master auto" lock, and the `PointFields` time and value editor.
- `apps/desktop/renderer/src/Mixer.tsx`: the master fader is marked and locked.
- `apps/desktop/renderer/src/styles.css`: `.auto-point`.
- `apps/desktop/electron/autoCheck.ts`: three new GUI checks:
  - typed point time/value;
  - master volume lane and lock;
  - mixer master fader lock.
- `docs/phase23-final-report.md`.
- `.cursor/rules/testing-policy.mdc` (new, testing policy).

**Changed earlier in Phase 2.3:**

- **Native:**
  - `Automation.h/.cpp` and `Recording.h/.cpp` (new);
  - `Mixer`, `Session`, `Routing`, `Project` and `Engine` (`.h/.cpp`);
  - `CMakeLists.txt`;
  - `tests/test_main.cpp`.
- **Shared:** `packages/shared/src/protocol.ts`.
- **Renderer:** `automation.ts` (new), `App.tsx` (including the wheel-scroll and canvas-width fixes), `Mixer.tsx`, `styles.css`, `studio.d.ts`.
- **Electron:**
  - `autoCheck.ts` (new);
  - `main.ts`: the `MSP_AUTO_CHECK` hook, the folder dialog and the GUI-check rendering switches;
  - `preload.ts`;
  - `fxCheck.ts`: expects schema v5.
- **Scripts:** `run-regression.ps1` (auto-build / auto-reload steps), `verify-phase0-fixtures.py` (version 5).

## 3. Build commands executed (this session)

In `D:\MusicStudioPro\apps\desktop`:
```
cmd /c "npx tsc -p tsconfig.json --noEmit 2>&1 && npx tsc -p tsconfig.electron.json --noEmit 2>&1 && echo TSC-OK"   -> TSC-OK
cmd /c "npm run build 2>&1"                                                                                         -> exit 0 (Vite build)
```
In `D:\MusicStudioPro`:
```
powershell -ExecutionPolicy Bypass -File scripts\build-engine.ps1   -> exit 0 (engine + test binary, after the native changes)
powershell -ExecutionPolicy Bypass -File scripts\build-engine.ps1   -> exit 0 (test binary only, after adding the "automation" argument)
powershell -ExecutionPolicy Bypass -File scripts\build-engine.ps1   -> exit 0 (test binary only, after adding testMasterGainManual; 2026-11-07)
```

## 4. Tests executed (this session)

1. **Native automation group:** `build\audio_engine_tests.exe automation`.
   - It runs `testAutomationModel`, `testAutomationMix`, `testAutomationPersistence` and `testIpcAutomationRecording`.
   - The last group also contains the recording IPC tests, so those ran too.
   - Result: **50 pass, 0 fail, 0 not run.**
2. **Automation GUI check, build phase.**
   - Command: `MSP_AUTO_CHECK=build\phase23-targeted1`, `MSP_AUTO_PHASE=build`, then `npx electron .`.
   - Result: **19 pass, 0 fail, 1 not run.**
3. **Automation GUI check, reload phase.**
   - Command: the same folder, with `MSP_AUTO_PHASE=reload`.
   - Result: **4 pass, 0 fail, 1 not run.**
4. **Saved project contents.**
   - I read `build\phase23-targeted1\automation.msp.json`.
   - It is version 5 and contains `"masterAutomation": [{"param": "volume", "enabled": true, "points": [{"time": 24000, "value": 0.5012, ...}]}]`.
5. **Manual master gain with automation off (2026-11-07):** `build\audio_engine_tests.exe master-gain`.
   - It runs only the new test `auto-master-volume-off-manual-gain-playback-equals-export`.
   - Result: **1 pass, 0 fail, 0 not run.**

## 5. PASS / FAIL / NOT RUN

### New in this session

| Test | Result | Measured |
|---|---|---|
| `auto-master-volume-sample-accurate` | PASS | max difference from the per-sample model 0.000000; 0.220971 at 0.25 s, 0.088388 at 0.625 s; largest step 0.000737 |
| `auto-master-volume-override-rule` | PASS | a manual master gain change while automated changes the output by 0.000000; lane off gives 0.176777 |
| `auto-master-volume-playback-equals-export` | PASS | 48,000 frames, difference 0.000000 |
| `auto-project-v5-roundtrip-master-volume` | PASS | 3 points, step flag and value 1.25 restored |
| `ipc-master-volume-automation-locks-master-gain` | PASS | "Master volume is automated. Turn off its automation lane to set it by hand."; removing the lane allows `setMaster` |
| `auto-master-volume-off-manual-gain-playback-equals-export` (2026-11-07) | PASS | master gain 0.5, never automated and with the master lane off: playback differs from 0.5 × input by 0.000000 at every sample; export differs from playback by 0.000000 over 48,000 frames |
| GUI: typed time and value edit the selected point | PASS | fields showed 0.250 s / −0.3 dB; typing −3 and 0.3 gave 14,400 samples, 0.7079, step kept |
| GUI: master volume lane added from the editor locks the master gain | PASS | point at 24,000 samples, 0.5012 (−6 dB); slider disabled, "Master auto"; manual set rejected |
| GUI: mixer master fader locked by the master volume lane | PASS | disabled, "A · Auto" |

### Existing tests that ran again in the targeted runs

All PASS:

- **Native automation group** (42 tests):
  - interpolation, validation and point edits;
  - track volume and pan, and bus volume, sample-accurate;
  - effect lanes: buffer-size independence, follows the lane, override rule;
  - playback equals export; clip boundaries; effect tails; export at another rate;
  - project v5 round trips; v4 compatibility; repair; duplicate; effect removal; sample-rate change;
  - IPC automation and IPC recording: the virtual take is sample-exact, the clip is placed, no partial files are left, monitoring is off by default, unsafe operations are rejected, a take at the playhead, overflow filled with silence, optional monitoring.
- **Automation GUI checks** (20):
  - layout unchanged; the A button; click, drag and step;
  - marking and lock; export follows the lane; render equals export; lane Off; delete;
  - effect lane; bus and master lanes; mixer lock;
  - record arm and controls; a take from the test signal; save;
  - after reload: lanes, record configuration, export and ● marks.

### NOT RUN

- **Record from a real microphone** (native `rec-record-from-microphone`, and the GUI check): **NOT RUN — NO HARDWARE**.
- **All other native groups** (pan law, mixing, export/project, timeline, routing, effects, tails, recording core): **NOT RUN** in this session.
- **The full regression** (`scripts/run-regression.ps1`) and the other GUI checks (phase0 script, smoke, layout, workflow, mixer, fx): **NOT RUN** in this session.
- Listening by ear, real-mouse operation, the 30-minute soak and round-trip latency: **NOT RUN**.

### Earlier evidence (before this session's changes)

Earlier in Phase 2.3, the full regression ran twice:
- `build\phase23-final2` and `build\phase23-final3`: 380 native and 156 GUI checks passed, 0 failed.
- Baseline before Phase 2.3: 328 / 0 / 7.

Those runs cover everything except master volume automation and typed point editing. They do not prove that this session's changes left other features unaffected.

### Final targeted coverage assessment: master gain signal path

The master gain change is in `mixRoute`, which every playback and export uses.
- When the plan has no active master lane (`masterLane < 0`), `mixRoute` takes a branch whose master loop is the original Phase 2.2 code, unchanged.
- The ramp priming with no lane is also unchanged: it starts at the manual gain.
- Only plans with an active master volume lane take the new per-sample branch.

Coverage of the four required cases:

| Case | Covered by | Assessment |
|---|---|---|
| Manual master gain, automation off | `auto-master-volume-off-manual-gain-playback-equals-export` (added 2026-11-07): never automated, and with the lane switched off, compared at every sample. Also `auto-master-volume-override-rule` (lane off gives the manual gain), `ipc-master-volume-automation-locks-master-gain` (`setMaster` works again after the lane is removed), and the GUI check "lane Off plays the manual value" | Covered. Before 2026-11-07 it was checked at one sample in playback only and never in an export. That was the one critical gap, and the test was added and run on its own. |
| Automated master gain, automation on | `auto-master-volume-sample-accurate` (every sample against an independent model, including a step and the 10 ms ramp); `auto-master-volume-override-rule` (a manual change has no effect while automated); the IPC and GUI lock checks | Covered |
| Playback / export consistency | `auto-master-volume-playback-equals-export` (automation on) and the new test (automation off): differences of 0.000000. GUI: "export after reload equals export before save" with the master lane on (0.00e+0 over 96,000 frames) | Covered for both branches |
| Project save/load of master automation | `auto-project-v5-roundtrip-master-volume` (points, step flag, values); GUI reload check (`masterAutomation` compared after load); the saved file contains the master volume lane | Covered |

Conclusion: the four cases are covered by targeted tests that ran and passed. No further tests are needed for this change, and the full native suite and full regression were not run.

![Typed point fields (0.300 s, −3 dB) on a step point](../build/phase23-targeted1/build-02-volume-lane.png)
![Effect lane and master volume lane](../build/phase23-targeted1/build-03-effect-and-master-lanes.png)
![Mixer: automated track, EQ output and master fader locked](../build/phase23-targeted1/build-04-mixer-automated.png)
![Recording from the test signal](../build/phase23-targeted1/build-05-recording.png)
![Take placed on the timeline](../build/phase23-targeted1/build-06-take-placed.png)

## 6. Known limitations

- **Microphone recording was never tested (NO HARDWARE).** Device input uses the same callback path as the virtual source.
- Recording needs an open output device; the virtual source and capture run in the audio callback.
- There is no input latency compensation. Takes are placed at the playhead where recording started.
- Stopping a recording returns the playhead to the take start.
- Monitoring is heard only while the transport runs.
- **Processed takes:**
  - "processed" records after the track's inserts, so placing that take on the same track applies the inserts twice;
  - "both" places the dry take.
- **Recording limits:**
  - maximum take length: 30 minutes;
  - the queue holds about 21 s for one stereo stream at 48 kHz;
  - device blocks over 8,192 samples are recorded as silence and reported.
- The recording folder is not saved with the project.
- Automation edits are not in the undo history.
- Effect parameters change at 32-sample steps and are then smoothed. A delay-time sweep goes through 20 ms crossfades, not a continuous glide.
- Choice parameters (EQ band type) cannot be automated. The master and buses have no pan automation.
- Typed point times are not snapped, even when Snap is on, and a typed time is clamped at 0.
- The transport bar wraps onto a second row at the default window size.
- Realtime safety was not measured with an allocation or lock tracker, and nobody listened for clicks.

## 7. Remaining work

- Verify recording with a real microphone when hardware is available.
- Run the full regression only if you request it. The targeted coverage assessment in section 5 found no further case that needs testing for the master gain change.
- Phase 2.3 follow-ups that are not required by this phase:
  - automation in the undo history;
  - input latency compensation;
  - keeping the playhead after recording;
  - saving the record folder per project.
