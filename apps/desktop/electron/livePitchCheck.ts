import type { BrowserWindow } from 'electron'
import fs from 'fs'
import path from 'path'
import type { EngineHost } from './engineHost'

interface Track { id: string, name: string }
interface State { tracks: Track[], deviceOpen: boolean, sampleRate: number, pitch?: { mapping?: { root: string, scale: string } } }
interface Check { scenario: string, result: 'PASS' | 'FAIL' | 'NOT RUN', detail: string }

export interface LivePitchCheckOptions {
  outDir: string
}

interface Readout { note: string, frequency: string, cents: string, confidence: string, target: string, correction: string, latency: string }

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function runLivePitchCheck(win: BrowserWindow, engine: EngineHost, options: LivePitchCheckOptions): Promise<number> {
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
    fs.writeFileSync(path.join(outDir, `livepitch-${name}.png`), image.toPNG())
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
    await wait(350)
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
    await wait(300)
    return done
  }

  async function readout(): Promise<Readout> {
    return await js<Readout>(`(() => {
      const text = (selector) => document.querySelector(selector)?.textContent ?? ''
      return {
        note: text('.live-pitch-note'), frequency: text('.live-pitch-frequency'), cents: text('.live-pitch-cents'),
        confidence: text('.live-pitch-confidence'), target: text('.live-pitch-target'), correction: text('.live-pitch-correction'),
        latency: text('.live-pitch-latency')
      }
    })()`)
  }

  async function reloadPage(): Promise<void> {
    web.reload()
    await new Promise<void>((resolve) => web.once('did-finish-load', () => resolve()))
    await wait(1200)
  }

  // Records the test signal on an armed track for `ms`, reading the panel while it plays.
  async function recordWhile(ms: number, screenshot: string): Promise<Readout> {
    const added = (await engine.request('addTrack', { name: 'Live pitch check' })).result as State
    const track = added.tracks.find((t) => t.name === 'Live pitch check')?.id ?? ''
    await engine.request('setTrackRecord', { trackId: track, armed: true, input: '1+2', monitor: false })
    await engine.request('transport', { action: 'seek', position: 0 })
    await engine.request('record', { action: 'start' })
    await wait(ms)
    const during = await readout()
    await shot(screenshot)
    await engine.request('record', { action: 'stop' }, 15000)
    await engine.request('setTrackRecord', { trackId: track, armed: false })
    await engine.request('removeTrack', { trackId: track })
    return during
  }

  try {
    for (const track of (await state()).tracks)
      await engine.request('removeTrack', { trackId: track.id })
    await engine.request('setPitchMapping', { enabled: false, root: 'C', scale: 'major' })
    await engine.request('setLivePitch', { enabled: false, input: 'mix' })
    await engine.request('setRecordFolder', { path: path.join(outDir, 'recordings') })
    await reloadPage()

    const layout = await js<{ found: boolean, order: string[], detect: boolean, input: string, key: string, scale: string, readout: boolean, overflow: boolean, height: number }>(`(() => {
      const panel = document.querySelector('.inspector .live-pitch-panel')
      const order = Array.from(panel?.parentElement?.children ?? []).flatMap((child) =>
        ['pitch-panel', 'live-pitch-panel', 'record-panel'].filter((name) => child.classList.contains(name)))
      return {
        found: panel != null,
        order,
        detect: document.querySelector('input[aria-label="Live pitch detection"]')?.checked === true,
        input: document.querySelector('select[aria-label="Live pitch input"]')?.value ?? '',
        key: document.querySelector('select[aria-label="Live pitch key"]')?.value ?? '',
        scale: document.querySelector('select[aria-label="Live pitch scale"]')?.value ?? '',
        readout: document.querySelector('.live-pitch-readout') != null,
        overflow: panel != null && panel.scrollWidth > panel.clientWidth + 1,
        height: panel?.getBoundingClientRect().height ?? 0
      }
    })()`)
    await shot('01-off')
    record('compact Live pitch panel between Pitch analysis and Recording; off by default',
      layout.found && layout.order.join(',') === 'pitch-panel,live-pitch-panel,record-panel' && !layout.detect && layout.input === 'mix'
        && layout.key === 'C' && layout.scale === 'major' && !layout.readout && !layout.overflow && layout.height < 160,
      `order ${layout.order.join(' > ')}; detect ${layout.detect}, input ${layout.input}, key ${layout.key} ${layout.scale}; readout shown ${layout.readout}; height ${layout.height.toFixed(0)} px, overflow ${layout.overflow}`)

    const device = await state()
    if (!device.deviceOpen) {
      for (const name of ['live readout of the test signal', 'key change from the panel', 'unvoiced after stop and disable'])
        checks.push({ scenario: name, result: 'NOT RUN', detail: 'no audio output device was open, so the audio callback does not run' })
    } else {
      await engine.request('setVirtualInput', { enabled: true, frequency: 440, level: 0.5 })
      const chosen = await choose('select[aria-label="Live pitch input"]', 'input1')
      const toggled = await press('input[aria-label="Live pitch detection"]')
      const engineOn = (await engine.request('getLivePitch')).result as { enabled: boolean, input: string }
      const during = await recordWhile(900, '02-detecting')
      record('live readout of the 440 Hz test signal: note, frequency, cents, confidence, target, correction and latency',
        chosen && toggled && engineOn.enabled && engineOn.input === 'input1' && during.note === 'A4' && during.frequency === '440.0'
          && during.cents === '+0' && Number(during.confidence.replace('%', '')) >= 90 && during.target === 'A4'
          && during.correction === '+0 c' && during.latency.startsWith('Detection ') && during.latency.includes('Device latency not included'),
        `engine ${JSON.stringify(engineOn)}; readout ${JSON.stringify(during)}`)

      const keyed = await choose('select[aria-label="Live pitch scale"]', 'minorPentatonic')
      const mapping = (await state()).pitch?.mapping
      const shifted = await recordWhile(900, '03-key')
      record('key change from the panel: C minor pentatonic targets A#4, +100 cents',
        keyed && mapping?.scale === 'minorPentatonic' && shifted.note === 'A4' && shifted.target === 'A#4' && shifted.correction === '+100 c',
        `mapping ${JSON.stringify(mapping)}; readout ${JSON.stringify(shifted)}`)

      await wait(400)
      const quiet = await readout()
      const untoggled = await press('input[aria-label="Live pitch detection"]')
      const engineOff = (await engine.request('getLivePitch')).result as { enabled: boolean }
      const hidden = await js<boolean>(`document.querySelector('.live-pitch-readout') == null`)
      record('unvoiced after stop (no note, no target); Detect off stops the engine detector',
        quiet.note === '—' && quiet.target === '—' && quiet.correction === '—' && untoggled && !engineOff.enabled && hidden,
        `after stop ${JSON.stringify(quiet)}; engine enabled ${engineOff.enabled}; readout hidden ${hidden}`)
      await engine.request('setVirtualInput', { enabled: false })
      await engine.request('setPitchMapping', { root: 'C', scale: 'major' })
    }
  } catch (error) {
    record('live pitch check run', false, error instanceof Error ? error.stack ?? error.message : String(error))
  }
  checks.push({ scenario: 'live microphone input', result: 'NOT RUN', detail: 'NOT RUN — NO HARDWARE: no microphone; the engine test signal is used' })
  fs.writeFileSync(path.join(outDir, 'livepitch-results.json'), JSON.stringify(checks, null, 2))
  for (const check of checks)
    console.log(`${check.result} ${check.scenario} — ${check.detail}`)
  return checks.every((check) => check.result !== 'FAIL') ? 0 : 1
}
