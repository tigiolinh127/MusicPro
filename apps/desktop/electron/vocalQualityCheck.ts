import type { BrowserWindow } from 'electron'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import type { EngineHost } from './engineHost'
import { writeWav24 } from './workflowCheck'

interface Clip {
  id: string
  sourceFileId: string
  timelineStart: number
  duration: number
  originalSourceFileId?: string
  pitchLabel?: string
}
interface Track { id: string, name: string, clips: Clip[] }
interface State { tracks: Track[], pitch?: { preview: { resultId: number } | null } }
interface Check { scenario: string, result: 'PASS' | 'FAIL' | 'NOT RUN', detail: string }

export interface VocalQualityCheckOptions {
  outDir: string
}

const rate = 48000
const a3Sharp = 220 * Math.pow(2, 40 / 1200)        // A3 +40 cents
const d4Flat = 293.6648 * Math.pow(2, -20 / 1200)   // D4 -20 cents

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function digest(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function wavCount(dir: string): number {
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith('.wav')).length : 0
}

// Vowel-like spectral envelope: glottal tilt, formants at 700 / 1220 / 2600 Hz, floor.
function envelope(hz: number): number {
  let value = 0.01 + 0.4 / (1 + (hz / 300) ** 2)
  for (const [f, bw, g] of [[700, 160, 1], [1220, 200, 0.5], [2600, 300, 0.25]])
    value += g / (1 + ((hz - f) / (bw / 2)) ** 2)
  return value
}

function vowel(f0: number, t: number): number {
  let sum = 0
  for (let h = 1; h * f0 < 5000; h++)
    sum += envelope(h * f0) * Math.sin(2 * Math.PI * h * f0 * t + 0.37 * h * h)
  return sum
}

// 0.2 s silence, 0.8 s vowel at A3+40c, 0.3 s silence, 0.8 s vowel at D4-20c, 0.2 s silence.
function take(i: number): number {
  const t = i / rate
  const edge = (start: number, end: number): number => Math.min(1, (t - start) / 0.005, (end - t) / 0.005)
  if (t >= 0.2 && t < 1.0)
    return 0.12 * edge(0.2, 1.0) * vowel(a3Sharp, t - 0.2)
  if (t >= 1.3 && t < 2.1)
    return 0.12 * edge(1.3, 2.1) * vowel(d4Flat, t - 1.3)
  return 0
}

export async function runVocalQualityCheck(win: BrowserWindow, engine: EngineHost, options: VocalQualityCheckOptions): Promise<number> {
  const { outDir } = options
  fs.mkdirSync(outDir, { recursive: true })
  const web = win.webContents
  const checks: Check[] = []
  const vocalPath = path.join(outDir, 'vocal-quality-48k.wav')
  const processedDir = path.join(outDir, 'processed')
  const projectPath = path.join(outDir, 'vocal-quality-project.msp.json')

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
    fs.writeFileSync(path.join(outDir, `vocal-${name}.png`), image.toPNG())
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

  async function enabled(selector: string, text: string): Promise<boolean> {
    return await js<boolean>(`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find((b) => b.textContent.trim() === ${JSON.stringify(text)})?.disabled === false`)
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

  const manual = '.pitch-correction'
  const auto = '.pitch-autocorrect'
  const clipValue = (trackId: string, clipId: string): string => `${trackId}\n${clipId}`
  const vocalClip = async (): Promise<Clip | undefined> => (await state()).tracks.find((t) => t.id === 'vocal')?.clips[0]
  const text = async (selector: string): Promise<string> => await js<string>(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`)
  const pressedAb = async (label: string): Promise<boolean> =>
    await js<boolean>(`Array.from(document.querySelectorAll('.pitch-ab button')).find((b) => b.textContent === ${JSON.stringify(label)})?.getAttribute('aria-pressed') === 'true'`)

  try {
    writeWav24(vocalPath, rate, Math.round(rate * 2.3), take, take)
    const hash = digest(vocalPath)
    for (const track of (await state()).tracks)
      await engine.request('removeTrack', { trackId: track.id })
    await engine.request('setPitchMapping', { enabled: false, root: 'C', scale: 'major' })
    await engine.request('setProcessedFolder', { path: processedDir })
    await engine.request('importTrack', { trackId: 'vocal', path: vocalPath }, 20000)
    await engine.request('renameTrack', { trackId: 'vocal', name: 'Vocal' })
    await reloadPage()
    const original = await vocalClip()

    // The compact section, its defaults and the formant shift following the toggle.
    const layout = await js<{ section: boolean, order: string[], preserve: boolean, shift: string, shiftOn: boolean, mode: string, modes: string[], overflow: boolean, height: number, eyebrow: string }>(`(() => {
      const section = document.querySelector('.inspector .pitch-panel .pitch-vocal')
      const panel = document.querySelector('.pitch-panel')
      const order = Array.from(panel?.children ?? []).flatMap((child) => child.classList.contains('pitch-vocal') || child.classList.contains('pitch-autocorrect')
        || child.classList.contains('pitch-correction') || child.classList.contains('pitch-mapping') ? [child.className] : [])
      return {
        section: section != null,
        order,
        preserve: document.querySelector('input[aria-label="Preserve formants"]')?.checked === true,
        shift: document.querySelector('input[aria-label="Formant shift"]')?.value ?? '',
        shiftOn: document.querySelector('input[aria-label="Formant shift"]')?.disabled === false,
        mode: document.querySelector('select[aria-label="Vocal quality mode"]')?.value ?? '',
        modes: Array.from(document.querySelectorAll('select[aria-label="Vocal quality mode"] option')).map((o) => o.textContent),
        overflow: section != null && section.scrollWidth > section.clientWidth + 1,
        height: section?.getBoundingClientRect().height ?? 0,
        eyebrow: document.querySelector('.eyebrow')?.textContent ?? ''
      }
    })()`)
    await press('input[aria-label="Preserve formants"]')
    const offState = await js<{ shiftOff: boolean, hint: string }>(`({ shiftOff: document.querySelector('input[aria-label="Formant shift"]')?.disabled === true, hint: document.querySelector('.pitch-vocal-hint')?.textContent ?? '' })`)
    await press('input[aria-label="Preserve formants"]')
    const onAgain = await js<boolean>(`document.querySelector('input[aria-label="Formant shift"]')?.disabled === false`)
    await shot('01-section')
    record('compact Vocal quality section in the Pitch Analysis panel: Preserve formants on, formant shift 0, Standard by default',
      layout.section && layout.order.join(',') === 'pitch-mapping,pitch-vocal,pitch-autocorrect,pitch-correction' && layout.preserve && layout.shift === '0'
        && layout.shiftOn && layout.mode === 'standard' && layout.modes.join('|') === 'Standard|High (slower)' && !layout.overflow && layout.height < 160
        && offState.shiftOff && offState.hint.startsWith('Formants move with the pitch') && onAgain && layout.eyebrow === 'Phase 2.3',
      `order ${layout.order.join(' > ')}; preserve ${layout.preserve}, shift "${layout.shift}", mode ${layout.mode} (${layout.modes.join('/')}); height ${layout.height.toFixed(0)} px, overflow ${layout.overflow}; preserve off disables the shift ${offState.shiftOff} ("${offState.hint}"); label ${layout.eyebrow}`)

    // Manual shift +5 st, formants kept, High quality.
    const picked = original != null && await choose('select[aria-label="Pitch clip"]', clipValue('vocal', original.id))
    await setField('Formant shift', '13')
    await setField('Pitch shift semitones', '5')
    await press(`${manual} button`, 'Process')
    const invalid = await text(`${manual} .pitch-error`)
    await setField('Formant shift', '0')
    const highChosen = await choose('select[aria-label="Vocal quality mode"]', 'high')
    const filesBefore = wavCount(processedDir)
    const started = await press(`${manual} button`, 'Process')
    const finished = await waitFor(`(document.querySelector('.pitch-process-summary')?.textContent ?? '').includes('Hz')`, 60000)
    const summary = await text('.pitch-process-summary')
    const afterProcess = await vocalClip()
    await shot('02-processed')
    record('manual shift with formants kept (High): invalid formant shift reported, then processed into a new file; clip and source unchanged',
      picked && invalid.includes('-12 to +12') && highChosen && started && finished && summary.startsWith('+5 st, formants kept, High quality')
        && wavCount(processedDir) === filesBefore + 1 && JSON.stringify(afterProcess) === JSON.stringify(original) && digest(vocalPath) === hash,
      `formant shift 13: "${invalid}"; summary "${summary}"; processed files ${filesBefore} -> ${wavCount(processedDir)}; clip unchanged ${JSON.stringify(afterProcess) === JSON.stringify(original)}`)

    // A/B preview, apply, undo, redo.
    const toProcessed = await press('.pitch-ab button', 'Processed')
    await wait(200)
    const previewOn = await state()
    const processedPressed = await pressedAb('Processed')
    const toOriginal = await press('.pitch-ab button', 'Original')
    await wait(200)
    const previewOff = await state()
    const applied = await press(`${manual} button`, 'Apply to clip')
    await wait(300)
    const appliedClip = await vocalClip()
    const hint = await text('.pitch-clip-state')
    const undone = await press('.toolbar button, button', 'Undo')
    await wait(300)
    const undoClip = await vocalClip()
    const redone = await press('.toolbar button, button', 'Redo')
    await wait(300)
    const redoClip = await vocalClip()
    await shot('03-applied')
    record('Original/Processed preview, apply with the vocal quality label, undo and redo',
      toProcessed && processedPressed && previewOn.pitch?.preview != null && JSON.stringify(previewOn.tracks.find((t) => t.id === 'vocal')?.clips[0]) === JSON.stringify(original)
        && toOriginal && previewOff.pitch?.preview == null && applied && appliedClip?.pitchLabel === '+5 st, formants kept, High quality'
        && appliedClip?.originalSourceFileId === original?.sourceFileId && hint.includes('formants kept') && undone && JSON.stringify(undoClip) === JSON.stringify(original)
        && redone && JSON.stringify(redoClip) === JSON.stringify(appliedClip),
      `preview ${JSON.stringify(previewOn.pitch?.preview)} then ${JSON.stringify(previewOff.pitch?.preview)}; label "${appliedClip?.pitchLabel}", hint "${hint}"; undo restores ${JSON.stringify(undoClip) === JSON.stringify(original)}; redo restores ${JSON.stringify(redoClip) === JSON.stringify(appliedClip)}`)

    // Save, load, revert.
    const saved = (await engine.request('saveProject', { path: projectPath })).ok
    const loaded = (await engine.request('loadProject', { path: projectPath }, 30000)).ok
    await reloadPage()
    const loadedClip = await vocalClip()
    await choose('select[aria-label="Pitch clip"]', clipValue('vocal', loadedClip?.id ?? ''))
    const reverted = await press(`${manual} button`, 'Revert to original')
    await wait(300)
    const revertClip = await vocalClip()
    record('the label is saved and loaded; revert restores the original source',
      saved && loaded && loadedClip?.pitchLabel === appliedClip?.pitchLabel && reverted && revertClip?.sourceFileId === original?.sourceFileId && revertClip?.pitchLabel == null,
      `loaded label "${loadedClip?.pitchLabel}"; reverted source ${revertClip?.sourceFileId} (original ${original?.sourceFileId})`)

    // Automatic correction with formants kept (Standard; the page reload reset the settings).
    const defaultsBack = await js<boolean>(`document.querySelector('input[aria-label="Preserve formants"]')?.checked === true && document.querySelector('select[aria-label="Vocal quality mode"]')?.value === 'standard'`)
    await press('.pitch-panel .pitch-actions button', 'Analyze')
    const analysed = await waitFor(`document.querySelectorAll('.pitch-segments li').length >= 2`, 30000)
    await press('input[aria-label="Pitch target mapping"]')
    await waitFor(`(document.querySelector('.pitch-segments li[data-segment="0"] .pitch-segment-target')?.textContent ?? '').startsWith('A3')`, 5000)
    await press('input[aria-label="Auto correct"]')
    await waitFor(`(document.querySelector('.pitch-auto-hint')?.textContent ?? '').startsWith('2 of 2 notes')`, 5000)
    const autoFiles = wavCount(processedDir)
    const autoStarted = await press(`${auto} button`, 'Process auto correction')
    const autoDone = await waitFor(`document.querySelector('.pitch-auto-summary') != null`, 60000)
    const autoSummary = await text('.pitch-auto-summary')
    const rows = await js<string[]>(`Array.from(document.querySelectorAll('.pitch-auto-notes li')).map((li) => li.textContent)`)
    const corrected = rows.map((row) => /→ ([+-][\d.]+) c/.exec(row)).map((match) => match == null ? 999 : Number(match[1]))
    await shot('04-auto')
    record('automatic correction with formants kept: both notes within 5 cents, labelled, new file',
      defaultsBack && analysed && autoStarted && autoDone && autoSummary.startsWith('Auto correction 100% 20 ms (C Major), formants kept')
        && rows.length === 2 && corrected.every((c) => Math.abs(c) < 5) && wavCount(processedDir) === autoFiles + 1 && await enabled(`${auto} button`, 'Apply to clip'),
      `defaults after reload ${defaultsBack}; "${autoSummary}"; notes: ${rows.join(' | ')}; files ${autoFiles} -> ${wavCount(processedDir)}`)

    record('source WAV never modified', digest(vocalPath) === hash, `identical ${digest(vocalPath) === hash}`)
  } catch (error) {
    record('vocal quality check run', false, error instanceof Error ? error.stack ?? error.message : String(error))
  }
  checks.push({ scenario: 'listening test of formant preservation', result: 'NOT RUN', detail: 'NOT RUN — NO HARDWARE: no audio output is monitored; formants are measured numerically by the native vocalquality tests' })
  checks.push({ scenario: 'real voice recording', result: 'NOT RUN', detail: 'NOT RUN — NO HARDWARE: no microphone' })
  fs.writeFileSync(path.join(outDir, 'vocal-quality-results.json'), JSON.stringify(checks, null, 2))
  for (const check of checks)
    console.log(`${check.result} ${check.scenario} — ${check.detail}`)
  return checks.every((check) => check.result !== 'FAIL') ? 0 : 1
}
