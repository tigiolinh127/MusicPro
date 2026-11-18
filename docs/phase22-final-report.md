# Phase 2.2 final report: realtime audio effects

Status: **PASS**, with the items listed under "Not run" below.

Date: 2026-11-06. Every result below comes from a command that was actually executed on the final build (`build\phase22-final`). Microphone tests are **NOT RUN — NO HARDWARE**. No installer was created. Nothing from Phase 2.3, Auto-Tune, AI, VST3, karaoke or livestreaming was started. The desktop mouse and keyboard were not used. All GUI checks drive the app window with Chromium input events injected into the page (`webContents.sendInputEvent`).

## Status by requirement

| Requirement | Status |
|---|---|
| A. Parametric EQ: 4 bands, frequency / gain / Q / type, low shelf, bell, high shelf, JUCE DSP | PASS |
| B. Compressor: threshold, ratio, attack, release, makeup, bypass, gain-reduction meter | PASS |
| C. Noise gate: threshold, attack, hold, release, range, hysteresis near the threshold | PASS |
| D. Reverb: room size, damping, wet/dry, bypass | PASS |
| E. Delay: time, feedback (limited to 0.95), wet/dry, buffers prepared in advance | PASS |
| F. Chains: add, remove, enable/bypass, reorder; track, group-bus, return-bus and master inserts; aux effects through existing sends | PASS |
| Realtime safety: no allocation, I/O, IPC or locks in the callback; smoothing; click-free changes; sample-rate changes; safe lifetimes | PASS (see "Realtime design") |
| Deterministic offline rendering; playback equals export | PASS (bit-identical) |
| Persistence: order, parameters, bypass; reopen restores; older projects load | PASS |
| Mixer effect rack UI, dark theme, no clipped controls at 1280x820 and 960x700 | PASS (injected Chromium input) |
| Phase 0, 1 and 2.1 regression; TypeScript; Vite build; native C++ tests | PASS |
| Listening by ear | NOT RUN |
| Real OS-mouse use of the rack | NOT RUN |
| Microphone | NOT RUN — NO HARDWARE |

## Audit and baseline (before any Phase 2.2 change)

- I read `docs/phase21-final-report.md` and the Phase 2.1 code: `buildMixPlan`, `mixRoute`, the snapshot publish/reclaim path in `Engine.cpp`, `Session`, the project schema and the GUI harnesses. The implementation matched the report.
- `scripts/run-regression.ps1` was added so every phase runs the same steps and keeps one log per step. The baseline run (`build\phase22-baseline`) passed the native build, native tests (239 pass, 0 fail, 7 not run), Phase 0 script, both TypeScript checks, Vite build, smoke, workflow-reload, mixer-build and mixer-reload.
- Three GUI checks failed in that first run: two "track area scrolls horizontally" layout checks and one mouse-wheel distance check. During that run an earlier Music Studio Pro test window (engine PID 5412) was still open, and the logs show Chromium cache-lock errors from the second instance. By the time I checked, that window had closed. I did not close it. Re-running only those two steps on the same unchanged binaries (`build\phase22-baseline-rerun`) passed both (exit 0). The final regression below also passes them.
- ProfilePilot was not touched.

## DSP architecture

Effects are native C++ in `native/audio-engine/src/Effects.cpp`. The renderer only sends parameter values. Every processor implements:

```
class EffectDsp {
  reset(params)                        // clear history, jump smoothing to params (realtime-safe)
  process(params, left, right, n)      // in place, per-sample state; returns gain reduction in dB
}
createEffectDsp(type, sampleRate, params)   // control thread: all allocation happens here
```

| Effect | Implementation |
|---|---|
| EQ | 4 biquads, coefficients from `juce::dsp::IIR::ArrayCoefficients<double>` (`makeLowShelf`, `makePeakFilter`, `makeHighShelf`), normalised by a0 and run as transposed direct form II in double precision. A 0 dB band is skipped, so a flat EQ is bit-exact. Frequency, gain and Q glide (log domain for frequency and Q) and coefficients are recomputed every 32 samples. Output gain ramps. Defaults: low shelf 100 Hz, bell 400 Hz, bell 2 kHz, high shelf 8 kHz. |
| Compressor | Feed-forward, stereo-linked peak detector, hard knee in dB. Gain reduction is smoothed by one-pole attack and release filters, and makeup gain glides. Reports the largest gain reduction per block. |
| Noise gate | Peak detector with a 25 ms decay. Opens at the threshold and closes only after the detector falls 6 dB below it (hysteresis) and the hold time has passed. Linear attack and release ramps down to a range floor. Raising the range while closed ramps rather than jumps. |
| Reverb | `juce::Reverb` (Freeverb). Comb buffers are sized in `setSampleRate()` on the control thread. Wet/dry maps to dry = 1 − mix and wet = mix, so mix 0 is exactly dry. |
| Delay | Stereo buffer for 2 s, allocated when the processor is created. Linear interpolation. A time change crossfades from the old read position to the new one over 20 ms, with no click and no pitch bend. Feedback is limited to 0.95; mix and feedback ramp. |

### Chain placement (`mixRoute`)

```
track source -> [track inserts] -> fader/pan/sends -> group buses or master
                                     sends -> return buses
bus sum      -> [bus inserts]   -> bus gain -> next bus or master
master sum   -> [master inserts] -> mic monitor (unchanged) -> master gain -> output
```

- Track inserts are pre-fader, so sends carry the processed signal. Each 512-sample chunk is copied into a prepared insert buffer, including silence after the clip, so reverb and delay tails keep sounding until the timeline ends.
- Aux effects use the Phase 2.1 send/return routing: put a reverb on a return bus and send tracks to it.
- At most 8 effects per chain (`kMaxEffectsPerChain`). The engine rejects a ninth.

### Realtime design

- **Where things live:** effect parameters are part of the immutable `MixPlan` (`MixEffect { type, key, enabled, params }`). The processors live in `MixState`, created by `prepareMixState` on the control thread when a snapshot is built.
- **Snapshot change:** when the audio thread picks up a new snapshot, `inheritMixState` swaps the running processors from the old state into the new one, by `std::unique_ptr` swap with no allocation. A processor is kept when its key ("fx:" + id + type) and sample rate match, so delay lines, reverb tails and filter state continue. The fresh processors that were swapped out are freed later with the old snapshot, on the control thread, after the audio thread has acknowledged the newer one. The existing `audioSeq` release/acquire rule covers this.
- **Bypass and enable:** these crossfade between dry and processed audio over 10 ms per sample (`effectMix`). A fully bypassed effect is skipped. Re-enabling clears its history first, so no stale tail returns.
- **Add, remove, move:** an effect added during playback starts dry and fades in. Remove and move during playback first publish the effect as bypassed, wait for the audio thread to finish the fade (`Engine::settleAudio`: wait for the acknowledgement, then 12 ms plus two buffers), and only then change the chain.
- **Parameter changes** are smoothed inside each processor, as listed in the table above.
- **Transport stop** clears every effect once, so the next Play starts clean (`stop-clears-effect-tails`).
- **Sample-rate change:** processors are prepared at the new rate and are not reused across rates. **Buffer-size change:** no effect state depends on the device buffer size, and processing is per sample.
- **Determinism:** offline renders (export, `renderPlayback`) build a fresh state, and all processing is per sample. The output is bit-identical for any block size (`effects-render-deterministic-any-block-size` checks 480, 1024, 37 and a repeat), and realtime playback equals export bit for bit.
- `juce::ScopedNoDenormals` is set inside `mixRoute`, so offline renders use the same floating-point mode as the callback.

## Project persistence

- Project schema **v4**: `effects: [{ id, type, enabled, params: { name: value } }]` on every track and bus, and a top-level `masterEffects` list.
- v1–v3 projects load with empty chains and no warnings.
- Damaged effect data is repaired with a warning, and clips and routing are never dropped. The repairs: unknown types and non-object entries are removed, chains longer than 8 are trimmed, out-of-range values are limited, non-numeric values return to their default, a non-boolean `enabled` is treated as on, and duplicate or overlong ids get new ids.
- New effect ids after loading never collide with loaded ones (`ipc-new-effect-id-after-load-is-unique`).

## IPC

| Op | Payload | Result |
|---|---|---|
| `addEffect` | `target: "track" \| "bus" \| "master"`, `ownerId` (track or bus), `type: eq \| compressor \| gate \| reverb \| delay`, optional `index` | state + `createdEffectId` |
| `setEffect` | `effectId`, optional `enabled`, optional `params: { name: number }` | state |
| `moveEffect` | `effectId`, `index` | state |
| `removeEffect` | `effectId` | state |

- The engine validates everything: unknown target, owner, type, effect id or parameter name; non-numeric values; values outside the range (for example feedback 1.5); non-integer EQ band types; and an out-of-range index. A rejected request changes nothing (`ipc-effect-validation`).
- `getState` returns `effects` on tracks and buses, plus `masterEffects`.
- The `meter` event and `renderPlayback` include `effects: [{ id, reduction }]`.

## UI

- Each track, group, return and master strip gets an **FX** button in its existing button row, showing the effect count (for example "FX 2"). Clicking it selects the strip, which gets an amber outline.
- The effect rack (292 px) sits to the right of the master strip. Its header shows the strip name and an "+ Add effect" list.
- Each effect is a card with:
  - an On/Off (bypass) button, ↑/↓ reorder buttons and a ✕ remove button;
  - a slider and value readout per parameter (logarithmic for frequency, Q, ratio and times; double-click resets to the default);
  - a band-type selector for each EQ band;
  - a live gain-reduction bar and dB readout for the compressor and gate.
- Long chains scroll inside the rack.
- The editor and the strips themselves were not redesigned. The dark theme and amber accent are unchanged. The header now reads "Phase 2.2".

Screenshots from the final run are in `build\phase22-final\fx\`: `build-fx-track-rack.png`, `build-fx-rack-min-window.png`, `build-fx-group-rack.png`, `build-fx-master-rack.png`, `build-fx-gain-reduction.png` and `reload-fx-reloaded.png`.

## Build and test results (final run: `build\phase22-final`)

Command: `$env:MSP_RUN_FX='1'; powershell -ExecutionPolicy Bypass -File scripts\run-regression.ps1 -OutDir build\phase22-final`

| Step | Result |
|---|---|
| native-build (CMake + Ninja, VS 2026 Build Tools, JUCE 8.0.17 incl. `juce_dsp`) | exit 0 |
| native-tests (`audio_engine_tests.exe`) | exit 0 — **308 pass, 0 fail, 7 not run** |
| phase0-script (`verify-phase0-fixtures.py`) | exit 0 — `BASELINE_EXPORT_OK`, `BASELINE_PROJECT_OK version=4` |
| tsc-renderer, tsc-electron | exit 0 |
| desktop-build (Vite) | exit 0 |
| smoke | exit 0 |
| layout-check (Phase 1) | exit 0 — 33 pass |
| workflow-edit / workflow-reload (Phase 1) | exit 0 — 31 / 5 pass |
| mixer-build / mixer-reload (Phase 2.1) | exit 0 — 28 / 5 pass |
| fx-build / fx-reload (Phase 2.2) | exit 0 — 26 / 5 pass |

The 7 native tests not run are the same as in earlier phases: `mic-monitor-switch` (no input device is enumerated) and six manual items (listening by ear, microphone with headphones, physical device switching, 30-minute soak, CPU/glitch listening, round-trip latency).

### New native tests (70, all PASS)

Every test uses generated fixtures (sines, DC, impulses) and numeric limits.

- **EQ:**
  - `eq-response-matches-model-{bell,narrow-cut,low-shelf,high-shelf}`: the sine gain measured with a Goertzel filter at 50 Hz to 12 kHz is within 0.02 dB of the analytic biquad response.
  - `eq-bell-centre-gain-and-q`: +6.00 dB at the centre, and Q widens or narrows the bell.
  - `eq-shelf-plateaus`, `eq-four-bands-combine`, `eq-flat-is-bit-exact`, `eq-output-gain`.
  - `eq-parameter-change-smoothed`: a 0 → +12 dB jump while a tone plays never steps faster than the tone's own slope.
- **Compressor:**
  - `compressor-threshold-ratio-static-curve`: −6 dBFS input at −18 dB / 4:1 gives −15.0 dB out, within 0.01 dB. The test also covers 20:1, 1:1 and −30 dB / 2:1.
  - `compressor-makeup-gain`, `compressor-below-threshold-untouched` (bit-exact), `compressor-stereo-linked`.
  - `compressor-attack-release-times`: 63.2 % of the reduction after the attack time and 36.8 % after the release time, each within 1 %.
  - `compressor-gain-reduction-reported`.
- **Gate:**
  - `gate-open-hold-close`, `gate-attack-ramp`.
  - `gate-close-timing`: closes after detector decay + 20 ms hold + 10 ms release, within 2 ms.
  - `gate-hysteresis-no-chatter`: a signal alternating between −38 and −44 dB around a −40 dB threshold opens once and never closes.
  - `gate-below-threshold-stays-closed`, `gate-range-floor`, `gate-range-change-ramps`.
- **Reverb:**
  - `reverb-impulse-response-decays`: a delayed onset (more than 500 samples), then RMS early > mid > late > 0, finite and below 1.
  - `reverb-room-size-lengthens-tail`: more than 4x the tail energy at room size 0.9 than at 0.2.
  - `reverb-damping-darkens-tail`, `reverb-mix-zero-is-dry` (bit-exact), `reverb-deterministic`, `reverb-block-size-independent`.
- **Delay:**
  - `delay-timing-and-feedback`: echoes of exactly 1, 0.5, 0.25, 0.125 at multiples of 480 samples, with nothing in between.
  - `delay-wet-dry-mix`, `delay-time-follows-sample-rate`, `delay-max-time-echo` (2 s).
  - `delay-feedback-limited`: feedback 5.0 is clamped to 0.95 and decays.
  - `delay-time-change-crossfades`.
- **Chains and realtime:**
  - `effect-params-sanitized`.
  - `chain-order-changes-result`: EQ before the compressor gives a different value from the compressor before the EQ, and both match their models.
  - `chain-bypass-all-is-dry`, `chain-limits-and-validation`, `chain-remove-effect`.
  - `bypass-is-bit-exact-dry`.
  - `bypass-crossfades-without-click`: the largest sample step is no more than (wet − dry) × ramp step.
  - `enable-crossfades-without-click`, `add-effect-fades-in`, `remove-effect-without-click`.
  - `plan-swap-keeps-effect-state`: a delay echo scheduled before a snapshot swap arrives, bit-identical to an unswapped render.
  - `sample-rate-change-reprepares-effects`, `stop-clears-effect-tails`, `effects-render-deterministic-any-block-size`.
  - `effects-on-track-group-return-master`, `return-bus-effect-via-send`, `export-applies-effects`.
  - `effects-mix-realtime-16-tracks-54-effects`: 16 tracks × (EQ + compressor + gate), 4 groups with reverb, master EQ + delay. 0.24 s of CPU for 4 s of audio, **5.9 % of one core**.
- **Persistence:** `effects-project-roundtrip`, `effects-v3-project-loads-without-effects`, `effects-damaged-project-repaired`. The existing tests were updated to expect the current version: `ipc-save-current-version` and `migrated-project-saves-as-current-version`.
- **Engine process (IPC):**
  - `ipc-add-effects-state`, `ipc-effect-validation`, `ipc-effects-playback-value`, `ipc-move-effect`.
  - `ipc-effects-playback-equals-export`: bit-identical.
  - `ipc-compressor-reduction-meter`: an offline render reports the modelled reduction within 0.05 dB.
  - `live-compressor-reduction-meter`: real output device, live `meter` event within 0.1 dB of the model.
  - `live-remove-effect-while-playing`, `ipc-save-effects-v4`, `ipc-render-before-reload`, `ipc-load-restores-effects`, `ipc-reload-effects-render-identically`, `ipc-new-effect-id-after-load-is-unique`.

## Audio output verification

Each GUI step below was done through the app window. The exported WAV is then compared with an independent steady-state model in `fxCheck.ts`, written from the documented behaviour of each effect for constant (DC) inputs; reverb is only modelled for silent input. The playback render (`renderPlayback`, the same mix path as the audio callback) is compared with the export, and every comparison was **0.00e+0** (bit-identical).

| GUI scenario (fx-build) | Export at 3.0 s | Model |
|---|---|---|
| Track 1 (DC 0.4): EQ low shelf +6.2 dB, then compressor at −29.5 dB, 4:1 | 0.19405 | 0.19405 |
| Compressor bypassed with its On/Off button | 0.71891 | 0.71891 |
| EQ removed with ✕, compressor back on | 0.18545 | 0.18545 |
| Track 2 → Group 1 with a gate whose threshold is above the signal (closes to −80 dB) | 0.04404 | 0.04404 |
| Impulse track → Return 1 (send at 0 dB) with a 100 % wet reverb | 0.04404 | 0.04404 |
| Master delay, 494 ms, mix 0.5, feedback 0 | 0.04404 | 0.04404 |

- **Reverb:** the difference between the exports with the reverb on and bypassed is exactly 0 before the impulse. The tail RMS 50–500 ms after the impulse is 1.44e-3.
- **Master delay:** across the whole file, the export with the delay on matches (1 − m)·y(t) + m·y(t − 23712 samples) within **5.96e-8**, where y is the export with the delay bypassed and m is the mix. So the echo lands on the exact sample for the set time.
- **Live playback on the real output device:** the compressor's gain-reduction display read "−16.2 dB". The native meter reported 16.16 dB against a model value of 16.16 dB. The display returned to "0.0 dB" after Stop.
- **Save and reload (fx-reload):** the project was saved as v4. The chains, order, parameters and bypass states were restored identically. The rack showed the restored values, and the export after reopening equals the export before closing (worst difference 0.00e+0).

## GUI verification

Performed in the real Electron window with injected Chromium mouse and keyboard events. Neither the OS mouse nor the keyboard was used.

- **Rack and selection:** the rack is visible beside the master strip and shows the Master chain by default. The FX buttons select a track, group, return or master and highlight the strip.
- **Effect controls:**
  - Add effect works by typing a letter in the Add effect list.
  - Dragging the EQ gain, compressor threshold, gate threshold, reverb wet/dry and delay time/feedback/mix sliders works; each engine value agrees with the readout.
  - ↑/↓ reorder, the On/Off bypass and ✕ remove all work.
- **Layout:**
  - At 1280x820, no control in the rack or the strips is clipped or smaller than 8 px, and no value readout is truncated.
  - At the 960x700 minimum window size, the rack and strips have no clipped controls, the effect list scrolls inside the rack, and the last control can be reached.
- **Not run:** listening to the effects by ear, and operating the rack with the real OS mouse.

## Files changed

New:
- `native/audio-engine/include/msp/Effects.h`, `native/audio-engine/src/Effects.cpp`: effect specs, parameter validation and the five processors
- `apps/desktop/renderer/src/effects.ts`: UI parameter metadata, slider scaling and value formatting
- `apps/desktop/electron/fxCheck.ts`: Phase 2.2 GUI and audio harness (build and reload phases)
- `scripts/run-regression.ps1`: the regression runner
- `docs/phase22-final-report.md`

Modified:
- `native/audio-engine/CMakeLists.txt`: adds `src/Effects.cpp` and links `juce::juce_dsp`
- `include/msp/Mixer.h`, `src/Mixer.cpp`:
  - `MixEffect`, `MixChain`, and per-state processors, crossfade, meters and insert buffers
  - `runChain`, effect inheritance in `inheritMixState`, and chain processing in `mixRoute`
- `include/msp/Routing.h`, `src/Routing.cpp`: effect chains in `buildMixPlan`, plus the plan sample rate
- `include/msp/Project.h`, `src/Project.cpp`: schema v4, effect save/load and repair
- `include/msp/Session.h`, `src/Session.cpp`: effect chains on tracks and the master; add/remove/set/move/repair; duplicate-track gives copied effects new ids
- `include/msp/Engine.h`, `src/Engine.cpp`: the four IPC ops, effect state, effect meters (live and offline), `settleAudio`, load/repair
- `tests/test_main.cpp`: 70 new tests; two version tests updated to expect the current version
- `packages/shared/src/protocol.ts`, `apps/desktop/electron/protocol.ts`: `EffectState`, `EffectType`, `EffectTarget`, `EffectMeter`, `masterEffects`, `createdEffectId`
- `apps/desktop/renderer/src/Mixer.tsx`, `App.tsx`, `styles.css`: FX buttons, the effect rack, gain-reduction meters, the Phase 2.2 label
- `apps/desktop/electron/main.ts`: `MSP_FX_CHECK` / `MSP_FX_PHASE` hook
- `apps/desktop/electron/mixerCheck.ts`, `scripts/verify-phase0-fixtures.py`: accept project versions ≥ 3 and 4 respectively

## Known limitations

- **Tails are cut at the timeline end.** Playback and export stop at the end of the last clip, so reverb and delay tails after it are cut off. The timeline is not extended for tails.
- **Click-free remove and move during playback have only been simulated.** The native `mixRoute` simulation of the bypass-then-remove sequence passes (`remove-effect-without-click`). In the engine test `live-remove-effect-while-playing`, the fixture is 0.1 s long, so the transport had probably already stopped when the remove arrived. That test therefore confirms the engine stays responsive, not the live fade path.
- `settleAudio` blocks the engine's control thread for the fade (normally 12 ms plus two buffers, at most about 0.3 s) when an effect is removed or moved during playback. Meter events pause for that time.
- **Some resets run on the audio thread.** Re-enabling an effect from full bypass and stopping the transport both clear effect history there. For a delay this is a fill of its 2 s buffer (about 0.77 MB). It is bounded and does not allocate, but it is not free.
- **Effect scope:**
  - The compressor has a hard knee and peak detection, with no look-ahead, side-chain or soft knee.
  - The gate has no side-chain or look-ahead.
  - The reverb is Freeverb with no pre-delay.
  - The EQ has no high-pass or low-pass band types.
  - A chain holds at most 8 effects. There is no parameter automation and no undo for effect edits.
- The gain-reduction meter shows the largest reduction in each 50 ms meter interval, with no peak hold.
- Slider positions come from 1000 steps, rounded to 3 significant figures on logarithmic scales. Exact values can be set only through the engine API.

## Not run

- Listening to the effects by ear (requires a person).
- Operating the rack with the real OS mouse. All GUI interaction used injected Chromium events.
- Microphone through effects: **NOT RUN — NO HARDWARE** (no input device is enumerated).
- 30-minute soak, glitch listening and round-trip latency, as in earlier phases.
