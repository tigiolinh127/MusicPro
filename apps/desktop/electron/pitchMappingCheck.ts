import type { BrowserWindow } from 'electron'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import type { EngineHost } from './engineHost'
import { writeWav24 } from './workflowCheck'

interface NoteTarget { clipId: string, targetMidi: number }
interface Clip { id: string, sourceFileId: string, timelineStart: number, duration: number, sourceOffset: number, noteTargets?: NoteTarget[] }
interface Track { id: string, clips: Clip[] }
interface Mapping { enabled: boolean, root: string, scale: string }
interface State { tracks: Track[], canUndo: boolean, pitch?: { mapping?: Mapping } }
interface Check { scenario: string, result: 'PASS' | 'FAIL' | 'NOT RUN', detail: string }
interface Row { overridden: boolean, original: string, suggested: string, target: string, manual: boolean, value: string, reset: boolean }

export interface PitchMappingCheckOptions {
  outDir: string
}

const rate = 44100

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function digest(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

// 0.6 s A3+39c, 0.3 s silence, 0.6 s C#4, 0.3 s silence, 0.6 s D4+37c.
function vocal(i: number): number {
  const t = i / rate
  const parts = [225, 0, 277.1826, 0, 300]
  const lengths = [0.6, 0.3, 0.6, 0.3, 0.6]
  let start = 0
  for (let k = 0; k < parts.length; k++) {
    if (t < start + lengths[k])
      return parts[k] > 0 ? 0.4 * Math.sin(2 * Math.PI * parts[k] * (t - start)) : 0
    start += lengths[k]
  }
  return 0
}

export async function runPitchMappingCheck(win: BrowserWindow, engine: EngineHost, options: PitchMappingCheckOptions): Promise<number> {
  const { outDir } = options
  fs.mkdirSync(outDir, { recursive: true })
  const web = win.webContents
  const checks: Check[] = []
  const vocalPath = path.join(outDir, 'pitchmap-vocal-44k.wav')

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
    fs.writeFileSync(path.join(outDir, `pitchmap-${name}.png`), image.toPNG())
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

  async function reloadPage(): Promise<void> {
    web.reload()
    await new Promise<void>((resolve) => web.once('did-finish-load', () => resolve()))
    await wait(1200)
  }

  async function rows(): Promise<Row[]> {
    return await js<Row[]>(`Array.from(document.querySelectorAll('.pitch-segments li')).map((li) => ({
      overridden: li.classList.contains('overridden'),
      original: li.querySelector('.pitch-segment-original')?.textContent ?? '',
      suggested: li.querySelector('.pitch-segment-suggested')?.textContent ?? '',
      target: li.querySelector('.pitch-segment-target')?.textContent ?? '',
      manual: li.querySelector('.pitch-manual') != null,
      value: li.querySelector('select')?.value ?? '',
      reset: li.querySelector('button')?.disabled === false
    }))`)
  }

  const vocalClip = async (): Promise<Clip | undefined> => (await state()).tracks.find((t) => t.id === 'vocal')?.clips[0]
  const firstRow = (condition: string): string => `(() => { const li = document.querySelector('.pitch-segments li[data-segment="0"]'); return li != null && (${condition}) })()`

  try {
    writeWav24(vocalPath, rate, Math.round(rate * 2.4), vocal, vocal)
    const hash = digest(vocalPath)
    for (const track of (await state()).tracks)
      await engine.request('removeTrack', { trackId: track.id })
    await engine.request('setPitchMapping', { enabled: false, root: 'C', scale: 'major' })
    await engine.request('importTrack', { trackId: 'vocal', path: vocalPath }, 20000)
    await engine.request('renameTrack', { trackId: 'vocal', name: 'Vocal' })
    await reloadPage()
    const original = await vocalClip()

    const panel = await js<{ section: boolean, keys: number, scales: string[], toggle: boolean, eyebrow: string, headers: number }>(`(() => ({
      section: document.querySelector('.inspector .pitch-panel .pitch-mapping') != null,
      keys: document.querySelectorAll('select[aria-label="Pitch key"] option').length,
      scales: Array.from(document.querySelectorAll('select[aria-label="Pitch scale"] option')).map((o) => o.textContent),
      toggle: document.querySelector('input[aria-label="Pitch target mapping"]')?.checked === false,
      eyebrow: document.querySelector('.eyebrow')?.textContent ?? '',
      headers: document.querySelectorAll('.lane-header').length
    }))()`)
    record('key, scale and mapping controls in the Pitch Analysis panel; editor unchanged',
      panel.section && panel.keys === 12 && panel.scales.length === 7 && panel.toggle && panel.headers === 1 && panel.eyebrow === 'Phase 2.3',
      `section ${panel.section}; ${panel.keys} keys; scales ${panel.scales.join(', ')}; mapping off ${panel.toggle}; ${panel.headers} track header; label ${panel.eyebrow}`)

    // Analyse; with mapping off the notes are listed without suggestions.
    await choose('select[aria-label="Pitch clip"]', `vocal\n${original?.id ?? ''}`)
    const analysed = await press('.pitch-panel .pitch-actions button', 'Analyze')
    const listed = await waitFor(`document.querySelectorAll('.pitch-segments li').length === 3`, 20000)
    const offRows = await rows()
    record('analysis lists three note segments; no suggestions while mapping is off',
      analysed && listed && offRows.length === 3 && offRows.every((row) => row.suggested.includes('no suggestion')) && offRows[0].original.startsWith('A3 +39'),
      `rows: ${offRows.map((row) => `${row.original} ${row.suggested}`).join(' | ')}`)

    // Enable mapping in C major.
    const toggled = await press('input[aria-label="Pitch target mapping"]')
    const suggested = await waitFor(firstRow(`li.querySelector('.pitch-segment-suggested').textContent.includes('A3')`), 5000)
    const cRows = await rows()
    const cState = await state()
    await shot('01-c-major')
    record('mapping on in C major: A3+39c -> A3, C#4 -> C4 or D4, D4+37c -> D4',
      toggled && suggested && cState.pitch?.mapping?.enabled === true && cRows[0].suggested.includes('A3 (-39 c)')
        && (cRows[1].suggested.includes('C4') || cRows[1].suggested.includes('D4')) && cRows[2].suggested.includes('D4 (-37 c)')
        && cRows.every((row) => !row.overridden && row.value === ''),
      `engine mapping ${JSON.stringify(cState.pitch?.mapping)}; rows: ${cRows.map((row) => `${row.original} ${row.suggested} = ${row.target}`).join(' | ')}`)

    // Change the key and the scale.
    const keyChosen = await choose('select[aria-label="Pitch key"]', 'D')
    const inKey = await waitFor(`(document.querySelectorAll('.pitch-segments li')[1]?.querySelector('.pitch-segment-suggested')?.textContent ?? '').includes('C#4')`, 5000)
    const dRows = await rows()
    const dState = await state()
    const scaleChosen = await choose('select[aria-label="Pitch scale"]', 'harmonicMinor')
    await wait(300)
    const minorState = await state()
    const minorLabel = await js<string>(`document.querySelector('.pitch-mapping .hint')?.textContent ?? ''`)
    await choose('select[aria-label="Pitch scale"]', 'major')
    await wait(300)
    record('key and scale selectors update the engine and the suggestions',
      keyChosen && inKey && dState.pitch?.mapping?.root === 'D' && dRows[1].suggested.includes('C#4') && scaleChosen
        && minorState.pitch?.mapping?.scale === 'harmonicMinor' && minorLabel.startsWith('D Harmonic minor: D E F G A A# C#'),
      `D major row 2: ${dRows[1].original} ${dRows[1].suggested}; harmonic minor engine scale ${minorState.pitch?.mapping?.scale}, hint "${minorLabel}"`)

    // Manual override, undo, redo, reset.
    const overrode = await choose('select[aria-label="Target note 1"]', '59')
    const marked = await waitFor(firstRow(`li.classList.contains('overridden')`), 5000)
    const manualRows = await rows()
    const manualClip = await vocalClip()
    await shot('02-manual-target')
    await js(`document.querySelector('.pitch-plot')?.scrollIntoView({ block: 'center' }); true`)
    await shot('03-plot-targets')
    record('manual target B3 on note 1: marked as manual, suggestion kept, stored on the clip',
      overrode && marked && manualRows[0].manual && manualRows[0].value === '59' && manualRows[0].target.startsWith('B3')
        && manualRows[0].suggested.includes('A3') && manualRows[0].reset && manualClip?.noteTargets?.length === 1 && manualClip.noteTargets[0].targetMidi === 59,
      `row 1: ${manualRows[0].original} ${manualRows[0].suggested} target ${manualRows[0].target}, manual badge ${manualRows[0].manual}; clip noteTargets ${JSON.stringify(manualClip?.noteTargets?.map((t) => t.targetMidi))}`)

    const undone = await press('.toolbar button, button', 'Undo')
    const undoCleared = await waitFor(firstRow(`!li.classList.contains('overridden')`), 5000)
    const redone = await press('.toolbar button, button', 'Redo')
    const redoMarked = await waitFor(firstRow(`li.classList.contains('overridden')`), 5000)
    const reset = await press('button[aria-label="Reset target 1"]')
    const resetCleared = await waitFor(firstRow(`!li.classList.contains('overridden')`), 5000)
    const resetRows = await rows()
    const resetClip = await vocalClip()
    record('undo, redo and reset of the manual target from the UI',
      undone && undoCleared && redone && redoMarked && reset && resetCleared && resetRows[0].value === '' && resetRows[0].target.startsWith('A3')
        && (resetClip?.noteTargets ?? []).length === 0,
      `undo cleared ${undoCleared}, redo restored ${redoMarked}, reset cleared ${resetCleared}; row 1 target ${resetRows[0].target}`)

    const same = resetClip != null && original != null && resetClip.timelineStart === original.timelineStart && resetClip.duration === original.duration
      && resetClip.sourceOffset === original.sourceOffset && resetClip.sourceFileId === original.sourceFileId
    record('clip timing, clip source and the WAV file are unchanged', same && digest(vocalPath) === hash,
      `clip timing and source unchanged ${same}; WAV identical ${digest(vocalPath) === hash}`)
  } catch (error) {
    record('pitch mapping check run', false, error instanceof Error ? error.stack ?? error.message : String(error))
  }
  checks.push({ scenario: 'real voice recording', result: 'NOT RUN', detail: 'NOT RUN — NO HARDWARE: no microphone' })
  fs.writeFileSync(path.join(outDir, 'pitchmap-results.json'), JSON.stringify(checks, null, 2))
  for (const check of checks)
    console.log(`${check.result} ${check.scenario} — ${check.detail}`)
  return checks.every((check) => check.result !== 'FAIL') ? 0 : 1
}
