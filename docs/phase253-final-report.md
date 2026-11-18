# Phase 2.5.3 — Real-Time Pitch Correction Engine: final report

Status: implemented and verified with targeted tests. Native group `realtimecorrection`:
**36 PASS, 0 FAIL, 1 NOT RUN** (microphone). No Mixer UI in this phase.

Real-time safety is shown by design, code structure and targeted tests on this machine. It is
not claimed for every device or system load. Observed peaks are observations, not hard
real-time guarantees.

## 1. Architecture audit and reuse

| Existing piece | Decision |
| --- | --- |
| `RealtimeProcessor` / `RealtimeKernel` (Phase 2.5.1) | **Reused.** `PitchCorrectionKernel` is the kernel; the processor supplies sanitizing, latency-aligned dry path, click-free bypass and timing stats. |
| `LivePitchAnalyzer` / `NoteTracker` / YIN (`PitchDetector`) | **Reused for streaming analysis.** Windows run every `kLiveCorrectionHop` (128) samples. Not copied into the callback as offline code; `prepare()` allocates, `push()`/`next()` do not. |
| Offline `pitchShift` / phase vocoder (`PitchShift`, `PitchCorrect`) | **Not used in the callback.** Whole-buffer, allocating, unbounded. Unsuitable without a streaming redesign. |
| `AudioRing` | Used only inside `RealtimeProcessor` (dry/wet). The corrector keeps its own power-of-two history ring. |
| `RecordQueue` | Worker/manual analysis input queue (epoch in `stream`, input index in `frame`, stamp). |
| Key / scale (`Scale.h`, `mapPitch` rules) | **Reused** via allocation-free `nearestAllowedNote` + `scaleMask` (same tie-break as offline). |
| Live pitch detector (Phase 2.5.2) | Remains a separate optional tap **before** the live stage. Correction has its own analyzer (in-callback or worker). |
| Mic Monitor (`micL`/`micR`) | **Unchanged.** Still the raw device path; bypasses the live stage. |

Streaming adaptations required: fixed delay for late pitch results, per-sample target lookup by
read position (never “newest result”), delay-line ratio shifter with period splices, packed
atomic parameters, no formant envelope (offline vocoder only).

## 2. Synchronization strategy

Every input sample has an index on the kernel’s monotonic timeline (samples since `prepare()`;
`reset()` starts a new epoch).

Each analysis result is a `PitchStamp` with `windowStart` / `windowEnd` / `centre`, pitch, epoch
and voiced/held/gap flags. Correction at read position `p` uses the two stamps whose centres
lie on either side of `p` (pitch interpolated), never the newest result alone.

Fixed latency after `prepare()`:

| Part | Rule (samples) |
| --- | --- |
| Detection | `windowSize/2 + hop` (window centred one hop after `p` ends this far after `p`) |
| Delivery | `inCallback`: 0; `worker`/`manual`: `maxFrames + workerMarginMs` |
| Shifter | `⌈(0.5 + 0.125)·maxPeriod⌉ + 4` (tap headroom for drift and splices) |
| **Total** | detection + delivery + shifter (= `latencySamples()`) |

Defined behaviours:

- **Late result** — counted; kept for later positions.
- **Missing** — last correction held `kLiveMissingHoldMs` (20 ms), then released over
  `kLiveReleaseMs` (5 ms).
- **Analysis queue overflow** — newest frames dropped; analyzer sees the index gap and restarts.
- **Result ring full** — result dropped; hole counts as missing.
- **Reset** — history cleared, epoch++, older results stale; output restarts from silence with
  the same latency.

Sync was validated with dedicated tests (`rtc-sync-*`) before treating correction as proven.
Worker delivery lag under paced callbacks stayed within the allowance (e.g. at 48 kHz / 512:
max lag 448 samples vs allowance 800).

## 3. Algorithm (streaming correction)

- Mono or stereo history; analysis input `input1` / `input2` / `mix`.
- Target = nearest scale note to the interpolated pitch, with 0.15 st hysteresis.
- Wanted cents clamped to ±200, one-pole smoothed with τ = max(retuneMs/3, 1 ms), scaled by
  smoothed strength. Retune 0 ms still uses the 1 ms floor; detection is not instantaneous.
- Delay-line shifter: tap advances `ratio = 2^(cents/1200)` per output sample (**linear**
  interpolation). Period splices with a raised-cosine crossfade (fade length 2× jump) when the
  tap leaves `L ± jump/2`. Strength 0 keeps ratio 1 and recentres to exact delay `L`
  (bit-identical dry).
- **Formants:** move with pitch. Live formant preservation is **not** implemented.
  `formantPreservation` is always `false`; no misleading Preserve Formants control.

## 4. Files changed

| File | Role |
| --- | --- |
| `native/audio-engine/include/msp/LiveCorrection.h` | Kernel API, latency model, stats, sync contracts |
| `native/audio-engine/src/LiveCorrection.cpp` | Analysis, sync lookup, shifter, worker |
| `native/audio-engine/include/msp/Engine.h` | Live DSP config gains correction fields; `liveCorrection` |
| `native/audio-engine/src/Engine.cpp` | `configureLiveDsp` kernel choice; `getLiveCorrection` / `setLiveCorrection`; routing notes |
| `native/audio-engine/CMakeLists.txt` | `LiveCorrection.cpp` |
| `native/audio-engine/tests/test_main.cpp` | Group `realtimecorrection` |
| `packages/shared/src/protocol.ts` | `LiveCorrectionStatus` and related types (no UI) |
| `docs/phase253-final-report.md` | This report |

No Mixer UI, no ProfilePilot changes, no installers.

## 5. Thread ownership

| Thread | Work |
| --- | --- |
| Control | `prepare()` / destroy (starts/stops worker); IPC; `setParams` via packed atomic |
| Audio | `process()` / `reset()`: store history, analyse (in-callback) or push queue + drain result ring, correct, splice. No alloc, lock, wait, log, I/O |
| Worker (optional) | Drain analysis queue, post results; 1 ms poll when idle |

## 6. Latency breakdown (measured, DSP only)

Device output latency is reported separately (480 samples on this machine) and is **not** part
of DSP latency.

**In-callback (default), 48 kHz, maxBlock 480:**

| Part | Samples | ms |
| --- | --- | --- |
| Detection (window/2 + hop) | 736 | 15.33 |
| Delivery | 0 | 0 |
| Shifter | 379 | 7.90 |
| Buffering (`RealtimeProcessor` blockSize) | 0 | 0 |
| **Total** | **1115** | **23.23** |

At 44.1 kHz the same formula gives **1053 samples (23.88 ms)**.

**Worker analysis** adds `maxFrames + ~6 ms` delivery (e.g. 1883 samples / 39.23 ms at 48 kHz /
480). Stage off: **0** added latency.

## 7. CPU and memory (observed on this machine)

`rtc-rt-performance`: stereo, in-callback, 10 s each; assert mean &lt; 25% and p99.9 &lt; 50% of
block time. Peaks are observations only.

| Rate / block | Mean | p99.9 | Observed peak | Load (mean) | Latency |
| --- | --- | --- | --- | --- | --- |
| 44.1 / 128 | 100 µs | 140 µs | 146 µs | 3.5% | 1053 |
| 44.1 / 256 | 201 µs | 328 µs | 328 µs | 3.5% | 1053 |
| 44.1 / 480 | 376 µs | 524 µs | 524 µs | 3.5% | 1053 |
| 44.1 / 512 | 403 µs | 525 µs | 525 µs | 3.5% | 1053 |
| 48 / 128 | 101 µs | 165 µs | 178 µs | 3.8% | 1115 |
| 48 / 256 | 202 µs | 311 µs | 420 µs | 3.8% | 1115 |
| 48 / 480 | 378 µs | 486 µs | 486 µs | 3.8% | 1115 |
| 48 / 512 | 406 µs | 706 µs | 706 µs | 3.8% | 1115 |

Memory after `prepare()` (stereo, maxBlock 512): ~183 KiB in-callback; ~1.2 MiB with worker
queue. Unchanged after processing; **0** heap allocations in 197 644 `process()` calls.

Worker backlog/drops: under normal paced load, analysis drops 0 and late results 0 within the
delivery allowance. Stalled worker: audio continues; analysis frames are dropped instead of
blocking.

## 8. Pitch accuracy (synthetic)

- Sustained 452 Hz → A4 within ~0.01 c (rms spread ~0.01 c) at 44.1 and 48 kHz, mono and stereo.
- Strength 50% → half the pull (23.29 c remaining of 46.58 c).
- Strength 0% → bit-identical to input delayed by `latencySamples`.
- Note steps 69.3 → 71.4 → 66.7 in C major settle on A4 / B4 / G4.
- Vibrato ±40 c at 5.5 Hz: retune 0 ms keeps ~21%; retune 200 ms keeps ~98%.
- IPC live: 452 Hz virtual input corrected take and monitored track output at 0.00 c from A4.

## 9. Monitoring and recording

| Path | Behaviour |
| --- | --- |
| Track input monitoring (armed + monitor) | **Corrected**, late by `latencySamples` |
| Recording of armed tracks | **Corrected**, same delay (no PDC) |
| Mic Monitor | **Raw** device input (unchanged); not corrected |
| Clip playback / offline export | **Unaffected** (bit-identical on vs off) |
| Stage off | Identical to pre-Phase-2.5.3 live path |

Enabling/disabling correction or changing analysis while recording is **rejected** with a clear
error. Key, scale, retune, strength and bypass may change while recording. Pass-through
`setRealtimeDsp` and correction are mutually exclusive on the live stage.

If Mic Monitor and corrected track monitoring are both on, `getLiveCorrection` may warn that
raw and corrected voices are heard together.

## 10. Native IPC

- `getLiveCorrection` — enabled, bypass, analysis, input, root/scale, retuneMs, strength (%),
  formant note (`false`), routing, latency breakdown, statistics, current pitch/target/cents,
  device output latency (separate).
- `setLiveCorrection` — `enabled`, `bypassed`, `root`, `scale`, `retuneMs` (0–200), `strength`
  (0–100), `analysis` (`inCallback`|`worker`), `input`, `workerMarginMs`, `resetStatistics`.

Shared TypeScript types were added in `packages/shared/src/protocol.ts`. No correction UI.

## 11. Test commands and results

Before each native build: process check for `MusicStudioEngine*` / Electron+MusicStudioPro —
nothing running; nothing force-closed.

| Command | Result |
| --- | --- |
| `scripts\build-engine.ps1` (several iterations during fixes) | exit 0 |
| `build\audio_engine_tests.exe realtimecorrection` (final) | **36 PASS, 0 FAIL, 1 NOT RUN**, exit 0 |

### Final native results (`realtimecorrection`)

**Synchronization:** sample association; audio association at a known step; delivery independence
across block sizes; late / missing / worker backlog / queue overflow; discontinuity reset;
reprepare; worker lag measured within allowance.

**Audio:** mono/stereo @ 44.1 & 48 kHz; variable blocks; sustained note; note transitions;
vibrato; silence/unvoiced; strength 0/50/100; retune 0/20/100/200 ms; key/scale; bypass;
invalid input; duration/alignment.

**Real-time:** concurrent params; nonblocking with stalled worker; bounded memory; performance
matrix; no overrun (paced); allocation-free (0 alloc / 0 guard errors).

**Integration (IPC):** defaults/errors; stage exclusive with pass-through; stage off unchanged;
strength 0 dry alignment; recording+monitoring corrected; while-recording rules; latency report;
playback/export unaffected.

**NOT RUN:** `ipc-rtc-mic-monitor` — NO HARDWARE (Mic Monitor stays raw by design).

**Not run (policy):** full regression, `scripts\run-regression.ps1`, other native groups
(`realtimedsp`, `realtimepitch`, `recordqueue`, …), GUI checks, installers.
Microphone: **NOT RUN — NO HARDWARE**.

## 12. Known limitations and remaining risks

- No live formant preservation; formants follow the pitch ratio.
- No plugin delay compensation; monitoring/recording through the stage are late by DSP latency.
- Mic Monitor is not corrected; users must use track input monitoring to hear correction.
- In-callback analysis uses CPU on the audio thread (~3–4% mean here); large host blocks +
  worst-case analysis are still bounded but load is machine-dependent.
- Worker mode needs the delivery margin; under extreme scheduling delay, results can be late
  and correction holds/releases as specified.
- Linear delay-line interpolation (chosen over Catmull-Rom to avoid overshoot at abrupt
  frequency steps); fine for sub-semitone ratios, not a substitute for offline High quality.
- Phase 2.5.4 Mixer UI not implemented.

## 13. Acceptance checklist

| Criterion | Status |
| --- | --- |
| Timestamp synchronization verified | PASS (`rtc-sync-*`) |
| Correction follows musical targets | PASS |
| Continuous pitch correction | PASS |
| Callback allocation-free / nonblocking | PASS |
| Latency measured and reported | PASS |
| Bypass smooth and time-aligned | PASS |
| Strength 0% = aligned dry | PASS |
| Stage OFF preserves behaviour | PASS |
| Targeted tests pass | **36 PASS / 0 FAIL / 1 NOT RUN** |

Phase 2.5.3 is complete. Stopped for approval before Phase 2.5.4.
