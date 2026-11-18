# Phase 2.5.1 — Real-Time DSP Foundation: final report

Status: implemented and verified with targeted tests (`realtimedsp`: 22 PASS, 0 FAIL). The
foundation is a transparent pass-through; **no pitch detection or correction is performed**.
Real-time safety is shown by design, code structure and targeted tests on this machine; it is
not claimed universally.

## 1. Architecture audit

| Area | Finding | Consequence |
| --- | --- | --- |
| JUCE audio callback | `Engine::audioDeviceIOCallbackWithContext` clears the outputs, picks up the published `MixSnapshot`, builds the live input pointers (`in1`/`in2`, or the virtual test signal), then calls `mixRoute` (stereo) or chunks through `scratchL/R` (mono). | The live input exists in exactly one place before it reaches record inputs and track input monitoring. |
| Processing graph | `mixRoute` (Mixer.cpp) splits any block into `kMixChunk` = 512 chunks; inputs → input chains → sources → buses → master chain → master gain. Plans are immutable and published via atomics; `MixState` holds the prepared `EffectDsp`s. | Playback, routing and effects need no change; they already accept any block size. |
| Track/bus DSP chains | `EffectDsp` (prepare on control thread, `process`/`reset` RT-safe), `runEffect` dry/wet crossfade for enable/bypass. All effects are zero-latency, so the existing crossfade uses an undelayed dry path. | Not reusable for a delayed processor; left untouched. |
| Device configuration | `openDevices` (WASAPI shared) detaches the callback, opens the device, stores rate/buffer, re-attaches. `outputLatencySamples` is driver-reported. | The stage is (re)prepared there, while the callback is detached. |
| Buffer handling | Fixed `kMaxInputBlock` = 8192 buffers allocated in the constructor; blocks larger than that skip recording (counted). | The stage uses the same limit and the same pattern. |
| Offline rendering | `exportMix` / `renderPlayback` call `mixRoute` with their own `MixState`; no live input. | Unaffected; the stage is never part of offline rendering. |
| Existing ring buffers | `RecordQueue`: SPSC slot queue, audio thread → writer thread, for recording only. `DelayDsp` has a private modulated delay line. | **No generic sample ring buffer, block adapter or latency manager existed**, so `AudioRing` and `RealtimeProcessor` are new. `RecordQueue` was not duplicated: it is a cross-thread slot queue, `AudioRing` a single-thread sample FIFO. |
| DSP utilities | `Fft` (prepare allocates, transform does not); the offline pitch code repairs non-finite samples inside its own loops. | Future kernels must create their `Fft` in `prepare()`. |

**Chosen integration point: the live input stage in the audio callback**, after the device or
virtual input is selected and before `mixRoute`. That is where future live pitch detection and
correction belong (vocal input → monitoring/recording). It does not touch playback of clips,
buses, effects, master or offline rendering, and adds nothing to normal playback.

## 2. Implementation

### Files

- New `native/audio-engine/include/msp/RealtimeDsp.h`, `native/audio-engine/src/RealtimeDsp.cpp`:
  `AudioRing`, `RealtimeSpec`, `RealtimeKernel` (interface), `PassThroughKernel`,
  `RealtimeOptions`, `RealtimeStats`, `RealtimeProcessor`.
- `native/audio-engine/CMakeLists.txt` — `src/RealtimeDsp.cpp`; test target adds `tests/AllocationCounter.cpp`.
- `include/msp/Engine.h`, `src/Engine.cpp` — live input stage, lifecycle, IPC `getRealtimeDsp` / `setRealtimeDsp`.
- New `native/audio-engine/tests/AllocationCounter.cpp` — test-only replacement of the global
  allocation functions that counts the calling thread's heap allocations.
- `native/audio-engine/tests/test_main.cpp` — group `realtimedsp` (also added to the full list).

No TypeScript, renderer, Electron, project-schema, Mixer or Effects files changed.

### Processor interface (project naming)

| Required | Implemented |
| --- | --- |
| `prepare(sampleRate, maxBlockSize, channels)` | `std::string RealtimeProcessor::prepare(double, int, int)` — control thread, allocates everything, returns an error message |
| `process(input, output, numSamples)` | `void process(const float* const* input, float* const* output, int numSamples) noexcept` — may run in place |
| `reset()` | `void reset() noexcept`, plus `requestReset()` (any thread, applied at the next `process`) |
| `getLatencySamples()` | `latencySamples()`, `latencyMs()` |
| `getProcessingStatistics()` | `RealtimeStats statistics() const noexcept` (any thread), `requestStatisticsReset()` |
| Bypass | `setBypassed(bool)` / `bypassed()` (any thread) |

Algorithms plug in as a `RealtimeKernel` (`prepare(spec)`, in-place `process(data, frames) noexcept`,
`reset()`, `latencySamples()`). `process()` rules: no allocation, file I/O, locks, waits, logging,
IPC, exceptions (`noexcept`, compile-time checked), unbounded loops or FFT-plan creation; every
loop is bounded by the samples given (the adapter loop by `n / blockSize + 2` iterations).

### Per-chunk processing (`RealtimeProcessor::processChunk`)

1. Copy the input into scratch, replacing NaN/Inf with 0 (counted) — this also makes in-place use safe.
2. Dry path: through `dryRing` (primed with `latency` zeros) so it is delayed by exactly the latency.
3. Wet path: direct (`blockSize` 0: kernel on the host chunk) or block adapter (`inRing` collects
   `blockSize` frames → kernel → `outRing`, primed with `blockSize` zeros). Kernel output is sanitized.
4. Output: wet, dry, or a per-sample linear crossfade while the bypass mix moves.

Host blocks larger than the prepared `maxBlockSize` are processed in `maxBlockSize` chunks
(counted as `oversizeCalls`), with no allocation.

## 3. Buffer ownership and limits

| Buffer | Owner / thread | Capacity |
| --- | --- | --- |
| `scratch` (input, dry, wet: channels × maxBlock each; one adapter block) | processor, audio thread after prepare | ≤ 2 × (3 × 8192 + 4096) floats |
| `dryRing` | processor, audio thread | latency + maxBlock frames |
| `inRing` | processor, audio thread | blockSize frames |
| `outRing` | processor, audio thread | blockSize + maxBlock frames (fill before a read is at most blockSize + n and at least n + 1; underflow/overflow stayed 0 in every test) |
| `PassThroughKernel::ring` | kernel, audio thread | delay + maxFrames |
| `Engine::liveL/liveR` | engine, written by the callback | `kMaxInputBlock` = 8192 |

Limits: channels 1–2; `maxBlockSize` 1–8192; `blockSize` 0–4096; total latency ≤ 65536 samples
(IPC: `latencySamples` ≤ 61440 so delay + block fits); fade 0–100 ms; rate 8–384 kHz.

`AudioRing` behaviour: overflow stores at most `space()` frames and drops (and counts) the newest
excess; underflow returns `available()` frames and zero-fills (and counts) the rest; positions are
64-bit counters (`writePos − readPos` is the fill), so wraparound needs no special case; `clear()`
empties without freeing; counters are kept until `clearCounters()`. Inside the processor the ring
sizes make underflow and overflow impossible; the counters are exported as a check (0 in every test).

## 4. Threading model

- **Control thread** (engine message thread): builds and `prepare()`s a processor while no callback
  can reach it, then publishes it with `liveDspLive.store(ptr)`.
- **Audio thread**: `liveDspUsers.fetch_add(1)`, `liveDspLive.load()`, `process()`, `fetch_sub(1)`.
  No locks, no waits.
- **Retire** (`retireLiveDsp`): `liveDspLive.store(nullptr)`, then the control thread waits until
  `liveDspUsers == 0` (at most one callback) and frees the processor. Sequentially consistent
  atomics make this safe: a callback either sees null or is counted before the store is checked.
  This is the same pattern as the existing capture (`captureOn` / `captureWriters`).
- Device reopen: `openDevices` detaches the callback first, then re-prepares the stage at the new
  rate and buffer size before re-attaching.
- Bypass target, reset request and statistics-reset request are atomics written by any thread and
  consumed by the audio thread. Statistics are single-writer (audio thread) relaxed atomics; peak
  values are updated by that single writer, so no compare-exchange loop is needed.
- No new threads. No SPSC queue was added (the stage runs entirely on the audio thread).

## 5. Latency model

`latencySamples = blockSize + kernel latency` (pass-through: kernel latency = configured delay),
`latencyMs = 1000 · latencySamples / sampleRate`. It is fixed by `prepare()`, does not change with
bypass, host block size or reset, and is recomputed by re-prepare (e.g. 300 samples = 6.250 ms at
48 kHz, 6.803 ms at 44.1 kHz).

This is **DSP latency only**. `getRealtimeDsp` also returns `deviceOutputLatencySamples`, which is
what the driver reports (480 on this machine); it is not measured and not added to the DSP figure.
No end-to-end or round-trip latency is claimed. No plugin delay compensation is implemented: with
latency > 0, input heard or recorded through the stage is late by that many samples.

## 6. Bypass behaviour

- Enabled (mix 1) → wet; bypassed (mix 0) → dry; changes ramp linearly over `fadeMs` (default
  10 ms = 480 samples at 48 kHz), one step per sample, identical for all channels.
- The dry path is delayed by the full latency, so dry and wet are time-aligned during the fade
  and the latency stays the same when bypassed (never a zero-latency dry path against a delayed wet).
- The kernel keeps running while bypassed, so re-enabling fades into a current signal.
- After `reset()` the mix jumps to its target (no history to fade from) and the output restarts
  from silence with the same latency.
- Changing enable, latency, block size or fade **rebuilds** the stage (not crossfaded; with
  latency > 0 the monitored input restarts from silence). Rebuilds are refused while recording;
  bypass may change at any time.

## 7. Engine integration and IPC

- Off by default and not saved with the project. When off, the callback only does one counter
  increment/decrement and a null pointer load; the input pointers are untouched, so output is
  unchanged (tested sample-exact through the real callback).
- When on, the stage processes inputs 1–2 (or the test signal) for **record inputs and armed-track
  input monitoring**. Clip playback, buses, effects, master and offline rendering never pass
  through it. The direct "Mic monitor" path still uses the raw device input (unchanged).
- `setRealtimeDsp { enabled?, bypassed?, latencySamples?, blockSize?, fadeMs?, resetStatistics? }`
  and `getRealtimeDsp` return the configuration, prepared rate/block/channels, latency (samples,
  ms), buffer bytes and statistics. No UI controls were added.

## 8. Commands executed and results

Process check before both builds (`Get-CimInstance Win32_Process` for `MusicStudioEngine*` or
Electron with `MusicStudioPro` in its command line) → empty; nothing was closed.

| Command | Result |
| --- | --- |
| `powershell -ExecutionPolicy Bypass -File scripts\build-engine.ps1` (1st) | built, no errors or warnings shown |
| `build\audio_engine_tests.exe realtimedsp` (1st) | 20 PASS, 2 FAIL (test fixture errors, below) |
| `powershell -ExecutionPolicy Bypass -File scripts\build-engine.ps1` (2nd, tests only) | built |
| `build\audio_engine_tests.exe realtimedsp` (2nd) | **22 PASS, 0 FAIL, 0 NOT RUN** |

First-run failures (no product code changed between the runs):
- `rt-bypass-latency-aligned-click-free`: the click bound used the steady curvature of the 0.5×
  processed state; the bypassed state is 1×. The bound now uses the louder steady state
  (fade 0.00260 vs steady 0.00265).
- `rt-wav-continuous-simulation`: a 24-bit WAV read and re-written by `WavIO` is not bit-exact
  (quantisation, unrelated to this phase); the processed samples already matched exactly. The
  harness now uses 32-bit float WAVs.

Tests (all PASS):

| Test | Evidence |
| --- | --- |
| rt-ring-wraparound | 52 495 stereo frames through a 7-frame ring (7 499 wraps) vs a reference queue: 0 order errors |
| rt-ring-overflow-underflow | 10 into 8 stores 8, full ring stores 0, overflow 5 counted; 12 from 8 returns 8 + 4 zeros, underflow 4; silence, discard, clear; invalid sizes rejected |
| rt-passthrough-sample-identical | block sizes 1, 64, 128, 256, 480, 512, 1024, mono and stereo, and in place: bit-identical (memcmp), latency 0 |
| rt-variable-block-sizes | random 1–1024 blocks: exact delayed copy (0 / 293 samples) and bit-equal to 1-frame callbacks, mono and stereo |
| rt-latency-reporting | 7 configurations up to 5 096 samples at 48 and 44.1 kHz: reported = measured impulse delay at 3 block phases |
| rt-oversize-callback | prepared 256, called with 4096/1000/3: exact, 19/19 oversize calls counted, 0 allocations |
| rt-reset-and-reprepare | reset and requestReset: exactly 300 samples of silence then the new input; re-prepare mono 44.1 kHz/128 and stereo 48 kHz/1024 exact; invalid settings rejected; unprepared process leaves output untouched |
| rt-bypass-zero-latency-transparent | 48 toggles: output bit-identical to input |
| rt-bypass-latency-aligned-click-free | 0.5× kernel, 264 samples latency: output = aligned crossfade model (error 0), fade exactly 480 samples, bypassed output = input delayed 264 exactly, latency unchanged, fade curvature 0.00260 ≤ steady 0.00265 (instant switch would jump 0.40; a zero-latency dry path would differ by up to 1.55); reset while bypassed exact |
| rt-fixed-kernel-blocks | adapter: 375 kernel calls of exactly 256 frames from 1–1024 host blocks; direct mode passes host blocks |
| rt-nan-inf-sanitized | 3 non-finite input samples → 0 (counted), rest exact; a NaN/Inf-writing kernel → finite output |
| rt-null-channels | null output channel skipped; null input → silence |
| rt-wav-continuous-simulation | 30 s stereo WAV, 2 993 WASAPI-like callbacks (441–528 frames): output WAV identical; delay 1000 + block 256 exact over ~807 dry-ring wraps; underflow/overflow 0/0 |
| rt-timing-statistics | see section 9; statistics reset request works |
| rt-allocation-free-and-bounds | 560 492 simulated callbacks: 0 heap allocations in `process()`, 0 guard-zone or unwritten-sample errors; counter sanity probe registered |
| ipc-rtdsp-defaults-and-errors | off by default, latency 0; 5 invalid requests rejected |
| ipc-rtdsp-off-output-unchanged | real WASAPI callback, stage off: monitored output = test signal × pan law (diff 1e-7, 24-bit capture) |
| ipc-rtdsp-passthrough-sample-identical | stage on, no latency: max difference from off 0 |
| ipc-rtdsp-latency-in-callback | delay 240 + block 256: reported 496 samples (10.333 ms); output = off output delayed 496, difference 0 |
| ipc-rtdsp-bypass-keeps-alignment | bypassed: latency 496, output identical to the processed run |
| ipc-rtdsp-callback-statistics | 163 callbacks, average 6.3 µs, peak 18.6 µs, load 0.063 % avg / 0.19 % peak, 0 oversize, 0/0 under/overflow |
| ipc-rtdsp-disable-restores-direct-path | off again: identical to the first off run |

The IPC tests used the real device on this machine (WASAPI shared, 48 kHz, 480-sample buffer) with
the deterministic virtual input; the capture is indexed by timeline position, so the comparisons do
not depend on callback timing.

**NOT RUN:**
- full regression and `scripts\run-regression.ps1`;
- all other native groups (`automation`, `master-gain`, `pitch`, `pitchshift`, `pitchmap`,
  `autocorrect`, `vocalquality`) and the full native list;
- TypeScript checks and `npm run build` (no TypeScript files changed);
- all GUI checks (no GUI changes);
- installer/packaging (not built).

Microphone: NOT RUN — NO HARDWARE.

Note: the `automation` group contains the existing recording/monitoring IPC tests
(`ipc-record-*`), which exercise the callback lines next to the new stage. They were not run per
policy; the stage-off path is covered by `ipc-rtdsp-off-output-unchanged`. Running that group
needs your approval.

## 9. Processing timing (Release build, this PC, no audio hardware in the harness)

| Configuration | Calls | Average | Peak | Average load | Peak load | Over budget |
| --- | --- | --- | --- | --- | --- | --- |
| pass-through, 480-frame blocks, 60 s stereo | 6 000 | 1.5 µs | 5.5 µs | 0.015 % | 0.05 % | 0 |
| delay 1000 + block 256, 480-frame blocks, 60 s | 6 000 | 2.1 µs | 7.4 µs | 0.021 % | 0.07 % | 0 |
| pass-through, 64-frame blocks, 10 s | 7 500 | 0.30 µs | 4.0 µs | 0.022 % | 0.30 % | 0 |
| pass-through, 1-frame blocks, 1 s | 48 000 | 0.045 µs | 1.0 µs | 0.22 % | 4.8 % | 0 |
| live callback (IPC run, 480-frame WASAPI blocks) | 163 | 6.3 µs | 18.6 µs | 0.063 % | 0.19 % | 0 |

Load = execution time of `process()` / audio duration of the block. These are DSP execution
times, not device latency; peaks depend on OS scheduling and will vary between runs and machines.
The live figures include cold caches and the timing calls themselves.

## 10. Memory allocation verification

- By design: all buffers are allocated in `prepare()` (`std::vector::assign`); `process()` only
  uses `memcpy`, `std::fill`, arithmetic and relaxed atomics; timing uses `std::chrono::steady_clock`
  (QueryPerformanceCounter, no allocation).
- By test: `tests/AllocationCounter.cpp` replaces every global `operator new`/`delete` variant in
  the test executable and counts the calling thread's allocations; 560 492 simulated callbacks
  across all configurations made **0** allocations, and the counter is proven live by a probe.
- Live stage buffers: 2 × 8192 floats in the engine (constructor) plus the processor's buffers
  (`bufferBytes` in `getRealtimeDsp`).

## 11. Known limitations

- Evidence comes from synthetic signals, one device configuration (WASAPI shared, 48 kHz, 480) and
  one PC. This does not prove real-time safety for every device, driver or system load.
- The allocation counter sees `operator new` on the calling thread only; direct `malloc` or OS
  allocations are excluded by code inspection, not by measurement.
- No plugin delay compensation: with latency > 0, monitored and recorded input through the stage
  is late by the stage latency. Default configuration (when enabled) is 0 latency.
- Reconfiguration (enable, latency, block size, fade) is not crossfaded and is refused while
  recording; only bypass is click-free.
- Callbacks larger than 8192 samples skip the stage (counted as `skippedBlocks`), like recording.
- The direct "Mic monitor" path is not routed through the stage.
- The kernel keeps running while bypassed (CPU is spent for continuity).
- Statistics measure `process()` only, not the whole callback; a statistics reset is applied at the
  next callback.
- No UI; diagnostics are available over IPC only.

## 12. Stop

Phase 2.5.1 is complete. Work stops here pending approval before Phase 2.5.2. ProfilePilot was not
touched.
