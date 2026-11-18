# Phase 1 final report

Status: **PASS**, with the items listed under "Not run" below.

Final functional QA on 2026-11-06 drove the real desktop window through every Phase 1 editing workflow, a save, a full app close, a reopen, and a load. Exported WAV samples were checked against an independent calculation of the edited arrangement. The previous PASS (2026-11-05) missed a save/load defect: a project built with Add track and Import WAV could not be reopened. That defect and five others found in this QA are fixed below.

Microphone monitoring remains **NOT RUN — NO HARDWARE**.

## Status by area

| Area | Status |
|---|---|
| Import WAV and real waveform | PASS |
| Split at playhead | PASS |
| Trim clip edges | PASS |
| Move clip | PASS |
| Copy, paste, delete | PASS |
| Undo and redo | PASS |
| Fade in and fade out | PASS (failed before fix) |
| Save, close app, reopen, load | PASS (failed before fix) |
| Export edited audio, sample validation | PASS |
| Playback and export use the same clip data | PASS |
| Unique automatic track names | PASS (fixed) |
| Mouse wheel scrolling | PASS |
| Vertical scrollbar dragging | PASS |
| Horizontal scrollbar dragging | PASS with injected input only |
| Phase 0 behavior | PASS |
| Microphone monitoring | NOT RUN — NO HARDWARE |
| Listening by ear | NOT RUN |

## Defects found and fixed in this QA

1. **Duplicate automatic track names.** Add track named tracks from an internal id counter. Tracks created by importing a file, loading a project, or renaming did not advance that counter, so Add track could produce a second "Track 1". Importing into a new track id used the raw id as its name. Every generated name now comes from one function. It picks "Track N" starting at the track's position and skips any name already in use, ignoring case. Duplicates are named "X copy", "X copy 2", and so on. Names typed by the user are kept exactly, even if they repeat another name. On project load, names saved in the file are restored first, and tracks saved without a name are named afterwards so they cannot take a saved name.
2. **Projects from the normal workflow could not be reopened.** Import WAV on a track made with Add track stored the file only as an extra source, leaving the track's file path empty. The project reader rejected any track with an empty path ("Each project track needs an id and a file path."), and the loader skipped clips on empty-path tracks. Now the first import into an empty track becomes that track's file. Version 2 projects accept an empty path for empty tracks and for tracks whose audio is in extra sources. Projects saved by the old build, with clips only in extra sources, load with all clips. Version 1 projects still require a path.
3. **The header said "Empty track" after an import.** It now shows the file name. A track whose audio is only in extra sources shows its clip count.
4. **Fade handles could not be dragged.** With a fade length of zero, the fade handle sits on the clip edge, where trim always took priority. Dragging a fade handle trimmed the clip instead. In the top 20 px of a clip, the fade handles now take priority. Trimming still works anywhere else along the edge.
5. **The error banner broke the page layout.** The page used fixed grid rows, so when a banner appeared every section moved down one row. The device panel took the stretch row and the editor collapsed. The page is now a flex column in which only the editor stretches. The 33-check layout suite still passes.
6. **Phase 0 baseline script** expected project version 1. Phase 1 saves version 2 on purpose, so the script now accepts 1 or 2.

## How the desktop workflows were verified

`apps/desktop/electron/workflowCheck.ts` runs inside the real app when `MSP_WORKFLOW_CHECK` is set. It clicks buttons, drags clips, and presses keys with Chromium input events (`webContents.sendInputEvent`). Those events go through the same pointer and keyboard handlers as a physical mouse. File dialogs are answered with fixed paths. Everything else is the normal UI and engine. The second track uses a 4 second 24-bit ramp WAV (left = 0.1 + 0.8 · n / N, right = half of left), so every output sample shows which source sample it came from.

Run from `D:\MusicStudioPro\apps\desktop`:

```text
$env:MUSICSTUDIO_ENGINE = 'D:\MusicStudioPro\build\MusicStudioEngine.exe'
$env:MSP_WORKFLOW_CHECK = 'D:\MusicStudioPro\build\workflow-check'
$env:MSP_WORKFLOW_PHASE = 'edit';   npx electron .
$env:MSP_WORKFLOW_PHASE = 'reload'; npx electron .
```

The reload phase is a new app and engine process, started after the first one exited.

Results on the final build: 36 PASS, 0 FAIL. Screenshots and `edit-results.json` / `reload-results.json` are in `D:\MusicStudioPro\build\workflow-check`. Results before the fixes are in `D:\MusicStudioPro\build\workflow-before`.

| Workflow | Evidence |
|---|---|
| Import WAV | Header Import WAV button and file dialog. 10.000 s music clip and 192000-frame ramp clip. Header shows `test_music_440hz.wav · stereo` and `ramp-4s.wav · stereo`. |
| Real waveform | Music: 554 of 554 pixel columns drawn, drawn height 68.0 px, height from the file's peak data 68.0 px. Ramp: height grows from 10.6 px to 58.3 px across the clip. Redrawn after loading. |
| Split at playhead | Ruler click at 1.000 s, clip click, Split button. Clips 0–1.000 s and 1.000–4.000 s, source offset 1.000 s, total length unchanged. |
| Undo / Redo | Buttons: 2 clips → 1 → 2. Keyboard: Delete, Ctrl+Z, Ctrl+Y, Ctrl+Z gave 2, 3, 2, 3 clips. |
| Trim | Left edge dragged to 1.5 s: start 1.5000, offset 1.5000, length 2.5000. Right edge dragged to 0.75 s: length 0.7500. |
| Move | Drag +0.5 s: start 2.0000, source offset unchanged at 1.5000. |
| Fades | Handle drags: fade in 0.5000 s with start unchanged, fade out 0.2500 s with length unchanged. Before the fix the same drags trimmed the clip to start 2.5 s and length 0.5 s. |
| Copy / paste / delete | Ctrl+C, ruler click at 5.0 s, Ctrl+V: pasted at 5.0000 with the same offset, length, and fade. Copy, Paste, and Delete buttons: 4 clips, then 3. |
| Save, close, reopen, load | Save project button wrote `edited.msp.json`. After a full restart, Load project restored the same names, mute state, and every clip's start, length, offset, and fades in samples. Before the fix, load failed and the window showed no tracks. |
| Export samples | Music track muted. Export WAV button: 48000 Hz, 480000 frames. Worst difference from the independently computed ramp arrangement, including pan law and linear fades: 2.72e-7 (24-bit quantization). Same result after reload. The export after reload is bit-identical to the export before closing. |
| Playback = export | New diagnostic engine command `renderPlayback` runs the published realtime mix through `mixBlock`, as the audio callback does, offline in 480-sample blocks. Difference from the export: 0 before and after reload. |
| Device playback | 6.4 s of real WASAPI playback. 53 of 53 meter windows inside clips were audible and 37 of 37 inside gaps were silent. Meter peaks come from the audio callback. This is not a loopback recording. |
| Track names | Two Add track tracks, a direct engine import, then Add track: Track 1, Track 2, Track 3, Track 4. |
| Error banner | Failed project load: banner shown, device panel 128 → 128 px, editor 427 → 382 px, tracks kept. |

## Scrolling

Injected input (`sendInputEvent`) in the workflow check, with 14 tracks:

- One wheel notch over the headers scrolled 120 px. One notch over the timeline also scrolled 120 px. Headers stayed aligned with their lanes.
- Shift + wheel over the timeline scrolled horizontally by 120 px, with no vertical movement.
- Dragging the vertical scrollbar thumb set scrollTop from 0 to 706, with headers aligned.
- Dragging the horizontal scrollbar thumb set scrollLeft from 0 to 220, and the ruler redrew.

Real Windows input (Computer Use: OS mouse wheel and mouse drag) on a separate test window with 6 tracks:

- Three notches down over the headers moved the list by the same distance as three notches up over the timeline: 228 px each in the 1.32× downscaled screenshot, about 300 screen px. There is no double scrolling over the timeline. The ruler stayed fixed.
- Dragging the vertical scrollbar thumb scrolled the list. The ruler stayed fixed.
- A real horizontal scrollbar drag was **NOT RUN**. That window had no clips, so the timeline was not wider than the view. Importing a WAV there would have required typing in the OS file dialog, which was not allowed in this session.

## Track layout verification

`MSP_LAYOUT_CHECK` (`electron/layoutCheck.ts`) re-run after the layout change in fix 5: 33 of 33 PASS. It covers 2, 4, 8, and 16 tracks; controls inside headers with no clipped text; headers within 0.5 px of their lanes; scroll to the bottom with the ruler fixed; resizing to 960x700, 1600x1000, and 1180x860; Add track and Remove; and 16-track playback. The ruler label overlap fixed on 2026-11-06 stays fixed.

## Phase 0 behavior

- `scripts/verify-phase0-fixtures.py` against the new engine: `BASELINE_EXPORT_OK left440=0.500 right880=0.500 frames=480000` and `BASELINE_PROJECT_OK version=2 tracks=2`. This covers two-track import, hard pan, 24-bit export, and project round-trip.
- UI smoke (`MSP_SMOKE=1`) exited 0.
- Native Phase 0 tests (pan law, gain, mute, solo, seek, EOF, WAV I/O, resampling, export, IPC, device play and pause) pass.
- Version 1 projects still load as one full-file clip per track (`phase0-v1-migration`).
- Mute was used through the header M button during the export test.

## Build results

Native build, 2026-11-06, after you confirmed Music Studio Pro was closed:

```text
powershell -ExecutionPolicy Bypass -File D:\MusicStudioPro\scripts\build-engine.ps1
```

Exit 0. Outputs: `D:\MusicStudioPro\build\MusicStudioEngine.exe` and `D:\MusicStudioPro\build\audio_engine_tests.exe`.

Desktop, from `D:\MusicStudioPro\apps\desktop`:

```text
npx tsc -p tsconfig.json --noEmit           exit 0
npx tsc -p tsconfig.electron.json --noEmit  exit 0
npm run build  (tsc electron + vite build)  exit 0
```

## Automated tests

```text
D:\MusicStudioPro\build\audio_engine_tests.exe
```

Exit 0. `SUMMARY pass=176 fail=0 not_run=7`. Before this QA: 154 / 0 / 7.

New in this QA:

- `name-*` (12 checks): generated names on import, Add track skipping taken names, re-import keeping the name, unique duplicate names, user names and user duplicates kept, generated names never colliding, project round-trip of names.
- `ipc-load-names-unique`: a project with unnamed tracks next to a saved "Track 1" loads as Track 2, Track 1, Track 3, and the next Add track gives Track 4.
- `import-into-empty-track-sets-file`, `second-import-reuses-file`
- `empty-track-project-save`, `empty-track-project-reads`, `extras-only-project-reads`, `v1-empty-path-still-rejected`
- `ipc-load-extras-only-project` (a project saved by the old build loads with clip start, offset, length, and fades), `ipc-load-empty-and-imported-project`
- `ipc-playback-matches-export`: `renderPlayback` against `exportWav` through the engine process, 0 difference allowed above 1e-4.

## Files changed in this QA

- `native/audio-engine/include/msp/Session.h`: name helpers
- `native/audio-engine/src/Session.cpp`: unique generated names; first import into an empty track becomes its file
- `native/audio-engine/src/Project.cpp`: version 2 accepts empty track paths
- `native/audio-engine/src/Engine.cpp`: empty-path tracks keep extras and clips on load; names after load; `renderPlayback` diagnostic
- `native/audio-engine/tests/test_main.cpp`
- `apps/desktop/renderer/src/App.tsx`: fade handle priority; header file name and clip count
- `apps/desktop/renderer/src/styles.css`: flex page layout
- `apps/desktop/electron/main.ts`: scripted dialog answers and workflow check hook (inactive unless `MSP_WORKFLOW_CHECK` is set)
- `apps/desktop/electron/workflowCheck.ts`: new
- `scripts/verify-phase0-fixtures.py`
- `docs/phase1-final-report.md`

## Known limitations

- Track count is not fixed. A 4, 8, 16, and 32 track mix, edit, save, load, and export test passes. Mixing 32 tracks for 2 seconds of audio used less than half of that audio duration on this machine. That is a CPU budget, not a listening test for dropouts.
- Undo applies to clip edits. Importing into an empty track can be undone (the clip goes away), but the track keeps the file as its source.
- Fades are linear. Overlap is a sum, including when both fades are zero.
- Snap is chosen in the interface, then rounded to a sample in the engine. Fade drags are not snapped.
- Trimming from the top 20 px of a clip edge now grabs the fade handle instead. Trim from lower on the edge.
- The device row wraps to two lines when device names are long. All controls stay visible.
- At the 960x700 minimum window, about one and a half lanes are visible below the transport and device panels.
- Editing renders the arrangement on the control thread and publishes the buffer. Old buffers are kept until the process exits.
- Source files longer than 30 minutes are rejected.

## Not run

- **Microphone monitoring: NOT RUN — NO HARDWARE.** No input device was enumerated (`inCh=0`). Headphone monitoring was not attempted.
- Listening by ear to playback or export. The audio evidence is sample comparison and callback meter peaks.
- Real (OS-level) horizontal scrollbar drag. See "Scrolling".
- Switching physical audio devices, a 30-minute soak, CPU/glitch listening, and loopback latency. Driver-reported output latency was 10.0 ms. That is not a round-trip measurement.

## Launch

From `D:\MusicStudioPro\apps\desktop`:

```text
$env:MUSICSTUDIO_ENGINE = 'D:\MusicStudioPro\build\MusicStudioEngine.exe'
npm start
```

Build the engine first with `D:\MusicStudioPro\scripts\build-engine.ps1` if `MusicStudioEngine.exe` is missing.
