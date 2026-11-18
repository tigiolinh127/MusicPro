import type { BrowserWindow } from 'electron'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import type { EngineHost } from './engineHost'
import { writeWav24 } from './workflowCheck'

interface Clip { id: string, timelineStart: number, duration: number, sourceOffset: number }
interface Track { id: string, name: string, clips: Clip[] }
interface State { tracks: Track[] }
interface Check { scenario: string, result: 'PASS' | 'FAIL' | 'NOT RUN', detail: string }

export interface PitchCheckOptions {
  outDir: string
}

const rate = 44100

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function tone(i: number, hz: number): number {
  return 0.4 * Math.sin(2 * Math.PI * hz * i / rate)
}

// 0.5 s A3, 0.3 s silence, 0.5 s C5.
function vocal(i: number): number {
  if (i < 22050)
    return tone(i, 220)
  if (i < 22050 + 13230)
    return 0
  return tone(i, 523.2511)
}

function digest(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

export async function runPitchCheck(win: BrowserWindow, engine: EngineHost, options: PitchCheckOptions): Promise<number> {
  const { outDir } = options
  fs.mkdirSync(outDir, { recursive: true })
  const web = win.webContents
  const checks: Check[] = []
  const vocalPath = path.join(outDir, 'pitch-vocal-44k.wav')
  const longPath = path.join(outDir, 'pitch-long-44k.wav')

  function record(scenario: string, ok: boolean, detail: string): void {
    checks.push({ scenario, result: ok ? 'PASS' : 'FAIL', detail })
  }

  async function js<T>(code: string): Promise<T> {
    return await web.executeJavaScript(code, true) as T
  }

  async function state(): Promise<State> {
    return (await engine.request('getState')).result as State
  }

  async function waitFor(code: string, timeoutMs: number): Promise<boolean> {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      if (await js<boolean>(code))
        return true
      await wait(100)
    }
    return false
  }

  async function shot(name: string): Promise<void> {
    web.invalidate()
    await js('new Promise((resolve) => { requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))); setTimeout(() => resolve(false), 500) })')
    await wait(150)
    const image = await web.capturePage()
    fs.writeFileSync(path.join(outDir, `pitch-${name}.png`), image.toPNG())
  }

  function mouse(type: 'mouseDown' | 'mouseUp' | 'mouseMove', x: number, y: number): void {
    web.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
  }

  async function click(x: number, y: number): Promise<void> {
    mouse('mouseMove', x, y)
    await wait(30)
    mouse('mouseDown', x, y)
    await wait(40)
    mouse('mouseUp', x, y)
    await wait(350)
  }

  async function press(selector: string, text?: string): Promise<boolean> {
    const point = await js<{ x: number, y: number, disabled: boolean } | null>(`(() => {
      const items = Array.from(document.querySelectorAll(${JSON.stringify(selector)}))
      const el = ${text == null ? 'items[0]' : `items.find((item) => item.textContent.trim() === ${JSON.stringify(text)})`}
      if (el == null)
        return null
      el.scrollIntoView({ block: 'nearest' })
      const r = el.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, disabled: el.disabled === true }
    })()`)
    if (point == null || point.disabled)
      return false
    await click(point.x, point.y)
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

  // Sets a React-controlled number input.
  async function setField(label: string, value: string): Promise<boolean> {
    const done = await js<boolean>(`(() => {
      const input = document.querySelector('input[aria-label=${JSON.stringify(label)}]')
      if (input == null || input.disabled)
        return false
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setter.call(input, ${JSON.stringify(value)})
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await wait(150)
    return done
  }

  async function reloadPage(): Promise<void> {
    web.reload()
    await new Promise<void>((resolve) => web.once('did-finish-load', () => resolve()))
    await wait(1200)
  }

  const clipValue = (trackId: string, clipId: string): string => `${trackId}\n${clipId}`

  try {
    writeWav24(vocalPath, rate, 22050 + 13230 + 22050, vocal, vocal)
    writeWav24(longPath, rate, rate * 30, (i) => tone(i, 196), (i) => tone(i, 196))
    const hashes = { vocal: digest(vocalPath), long: digest(longPath) }
    for (const track of (await state()).tracks)
      await engine.request('removeTrack', { trackId: track.id })
    await engine.request('importTrack', { trackId: 'vocal', path: vocalPath }, 20000)
    await engine.request('renameTrack', { trackId: 'vocal', name: 'Vocal' })
    await engine.request('importTrack', { trackId: 'long', path: longPath }, 20000)
    await engine.request('renameTrack', { trackId: 'long', name: 'Long take' })
    await reloadPage()
    const before = await state()
    const vocalClip = before.tracks.find((t) => t.id === 'vocal')?.clips[0]
    const longClip = before.tracks.find((t) => t.id === 'long')?.clips[0]

    const panel = await js<{ present: boolean, options: string[], eyebrow: string, headers: number }>(`(() => ({
      present: document.querySelector('.inspector .pitch-panel') != null,
      options: Array.from(document.querySelectorAll('select[aria-label="Pitch clip"] option')).map((o) => o.textContent),
      eyebrow: document.querySelector('.eyebrow')?.textContent ?? '',
      headers: document.querySelectorAll('.lane-header').length
    }))()`)
    record('pitch panel lists the existing clips; editor unchanged', panel.present && panel.options.length === 2 && panel.headers === 2 && panel.eyebrow === 'Phase 2.3',
      `${panel.options.join(' | ')}; ${panel.headers} track headers; label ${panel.eyebrow}`)

    // Analyse the vocal clip.
    const picked = vocalClip != null && await choose('select[aria-label="Pitch clip"]', clipValue('vocal', vocalClip.id))
    const analyzed = await press('.pitch-panel button', 'Analyze')
    const finished = await waitFor(`document.querySelectorAll('.pitch-notes li').length > 0`, 15000)
    const shown = await js<{ notes: string[], summary: string, plotted: number, width: number, height: number }>(`(() => {
      const canvas = document.querySelector('.pitch-plot')
      let plotted = 0
      if (canvas != null && canvas.width > 0) {
        const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
        for (let i = 0; i < data.length; i += 4)
          plotted += data[i] > 200 && data[i + 1] > 120 && data[i + 2] < 120 ? 1 : 0
      }
      return {
        notes: Array.from(document.querySelectorAll('.pitch-notes li')).map((li) => Array.from(li.children).map((c) => c.textContent).join(' ')),
        summary: document.querySelector('.pitch-summary')?.textContent ?? '',
        plotted, width: canvas?.width ?? 0, height: canvas?.height ?? 0
      }
    })()`)
    const names = shown.notes.map((text) => text.split(' ')[2] ?? '')
    record('analyze an imported 44.1 kHz WAV clip: notes over time', picked && analyzed && finished && names.includes('A3') && names.includes('C5')
        && names.indexOf('A3') < names.indexOf('C5') && /voiced \d+%/.test(shown.summary),
      `${shown.notes.join(' / ')}; "${shown.summary}"`)
    record('pitch plot drawn', shown.plotted > 50, `${shown.plotted} note pixels on a ${shown.width}x${shown.height} canvas; ${shown.notes.length} notes listed`)

    // Frequency and confidence at the pointer; silence reads as unvoiced.
    const box = await js<{ left: number, top: number, width: number, height: number }>(`(() => { const r = document.querySelector('.pitch-plot').getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height } })()`)
    const duration = 1.3
    mouse('mouseMove', box.left + box.width * (0.25 / duration), box.top + box.height / 2)
    await wait(300)
    const voicedText = await js<string>(`document.querySelector('.pitch-readout').textContent`)
    mouse('mouseMove', box.left + box.width * (0.65 / duration), box.top + box.height / 2)
    await wait(300)
    const silentText = await js<string>(`document.querySelector('.pitch-readout').textContent`)
    const hz = Number(/A3 ([\d.]+) Hz/.exec(voicedText)?.[1] ?? 0)
    record('frequency and confidence shown; silence is unvoiced', Math.abs(hz - 220) < 0.2 && /confidence 0\.9\d|confidence 1\.00/.test(voicedText) && silentText.includes('unvoiced'),
      `at 0.25 s "${voicedText}"; at 0.65 s "${silentText}"`)
    await shot('01-result')

    // A setting the engine rejects shows its message.
    await setField('Pitch Window', '512')
    await press('.pitch-panel button', 'Analyze')
    const errorShown = await waitFor(`(document.querySelector('.pitch-error')?.textContent ?? '').includes('too short')`, 5000)
    const errorText = await js<string>(`document.querySelector('.pitch-error')?.textContent ?? ''`)
    record('analysis errors displayed', errorShown, `"${errorText}"`)
    await shot('02-error')
    await setField('Pitch Window', '2048')

    // Cancel a long analysis (30 s clip, 16-sample hop) from the panel; the app stays responsive.
    await choose('select[aria-label="Pitch clip"]', clipValue('long', longClip?.id ?? ''))
    await setField('Pitch Hop', '16')
    await press('.pitch-panel button', 'Analyze')
    const running = await waitFor(`document.querySelector('progress[aria-label="Pitch progress"]') != null && Number(document.querySelector('progress[aria-label="Pitch progress"]').value) > 0`, 5000)
    const pingStart = Date.now()
    await engine.request('getState')
    const engineMs = Date.now() - pingStart
    const uiStart = Date.now()
    await js('new Promise((resolve) => requestAnimationFrame(() => resolve(true)))')
    const uiMs = Date.now() - uiStart
    const progressBefore = await js<number>(`Number(document.querySelector('progress[aria-label="Pitch progress"]')?.value ?? 0)`)
    const cancelled = await press('.pitch-panel button', 'Cancel')
    const stopped = await waitFor(`(document.querySelector('.pitch-summary')?.textContent ?? '').startsWith('Cancelled after')`, 5000)
    const after = await js<{ summary: string, progress: boolean, analyzeEnabled: boolean }>(`(() => ({
      summary: document.querySelector('.pitch-summary')?.textContent ?? '',
      progress: document.querySelector('progress[aria-label="Pitch progress"]') != null,
      analyzeEnabled: Array.from(document.querySelectorAll('.pitch-panel button')).find((b) => b.textContent === 'Analyze')?.disabled === false
    }))()`)
    record('analysis cancelled from the panel; app responsive while it runs', running && cancelled && stopped && !after.progress && after.analyzeEnabled && engineMs < 500 && uiMs < 500,
      `progress ${progressBefore} windows before Cancel; "${after.summary}"; getState ${engineMs} ms and a frame ${uiMs} ms during analysis`)
    await shot('03-cancelled')

    // Nothing the analysis touched changed.
    const end = await state()
    const sameClips = JSON.stringify(before.tracks.map((t) => t.clips)) === JSON.stringify(end.tracks.map((t) => t.clips))
    const sameFiles = digest(vocalPath) === hashes.vocal && digest(longPath) === hashes.long
    record('source files and timeline unchanged by analysis', sameClips && sameFiles, `clips identical ${sameClips}, WAV files identical ${sameFiles}`)
  } catch (error) {
    record('pitch check run', false, error instanceof Error ? error.stack ?? error.message : String(error))
  }
  checks.push({ scenario: 'live microphone pitch analysis', result: 'NOT RUN', detail: 'NOT RUN — NO HARDWARE: no microphone; live analysis is not part of Phase 2.4.1' })
  fs.writeFileSync(path.join(outDir, 'pitch-results.json'), JSON.stringify(checks, null, 2))
  for (const check of checks)
    console.log(`${check.result} ${check.scenario} — ${check.detail}`)
  return checks.every((check) => check.result !== 'FAIL') ? 0 : 1
}
