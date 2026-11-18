# Phase 2.1 Baseline Audit

Date: 2026-11-06. Audit was done before any Phase 2.1 code change.

## Current signal flow

```
per-track clips (Phase 1 non-destructive edits)
  -> renderArrangement() on the control thread -> track.playLeft / playRight
  -> MixSnapshot { MixTrackView[], timeline } published through std::atomic pointer
  -> audio callback: mixBlock()
       for each track: skip if mute, skip if (any solo && !solo)
                       gain (linear 0..4) * constant-power pan (cos/sin)
                       summed straight into the stereo output buffer
       + microphone monitor (only when enabled and an input is open)
       * master gain (atomic, read every callback)
       -> single stereo peak (peakL/peakR atomics)
  -> timer (50 ms, message thread) sends one `meter` event with master peakL/peakR
```

Export (`Session::exportMix`) re-renders every track from its original sources at the export
rate and runs the same `mixBlock` in 1024-sample blocks. `renderPlayback` (diagnostic IPC op)
runs the published snapshot through `mixBlock` in 480-sample blocks. Playback and export
therefore share one summing function.

## Routing limitations found

- No buses. Every track sums straight to the master. No group buses, no return buses.
- No sends. No pre/post-fader taps.
- No per-track or per-bus meters. Only one master stereo peak is measured.
- No clip indicators in the engine. The renderer colours the master bar red at >= 1.0 only.
- Track gain and pan changes are step changes when a new snapshot is swapped in. Master gain is
  also a step change. That can click on loud material.
- The UI has gain/pan sliders in each track header (no dB fader, no mixer view, no routing).
- Snapshots are kept in `mixHistory` until exit. That is safe but grows with every edit.

## Realtime model (kept)

- Control thread (JUCE message thread) builds immutable snapshots and publishes with
  release/acquire on `mixHead`. The audio callback never allocates, locks, logs, or does I/O.
- Retired audio buffers are held, not freed, so the callback can never read freed memory.

## Project schema

- `format: "music-studio-pro-project"`, `version: 2` written. Reader accepts 1 and 2.
- v1: one path per track. v2: clips, extra sources, empty-path tracks allowed.
- Stored mix data: masterGain, per-track gain/pan/mute/solo. No routing data.

## Baseline build and test results (executed 2026-11-06, before changes)

| Check | Command | Result |
| --- | --- | --- |
| Native build | `scripts\build-engine.ps1` | PASS (up to date, `ninja: no work to do`) |
| Native tests | `build\audio_engine_tests.exe` | PASS: pass=176 fail=0 not_run=7 |
| Renderer TypeScript | `npx tsc -p tsconfig.json --noEmit` | PASS |
| Electron TypeScript | `npx tsc -p tsconfig.electron.json --noEmit` | PASS |
| Vite build | `npx vite build` | PASS |
| Electron smoke launch | `MSP_SMOKE=1 npx electron .` | PASS (exit 0) |
| Phase 0 fixture script | `python scripts\verify-phase0-fixtures.py` | PASS |

The 7 NOT RUN native tests are microphone and hardware checks: NOT RUN — NO HARDWARE.

## Phase 1 compatibility risks for Phase 2.1

1. `mixBlock` is used by tests directly. It must keep its exact behaviour. New routing should be
   a separate function that playback, `renderPlayback`, `Session::render`, and export all share.
2. Gain smoothing must not change export output for static mixes, or playback/export equality
   tests break. Smoothing state must start at the target value for a fresh render.
3. Bumping the project schema to v3 must keep v1/v2 loading. The Phase 0 fixture script checks
   the saved version number and must accept 3.
4. Track ids are strings and tracks can be added, removed, or duplicated. Routing must refer to
   ids, not indexes, and must repair itself when a destination is removed.
5. The meter event shape is consumed by the renderer. New per-strip meter data must be added
   without removing `peakL`/`peakR`.
6. Header layout and the editor grid were verified in Phase 1. The mixer must be a separate view
   so the editor layout does not change.
