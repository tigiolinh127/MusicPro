# EngineHost.request EPIPE — status and fix

**Status:** resolved (focused fix)  
**Date:** 2026-11-09  
**Karaoke K1:** not started

## Prior status

**Not fixed before this pass.** No prior EPIPE root-cause write-up, code change, or targeted test existed in `docs/`, phase reports, or `engineHost.ts`. Phase 2.6.5 did not address it.

## Root cause

`apps/desktop/electron/engineHost.ts` wrote JSON-lines commands to the native engine’s stdin. When the child exited (crash, kill, or shutdown), Node emitted an `error` on that writable stream (`EPIPE` / `ERR_STREAM_DESTROYED`).

There was **no** `stdin.on('error')` listener. An unhandled stream `error` becomes an uncaught exception in the Electron main process and can crash the app. The write callback could reject with a raw `Error: write EPIPE`, which also leaked into UI/IPC as a low-level pipe failure.

## Fix

**File:** `apps/desktop/electron/engineHost.ts`

- Attach `stdin.on('error')` so EPIPE is handled (no uncaught crash)
- Treat closed/destroyed stdin as “engine not running” before write
- Normalize pipe-closed errors to `The audio engine is not running.`
- Fail all pending waiters on stdin/process error or exit
- Add `forceKill()` for abrupt child termination (tests / recovery)
- Harden `shutdown()` against already-closed stdin

**Also:** `apps/desktop/electron/engineHostEpipeCheck.ts` (new), `apps/desktop/electron/main.ts` hook `MSP_ENGINE_HOST_EPIPE_CHECK` (optional Electron entry; primary verification used Node + compiled check).

## Targeted verification

```
Executed:
- npx tsc -p tsconfig.electron.json --noEmit: exit 0
- npm run build:electron: exit 0
- node runEngineHostEpipeCheck (docs/epipe-check): 9 PASS, 0 FAIL, 1 NOT RUN, exit 0

Not run: full regression, unrelated native/GUI suites, installer
Microphone: NOT RUN — NO HARDWARE
```

Results: `docs/epipe-check/engine-host-epipe-summary.json`

Covered: ping while alive; force-kill then request rejects without raw EPIPE; repeated post-death request; shutdown after death; request after graceful shutdown; no uncaughtException/unhandledRejection.

## Stop

EPIPE investigation and fix complete. Do not begin Karaoke K1 until approved.
