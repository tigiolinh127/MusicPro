# Phase 0 plan

Phase 0 proves a real Windows desktop audio path. It is not a mock engine and it does not include the later workstation features listed in `docs/architecture.md`.

## Build

Native engine, from a Visual Studio 2026 Build Tools x64 prompt (or `scripts/build-engine.ps1`):

```text
cmake -S D:\MusicStudioPro -B D:\MusicStudioPro\build -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build D:\MusicStudioPro\build
```

Desktop shell:

```text
cd D:\MusicStudioPro\apps\desktop
npm install
npm run build
$env:MUSICSTUDIO_ENGINE = 'D:\MusicStudioPro\build\MusicStudioEngine.exe'
npm start
```

Demo WAVs:

```text
node D:\MusicStudioPro\scripts\generate-fixtures.mjs
```

Automated tests:

```text
D:\MusicStudioPro\build\audio_engine_tests.exe
```

## In scope

1. Import mono or stereo PCM WAV files and reject missing or non-WAV paths with an error string.
2. Play two tracks at once through WASAPI.
3. Play, pause, stop, and seek.
4. Per-track gain, constant-power pan, mute, and solo.
5. Master gain and a peak meter fed from the audio callback.
6. Microphone input through JUCE, monitoring off unless the user turns it on and an input is open.
7. Output/input device, sample rate, and buffer size where the device reports them.
8. Resample source files to the device rate for playback and to the requested rate for export.
9. Offline stereo 24-bit WAV export using the same mixer, with no device required.
10. Electron + React UI with a restricted preload bridge.
11. Version 1 project save/load.
12. Native tests for mix math, WAV I/O, resampling, export integrity, project files, invalid IPC, missing files, and process shutdown.

## Out of scope

Installers, code signing, packaging, VST3, ASIO, pitch correction, karaoke, livestreaming, AI, and recording.

## Acceptance

PASS requires a compiled engine, a launching UI, simultaneous playback, working mixer and transport, real microphone monitoring, export integrity tests, and executed hardware checks.

If a microphone or listening check cannot be performed, that item is NOT RUN and Phase 0 is PARTIAL rather than PASS. Test results are recorded from the commands that were actually run.
