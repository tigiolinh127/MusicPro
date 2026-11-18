# Phase 0 final report

**Status: PARTIAL**

The native engine compiles, the Electron UI launches, two WAV tracks play through WASAPI, the mixer and transport behave correctly in tests, and offline export matches the source tones. Microphone monitoring was not executed on hardware because this PC enumerated no input device. Listening, soak, and loopback-latency checks were not performed.

## Location

`D:\MusicStudioPro`

ProfilePilot was not modified. JUCE is not installed system-wide. CMake downloads JUCE 8.0.17-security into the build tree. JUCE is AGPLv3 or commercial; this build does not include a commercial license and does not ship an installer.

## Toolchain used

- Node.js 26.11.1, npm 11.20.0
- Git 2.56.0
- Visual Studio Build Tools 2026, MSVC 14.51 / 19.51
- CMake 4.3.1 and Ninja bundled with those Build Tools
- Windows SDK 10.0.26100.0
- Electron 33.4.11, React 19, Vite 6, TypeScript 5.9

## Build

```text
powershell -ExecutionPolicy Bypass -File D:\MusicStudioPro\scripts\build-engine.ps1
cd D:\MusicStudioPro\apps\desktop
npm install
npm run build
node D:\MusicStudioPro\scripts\generate-fixtures.mjs
```

`scripts/build-engine.ps1` loads the VS 2026 x64 developer environment, configures Ninja Release, and builds.

npm 11 blocked Electron's and esbuild's install scripts until they were approved (`npm install-scripts approve electron esbuild`). The Electron 33.4.11 Windows binary is in `apps/desktop/node_modules/electron/dist/electron.exe`.

## Run

```text
cd D:\MusicStudioPro\apps\desktop
$env:MUSICSTUDIO_ENGINE = 'D:\MusicStudioPro\build\MusicStudioEngine.exe'
npm start
```

Automated tests:

```text
D:\MusicStudioPro\build\audio_engine_tests.exe
```

UI smoke (loads the window, fails on a renderer console error, then exits):

```text
$env:MSP_SMOKE = '1'
$env:MUSICSTUDIO_ENGINE = 'D:\MusicStudioPro\build\MusicStudioEngine.exe'
npx electron .
```

Demo files are in `D:\MusicStudioPro\fixtures`.

## What was built

- C++20 JUCE engine `build\MusicStudioEngine.exe`
- JSON-lines IPC, protocol version 1, validated on the engine side
- WASAPI shared mode only (`JUCE_WASAPI=1`, `JUCE_DIRECTSOUND=0`, `JUCE_ASIO=0`)
- Two-track import, resample, play, pause, stop, seek
- Gain, constant-power pan, mute, solo, master gain, peak meters
- Microphone monitor, default off, refused unless an input is open
- Offline stereo 24-bit WAV export through the same mixer, without a device
- Version 1 project save/load
- Electron renderer with `contextIsolation`, no Node integration, and a sandboxed preload
- Native test executable `build\audio_engine_tests.exe`

The audio callback does not allocate, lock, log, read disk, or send IPC. Track audio is published as one pointer. Old buffers are retained until process exit. JUCE still takes its own callback-list lock inside the device manager; this project does not add another one and does not implement a driver.

## Test results

Command: `D:\MusicStudioPro\build\audio_engine_tests.exe`  
Result: **65 PASS, 0 FAIL, 7 NOT RUN**, exit code 0.

| Check | Result |
| --- | --- |
| Native compile and link | PASS |
| Pan law, gain, mute, solo, master | PASS |
| Play, pause, resume, stop, seek, end of file | PASS |
| Two-tone mix (440 Hz left, 880 Hz right) | PASS |
| WAV import, mono and stereo, missing file, non-WAV | PASS |
| Resample length and 440 Hz preservation (48 kHz to 44.1 kHz) | PASS |
| Export format, 24-bit stereo, signal integrity, silence, full-scale bound | PASS |
| Project version 1 round trip and rejected future version | PASS |
| Invalid JSON, unknown command, bad version, bad gain, engine still answers | PASS |
| Missing audio file over IPC | PASS |
| Engine shutdown exit code 0 | PASS |
| Import two tracks, list devices, IPC export contains 440 Hz | PASS |
| Real WASAPI playback position advances, pause holds | PASS |
| Electron window load with no renderer console error | PASS |
| Microphone monitor on/off on hardware | NOT RUN — no input device enumerated (`inCh=0`) |
| Listen to two WAVs in the UI | NOT RUN |
| Listen to microphone monitoring on headphones | NOT RUN |
| Switch physical devices by hand | NOT RUN |
| 30-minute playback/monitor soak | NOT RUN |
| CPU and glitch listening | NOT RUN |
| Loopback round-trip latency | NOT RUN |

## Latency

Measured from the open WASAPI device, not from a loopback:

- Device: Speakers (2- Realtek High Definition Audio)
- Sample rate: 48000 Hz
- Buffer: 480 frames (the device did not keep the requested 512)
- Driver-reported output latency: 480 samples, **10.0 ms**

Round-trip latency was not measured.

## Known issues

- This machine exposes no capture endpoint, so monitoring cannot be switched on. The engine keeps it off and returns an error if a client tries to enable it.
- Shared-mode WASAPI picked a 480-frame buffer instead of 512.
- Phase 0 loads each WAV fully into memory and rejects files longer than 30 minutes.
- Export does not include the live microphone.
- ASIO, VST3, recording, pitch correction, karaoke, livestream, and AI are not implemented.
- npm 11 will not run Electron's download script until that package's install script is approved.

## Acceptance

Phase 0 is **PARTIAL**. The software path for file playback, mixing, and export is in place and the automated suite passed. It is not PASS until microphone monitoring is heard on real hardware and the manual stability checks have been run.

## Next step

On a PC with a headset, import `fixtures\sine_440_stereo_44100.wav` and `fixtures\sine_880_stereo_48000.wav`, play them together, then enable monitoring only with headphones. After that, the next build should be multitrack recording or ASIO, still without VST3 or AI.
