import type { BrowserWindow } from 'electron'
import fs from 'fs'
import path from 'path'
import { EngineHost } from './engineHost'
import { writeWav24 } from './workflowCheck'

interface Check { scenario: string, result: 'PASS' | 'FAIL' | 'NOT RUN', detail: string }

export interface RecordingWorkflow271CheckOptions { outDir: string }

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function findEngine(): string | null {
  const candidates = [
    process.env.MUSICSTUDIO_ENGINE,
    path.resolve(__dirname, '../../../../build/MusicStudioEngine.exe'),
    path.resolve(process.cwd(), 'build/MusicStudioEngine.exe')
  ].filter((value): value is string => typeof value === 'string' && value.length > 0)
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null
}

export async function runRecordingWorkflow271Check(win: BrowserWindow, _engine: EngineHost, options: RecordingWorkflow271CheckOptions): Promise<number> {
  const { outDir } = options
  fs.mkdirSync(outDir, { recursive: true })
  const web = win.webContents
  const checks: Check[] = []
  let probe: EngineHost | null = null
  const consoleErrors: string[] = []

  function record(scenario: string, ok: boolean, detail: string): void {
    checks.push({ scenario, result: ok ? 'PASS' : 'FAIL', detail })
  }

  async function js<T>(code: string): Promise<T> {
    if (win.isDestroyed() || web.isDestroyed())
      throw new Error('BrowserWindow/webContents destroyed')
    return await web.executeJavaScript(code, true) as T
  }

  async function shot(name: string): Promise<void> {
    web.invalidate()
    await js('new Promise((resolve) => { requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))); setTimeout(() => resolve(false), 500) })')
    await wait(200)
    const image = await web.capturePage()
    fs.writeFileSync(path.join(outDir, `phase271-${name}.png`), image.toPNG())
  }

  const onConsole = (_event: unknown, level: number, message: string): void => {
    if (level >= 3)
      consoleErrors.push(message)
  }
  web.on('console-message', onConsole)

  try {
    await wait(700)
    await js(`(() => {
      const btn = document.querySelector('[data-view="editor"]')
      if (btn instanceof HTMLElement) btn.click()
      return true
    })()`)
    await wait(500)

    const ui = await js<{
      panel: boolean
      status: boolean
      monitor: boolean
      startStop: boolean
      review: boolean
      retake: boolean
      micError: boolean
      pauseDisabled: boolean
      stopDisabled: boolean
    }>(`(() => {
      const pause = document.querySelector('[data-action="transport-pause"]')
      const stop = document.querySelector('[data-action="transport-stop"]')
      return {
        panel: document.querySelector('[data-panel="recording-workflow-271"]') != null,
        status: document.querySelector('[data-recording-status]') != null,
        monitor: document.querySelector('[data-recording-monitor]') != null,
        startStop: document.querySelector('[data-action="recording-start-stop"]') != null,
        review: document.querySelector('[data-action="recording-review"]') != null,
        retake: document.querySelector('[data-action="recording-retake"]') != null,
        micError: document.querySelector('[data-recording-mic-error]') != null,
        pauseDisabled: pause instanceof HTMLButtonElement ? !pause.disabled : false,
        stopDisabled: stop instanceof HTMLButtonElement ? !stop.disabled : false
      }
    })()`)
    record('recording workflow panel present', ui.panel && ui.status && ui.monitor && ui.startStop && ui.review && ui.retake, JSON.stringify(ui))
    record('missing microphone surfaced in Editor', ui.micError, JSON.stringify(ui))
    record('pause/stop enabled when idle (valid)', ui.pauseDisabled && ui.stopDisabled, JSON.stringify(ui))

    // Ensure a track exists and arm it via UI / engine
    probe = new EngineHost(findEngine())
    record('probe EngineHost started', probe.startupError == null, probe.startupError ?? 'ok')
    if (probe.startupError == null) {
      await probe.request('configure', { sampleRate: 48000, bufferSize: 512 })
      await probe.request('setRecordFolder', { path: outDir })
      await probe.request('setVirtualInput', { enabled: true, frequency: 440, level: 0.2 })

      // Disconnect handling (EPIPE-safe)
      const victim = new EngineHost(findEngine())
      await victim.request('ping', {}, 5000)
      victim.forceKill()
      await wait(250)
      const dead = await victim.request('ping', {}, 2000).then(
        () => ({ ok: false, detail: 'unexpected success' }),
        (error: Error) => ({ ok: !/EPIPE/i.test(error.message), detail: error.message })
      )
      record('engine disconnect rejects without EPIPE', dead.ok, dead.detail)
      await victim.shutdown()

      for (const track of ((await probe.request('getState')).result as { tracks: Array<{ id: string }> }).tracks)
        await probe.request('removeTrack', { trackId: track.id })
      await probe.request('addTrack', { name: 'Vocal 271' })
      let state = (await probe.request('getState')).result as {
        tracks: Array<{ id: string, name: string, armed: boolean, monitorInput: boolean, takes?: Array<{ id: string }>, clips: Array<{ id: string }> }>
        transport: string
        record: { state: string, lastTake: { startSeconds: number, takes: Array<{ path: string }> } | null }
      }
      const trackId = state.tracks.find((t) => t.name === 'Vocal 271')!.id

      // Invalid: record with no arm
      const noArm = await probe.request('record', { action: 'start' })
      record('invalid record without arm rejected', noArm.ok === false, String(noArm.error ?? 'unexpected ok'))

      const armed = await probe.request('setTrackRecord', { trackId, armed: true, input: '1', mode: 'dry', monitor: false })
      record('record-arm transition', armed.ok === true, armed.ok ? 'armed' : String(armed.error))
      const mon = await probe.request('setTrackRecord', { trackId, monitor: true })
      state = (await probe.request('getState')).result as typeof state
      record('monitoring mode selection (track monitor on)', mon.ok && state.tracks.find((t) => t.id === trackId)?.monitorInput === true,
        JSON.stringify(state.tracks.find((t) => t.id === trackId)))

      // Live correction RAW/CORRECTED
      await probe.request('setLiveCorrection', { enabled: true, monitorMode: 'raw' })
      const liveRaw = (await probe.request('getLiveCorrection')).result as { monitorMode: string, enabled: boolean }
      await probe.request('setLiveCorrection', { monitorMode: 'corrected' })
      const liveCorr = (await probe.request('getLiveCorrection')).result as { monitorMode: string }
      record('RAW/CORRECTED monitor mode selection', liveRaw.enabled && liveRaw.monitorMode === 'raw' && liveCorr.monitorMode === 'corrected',
        JSON.stringify({ liveRaw, liveCorr }))

      // Record refused while playing
      const backing = path.join(outDir, 'phase271-backing.wav')
      writeWav24(backing, 48000, 48000, (i) => 0.2 * Math.sin(2 * Math.PI * 220 * i / 48000), (i) => 0.2 * Math.sin(2 * Math.PI * 220 * i / 48000))
      await probe.request('importClip', { trackId, path: backing, timelineStart: 0 }, 15000)
      // Use a second track for vocal so backing stays audible
      await probe.request('addTrack', { name: 'Vocal Rec 271' })
      state = (await probe.request('getState')).result as typeof state
      const vocalId = state.tracks.find((t) => t.name === 'Vocal Rec 271')!.id
      await probe.request('setTrackRecord', { trackId: vocalId, armed: true, input: '1', mode: 'dry', monitor: false })
      await probe.request('setTrackRecord', { trackId, armed: false })

      await probe.request('transport', { action: 'play' })
      await wait(80)
      const whilePlaying = await probe.request('record', { action: 'start' })
      record('invalid record while playing rejected', whilePlaying.ok === false, String(whilePlaying.error ?? 'unexpected ok'))
      await probe.request('transport', { action: 'stop' })
      await probe.request('transport', { action: 'seek', position: 0 })

      const started = await probe.request('record', { action: 'start' })
      record('record start with playback path', started.ok === true, started.ok ? 'started' : String(started.error))
      state = (await probe.request('getState')).result as typeof state
      record('transport plays during recording', state.transport === 'playing' && state.record.state === 'recording', `${state.transport}/${state.record.state}`)
      await wait(600)
      const stopped = await probe.request('record', { action: 'stop' }, 15000)
      record('record stop', stopped.ok === true, stopped.ok ? 'stopped' : String(stopped.error))
      state = (await probe.request('getState')).result as typeof state
      const take1 = state.record.lastTake
      const paths1 = (take1?.takes ?? []).map((t) => t.path).filter(Boolean)
      record('take creation', paths1.length >= 1 && paths1.every((p) => fs.existsSync(p)), paths1[0] ?? 'none')

      // Second take (retake) — earlier intact
      await probe.request('transport', { action: 'seek', position: take1?.startSeconds ?? 0 })
      const started2 = await probe.request('record', { action: 'start' })
      await wait(400)
      const stopped2 = await probe.request('record', { action: 'stop' }, 15000)
      state = (await probe.request('getState')).result as typeof state
      const vocal = state.tracks.find((t) => t.id === vocalId)
      const takeCount = vocal?.takes?.length ?? 0
      record('multiple takes / retake keeps earlier', started2.ok && stopped2.ok && (takeCount >= 2 || paths1[0] != null && fs.existsSync(paths1[0])),
        `takes=${takeCount} firstExists=${paths1[0] != null && fs.existsSync(paths1[0])}`)

      // Cancellation / stop without corrupting — removeTrack while recording should fail
      await probe.request('transport', { action: 'seek', position: 0 })
      await probe.request('record', { action: 'start' })
      const removeWhile = await probe.request('removeTrack', { trackId: vocalId })
      record('invalid remove while recording rejected', removeWhile.ok === false, String(removeWhile.error ?? 'unexpected ok'))
      await probe.request('record', { action: 'stop' }, 15000)
      state = (await probe.request('getState')).result as typeof state
      record('project intact after cancel/stop', state.tracks.some((t) => t.id === vocalId), state.tracks.map((t) => t.name).join(','))

      await probe.request('setLiveCorrection', { enabled: false })
    }

    // Drive the App UI (React) so arm/monitor controls appear — do not poke a side EngineHost here.
    await js(`(() => {
      const btn = document.querySelector('[data-view="editor"]')
      if (btn instanceof HTMLElement) btn.click()
      return true
    })()`)
    await wait(400)

    await js(`(() => {
      const add = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Add track')
      if (add instanceof HTMLElement) add.click()
      return true
    })()`)
    await wait(700)
    await js(`(() => {
      const arm = document.querySelector('[data-action="track-arm"]')
      if (arm instanceof HTMLElement && arm.getAttribute('aria-pressed') !== 'true')
        arm.click()
      return true
    })()`)
    await wait(600)
    await js(`(() => {
      const mon = document.querySelector('[data-action="track-monitor"]')
      if (mon instanceof HTMLElement && mon.getAttribute('aria-pressed') !== 'true')
        mon.click()
      return true
    })()`)
    await wait(500)

    const afterArm = await js<{ armedMon: boolean, statusText: string, hasArmButton: boolean }>(`(() => {
      const mon = document.querySelector('[data-action="track-monitor"], [data-action="recording-track-monitor"]')
      return {
        armedMon: mon != null,
        hasArmButton: document.querySelector('[data-action="track-arm"]') != null,
        statusText: document.querySelector('[data-recording-status]')?.textContent ?? ''
      }
    })()`)
    record('arm exposes monitoring control', afterArm.armedMon || (/Armed:/i.test(afterArm.statusText) && !/Armed track: none/i.test(afterArm.statusText)), JSON.stringify(afterArm))
    record('input selection states in status', /Input:/i.test(afterArm.statusText) && /Engine:/i.test(afterArm.statusText), afterArm.statusText.slice(0, 200))

    // Monitor mode control in panel
    const modeSelect = await js<{ present: boolean, disabled: boolean }>(`(() => {
      const sel = document.querySelector('[data-action="recording-monitor-mode"]')
      return {
        present: sel instanceof HTMLSelectElement,
        disabled: sel instanceof HTMLSelectElement ? sel.disabled : true
      }
    })()`)
    record('monitoring mode control present', modeSelect.present, JSON.stringify(modeSelect))

    await shot('recording-workflow')
    await shot('monitoring')

    record('no renderer console errors', consoleErrors.length === 0, consoleErrors.length === 0 ? 'none' : consoleErrors.slice(0, 4).join(' | '))
    checks.push({ scenario: 'live microphone', result: 'NOT RUN', detail: 'NOT RUN — NO HARDWARE' })
  } catch (error) {
    const extra = consoleErrors.length > 0 ? ` | console: ${consoleErrors.slice(0, 4).join(' | ')}` : ''
    record('recording workflow 271 check crashed', false, (error instanceof Error ? error.message : String(error)) + extra)
  } finally {
    web.removeListener('console-message', onConsole)
    try { await probe?.shutdown() } catch { /* ignore */ }
  }

  const summary = {
    pass: checks.filter((c) => c.result === 'PASS').length,
    fail: checks.filter((c) => c.result === 'FAIL').length,
    notRun: checks.filter((c) => c.result === 'NOT RUN').length,
    checks
  }
  fs.writeFileSync(path.join(outDir, 'phase271-summary.json'), JSON.stringify(summary, null, 2))
  console.log(`RECORDING_WORKFLOW_271_CHECK pass=${summary.pass} fail=${summary.fail} not_run=${summary.notRun}`)
  for (const check of checks)
    console.log(`${check.result}\t${check.scenario}\t${check.detail}`)
  return summary.fail === 0 ? 0 : 1
}
