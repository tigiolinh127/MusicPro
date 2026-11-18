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
  sourceOffset: number
  fadeIn: number
  fadeOut: number
  gain: number
  originalSourceFileId?: string
  pitchLabel?: string
}
interface Track { id: string, name: string, clips: Clip[] }
interface State { tracks: Track[], pitch?: { preview: { resultId: number } | null } }
interface Check { scenario: string, result: 'PASS' | 'FAIL' | 'NOT RUN', detail: string }

export interface AutoCorrectionCheckOptions {
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

// 0.2 s silence, 0.8 s A3+40c, 0.3 s silence, 0.8 s D4-20c, 0.2 s silence.
function take(i: number): number {
  const t = i / rate
  if (t >= 0.2 && t < 1.0)
    return 0.4 * Math.sin(2 * Math.PI * a3Sharp * (t - 0.2))
  if (t >= 1.3 && t < 2.1)
    return 0.4 * Math.sin(2 * Math.PI * d4Flat * (t - 1.3))
  return 0
}

// 60 s of detuned half-second notes, long enough to cancel while it is processed.
function longTake(i: number): number {
  const t = i / rate
  const notes = [a3Sharp, d4Flat, 246.94 * Math.pow(2, 30 / 1200), 329.63 * Math.pow(2, -35 / 1200)]
  const k = Math.floor(t / 0.5)
  return 0.3 * Math.sin(2 * Math.PI * notes[k % notes.length] * (t - k * 0.5))
}

export async function runAutoCorrectionCheck(win: BrowserWindow, engine: EngineHost, options: AutoCorrectionCheckOptions): Promise<number> {
  const { outDir } = options
  fs.mkdirSync(outDir, { recursive: true })
  const web = win.webContents
  const checks: Check[] = []
  const vocalPath = path.join(outDir, 'autocorrect-vocal-48k.wav')
  const longPath = path.join(outDir, 'autocorrect-long-48k.wav')
  const processedDir = path.join(outDir, 'processed')
  const projectPath = path.join(outDir, 'autocorrect-project.msp.json')

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
    fs.writeFileSync(path.join(outDir, `autocorrect-${name}.png`), image.toPNG())
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

  async function analyse(segments: number): Promise<boolean> {
    const pressed = await press('.pitch-panel .pitch-actions button', 'Analyze')
    return pressed && await waitFor(`document.querySelectorAll('.pitch-segments li').length >= ${segments}`, 30000)
  }

  const section = '.pitch-autocorrect'
  const clipValue = (trackId: string, clipId: string): string => `${trackId}\n${clipId}`
  const vocalClip = async (): Promise<Clip | undefined> => (await state()).tracks.find((t) => t.id === 'vocal')?.clips[0]
  const text = async (selector: string): Promise<string> => await js<string>(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`)
  const pressedAb = async (label: string): Promise<boolean> =>
    await js<boolean>(`Array.from(document.querySelectorAll('.pitch-auto-ab button')).find((b) => b.textContent === ${JSON.stringify(label)})?.getAttribute('aria-pressed') === 'true'`)

  try {
    writeWav24(vocalPath, rate, Math.round(rate * 2.3), take, take)
    writeWav24(longPath, rate, rate * 60, longTake, longTake)
    const hashes = { vocal: digest(vocalPath), long: digest(longPath) }
    for (const track of (await state()).tracks)
      await engine.request('removeTrack', { trackId: track.id })
    await engine.request('setPitchMapping', { enabled: false, root: 'C', scale: 'major' })
    await engine.request('setProcessedFolder', { path: processedDir })
    await engine.request('importTrack', { trackId: 'vocal', path: vocalPath }, 20000)
    await engine.request('renameTrack', { trackId: 'vocal', name: 'Vocal' })
    await engine.request('importTrack', { trackId: 'long', path: longPath }, 20000)
    await engine.request('renameTrack', { trackId: 'long', name: 'Long take' })
    const firstClip = await vocalClip()
    await engine.request('setClipFades', { trackId: 'vocal', clipId: firstClip?.id, fadeIn: 0.05, fadeOut: 0.1 })
    await reloadPage()
    const original = await vocalClip()
    const longClip = (await state()).tracks.find((t) => t.id === 'long')?.clips[0]

    // The section exists, separate from manual shifting, and is off until enabled.
    const panel = await js<{ section: boolean, manual: string, toggle: boolean, retuneOff: boolean, strengthOff: boolean, eyebrow: string }>(`(() => ({
      section: document.querySelector('.inspector .pitch-panel .pitch-autocorrect') != null,
      manual: document.querySelector('.pitch-correction h3')?.textContent ?? '',
      toggle: document.querySelector('input[aria-label="Auto correct"]')?.checked === false,
      retuneOff: document.querySelector('input[aria-label="Retune speed"]')?.disabled === true,
      strengthOff: document.querySelector('input[aria-label="Correction strength"]')?.disabled === true,
      eyebrow: document.querySelector('.eyebrow')?.textContent ?? ''
    }))()`)
    const processOff = !await enabled(`${section} button`, 'Process auto correction')
    const applyOff = !await enabled(`${section} button`, 'Apply to clip')
    record('automatic correction section in the Pitch Analysis panel, separate from manual shifting, off by default',
      panel.section && panel.manual === 'Manual pitch shift' && panel.toggle && panel.retuneOff && panel.strengthOff && processOff && applyOff && panel.eyebrow === 'Phase 2.3',
      `section ${panel.section}; manual section "${panel.manual}"; Auto correct off ${panel.toggle}; retune/strength disabled ${panel.retuneOff}/${panel.strengthOff}; Process disabled ${processOff}; Apply disabled ${applyOff}; label ${panel.eyebrow}`)

    // Analyse, enable target suggestions and auto correction.
    const picked = original != null && await choose('select[aria-label="Pitch clip"]', clipValue('vocal', original.id))
    const analysed = await analyse(2)
    await press('input[aria-label="Pitch target mapping"]')
    const suggested = await waitFor(`(document.querySelector('.pitch-segments li[data-segment="0"] .pitch-segment-target')?.textContent ?? '').startsWith('A3')`, 5000)
    await press('input[aria-label="Auto correct"]')
    const ready = await waitFor(`(document.querySelector('.pitch-auto-hint')?.textContent ?? '').startsWith('2 of 2 notes')`, 5000)
    await setField('Retune speed', '250')
    await press(`${section} button`, 'Process auto correction')
    const invalid = await text(`${section} .pitch-error`)
    await setField('Retune speed', '30')
    await setField('Correction strength', '100')
    record('analysis, suggested targets and settings enable the auto correction; invalid retune reported',
      picked && analysed && suggested && ready && invalid.includes('0 to 200 ms'),
      `analysed ${analysed}, A3 target suggested ${suggested}, hint "${await text('.pitch-auto-hint')}"; retune 250: "${invalid}"`)

    // Process: asynchronous, new file, measured result, clip and source unchanged.
    const filesBefore = wavCount(processedDir)
    const started = await press(`${section} button`, 'Process auto correction')
    const finished = await waitFor(`document.querySelector('.pitch-auto-summary') != null`, 30000)
    const summary = await text('.pitch-auto-summary')
    const rows = await js<string[]>(`Array.from(document.querySelectorAll('.pitch-auto-notes li')).map((li) => li.textContent)`)
    const corrected = rows.map((row) => /→ ([+-][\d.]+) c/.exec(row)).map((match) => match == null ? 999 : Number(match[1]))
    const afterProcess = await vocalClip()
    await shot('01-processed')
    record('process auto correction from the panel: both notes measured within 5 cents, new file, clip and source unchanged',
      started && finished && summary.startsWith('Auto correction 100% 30 ms (C Major)') && rows.length === 2 && corrected.every((c) => Math.abs(c) < 5)
        && wavCount(processedDir) === filesBefore + 1 && JSON.stringify(afterProcess) === JSON.stringify(original) && digest(vocalPath) === hashes.vocal
        && await enabled(`${section} button`, 'Apply to clip'),
      `"${summary}"; notes: ${rows.join(' | ')}; processed files ${filesBefore} -> ${wavCount(processedDir)}; clip unchanged ${JSON.stringify(afterProcess) === JSON.stringify(original)}`)

    // Original/Corrected A/B preview.
    const toCorrected = await press('.pitch-auto-ab button', 'Corrected')
    await wait(200)
    const previewOn = await state()
    const correctedPressed = await pressedAb('Corrected')
    await shot('02-corrected-preview')
    const toOriginal = await press('.pitch-auto-ab button', 'Original')
    await wait(200)
    const previewOff = await state()
    const originalPressed = await pressedAb('Original')
    record('Original/Corrected A/B preview changes playback only',
      toCorrected && correctedPressed && previewOn.pitch?.preview != null && JSON.stringify(previewOn.tracks.find((t) => t.id === 'vocal')?.clips[0]) === JSON.stringify(original)
        && toOriginal && originalPressed && previewOff.pitch?.preview == null,
      `Corrected pressed ${correctedPressed}, engine preview ${JSON.stringify(previewOn.pitch?.preview)}; Original pressed ${originalPressed}, engine preview ${JSON.stringify(previewOff.pitch?.preview)}`)

    // Apply, undo, redo.
    const applied = await press(`${section} button`, 'Apply to clip')
    await wait(300)
    const appliedClip = await vocalClip()
    const hint = await text('.pitch-auto-state')
    const keptTiming = appliedClip != null && original != null && Math.abs(appliedClip.timelineStart - original.timelineStart) < 1e-4
      && Math.abs(appliedClip.duration - original.duration) < 1e-4 && Math.abs(appliedClip.fadeIn - original.fadeIn) < 1e-4
      && Math.abs(appliedClip.fadeOut - original.fadeOut) < 1e-4 && appliedClip.gain === original.gain
    await shot('03-applied')
    const undone = await press('.toolbar button, button', 'Undo')
    await wait(300)
    const undoClip = await vocalClip()
    const redone = await press('.toolbar button, button', 'Redo')
    await wait(300)
    const redoClip = await vocalClip()
    record('apply to clip keeps timing and fades and shows the correction label; undo and redo from the toolbar',
      applied && appliedClip?.originalSourceFileId === original?.sourceFileId && appliedClip?.sourceFileId !== original?.sourceFileId && keptTiming
        && (appliedClip?.pitchLabel ?? '').startsWith('Auto correction') && hint.includes('Auto correction') && undone
        && JSON.stringify(undoClip) === JSON.stringify(original) && redone && JSON.stringify(redoClip) === JSON.stringify(appliedClip),
      `label "${appliedClip?.pitchLabel}", hint "${hint}", timing/fades/gain kept ${keptTiming}; undo restores ${JSON.stringify(undoClip) === JSON.stringify(original)}; redo restores ${JSON.stringify(redoClip) === JSON.stringify(appliedClip)}`)

    // Save and load the applied correction, then revert to the original.
    const saved = (await engine.request('saveProject', { path: projectPath })).ok
    const loaded = (await engine.request('loadProject', { path: projectPath }, 30000)).ok
    await reloadPage()
    const loadedClip = await vocalClip()
    await choose('select[aria-label="Pitch clip"]', clipValue('vocal', loadedClip?.id ?? ''))
    const loadedHint = await text('.pitch-auto-state')
    const reverted = await press(`${section} button`, 'Revert to original')
    await wait(300)
    const revertClip = await vocalClip()
    const revertOff = !await enabled(`${section} button`, 'Revert to original')
    record('the applied correction is saved and loaded; revert to original restores the source clip',
      saved && loaded && loadedClip?.pitchLabel === appliedClip?.pitchLabel && loadedClip?.sourceFileId === appliedClip?.sourceFileId
        && loadedHint.includes('Auto correction') && reverted && revertClip?.sourceFileId === original?.sourceFileId && revertClip?.pitchLabel == null && revertOff,
      `loaded label "${loadedClip?.pitchLabel}", hint "${loadedHint}"; reverted source ${revertClip?.sourceFileId} (original ${original?.sourceFileId}), label ${revertClip?.pitchLabel ?? 'none'}; Revert disabled ${revertOff}`)

    // Cancel a long correction from the panel.
    await choose('select[aria-label="Pitch clip"]', clipValue('long', longClip?.id ?? ''))
    const longAnalysed = await analyse(10)
    if (await js<boolean>(`document.querySelector('input[aria-label="Auto correct"]')?.checked !== true`))
      await press('input[aria-label="Auto correct"]')
    await waitFor(`(document.querySelector('.pitch-auto-hint')?.textContent ?? '').includes('notes have a target')`, 5000)
    const longFiles = wavCount(processedDir)
    await press(`${section} button`, 'Process auto correction')
    const running = await waitFor(`document.querySelector('progress[aria-label="Auto correction progress"]') != null`, 5000)
    await shot('04-running')
    const cancelled = await press(`${section} button[aria-label="Cancel auto correction"]`)
    const stopped = await waitFor(`document.querySelector('progress[aria-label="Auto correction progress"]') == null`, 15000)
    await wait(300)
    const afterCancel = await js<{ summary: boolean, processEnabled: boolean }>(`(() => ({
      summary: document.querySelector('.pitch-auto-summary') != null,
      processEnabled: Array.from(document.querySelectorAll('.pitch-autocorrect button')).find((b) => b.textContent === 'Process auto correction')?.disabled === false
    }))()`)
    record('auto correction cancelled from the panel; no file written',
      longAnalysed && running && cancelled && stopped && !afterCancel.summary && afterCancel.processEnabled && wavCount(processedDir) === longFiles,
      `long take analysed ${longAnalysed}, progress shown ${running}, stopped ${stopped}, Process enabled ${afterCancel.processEnabled}; processed files ${longFiles} -> ${wavCount(processedDir)}`)

    const sameFiles = digest(vocalPath) === hashes.vocal && digest(longPath) === hashes.long
    record('source WAV files never modified', sameFiles, `WAV files identical ${sameFiles}`)
  } catch (error) {
    record('auto correction check run', false, error instanceof Error ? error.stack ?? error.message : String(error))
  }
  checks.push({ scenario: 'listening test of the A/B preview on speakers', result: 'NOT RUN', detail: 'NOT RUN — NO HARDWARE: no audio output is monitored; the preview audio is verified numerically by the native test ipc-autocorrect-ab-preview' })
  checks.push({ scenario: 'real voice recording', result: 'NOT RUN', detail: 'NOT RUN — NO HARDWARE: no microphone' })
  fs.writeFileSync(path.join(outDir, 'autocorrect-results.json'), JSON.stringify(checks, null, 2))
  for (const check of checks)
    console.log(`${check.result} ${check.scenario} — ${check.detail}`)
  return checks.every((check) => check.result !== 'FAIL') ? 0 : 1
}
