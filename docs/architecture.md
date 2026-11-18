# Music Studio Pro architecture

Music Studio Pro is a Windows desktop audio workstation. Phase 0 is a working proof of concept: two WAV tracks, a real mixer, microphone monitoring, and offline export. Later production features are boundaries only. They are not implemented.

## Process split

```text
Electron main (Node)
  |  JSON lines on stdin/stdout, protocol version 1
  v
MusicStudioEngine.exe  (C++20, JUCE 8.0.17-security)
  |  WASAPI shared mode via juce::AudioDeviceManager
  v
Audio device callback  (playback, monitor, meters)
```

The React renderer has `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true`. It can only call the preload bridge: engine commands, engine events, and native file dialogs. The renderer never opens audio devices and never decodes files.

The native engine owns decoding, resampling, mixing, monitoring, and WAV export. Offline export uses the same mix function as live playback and does not need an open output device.

## Repository

```text
apps/desktop/electron     Electron main, preload, engine host
apps/desktop/renderer     React + TypeScript UI
native/audio-engine       JUCE engine, mixer, WAV I/O, tests
packages/shared           Protocol types
fixtures                  Generated demo WAV files
scripts                   Build, fixture, and run helpers
docs                      Architecture and phase reports
```

## Realtime rules

The WASAPI callback may only read atomics and previously published sample pointers, write the device buffers, and update atomic peaks and the transport clock. It does not allocate, take a lock, read disk, write logs, or send IPC.

Control changes are applied on the JUCE message thread. Replacing a track's samples publishes one immutable pointer. The previous allocation is kept until process exit so the callback cannot use freed memory. Gain, pan, mute, solo, master, and monitor are atomics.

JUCE's device manager takes its own callback-list lock around the callback. This project does not add another lock there, and it does not replace JUCE with a custom driver.

## Mixing

Pan is constant power. `-1` is hard left, `0` is equal power (about -3 dB each side), and `+1` is hard right. Mute always silences a track. If any track is soloed, only soloed tracks are heard, and a muted solo still silences the rest of the mix. Master gain is applied after the track sum and after the microphone mix.

Microphone monitoring defaults to off. Enabling it requires an open input. The UI tells the user to use headphones.

Source files are decoded once and resampled to the device rate before playback. Export resamples from the original samples to the requested rate, so it does not depend on the live device buffers.

## IPC

One JSON object per line, version `1`. Requests have `v`, `id`, and `op`. Responses have `v`, `id`, and `ok`. Failures include `error`. Events (`ready`, `meter`, `error`) have no `id`.

Operations: `ping`, `listDevices`, `configure`, `importTrack`, `clearTrack`, `setTrack`, `setMaster`, `setMonitor`, `transport`, `getState`, `exportWav`, `saveProject`, `loadProject`, `shutdown`.

Project files are JSON, `format` `music-studio-pro-project`, `version` `1`.

## Audio devices

Windows audio is WASAPI shared mode (`Windows Audio` in JUCE). DirectSound and ASIO are compiled out (`JUCE_DIRECTSOUND=0`, `JUCE_ASIO=0`). ASIO can be added later with the Steinberg ASIO SDK and `JUCE_ASIO=1`. That SDK is not vendored here.

## Dependency license

[JUCE 8.0.17-security](https://github.com/juce-framework/JUCE/releases/tag/8.0.17-security) is fetched at configure time. JUCE is AGPLv3 or a commercial license. This Phase 0 build does not include a commercial JUCE license and does not ship an installer. Distributing a closed-source build would require AGPL compliance or a JUCE license.

Electron, React, and Vite are used under their own permissive licenses.

## Explicitly later

These stay out of the engine until a later phase: multitrack editing beyond the eight-slot mixer, remixing, BPM detection, time stretch, mastering, realtime pitch correction, karaoke, multitrack recording, OBS/livestream output, VST3 hosting, and AI stem separation. Phase 0 loads whole WAV files into memory (30 minute cap) and plays a stereo timeline. It does not record.
