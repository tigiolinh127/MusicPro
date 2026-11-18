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
  pitchShiftCents?: number
}
interface Track { id: string, name: string, clips: Clip[] }
interface State { tracks: Track[], pitch?: { preview: { resultId: number } | null } }
interface Check { scenario: string, result: 'PASS' | 'FAIL' | 'NOT RUN', detail: string }

export interface PitchCorrectionCheckOptions {
  outDir: string
}

const rate = 44100

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function digest(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function wavCount(dir: string): number {
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith('.wav')).length : 0
}

export async function runPitchCorrectionCheck(win: BrowserWindow, engine: EngineHost, options: PitchCorrectionCheckOptions): Promise<number> {
  const { outDir } = options
  fs.mkdirSync(outDir, { recursive: true })
  const web = win.webContents
  const checks: Check[] = []
  const vocalPath = path.join(outDir, 'pitchfix-vocal-44k.wav')
  const longPath = path.join(outDir, 'pitchfix-long-44k.wav')
  const processedDir = path.join(outDir, 'processed')

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
    fs.writeFileSync(path.join(outDir, `pitchfix-${name}.png`), image.toPNG())
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

  const clipValue = (trackId: string, clipId: string): string => `${trackId}\n${clipId}`
  const vocalClip = async (): Promise<Clip | undefined> => (await state()).tracks.find((t) => t.id === 'vocal')?.clips[0]
  const errorText = async (): Promise<string> => await js<string>(`document.querySelector('.pitch-correction .pitch-error')?.textContent ?? ''`)
  const pressed = async (text: string): Promise<boolean> =>
    await js<boolean>(`Array.from(document.querySelectorAll('.pitch-ab button')).find((b) => b.textContent === ${JSON.stringify(text)})?.getAttribute('aria-pressed') === 'true'`)

  try {
    writeWav24(vocalPath, rate, rate * 2, (i) => 0.4 * Math.sin(2 * Math.PI * 220 * i / rate), (i) => 0.4 * Math.sin(2 * Math.PI * 220 * i / rate))
    writeWav24(longPath, rate, rate * 60, (i) => 0.3 * Math.sin(2 * Math.PI * 196 * i / rate), (i) => 0.3 * Math.sin(2 * Math.PI * 196 * i / rate))
    const hashes = { vocal: digest(vocalPath), long: digest(longPath) }
    for (const track of (await state()).tracks)
      await engine.request('removeTrack', { trackId: track.id })
    await engine.request('setProcessedFolder', { path: processedDir })
    await engine.request('importTrack', { trackId: 'vocal', path: vocalPath }, 20000)
    await engine.request('renameTrack', { trackId: 'vocal', name: 'Vocal' })
    await engine.request('importTrack', { trackId: 'long', path: longPath }, 20000)
    await engine.request('renameTrack', { trackId: 'long', name: 'Long take' })
    const firstClip = await vocalClip()
    await engine.request('moveClip', { trackId: 'vocal', clipId: firstClip?.id, timelineStart: 0.5 })
    await engine.request('setClipFades', { trackId: 'vocal', clipId: firstClip?.id, fadeIn: 0.05, fadeOut: 0.2 })
    await reloadPage()
    const original = await vocalClip()
    const longClip = (await state()).tracks.find((t) => t.id === 'long')?.clips[0]

    const panel = await js<{ section: boolean, semitones: boolean, cents: boolean, eyebrow: string, headers: number }>(`(() => ({
      section: document.querySelector('.inspector .pitch-panel .pitch-correction') != null,
      semitones: document.querySelector('input[aria-label="Pitch shift semitones"]') != null,
      cents: document.querySelector('input[aria-label="Pitch shift cents"]') != null,
      eyebrow: document.querySelector('.eyebrow')?.textContent ?? '',
      headers: document.querySelectorAll('.lane-header').length
    }))()`)
    const applyOff = !await enabled('.pitch-correction button', 'Apply to clip')
    const revertOff = !await enabled('.pitch-correction button', 'Revert to original')
    record('pitch correction section in the Pitch Analysis panel; editor unchanged',
      panel.section && panel.semitones && panel.cents && applyOff && revertOff && panel.headers === 2 && panel.eyebrow === 'Phase 2.3',
      `section ${panel.section}, semitone and cent fields ${panel.semitones && panel.cents}, Apply disabled ${applyOff}, Revert disabled ${revertOff}; ${panel.headers} track headers; label ${panel.eyebrow}`)

    // Invalid settings are reported in the section.
    const picked = original != null && await choose('select[aria-label="Pitch clip"]', clipValue('vocal', original.id))
    await setField('Pitch shift semitones', '13')
    await press('.pitch-correction button', 'Process')
    const invalid = await errorText()
    await setField('Pitch shift semitones', '0')
    await setField('Pitch shift cents', '150')
    await press('.pitch-correction button', 'Process')
    const invalidCents = await errorText()
    record('invalid shift settings show a clear error', picked && invalid.includes('-12 to +12') && invalidCents.includes('-100 to +100'),
      `"${invalid}" | "${invalidCents}"`)

    // Process +12 st: asynchronous, writes a new file, the clip is unchanged.
    await setField('Pitch shift semitones', '12')
    await setField('Pitch shift cents', '0')
    const filesBefore = wavCount(processedDir)
    const started = await press('.pitch-correction button', 'Process')
    const finished = await waitFor(`(document.querySelector('.pitch-process-summary')?.textContent ?? '').includes('Hz')`, 20000)
    const summary = await js<string>(`document.querySelector('.pitch-process-summary')?.textContent ?? ''`)
    const afterProcess = await vocalClip()
    const match = /([\d.]+) → ([\d.]+) Hz/.exec(summary)
    record('process +12 st from the panel: measured pitch, new file, clip and source unchanged',
      started && finished && match != null && Math.abs(Number(match[1]) - 220) < 0.5 && Math.abs(Number(match[2]) - 440) < 0.5
        && wavCount(processedDir) === filesBefore + 1 && JSON.stringify(afterProcess) === JSON.stringify(original) && digest(vocalPath) === hashes.vocal
        && await enabled('.pitch-correction button', 'Apply to clip'),
      `"${summary}"; processed files ${filesBefore} -> ${wavCount(processedDir)}; clip unchanged ${JSON.stringify(afterProcess) === JSON.stringify(original)}; source unchanged ${digest(vocalPath) === hashes.vocal}`)

    // A/B preview toggles playback only.
    const toProcessed = await press('.pitch-ab button', 'Processed')
    await wait(200)
    const previewOn = await state()
    const processedPressed = await pressed('Processed')
    await shot('01-processed-preview')
    const toOriginal = await press('.pitch-ab button', 'Original')
    await wait(200)
    const previewOff = await state()
    const originalPressed = await pressed('Original')
    record('Original/Processed A/B preview toggles playback without changing the clip',
      toProcessed && processedPressed && previewOn.pitch?.preview != null && JSON.stringify(previewOn.tracks.find((t) => t.id === 'vocal')?.clips[0]) === JSON.stringify(original)
        && toOriginal && originalPressed && previewOff.pitch?.preview == null,
      `Processed pressed ${processedPressed}, engine preview ${JSON.stringify(previewOn.pitch?.preview)}; Original pressed ${originalPressed}, engine preview ${JSON.stringify(previewOff.pitch?.preview)}`)

    // Apply, undo, redo from the UI.
    const applied = await press('.pitch-correction button', 'Apply to clip')
    await wait(300)
    const appliedClip = await vocalClip()
    const hint = await js<string>(`document.querySelector('.pitch-clip-state')?.textContent ?? ''`)
    const keptTiming = appliedClip != null && original != null && Math.abs(appliedClip.timelineStart - original.timelineStart) < 1e-4
      && Math.abs(appliedClip.duration - original.duration) < 1e-4 && Math.abs(appliedClip.fadeIn - original.fadeIn) < 1e-4
      && Math.abs(appliedClip.fadeOut - original.fadeOut) < 1e-4 && appliedClip.gain === original.gain
    await shot('02-applied')
    const undone = await press('.toolbar button, button', 'Undo')
    await wait(300)
    const undoClip = await vocalClip()
    const redone = await press('.toolbar button, button', 'Redo')
    await wait(300)
    const redoClip = await vocalClip()
    record('apply to clip keeps timing and fades; undo and redo from the toolbar',
      applied && appliedClip?.originalSourceFileId === original?.sourceFileId && appliedClip?.sourceFileId !== original?.sourceFileId && keptTiming
        && hint.includes('+12 st') && undone && JSON.stringify(undoClip) === JSON.stringify(original) && redone && JSON.stringify(redoClip) === JSON.stringify(appliedClip),
      `applied source ${appliedClip?.sourceFileId} (original ${appliedClip?.originalSourceFileId}), timing/fades/gain kept ${keptTiming}; hint "${hint}"; undo restores ${JSON.stringify(undoClip) === JSON.stringify(original)}; redo restores ${JSON.stringify(redoClip) === JSON.stringify(appliedClip)}`)

    // Revert to original.
    const reverted = await press('.pitch-correction button', 'Revert to original')
    await wait(300)
    const revertClip = await vocalClip()
    const revertOffAfter = !await enabled('.pitch-correction button', 'Revert to original')
    record('revert to original restores the source clip', reverted && JSON.stringify(revertClip) === JSON.stringify(original) && revertOffAfter,
      `clip equals the original ${JSON.stringify(revertClip) === JSON.stringify(original)}; Revert disabled afterwards ${revertOffAfter}`)

    // Cancel a long processing job from the panel.
    await choose('select[aria-label="Pitch clip"]', clipValue('long', longClip?.id ?? ''))
    await setField('Pitch shift semitones', '5')
    const longFiles = wavCount(processedDir)
    await press('.pitch-correction button', 'Process')
    const running = await waitFor(`document.querySelector('progress[aria-label="Pitch correction progress"]') != null`, 5000)
    const cancelled = await press('.pitch-correction button', 'Cancel')
    const stopped = await waitFor(`document.querySelector('progress[aria-label="Pitch correction progress"]') == null`, 10000)
    await wait(300)
    const afterCancel = await js<{ summary: boolean, processEnabled: boolean }>(`(() => ({
      summary: document.querySelector('.pitch-process-summary') != null,
      processEnabled: Array.from(document.querySelectorAll('.pitch-correction button')).find((b) => b.textContent === 'Process')?.disabled === false
    }))()`)
    await shot('03-cancelled')
    record('processing cancelled from the panel; no file written', running && cancelled && stopped && !afterCancel.summary && afterCancel.processEnabled && wavCount(processedDir) === longFiles,
      `progress shown ${running}, stopped ${stopped}, Process enabled ${afterCancel.processEnabled}; processed files ${longFiles} -> ${wavCount(processedDir)}`)

    const sameFiles = digest(vocalPath) === hashes.vocal && digest(longPath) === hashes.long
    record('source WAV files never modified', sameFiles, `WAV files identical ${sameFiles}`)
  } catch (error) {
    record('pitch correction check run', false, error instanceof Error ? error.stack ?? error.message : String(error))
  }
  checks.push({ scenario: 'listening test of the A/B preview on speakers', result: 'NOT RUN', detail: 'NOT RUN — NO HARDWARE: no audio output is monitored; the preview audio is verified numerically by the native test ipc-pitchshift-ab-preview' })
  checks.push({ scenario: 'real voice recording', result: 'NOT RUN', detail: 'NOT RUN — NO HARDWARE: no microphone' })
  fs.writeFileSync(path.join(outDir, 'pitchfix-results.json'), JSON.stringify(checks, null, 2))
  for (const check of checks)
    console.log(`${check.result} ${check.scenario} — ${check.detail}`)
  return checks.every((check) => check.result !== 'FAIL') ? 0 : 1
}
