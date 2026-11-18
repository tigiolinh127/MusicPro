# Phase 2.5.5 — Real-Time Auto-Tune Optimization & Stability: final report

Status: measured, validated, and stable. **No product-code changes** — baselines from
Phases 2.5.3/2.5.4 already met acceptance criteria; no measured defect justified an
optimization. STOP — awaiting approval before any later phase.

## 1. Baseline audit

| Area | Finding |
| --- | --- |
| `RealtimeProcessor` / `PitchCorrectionKernel` | Allocation-free `process()`, noexcept, no mutex; Phase 2.5.3 RT matrix already covered stereo @ 44.1/48 × 128–512 |
| Live pitch worker | Separate tap; not on Auto-Tune hot path |
| RAW/CORRECTED monitoring | Phase 2.5.4 delay ring + crossfade on audio thread; recording stays corrected |
| Known limitations (2.5.3/2.5.4) | No formant preservation; no PDC; end-to-end latency Unavailable; Mic monitor raw; machine-dependent peaks |
| Risks checked | Callback alloc/lock/IO; monitor crossfade clicks; worker overflow recovery; 10‑min memory growth |

**Decision:** Reuse existing measurements where sufficient; add dedicated group `realtimestability`
for long-run, mono×stereo matrix with p95/p99, vowel-like quality, monitor stress, and IPC
recording integrity. Optimize only if a measured problem appears → **none did**.

## 2. Performance (measured, simulated callbacks)

In-callback analysis, 8 s simulated vowel-like melody per cell. Asserted: mean &lt; 25% of
block budget, p99.9 &lt; 50%, 0 over-budget. **Peaks are observations, not guarantees.**

| Rate | Ch | Block | Mean (µs) | % budget | p95 | p99 | p99.9 | Peak (µs) | Latency |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 44.1 | mono | 128 | 99.5 | 3.43% | 126.6 | 195.4 | 249.0 | 257.9 | 1053 (23.88 ms) |
| 44.1 | mono | 256 | 195.3 | 3.36% | 248.8 | 289.3 | 330.7 | 331.2 | 1053 |
| 44.1 | mono | 480 | 370.6 | 3.40% | 505.4 | 615.8 | 677.5 | 677.5 | 1053 |
| 44.1 | mono | 512 | 391.0 | 3.37% | 494.7 | 579.2 | 657.0 | 657.0 | 1053 |
| 44.1 | stereo | 128 | 113.9 | 3.92% | 120.1 | 139.3 | 174.1 | 199.7 | 1053 |
| 44.1 | stereo | 256 | 228.8 | 3.94% | 247.4 | 282.2 | 323.3 | 335.0 | 1053 |
| 44.1 | stereo | 480 | 430.5 | 3.95% | 479.8 | 579.2 | 708.7 | 708.7 | 1053 |
| 44.1 | stereo | 512 | 469.1 | 4.04% | 578.7 | 718.9 | 726.7 | 726.7 | 1053 |
| 48.0 | mono | 128 | 99.0 | 3.71% | 122.5 | 174.6 | 217.6 | 1064.3* | 1115 (23.23 ms) |
| 48.0 | mono | 256 | 199.9 | 3.75% | 268.8 | 352.8 | 447.9 | 1150.4* | 1115 |
| 48.0 | mono | 480 | 371.1 | 3.71% | 500.6 | 623.3 | 715.1 | 715.1 | 1115 |
| 48.0 | mono | 512 | 392.7 | 3.68% | 491.8 | 587.2 | 718.4 | 718.4 | 1115 |
| 48.0 | stereo | 128 | 115.6 | 4.33% | 121.1 | 141.3 | 179.5 | 209.3 | 1115 |
| 48.0 | stereo | 256 | 230.0 | 4.31% | 240.7 | 265.7 | 298.0 | 326.9 | 1115 |
| 48.0 | stereo | 480 | 431.4 | 4.31% | 474.4 | 501.0 | 672.8 | 672.8 | 1115 |
| 48.0 | stereo | 512 | 459.9 | 4.31% | 485.3 | 513.1 | 663.9 | 663.9 | 1115 |

\*Occasional peak spikes under OS load; mean/p99.9 still within bounds; 0 over-budget callbacks.

Kernel memory ≈ 173–184 KiB (in-callback stereo); worker ≈ 1.2 MiB.

## 3. Long-running stability (simulated)

| Item | Result |
| --- | --- |
| Duration | **600.0 s** of stereo Auto-Tune @ 48 kHz / 256 (112 500 callbacks) |
| Wall time | ≈ 27.7 s (unpaced simulation) |
| Mean load | 223 µs (4.19% of budget) |
| Observed peak | 617 µs (observation) |
| Over-budget | 0 (0.000%) |
| NaN/Inf | 0 |
| Heap alloc in `process()` | 0 |
| Memory | 199.4 KiB unchanged |
| Recoveries | 0 |
| Unexpected silence (excl. event windows) | 292 / 100 195 blocks (0.291% &lt; 1% bound) |
| Events | Param churn, bypass on/off, reset |

**Kind:** simulated synthetic input — **not** microphone hardware.

## 4. Callback safety

| Check | Result |
| --- | --- |
| Zero heap alloc in `process()` | PASS (guarded simulate + monitor delay/crossfade mirror) |
| Noexcept API | PASS (`process` / `reset` / `setParams` / `statistics`) |
| No mutex / file I/O / logging / IPC / FFT plan in callback | PASS (code audit; unchanged modules) |
| Monitoring path alloc-free | PASS |

## 5. Pitch quality (synthetic vowel-like harmonics)

Not a professional vocal-quality or listening claim.

| Scenario | Result |
| --- | --- |
| Sustained 452 Hz → A4 | −0.00 ¢ (spread 0.01); 2nd-diff out ≤ in |
| Fast note settle → G4 | 0.01 ¢ |
| Chromatic glide hold/end | hold @70 within 8 ¢; end err 0.00 ¢ |
| Vibrato | retune 200 preserves more depth (26.62) than retune 0 (5.75) |
| Silence | exact zeros |
| Low (~90 Hz) / high (A5) | −0.00 / 0.00 ¢ |
| Stereo L/R ratio | exact |

## 6. Monitoring & recording

| Check | Result |
| --- | --- |
| RAW delay = input + L | 0 mismatches |
| Crossfade step | ≤ 1/fade; 2nd-diff at switch ≈ steady |
| No ~2× peak stack | peaks 0.256 / 0.256 / 0.256 |
| 40× monitorMode switches while recording | takes stay corrected (−0.00 ¢); 0 refused |
| Recording vs monitor mode | takes corrected in both modes; monitor corrected −0.00 vs raw-aligned +46.58 ¢ |
| End-to-end latency | still **Unavailable** (not fabricated) |

## 7. Latency verification

| Rate | DSP latency | After reprepare restore | Strength 0 dry align |
| --- | --- | --- | --- |
| 44.1 kHz | 1053 smp (23.88 ms) | restored | 0 mismatches |
| 48.0 kHz | 1115 smp (23.23 ms) | restored | 0 mismatches |

No global delay compensation added.

## 8. Worker backlog / overflow

Continuous stream: 300 ms pause (queue holds) then 2 s pause (drops). Paced 2 s recover after.

- Drops 133 120, late 126, max delivery lag 164 032 samples  
- Post-backlog and paced recover both −0.00 ¢ from A4  
- Recover over-budget 0/375; memory unchanged; recoveries 0  

## 9. Product-code changes

**None.** Baseline already met criteria; no optimization performed.

Test-only additions:

| File | Change |
| --- | --- |
| `native/audio-engine/tests/test_main.cpp` | Group `realtimestability`; `RtcTiming` gains p95/p99; vowel helper; IPC stability |

## 10. Exact commands and results

```
scripts\build-engine.ps1
build\audio_engine_tests.exe realtimestability
```

| Command | Result |
| --- | --- |
| `scripts\build-engine.ps1` | exit 0 |
| `build\audio_engine_tests.exe realtimestability` (final) | **10 PASS, 0 FAIL, 0 NOT RUN**, exit 0 |

### Final native results (`realtimestability`)

| Test | Result |
| --- | --- |
| `rts-callback-safety` | PASS |
| `rts-performance-matrix` | PASS |
| `rts-worker-backlog-recovery` | PASS |
| `rts-latency-stable` | PASS |
| `rts-pitch-quality-vowel` | PASS |
| `rts-monitor-alignment` | PASS |
| `rts-long-running-10min` | PASS |
| `rts-memory-stable` | PASS |
| `rts-monitor-ipc-switching` | PASS |
| `rts-recording-integrity` | PASS |

### Not run

- Full regression / `scripts\run-regression.ps1`
- Unrelated native groups (`realtimecorrection`, …)
- TypeScript / GUI checks (no TS/UI product changes)
- Installer / packaging
- Microphone: **NOT RUN — NO HARDWARE**

## 11. Remaining limitations

- Finite measurements ≠ worst-case RT guarantees (OS scheduling can spike peaks).
- No live formant preservation; no PDC; end-to-end monitoring latency Unavailable.
- Pitch quality is synthetic only — not a listening / pro-vocal claim.
- Unexpected silence bound allows &lt; 1% around scripted bypass/reset/param windows.
- Mic monitor still raw and undelayed.

## 12. Stop

Phase 2.5.5 complete. Waiting for approval before continuing.
