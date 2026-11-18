# Phase 2.1 final report: mixer console and audio routing

Status: **PASS**, with the items listed under "Not run" below.

Date: 2026-11-06. Every result here was produced by a command that was actually executed on the final build. Microphone tests are **NOT RUN — NO HARDWARE**. No installer was created. No Phase 2.2 work (EQ, compressor, reverb, delay, Auto-Tune, AI, karaoke, VST3, livestream) was started.

## Status by requirement

| Requirement | Status |
|---|---|
| Mixer console with one strip per track (name, dB fader, pan, mute, solo, meter, clip LED, output bus) | PASS |
| Strips grow with the track count, horizontal scroll, Editor/Mixer toggle | PASS |
| Master bus and group buses, track-to-bus routing, nested groups | PASS |
| Loops and invalid routes rejected | PASS |
| Aux sends to return buses, per-send level, pre/post-fader | PASS |
| Realtime safety (snapshots built off the audio thread, smoothing, click-free route changes) | PASS |
| Track, bus, and master meters from native peaks; clip indicators; decay; no stale meters | PASS |
| Project schema v3, v1/v2 migration, repair of invalid routing without dropping clips | PASS |
| Playback mix equals export | PASS (bit-identical) |
| Save, close, reopen, load restores routing and audio | PASS |
| Real window at 2, 4, 8, 16 tracks and at the 960x700 minimum size | PASS (injected Chromium input) |
| Phase 0 and Phase 1 regression | PASS |
| Real OS-mouse fader drag | PASS (visual readout only, see "Real Windows mouse") |
| Listening by ear | NOT RUN |
| Microphone | NOT RUN — NO HARDWARE |

## Architecture

All realtime audio work stays in C++ JUCE. The renderer only sends commands and draws engine state and meter events. The existing engine was extended, not rewritten: Phase 1 `mixBlock` is unchanged and its tests still pass. Playback, `renderPlayback`, `Session::render`, and export now share the new routed mixer, `mixRoute`.

```
Control thread (JUCE message thread)
  Session: tracks (clips, gain, pan, mute, solo, output, sends) + buses
  buildMixPlan(tracks, buses, rate, previous plan)
    -> MixPlan: sources, buses in topological order, feeds with target L/R gains
       (fader, constant-power pan, mute, solo folded into each feed's target)
  -> MixSnapshot { plan, MixState, timeline, seq } published with an atomic pointer

Audio thread (callback)
  on a new snapshot: inheritMixState(old -> new) keeps ramp positions and fading feeds,
                     then stores audioSeq (release)
  mixRoute: for each 512-sample chunk
    source feeds -> bus accumulators or master   (gains ramp per sample)
    buses in order -> later buses or master       (a bus only feeds higher indexes)
    + microphone monitor (unchanged) -> * master gain -> output
    peak atomics per source, per bus, and master

Control thread timer (50 ms)
  reclaimSnapshots: frees snapshots older than the one the audio thread acknowledged
  meterVar: exchanges peak atomics, applies decay, latches clips, sends one `meter` event
```

### Realtime rules

- The audio callback does not allocate, lock, log, or do I/O. Plans and their `MixState` buffers are allocated on the control thread when the snapshot is built.
- A snapshot is freed only after the audio thread has acknowledged a newer one (`audioSeq`, release/acquire). When the callback is detached, everything except the head is freed. A snapshot is never freed while the callback may still be reading it.
- Gains ramp linearly over 10 ms (`rampStep = 1 / (0.01 · rate)` per sample) whenever a target changes: faders, pan, mute, solo, sends, bus gains, master routing.
- Route changes cross-fade. When a feed disappears (for example, a track moves from Master to Group 1), the new plan keeps the old feed with target 0 for up to 4 snapshots so it fades out while the new feed fades in. `route-change-crossfade-continuous` checks that a DC signal stays within 1e-5 of its level through a route change.
- A fresh render (export, `renderPlayback`, a stopped transport) starts every feed at its target, so static mixes have no ramp. This keeps playback and export bit-identical.
- If a bus referenced by a track or bus is missing, its audio goes to the master (`route-missing-bus-falls-back-to-master`).

## Routing behavior

- **Track output:** Master or any group bus. Return buses are reached only through sends.
- **Bus output:** Master or a group bus. A bus can never output to itself, to a return bus, or to a bus that would form a loop. The engine rejects these requests ("That route would create a feedback loop."). The UI does not offer them.
- **Nested groups:** allowed (`route-nested-groups-multiply`: gains multiply through the chain).
- **Return buses** can output to the master or a group. A group that feeds a return through any path is rejected (`feedback-group-to-return-rejected`).
- **Stereo:** buses are stereo all the way. Pan is constant power on tracks only (`route-stereo-preserved`).
- **No double summing:** each source feeds exactly one main destination plus its sends. Each bus is summed once into its own output.
- **Removing a bus:** tracks and buses that used it are rerouted to that bus's own output, and sends to it are dropped (`bus-remove-reroutes-inputs`, `return-remove-drops-sends`).
- **Limit:** 64 buses (`bus-limit-enforced`).

### Sends

- One send per track per return bus, with level (−∞ to +12 dB) and pre/post-fader.
- A post-fader send follows the track fader and pan. A pre-fader send ignores the fader and pan.
- Track mute silences the track's main output and all its sends, including pre-fader sends (`track-mute-silences-sends`).
- Return buses have their own gain, mute, and solo. No reverb or delay processing exists. A return only sums its sends.

### Solo

- Solo is active when any track or bus is soloed.
- A track is heard if it is not muted and either solo is not active, or the track is soloed, or a group bus in its output chain is soloed.
- A send is heard if its track is heard under solo, or if its return bus is soloed (`return-solo-hears-only-sends`).
- Return buses are solo-safe: soloing a track still lets its sends reach the returns.

### Meters

| Meter | Measured at |
|---|---|
| Track strip | After fader and pan (post-fader), before the bus |
| Group or return bus | After bus gain and mute |
| Master | After master gain, the final output |

Meters are peak values from the audio thread. The control thread sends them every 50 ms. The display level holds the highest peak and decays by ×0.891 per 50 ms tick (−1 dB per tick, 20 dB/s). A clip indicator latches when a peak reaches 1.0 (0 dBFS) and stays lit until "Reset clip indicators" or a click on any clip LED. When playback stops, meters fall to zero. The `meter` event still carries `peakL`/`peakR` for the master (Phase 1 shape) plus `master`, `tracks[]`, and `buses[]`.

## Project schema v3

- `version: 3`. New fields: `buses[]` (`id`, `name`, `kind` = `group`/`return`, `gain`, `mute`, `solo`, `output`) and, per track, `output` and `sends[]` (`bus`, `level`, `preFader`).
- The reader accepts versions 1, 2, and 3. v1 and v2 projects load with every track on the master and no buses, and are saved as v3 (`migrate-v1-project-to-master`, `ipc-migrate-v2-project`, `migrated-project-saves-as-v3`).
- Damaged routing is repaired on load, with a warning. Unknown or reserved bus ids, unknown kinds, duplicates, bad gains, routes to missing buses, routes that form loops, and sends to non-returns are fixed or dropped. Clips are never dropped (`ipc-damaged-routing-repaired-clips-kept`).
- New bus ids after a load never collide with loaded ones (`ipc-new-bus-id-after-load-is-unique`).

## Mixer UI

- The header has an **Editor / Mixer** toggle. The editor (Phase 1 layout) is unchanged. The transport, master slider, and device panel stay visible in both views.
- Each strip, top to bottom: name (editable), output selector (`→ Master`, `→ Group 1`, …), strip type plus send rows (level slider and Pre/Post button per return bus), pan, a vertical dB fader (−∞ to +12 dB, double-click for 0 dB) with its readout, a stereo meter with clip LED and a 0 dBFS line, and the M and S buttons. Buses also have a ✕ (remove) button.
- Track strips come first, then group and return buses after a divider. The master strip is pinned on the right.
- Strips scroll horizontally with the scrollbar or the mouse wheel. At small window heights the mixer area scrolls vertically instead of squeezing controls.
- Control changes are sent while dragging (80 ms debounce) and immediately on release.
- Keyboard: in the mixer view only Space (play/pause) is active, so editor shortcuts cannot change clips while you are mixing.

## Builds

Native, after you confirmed Music Studio Pro was closed for Phase 2.1:

```text
powershell -ExecutionPolicy Bypass -File D:\MusicStudioPro\scripts\build-engine.ps1     exit 0
```

Desktop, from `D:\MusicStudioPro\apps\desktop`:

```text
npx tsc -p tsconfig.json --noEmit            exit 0
npx tsc -p tsconfig.electron.json --noEmit   exit 0
npm run build  (tsc electron + vite build)   exit 0
```

## Automated native tests

```text
D:\MusicStudioPro\build\audio_engine_tests.exe
SUMMARY pass=239 fail=0 not_run=7        (baseline before Phase 2.1: 176 / 0 / 7)
```

The 63 new checks:

- **Routing math:** default master, track gain/pan/mute/solo, group gain/mute/solo, nested groups, 16 tracks into 8 groups, stereo kept, bus creation names, bus removal (reroute, audio follows, fallback to master), 64-bus limit.
- **Rejections:** two- and three-bus loops, self output, bus to return, missing destination, track main output to a return, sends to a group or the master, group-to-return feedback.
- **Sends and returns:** create, pre-fader ignores fader, post-fader follows fader, post-fader level, return gain/mute/solo, return into a group, mute silences sends, removing a return drops sends.
- **Realtime:** meter accuracy (track, bus, master within 1e-6), 10 ms gain ramp with no step larger than the ramp allows, fresh render starts at target, route change cross-fade, fading feed expiry, bus order kept across a swap, missing bus fallback, and a CPU check (16 tracks, 6 buses: must mix in under 25% of real time).
- **Engine process (IPC):** add buses, route and send state, invalid routes rejected with state unchanged, routed playback value, playback equals export, per-strip native meter values, per-strip clip indicators, live device meter peak, no stale meters after stop, v3 save, load restores routing, reload renders identically, unique bus ids after load, v2 migration, damaged-routing repair.
- **Persistence:** v1 migration to master, export uses routing.

The 7 NOT RUN native tests are hardware or manual checks: the microphone monitor switch (no input device was found) and six manual checks (listening, microphone with headphones, device switching, 30-minute soak, CPU/glitch listening, round-trip latency).

## Real-window GUI tests

`apps/desktop/electron/mixerCheck.ts` runs inside the real app when `MSP_MIXER_CHECK` is set. It clicks, drags, uses the wheel, and presses keys with Chromium input events (`webContents.sendInputEvent`). These go through the same handlers as a physical mouse. File dialogs are answered with fixed paths. The engine is the real `MusicStudioEngine.exe` with the real WASAPI output device open. Test tracks are DC WAV files (0.5, 0.25, and stereo 0.5/0.1), so every exported sample value can be predicted from the routing shown in the mixer.

Run from `D:\MusicStudioPro\apps\desktop`:

```text
$env:MUSICSTUDIO_ENGINE = 'D:\MusicStudioPro\build\MusicStudioEngine.exe'
$env:MSP_MIXER_CHECK    = 'D:\MusicStudioPro\build\phase21-mixer-check'
$env:MSP_MIXER_PHASE    = 'build';  npx electron .
$env:MSP_MIXER_PHASE    = 'reload'; npx electron .
```

The reload phase is a new app and engine process, started after the first one exited.

Result on the final build: **build phase 28 PASS, 0 FAIL; reload phase 5 PASS, 0 FAIL.** Results and screenshots are in `D:\MusicStudioPro\build\phase21-mixer-check` (`build-results.json`, `reload-results.json`, `build-*.png`, `reload-*.png`).

| Scenario | Evidence |
|---|---|
| 2, 4, 8, 16 tracks | One strip per track; no control clipped or overflowing its strip; no truncated dB readouts; master visible; mixer fits above the footer. Fader 147 px (2 and 4 tracks), 136 px (8 and 16, with horizontal scrollbar). |
| Editor switch | Editor shows the same 2/4/8/16 lanes and timeline after each switch. |
| Scrolling (16 tracks) | Wheel over strips: scrollLeft 0 → 240. Scrollbar drag: 0 → 430. |
| 960x700 minimum window | No clipped controls. Fader 65 px. The mixer area is 184 px, so it scrolls vertically, and the bottom M/S buttons and master fader are reachable. |
| Buses | Add group bus ×2 and Add return bus: Group 1, Group 2, Return 1. |
| Routing | Track 1 → Group 1 with the output selector. Group 1 → Group 2. Group 2's selector offered only `→ Master, → Group 1` before nesting and only `→ Master` after (no loops, no returns). A direct engine request for Group 2 → Group 1 was rejected. |
| Faders | Group 1 fader dragged to −6.2 dB; engine gain 0.4898 and readout "-6.2 dB" agree. Track 2 fader pulled to −∞: gain 0. |
| Send | Track 2 send to Return 1 dragged to −5.5 dB (0.5309), then switched to Pre. |
| Pan | Track 3 pan dragged to −0.61. |
| Bus M/S | Return 1 mute on/off, Group 2 solo on, all reflected in engine state. |
| Export = routing | Group 2 soloed: frame 144000 L 0.13853 R 0.13853, model 0.13853 / 0.13853. Unsoloed: L 0.41076 R 0.34557, model identical. The model is computed independently in the harness from engine state. |
| Playback = export | Realtime mix rendered through `renderPlayback` vs exported WAV: worst difference 0 in both cases. |
| Live meters | During device playback, strip meters 74/0/60/56/65/65/61/79 %. Track 2 (fader −∞) is 0 % while Return 1 still shows its pre-fader send. Track 1 native peak 0.2828 = expected post-fader value. |
| Clip LED | Track 1 fader to +11.9 dB lit only Track 1's LED (Group 1 stays below 0 dBFS). Reset clip indicators turned it off. |
| No stale meters | 4 s after Stop: every strip 0.0 %. |
| Save | Save project button wrote `mixer.msp.json`, version 3, 3 buses. |
| Reopen and load | New app process, Load project: every track's output, gain, pan, and sends, plus every bus's kind, output, and gain, match the saved state. Output selectors show `→ Group 1, → Master, → Master, → Master, → Group 2, → Master, → Master`. |
| Reloaded audio | Export matches the routing model and playback (worst 0). The export after reopening is bit-identical to the export before closing. |

Screenshots: `build-mixer-2-tracks.png`, `build-mixer-4-tracks.png`, `build-mixer-8-tracks.png`, `build-mixer-16-tracks.png`, `build-mixer-16-scrolled.png`, `build-mixer-16-min-window.png`, `build-mixer-16-min-window-scrolled.png`, `build-mixer-routed.png`, `build-mixer-clipping.png`, `reload-mixer-reloaded.png`.

### Real Windows mouse

A separate test window (PID 3548) was driven with real Windows mouse input (Computer Use):

- Clicks added two tracks, switched to the Mixer view, and added a group bus. Each change appeared on screen.
- A real mouse drag on the Track 1 fader thumb moved it from +0.0 dB to −27.5 dB. The readout and thumb updated. This window's engine state was not read directly. The injected-input check above confirms that fader readouts match engine gain.
- During this session another input source was also using the desktop. The pointer moved while no input was being sent, and the window gained tracks, bus changes, and pan changes (Track 4 to L31, Group 2 from −14.0 to −13.8 dB) that this test did not make. Real-mouse testing was stopped at that point. Mixer routing, sends, and save/load with the real mouse were not repeated. The window was left open.

### Defects found by the GUI test and fixed

1. **Strips overflowed at normal window sizes.** Fixed row heights needed about 416 px, but a strip gets about 300 px at 1280x820. The M/S buttons and the bottom of the fader were clipped, so a fader drag to −∞ stopped at gain 0.26. The strip was restructured into six rows (name, output, sends, pan, fader, buttons). The sends area and fader share the flexible height. At very small heights the mixer scrolls vertically.
2. **Harness drag reliability (test tool, not the app).** Long synthetic drags with large mouse-move steps did not start a range-input drag in Chromium (only `pointerdown`, `pointerup`, `click` arrived). The harness now marks moves with the left button held and moves in 3 px steps. With that change the same fader drag reaches −∞.
3. **Stale-meter check timing.** The master meter needs about 3 s to fall from a hot level at 20 dB/s. The check now waits 4 s.

## Phase 0 and Phase 1 regression (re-run on the final build)

| Check | Result |
|---|---|
| `python scripts\verify-phase0-fixtures.py` | PASS: `BASELINE_EXPORT_OK left440=0.500 right880=0.500 frames=480000`, `BASELINE_PROJECT_OK version=3 tracks=2` |
| `MSP_SMOKE=1 npx electron .` | PASS, exit 0, device opened |
| `MSP_LAYOUT_CHECK` (editor layout) | 33 / 33 PASS |
| `MSP_WORKFLOW_CHECK` edit phase | 31 / 31 PASS: import, waveforms, split, undo/redo, trim, move, fades, copy/paste/delete, mute, export samples (worst error 2.72e-7), playback = export through `mixRoute` (worst 0), audible playback, save, error banner, scrolling |
| `MSP_WORKFLOW_CHECK` reload phase | 5 / 5 PASS: project restored, waveforms, export samples, export identical before and after reload, playback = export |
| Native Phase 0/1 tests | PASS (part of the 239) |

## Files

New:

- `native/audio-engine/include/msp/Routing.h`, `native/audio-engine/src/Routing.cpp`: route checks, repair, `buildMixPlan`
- `apps/desktop/renderer/src/Mixer.tsx`: mixer console
- `apps/desktop/electron/mixerCheck.ts`: real-window mixer check (inactive unless `MSP_MIXER_CHECK` is set)
- `docs/phase21-baseline.md`, `docs/phase21-final-report.md`

Changed:

- `native/audio-engine/CMakeLists.txt`: adds `Routing.cpp`
- `native/audio-engine/include/msp/Mixer.h`, `src/Mixer.cpp`: `MixPlan`, `MixState`, `mixRoute`, `inheritMixState` (`mixBlock` unchanged)
- `native/audio-engine/include/msp/Project.h`, `src/Project.cpp`: schema v3, buses, routing, repair warnings
- `native/audio-engine/include/msp/Session.h`, `src/Session.cpp`: buses, routing, sends; render and export through `mixRoute`
- `native/audio-engine/include/msp/Engine.h`, `src/Engine.cpp`: bus/route/send commands, snapshot reclaim, strip meters, clip latching
- `native/audio-engine/tests/test_main.cpp`: 63 new checks
- `packages/shared/src/protocol.ts`, `apps/desktop/electron/protocol.ts`: bus, send, and strip meter types
- `apps/desktop/renderer/src/App.tsx`: Editor/Mixer toggle, strip meter state
- `apps/desktop/renderer/src/styles.css`: mixer styles
- `apps/desktop/electron/main.ts`: mixer check hook
- `apps/desktop/electron/workflowCheck.ts`: exports WAV helpers for the mixer check
- `scripts/verify-phase0-fixtures.py`: accepts version 3

## Known limitations

- Retired audio buffers (rendered track audio) are still kept until the process exits, as in Phase 1. Mix snapshots are now freed.
- Removing a bus while audio is playing switches its inputs to the new destination without a cross-fade.
- The `getMeters` diagnostic command (tests only) reads and clears the same peak values the meter timer uses.
- At the 960x700 minimum window, the mixer area is 184 px tall and scrolls vertically. The fader is 65 px.
- Pan is on tracks only. Buses have gain, mute, and solo but no pan or balance.
- Sends exist only to return buses. Returns only sum; there is no effect processing (Phase 2.2 or later).

## Not run

- **Microphone: NOT RUN — NO HARDWARE.** No input device was enumerated (`inCh=0`). The microphone was not retested, as required for this phase.
- **Real OS-mouse routing, sends, and save/load: NOT RUN.** Only clicks and one fader drag were done with the real mouse (see "Real Windows mouse"). Another input source was active on the desktop, so testing stopped. Those workflows are covered by the injected-input real-window check.
- Listening by ear to playback or export. The audio evidence is sample comparison, the independent routing model, and callback meter peaks.
- Switching physical audio devices, a 30-minute soak, CPU/glitch listening, and loopback latency.

## Launch

From `D:\MusicStudioPro\apps\desktop`:

```text
$env:MUSICSTUDIO_ENGINE = 'D:\MusicStudioPro\build\MusicStudioEngine.exe'
npm start
```
