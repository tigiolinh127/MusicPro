# Phase 1 baseline

Recorded before any Phase 1 edits. Microphone monitoring stays **NOT RUN — NO HARDWARE**.

## What Phase 0 contains

- Electron main, sandboxed preload, and one React screen in `apps/desktop`.
- JSON-lines protocol version 1 between the main process and `MusicStudioEngine.exe`.
- JUCE 8.0.17 WASAPI engine. Each imported WAV is resampled once and played as a whole-track buffer.
- Mixing is `mixBlock`: constant-power pan, mute, solo, master gain, optional microphone.
- Offline export writes stereo 24-bit WAV through the same mixer and does not need a device.
- Project files are `music-studio-pro-project` version 1: track path, gain, pan, mute, solo, master, devices. There is no clip model.
- Automated coverage is `native/audio-engine/tests/test_main.cpp`.

## Commands

```text
powershell -ExecutionPolicy Bypass -File D:\MusicStudioPro\scripts\build-engine.ps1
D:\MusicStudioPro\build\audio_engine_tests.exe
python D:\MusicStudioPro\scripts\verify-phase0-fixtures.py
```

The engine binary used for this baseline was already built. `audio_engine_tests.exe` was run on 2026-11-05 and finished exit 0.

## Automated tests

`SUMMARY pass=65 fail=0 not_run=7`

Playback, mix, WAV decode, resample, export integrity, project parse, IPC, shutdown, and WASAPI transport all passed. Device playback advanced on Speakers (2- Realtek High Definition Audio). Driver-reported output latency was 10 ms.

Microphone results are **NOT RUN — NO HARDWARE**:

- `mic-monitor-switch` — no input device enumerated
- manual microphone monitoring with headphones

Other manual checks (listening, device switching, 30-minute soak, CPU, loopback latency) were also not run.

## Fixture export and project round-trip

`scripts/verify-phase0-fixtures.py` imported:

- `D:\MusicStudioPro\fixtures\audio\test_music_440hz.wav`
- `D:\MusicStudioPro\fixtures\audio\test_music_880hz.wav`

Export was stereo 24-bit 48 kHz, 480000 frames. Goertzel magnitudes were left 440 Hz = 0.500 and right 880 Hz = 0.500 after hard pan. Save then load restored both tracks. Project version was 1.

Export and persistence are not broken, so Phase 1 can start without a Phase 0 repair.
