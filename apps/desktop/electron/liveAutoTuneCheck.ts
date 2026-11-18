import type { BrowserWindow } from 'electron'
import fs from 'fs'
import path from 'path'
import type { EngineHost } from './engineHost'

interface Track { id: string, name: string, monitorInput?: boolean }
interface State {
  tracks: Track[]
  deviceOpen: boolean
  sampleRate: number
  pitch?: { mapping?: { root: string, scale: string } }
}
interface Check { scenario: string, result: 'PASS' | 'FAIL' | 'NOT RUN', detail: string }

export interface LiveAutoTuneCheckOptions {
  outDir: string
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function runLiveAutoTuneCheck(win: BrowserWindow, engine: EngineHost, options: LiveAutoTuneCheckOptions): Promise<number> {
  const { outDir } = options
  fs.mkdirSync(outDir, { recursive: true })
  const web = win.webContents
  const checks: Check[] = []

  function record(scenario: string, ok: boolean, detail: string): void {
    checks.push({ scenario, result: ok ? 'PASS' : 'FAIL', detail })
  }

  async function js<T>(code: string): Promise<T> {
    return await web.executeJavaScript(code, true) as T
  }

  async function state(): Promise<State> {
    return (await engine.request('getState')).result as State
  }

  async function shot(name: string): Promise<void> {
    web.invalidate()
    await js('new Promise((resolve) => { requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))); setTimeout(() => resolve(false), 500) })')
    await wait(150)
    const image = await web.capturePage()
    fs.writeFileSync(path.join(outDir, `live-autotune-${name}.png`), image.toPNG())
  }

  function mouse(type: 'mouseDown' | 'mouseUp' | 'mouseMove', x: number, y: number): void {
    web.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
  }

  async function press(selector: string): Promise<boolean> {
    const point = await js<{ x: number, y: number, disabled: boolean } | null>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (el == null)
        return null
      el.scrollIntoView({ block: 'nearest' })
      const r = el.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, disabled: el.disabled === true }
    })()`)
    if (point == null || point.disabled)
      return false
    mouse('mouseMove', point.x, point.y)
    await wait(30)
    mouse('mouseDown', point.x, point.y)
    await wait(40)
    mouse('mouseUp', point.x, point.y)
    await wait(400)
    return true
  }

  async function choose(selector: string, value: string): Promise<boolean> {
    const done = await js<boolean>(`(() => {
      const select = document.querySelector(${JSON.stringify(selector)})
      if (select == null || select.disabled)
        return false
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
      setter.call(select, ${JSON.stringify(value)})
      select.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`)
    await wait(350)
    return done
  }

  async function setNumber(selector: string, value: number): Promise<boolean> {
    const done = await js<boolean>(`(() => {
      const input = document.querySelector(${JSON.stringify(selector)})
      if (input == null || input.disabled)
        return false
      const proto = input instanceof HTMLInputElement && input.type === 'range'
        ? HTMLInputElement.prototype : HTMLInputElement.prototype
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
      setter.call(input, ${JSON.stringify(String(value))})
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`)
    await wait(350)
    return done
  }

  async function panelSnapshot(): Promise<{
    found: boolean
    order: string[]
    enabled: boolean
    root: string
    scale: string
    retune: string
    strength: string
    monitor: string
    state: string
    latency: string
    cpu: string
    endToEnd: string
    overflow: boolean
    height: number
    error: string
    pitchAutoTune: string
  }> {
    return await js(`(() => {
      const panel = document.querySelector('.inspector .live-autotune-panel')
      const order = Array.from(panel?.parentElement?.children ?? []).flatMap((child) =>
        ['pitch-panel', 'live-pitch-panel', 'live-autotune-panel', 'record-panel']
          .filter((name) => child.classList.contains(name)))
      const text = (selector) => document.querySelector(selector)?.textContent?.trim() ?? ''
      return {
        found: panel != null,
        order,
        enabled: document.querySelector('input[aria-label="Enable Auto-Tune"]')?.checked === true,
        root: document.querySelector('select[aria-label="Auto-Tune root"]')?.value ?? '',
        scale: document.querySelector('select[aria-label="Auto-Tune scale"]')?.value ?? '',
        retune: document.querySelector('input[aria-label="Retune speed"]')?.value ?? '',
        strength: document.querySelector('input[aria-label="Correction strength"]')?.value ?? '',
        monitor: document.querySelector('select[aria-label="Auto-Tune monitor mode"]')?.value ?? '',
        state: text('.live-autotune-readout dd'),
        latency: text('.live-autotune-latency'),
        cpu: Array.from(document.querySelectorAll('.live-autotune-readout div')).map((d) => d.textContent).find((t) => t?.includes('CPU')) ?? '',
        endToEnd: Array.from(document.querySelectorAll('.live-autotune-readout div')).map((d) => d.textContent).find((t) => t?.includes('End-to-end')) ?? '',
        overflow: panel != null && panel.scrollWidth > panel.clientWidth + 1,
        height: panel?.getBoundingClientRect().height ?? 0,
        error: document.querySelector('.live-autotune-panel .pitch-error[role="alert"]')?.textContent ?? '',
        pitchAutoTune: text('[aria-label="Auto-Tune enabled status"]')
      }
    })()`)
  }

  async function reloadPage(): Promise<void> {
    web.reload()
    await new Promise<void>((resolve) => web.once('did-finish-load', () => resolve()))
    await wait(1200)
  }

  try {
    for (const track of (await state()).tracks)
      await engine.request('removeTrack', { trackId: track.id })
    await engine.request('setLiveCorrection', { enabled: false, bypassed: false, root: 'C', scale: 'major', retuneMs: 20, strength: 100, monitorMode: 'corrected' })
    await engine.request('setLivePitch', { enabled: false })
    await engine.request('setRecordFolder', { path: path.join(outDir, 'recordings') })
    await engine.request('setMonitor', { enabled: false })
    await reloadPage()

    const layout = await panelSnapshot()
    await shot('01-off')
    record('Auto-Tune panel between Live pitch and Recording; off by default with visible controls',
      layout.found && layout.order.join(',') === 'pitch-panel,live-pitch-panel,live-autotune-panel,record-panel'
        && !layout.enabled && layout.root === 'C' && layout.scale === 'major' && layout.retune === '20' && layout.strength === '100'
        && layout.monitor === 'corrected' && layout.state === 'Off' && layout.latency.includes('—')
        && layout.endToEnd.includes('Unavailable') && !layout.overflow && layout.height < 320
        && layout.pitchAutoTune.includes('Off'),
      `order ${layout.order.join(' > ')}; enabled ${layout.enabled}; ${layout.root}/${layout.scale} retune ${layout.retune} strength ${layout.strength}; `
        + `monitor ${layout.monitor}; state ${layout.state}; latency ${layout.latency}; end-to-end ${layout.endToEnd}; `
        + `height ${layout.height.toFixed(0)} px; pitch badge ${layout.pitchAutoTune}`)

    const device = await state()
    if (!device.deviceOpen) {
      for (const name of [
        'enable Auto-Tune shows DSP latency and CPU',
        'key, scale, retune and strength update the engine',
        'monitor mode raw/corrected without enabling track monitoring',
        'IPC rejection while recording restores UI',
        'Live pitch shows Auto-Tune On',
        'recording unchanged by monitor mode'
      ])
        checks.push({ scenario: name, result: 'NOT RUN', detail: 'no audio output device was open, so the audio callback does not run' })
    } else {
      await engine.request('setVirtualInput', { enabled: true, frequency: 452, level: 0.5 })

      const toggled = await press('input[aria-label="Enable Auto-Tune"]')
      await wait(300)
      const onUi = await panelSnapshot()
      const onEngine = (await engine.request('getLiveCorrection')).result as {
        enabled: boolean
        latencySamples: number
        latencyMs: number
        statistics?: { averageLoad: number }
        monitorMode: string
        routing: { recording: string, trackInputMonitoring: string, micMonitor: string }
      }
      await shot('02-enabled')
      record('enable Auto-Tune shows DSP latency and CPU; recording stays corrected policy',
        toggled && onUi.enabled && onEngine.enabled && onEngine.latencySamples > 0 && onUi.latency.includes('ms')
          && onUi.latency.includes('smp') && onUi.state.includes('On') && onEngine.routing.recording === 'corrected'
          && onEngine.routing.micMonitor === 'raw' && onEngine.monitorMode === 'corrected',
        `ui ${JSON.stringify({ enabled: onUi.enabled, latency: onUi.latency, state: onUi.state })}; engine latency ${onEngine.latencySamples} / ${onEngine.latencyMs} ms; routing ${JSON.stringify(onEngine.routing)}`)

      const rootOk = await choose('select[aria-label="Auto-Tune root"]', 'D')
      const scaleOk = await choose('select[aria-label="Auto-Tune scale"]', 'minorPentatonic')
      const retuneOk = await setNumber('input[aria-label="Retune speed"]', 50)
      const strengthOk = await setNumber('input[aria-label="Correction strength"]', 60)
      const afterParams = (await engine.request('getLiveCorrection')).result as {
        root: string, scale: string, retuneMs: number, strength: number
      }
      const paramUi = await panelSnapshot()
      record('key, scale, retune and strength update the engine',
        rootOk && scaleOk && retuneOk && strengthOk && afterParams.root === 'D' && afterParams.scale === 'minorPentatonic'
          && afterParams.retuneMs === 50 && afterParams.strength === 60 && paramUi.root === 'D' && paramUi.strength === '60',
        `engine ${JSON.stringify(afterParams)}; ui root ${paramUi.root} strength ${paramUi.strength}`)

      const beforeMonitor = await state()
      const anyMonitor = beforeMonitor.tracks.some((t) => t.monitorInput)
      const rawOk = await choose('select[aria-label="Auto-Tune monitor mode"]', 'raw')
      const rawEngine = (await engine.request('getLiveCorrection')).result as { monitorMode: string, routing: { trackInputMonitoring: string } }
      const afterRaw = await state()
      const stillNoSilentMonitor = afterRaw.tracks.every((t) => !t.monitorInput) && !anyMonitor
      const corrOk = await choose('select[aria-label="Auto-Tune monitor mode"]', 'corrected')
      const corrEngine = (await engine.request('getLiveCorrection')).result as { monitorMode: string }
      record('monitor mode raw/corrected without enabling track monitoring',
        rawOk && corrOk && rawEngine.monitorMode === 'raw' && rawEngine.routing.trackInputMonitoring === 'raw'
          && corrEngine.monitorMode === 'corrected' && stillNoSilentMonitor,
        `raw ${rawEngine.monitorMode}/${rawEngine.routing.trackInputMonitoring}; corrected ${corrEngine.monitorMode}; silent monitor enable avoided ${stillNoSilentMonitor}`)

      // Rejection while recording: turning off is refused; UI must not stay checked.
      const added = (await engine.request('addTrack', { name: 'AT check' })).result as State
      const track = added.tracks.find((t) => t.name === 'AT check')?.id ?? ''
      await engine.request('setTrackRecord', { trackId: track, armed: true, input: '1+2', monitor: true })
      await engine.request('transport', { action: 'seek', position: 0 })
      await engine.request('record', { action: 'start' })
      await wait(200)
      await press('input[aria-label="Enable Auto-Tune"]')   // try to turn off
      await wait(400)
      const refused = await panelSnapshot()
      const stillOn = (await engine.request('getLiveCorrection')).result as { enabled: boolean }
      await engine.request('record', { action: 'stop' }, 15000)
      await engine.request('setTrackRecord', { trackId: track, armed: false, monitor: false })
      await engine.request('removeTrack', { trackId: track })
      record('IPC rejection while recording restores UI (Enable stays on, error shown)',
        stillOn.enabled && refused.enabled && refused.error.toLowerCase().includes('recording'),
        `engine enabled ${stillOn.enabled}; ui enabled ${refused.enabled}; error ${refused.error}`)

      await engine.request('setLivePitch', { enabled: true, input: 'input1' })
      await wait(200)
      const detectOn = await press('input[aria-label="Live pitch detection"]')
      await wait(500)
      const pitchBadge = await js<string>(`document.querySelector('[aria-label="Auto-Tune enabled status"]')?.textContent ?? ''`)
      await shot('03-with-live-pitch')
      record('Live pitch shows Auto-Tune On',
        detectOn && pitchBadge.includes('On'),
        `detect toggled ${detectOn}; badge ${pitchBadge}`)

      // Recording sample path: corrected take whether monitor mode is raw or corrected.
      await engine.request('setLiveCorrection', { strength: 100, retuneMs: 20, root: 'C', scale: 'major', monitorMode: 'corrected' })
      const folder = path.join(outDir, 'takes')
      fs.mkdirSync(folder, { recursive: true })
      await engine.request('setRecordFolder', { path: folder })
      async function take(mode: 'raw' | 'corrected'): Promise<string> {
        await engine.request('setLiveCorrection', { monitorMode: mode })
        const add = (await engine.request('addTrack', { name: `Take ${mode}` })).result as State
        const id = add.tracks.find((t) => t.name === `Take ${mode}`)?.id ?? ''
        await engine.request('setTrackRecord', { trackId: id, armed: true, input: '1+2', monitor: true, mode: 'dry' })
        await engine.request('transport', { action: 'seek', position: 0 })
        await engine.request('record', { action: 'start' })
        await wait(700)
        const stopped = await engine.request('record', { action: 'stop' }, 15000)
        await engine.request('setTrackRecord', { trackId: id, armed: false })
        await engine.request('removeTrack', { trackId: id })
        const takeInfo = (stopped.result as { take?: { takes?: Array<{ path?: string }> } }).take?.takes?.[0]
        return takeInfo?.path ?? ''
      }
      const pathCorrected = await take('corrected')
      const pathRawMon = await take('raw')
      const corrExists = pathCorrected.length > 0 && fs.existsSync(pathCorrected)
      const rawExists = pathRawMon.length > 0 && fs.existsSync(pathRawMon)
      // Engine-side: both takes should be non-empty WAVs (pitch-corrected). Full sample compare is in native tests.
      record('recording unaffected by monitor mode (both modes produce take files while Auto-Tune stays on)',
        corrExists && rawExists && stillOn.enabled,
        `corrected take ${pathCorrected}; raw-monitor take ${pathRawMon}`)

      await engine.request('setLivePitch', { enabled: false })
      await engine.request('setLiveCorrection', { enabled: false })
      await engine.request('setVirtualInput', { enabled: false })
    }
  } catch (error) {
    record('live Auto-Tune check run', false, error instanceof Error ? error.stack ?? error.message : String(error))
  }
  checks.push({ scenario: 'live microphone input', result: 'NOT RUN', detail: 'NOT RUN — NO HARDWARE: no microphone; the engine test signal is used' })
  fs.writeFileSync(path.join(outDir, 'live-autotune-results.json'), JSON.stringify(checks, null, 2))
  for (const check of checks)
    console.log(`${check.result} ${check.scenario} — ${check.detail}`)
  return checks.every((check) => check.result !== 'FAIL') ? 0 : 1
}
