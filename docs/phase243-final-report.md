# Phase 2.4.3 — Musical Key, Scale & Target Note Mapping — Final Report

Date: 2026-11-07. Scope: note mapping and preview only. No audio is modified by this phase: the
playback and export signal paths are unchanged, source WAV files are never written, and clip
timing/duration never changes because of a mapping, a key change or a manual target.

## 1. Features

- **Music theory module** (native, independent of audio): 12 chromatic roots, 7 scales, nearest
  allowed note mapping with explicit status, deterministic tie-breaking and safe handling of
  unvoiced / invalid input.
- **Note segmentation** of the existing YIN frames into note segments (start/end, median pitch,
  confidence). Raw frames are kept and are not modified.
- **Target mapping per segment**: original pitch (fractional MIDI and Hz), nearest chromatic note
  with cents, suggested target note, cents needed, status (`off`, `inTune`, `needsCorrection`).
- **Manual target override per segment**, stored separately from the automatic suggestion:
  set / reset / clear all, undo/redo through the existing clip undo stack, saved in the project.
  Overrides carry a stable identity (clip id, source id, source time span, original pitch) and are
  never attached to a different clip or an unrelated note.
- **Pitch Analysis panel**: "Key and target notes" section with key selector (12 roots, sharps with
  flat spelling, e.g. `C#/Db`), scale selector (7 scales), "Suggest targets" toggle, scale note
  read-out, a note list (time, original note ± cents, suggestion, manual target select with
  out-of-key marking, effective correction, `manual` badge, Reset), "Clear manual targets", and
  target bars on the pitch plot (green = suggestion, purple = manual, thin white = original median).
- **Persistence**: key, scale, enabled state, tie rule, tolerance and overrides are saved in the
  version 5 project format as optional fields; older v5 files load with defaults.

## 2. Scale definitions

Intervals in semitones above the root (`native/audio-engine/src/Scale.cpp`):

| Scale | Protocol name | Intervals |
|---|---|---|
| Major | `major` | 0 2 4 5 7 9 11 |
| Natural minor | `naturalMinor` | 0 2 3 5 7 8 10 |
| Harmonic minor | `harmonicMinor` | 0 2 3 5 7 8 11 |
| Melodic minor (ascending) | `melodicMinor` | 0 2 3 5 7 9 11 |
| Major pentatonic | `majorPentatonic` | 0 2 4 7 9 |
| Minor pentatonic | `minorPentatonic` | 0 3 5 7 10 |
| Chromatic | `chromatic` | 0–11 |

Enharmonics: pitch classes are 0–11 (C = 0). Output names always use sharps (`C#`, `A#`); input
accepts sharps and flats (`Db` = `C#` = 1, `Cb` = 11, `B#` = 0, `E#` = 5). Note names follow the
existing convention (MIDI 60 = C4, 69 = A4 = 440 Hz).

## 3. Mapping behaviour

`mapPitch(midi, voiced, key, settings)` / `mapFrequency(hz, ...)`:

- Works on the **unrounded** fractional MIDI pitch. It finds the closest allowed note at or below and
  at or above the pitch, so octave boundaries are crossed naturally (C major 71.6 → C5; C minor
  pentatonic 71.2 → C5, 70.9 → A#4).
- Exact ties (equal distance within 1e-9 semitone) go to the lower note by default, or to the upper
  note with `tieBreak: "upper"`. The result is deterministic.
- Targets are limited to MIDI 0–127. If the nearest allowed note lies outside that range, the
  nearest one inside is used.
- `cents = (target − original) × 100` is the correction needed. `inTune` when |cents| ≤ tolerance
  (default 10 c, range 0–50), otherwise `needsCorrection`.
- Unvoiced input (and 0 Hz / negative Hz) → `unvoiced`, no target. NaN, ±inf, pitch outside
  [−0.5, 127.5] or a root outside 0–11 → `invalid`, no target. Silence never gets a target.
- With mapping disabled, the engine reports `status: "off"` and no suggestion. Manual targets are
  still shown, because they are the user's explicit choice.

## 4. Segmentation behaviour

`segmentPitch(frames, hopSeconds, params)` (`native/audio-engine/src/NoteSegments.cpp`). Defaults:

- `minFrames` 5: shorter segments are dropped.
- `maxGapFrames` 2: unvoiced runs up to 2 frames are bridged.
- `splitSemitones` 0.7.
- `splitFrames` 3.

How a segment is built:

- A segment starts at a voiced frame. Each following voiced frame is compared with the median of
  the segment's last 15 accepted frames.
- If a frame deviates by more than 0.7 semitones for 1–2 frames, it is treated as a glitch (for
  example a YIN octave error) and excluded from the segment's pitch.
- After 3 consecutive deviating frames, a new segment starts at the first of them.
- More than 2 unvoiced frames end the segment.
- Segment times are frame centre ± hop/2, relative to the analysed audio. The engine adds
  timeline times.

The pitch analysis worker computes the segments off the audio thread, right after the YIN
analysis. The last 4 analyses are kept in memory. The 2.4.1 frame and note output is unchanged.

**Not perfect:**
- A slow glide (portamento) can stay a single segment.
- Wide vibrato (more than 0.7 st for 3 or more frames) can split a note.
- Very short notes (under 5 frames, about 58 ms at the default 44.1 kHz hop) are not listed.

## 5. Override identity and the engine protocol

An override (`NoteTarget`) stores:
- `clipId` and `sourceFileId`;
- the segment's source-time span (`sourceStart`, `sourceEnd`, in seconds);
- the segment's median pitch (`originalMidi`);
- `targetMidi`.

It applies to a segment only when all of these hold:
- clip id and source id are equal;
- both edges are within max(30 ms, 2 hops);
- the original pitch is within 0.5 semitones.

Consequences:
- **Duplicated clips** and the right half of a split get new ids. Their copied overrides stay
  unmatched and are reported as `unmatchedOverrides`, never silently applied. The left half of a
  split and moved clips keep theirs.
- **Trimmed clips:** an analysis made before a trim (or any change to source offset, duration or
  source) is refused for editing ("The clip changed after it was analysed…"). A fresh analysis
  re-attaches the overrides by source time.
- **After a Phase 2.4.2 "Apply to clip"**, the clip plays a different source, so its overrides are
  unmatched until "Revert to original".
- **Loading a project** discards cached analyses, and stale analyses are also rejected by a
  project generation counter.

New engine commands:

| Command | Effect |
|---|---|
| `getPitchMapping {jobId}` | Segments with original, suggestion, override and effective target, plus `clipChanged`, `overrideCount` and `unmatchedOverrides`. |
| `setPitchMapping {enabled?, root?, scale?, tieBreak?, toleranceCents?}` | Project setting, validated, returns state. Not part of clip undo. |
| `setNoteTarget {jobId, segment, targetMidi}` / `resetNoteTarget {jobId, segment}` | Undoable. Only the clip's `noteTargets` change; the track is not re-arranged and no audio buffer is touched. |
| `clearNoteTargets {trackId, clipId}` | Undoable. Removes all of the clip's overrides, including unmatched ones. |

Also:
- State gains `pitch.mapping` and clip `noteTargets`.
- These commands keep an active A/B pitch preview running.

## 6. Persistence

- Project version stays **5**.
- New optional project object `pitchMapping {enabled, root, scale, tieBreak, toleranceCents}`.
- New optional clip array `noteTargets` (written only when non-empty).
- No analysis data (frames or segments) is stored. Segments are recomputed from the audio.
- Files without these fields load with defaults (C major, off, lower ties, 10 c) and no warnings.
- Invalid settings reset to defaults with a warning; invalid overrides are dropped with a warning.

## 7. Files changed

New:
- `native/audio-engine/include/msp/Scale.h`, `native/audio-engine/src/Scale.cpp`
- `native/audio-engine/include/msp/NoteSegments.h`, `native/audio-engine/src/NoteSegments.cpp`
- `apps/desktop/electron/pitchMappingCheck.ts` (GUI check `MSP_PITCHMAP_CHECK`)
- `docs/phase243-final-report.md`

Modified:
- `native/audio-engine/CMakeLists.txt`: the two new sources.
- `include/msp/Timeline.h`: `NoteTarget`, `Clip::noteTargets`.
- `include/msp/Project.h`, `src/Project.cpp`: `ProjectClip::noteTargets`, `ProjectData::pitchMapping`, save/load with validation.
- `include/msp/Session.h`, `src/Session.cpp`: `pitchMapping`, `editNoteTargets` (undo without re-arranging), `toProject`.
- `include/msp/Engine.h`, `src/Engine.cpp`: segment cache, project generation, the commands above, state additions, project load.
- `tests/test_main.cpp`: test group `pitchmap` (unit + IPC), also added to the full list.
- `packages/shared/src/protocol.ts`: mapping types, `scaleOptions`, `keyRoots`, `NoteTarget`.
- `apps/desktop/renderer/src/PitchPanel.tsx`, `apps/desktop/renderer/src/styles.css`: the panel section, note list and plot overlay.
- `apps/desktop/electron/main.ts`: `MSP_PITCHMAP_CHECK` hook.

## 8. Tests and build commands executed

Process check before the native build (no Music Studio Pro window or engine was running):
`Get-CimInstance Win32_Process | Where-Object { MusicStudioEngine* or electron*MusicStudioPro* }` → none.

| Command | Result |
|---|---|
| `powershell -ExecutionPolicy Bypass -File scripts\build-engine.ps1` | exit 0 (engine + tests built) |
| `build\audio_engine_tests.exe pitchmap` | **19 PASS, 0 FAIL** |
| `build\audio_engine_tests.exe pitch` (analysis worker changed) | **15 PASS, 0 FAIL** |
| `build\audio_engine_tests.exe pitchshift` (clip/project structs changed) | **18 PASS, 0 FAIL** |
| `npx tsc -p tsconfig.json --noEmit` and `npx tsc -p tsconfig.electron.json --noEmit` | exit 0 |
| `npm run build` | exit 0 |
| GUI check `MSP_PITCHMAP_CHECK` (3 runs) | **7 PASS, 0 FAIL, 1 NOT RUN** each run |

About the three GUI runs:
- Run 1 passed, but its screenshot showed clipped selects and note rows in the narrow inspector.
- The layout was fixed and run 2 passed.
- Run 3 added a plot screenshot; it passed again.

`pitchmap` native tests (all PASS):
- **Unit tests** (12):
  - `pitchmap-scale-intervals-and-enharmonics`
  - `pitchmap-major-minor-mapping`
  - `pitchmap-chromatic`
  - `pitchmap-pentatonic`
  - `pitchmap-nearest-across-octaves`
  - `pitchmap-fractional-midi-and-cents` (69.25 → A4 −25 c; 452 Hz → A4 −46.583 c; no rounding before mapping)
  - `pitchmap-unvoiced-and-invalid-input`
  - `pitchmap-deterministic-ties`
  - `pitchmap-note-segmentation`
  - `pitchmap-override-identity`
  - `pitchmap-override-reset-undo-redo` (the playback buffer is unchanged)
  - `pitchmap-project-save-load` (v5 round trip, v5 file without the new fields, damaged fields)
- **IPC tests** (7):
  - `ipc-pitchmap-suggestions`
  - `ipc-pitchmap-override-undo-redo-reset`
  - `ipc-pitchmap-audio-unchanged` (realtime render bit-identical with an override; WAV bytes unchanged)
  - `ipc-pitchmap-key-change`
  - `ipc-pitchmap-project-save-load`
  - `ipc-pitchmap-override-identity` (duplicate and trim)
  - `ipc-pitchmap-errors`

GUI scenarios (PASS):
- controls present and editor unchanged ("Phase 2.3" label);
- three segments listed, with no suggestions while mapping is off;
- C major suggestions;
- key change to D major and scale change to harmonic minor;
- manual target B3 shown as manual, with the suggestion kept;
- undo, redo and reset from the UI;
- clip timing, clip source and WAV file unchanged.

Screenshots: `pitchmap-01-c-major.png`, `pitchmap-02-manual-target.png` and
`pitchmap-03-plot-targets.png` in `%TEMP%\msp-pitchmap-20261107-174659`.

NOT RUN:
- full regression and `scripts\run-regression.ps1` (not requested);
- the other native groups (`automation`, `master-gain`, and the full run);
- the other GUI checks (layout, workflow, mixer, fx, auto, pitch, pitchfix);
- installer and release packaging (excluded).

Microphone / real voice recording: **NOT RUN — NO HARDWARE**.

## 9. Limitations

- Segmentation is a heuristic; see section 4.
- An exact tie needs an exactly centred measurement. In real recordings a pitch near the midpoint
  goes to whichever side it measures closer to; the GUI fixture's C#4 in C major went to D4 for that
  reason.
- The tie rule and the in-tune tolerance can be set through the engine command and are saved, but
  the panel uses their current values without a control.
- Key and scale changes are project settings and are not on the clip undo stack.
- Editing targets needs an analysis made after the clip's last source, offset or duration change.
  The panel says so when the clip changed.
- Overrides are not re-targeted when a clip is duplicated or split; copies are reported as
  unmatched and can be removed with "Clear manual targets".
- Only the most recent 4 analyses can be edited. Older ones need re-analysis.
- Targets are a preview. No correction is rendered from them in this phase.

## 10. Remaining work (next phases, not started)

- Rendering corrections from the effective targets: per-segment offline pitch shifting, reusing the
  Phase 2.4.2 shifter, with crossfades between segments.
- Controls for tolerance and tie rule; a correction amount or retune speed.
- Better segmentation for glides and vibrato, and editing segment boundaries.
- Re-targeting overrides on split and duplicate, if wanted.

Phase 2.4.3 is complete. Work is stopped here pending approval for the next phase.
