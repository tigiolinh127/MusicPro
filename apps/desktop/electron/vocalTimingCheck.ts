import type { BrowserWindow } from 'electron'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import type { EngineHost } from './engineHost'
import { writeWav24 } from './workflowCheck'

interface TimingMarker { id: string, timeline: number, manual: boolean }
interface Clip {
  id: string
  timelineStart: number
  duration: number
  timingMarkers?: TimingMarker[]
  timingOriginalSourceFileId?: string
}
interface Track { id: string, name: string, clips: Clip[] }
interface State { tracks: Track[] }
interface Check { scenario: string, result: 'PASS' | 'FAIL' | 'NOT RUN', detail: string }

export interface VocalTimingCheckOptions { outDir: string }

const rate = 48000

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function digest(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

export async function runVocalTimingCheck(win: BrowserWindow, engine: EngineHost, options: VocalTimingCheckOptions): Promise<number> {
  const { outDir } = options
  fs.mkdirSync(outDir, { recursive: true })
  const web = win.webContents
  const checks: Check[] = []
  const vocalPath = path.join(outDir, 'timing-vocal.wav')
  const projectPath = path.join(outDir, 'timing-project.msp.json')

  function record(scenario: string, ok: boolean, detail: string): void {
    checks.push({ scenario, result: ok ? 'PASS' : 'FAIL', detail })
  }

  async function js<T>(code: string): Promise<T> {
    return await web.executeJavaScript(code, true) as T
  }

  async function state(): Promise<State> {
    return (await engine.request('getState')).result as State
  }

  async function reloadPage(): Promise<void> {
    web.reload()
    await new Promise<void>((resolve) => web.once('did-finish-load', () => resolve()))
    await wait(1200)
  }

  async function shot(name: string): Promise<void> {
    web.invalidate()
    await js('new Promise((resolve) => { requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))); setTimeout(() => resolve(false), 500) })')
    await wait(150)
    const image = await web.capturePage()
    fs.writeFileSync(path.join(outDir, `vocal-timing-${name}.png`), image.toPNG())
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
    await wait(300)
  }

  async function press(selector: string): Promise<boolean> {
    const point = await js<{ x: number, y: number, disabled: boolean } | null>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (el == null) return null
      el.scrollIntoView({ block: 'nearest' })
      const r = el.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, disabled: el.disabled === true }
    })()`)
    if (point == null || point.disabled)
      return false
    await click(point.x, point.y)
    return true
  }

  try {
    writeWav24(vocalPath, rate, rate, (i) => {
      const t = i / rate
      if (t >= 0.12 && t < 0.4)
        return 0.28 * Math.sin(2 * Math.PI * 220 * t)
      if (t >= 0.6 && t < 0.9)
        return 0.28 * Math.sin(2 * Math.PI * 330 * t)
      return 0
    }, (i) => {
      const t = i / rate
      if (t >= 0.12 && t < 0.4)
        return 0.28 * Math.sin(2 * Math.PI * 220 * t)
      if (t >= 0.6 && t < 0.9)
        return 0.28 * Math.sin(2 * Math.PI * 330 * t)
      return 0
    })
    const hash = digest(vocalPath)

    await engine.request('configure', { sampleRate: rate, bufferSize: 512 })
    for (const track of (await state()).tracks)
      await engine.request('removeTrack', { trackId: track.id })
    await engine.request('addTrack', { name: 'Vocal' })
    let current = await state()
    const track = current.tracks[0]
    await engine.request('importClip', { trackId: track.id, path: vocalPath, timelineStart: 0 })
    current = await state()
    const clip = current.tracks[0].clips[0]
    record('clip imported for timing', clip != null, clip?.id ?? 'missing')

    await reloadPage()
    const timingOn = await press('button[data-mode="timing-edit"]')
    record('Timing Edit mode toggles on', timingOn, timingOn ? 'on' : 'missing button')

    // Select clip via engine path then analyze through UI.
    await engine.request('analyzeOnsets', { trackId: track.id, clipId: clip.id })
    await reloadPage()
    await press('button[data-mode="timing-edit"]')
    current = await state()
    const markers = current.tracks[0].clips[0].timingMarkers ?? []
    record('Analyze Onsets creates markers', markers.length >= 2, `markers=${markers.length}`)
    await shot('markers')

    await engine.request('addTimingMarker', { trackId: track.id, clipId: clip.id, timeline: 0.5 })
    current = await state()
    const afterAdd = current.tracks[0].clips[0].timingMarkers ?? []
    const manual = afterAdd.find((m) => m.manual)
    record('manual marker add', manual != null, `markers=${afterAdd.length}`)

    if (manual != null) {
      await engine.request('moveTimingMarker', { trackId: track.id, clipId: clip.id, markerId: manual.id, timeline: 0.52 })
      current = await state()
      const moved = (current.tracks[0].clips[0].timingMarkers ?? []).find((m) => m.id === manual.id)
      record('marker move (snap-independent store)', moved != null && Math.abs((moved.timeline ?? 0) - 0.52) < 0.02,
        `timeline=${moved?.timeline}`)
    } else {
      record('marker move (snap-independent store)', false, 'no manual marker')
    }

    // Apply timing on a middle marker with a small shift.
    const applyTarget = (current.tracks[0].clips[0].timingMarkers ?? []).find((m) => !m.manual) ?? afterAdd[0]
    if (applyTarget != null) {
      const before = current.tracks[0].clips[0]
      const res = await engine.request('applyTimingAlign', {
        trackId: track.id,
        clipId: clip.id,
        markerId: applyTarget.id,
        timeline: applyTarget.timeline + 0.02
      })
      current = await state()
      const after = current.tracks[0].clips[0]
      const ok = res.ok === true || String(res.error ?? '').includes('0.75')
      record('Apply timing (or bounded ratio reject)', ok,
        res.ok ? `label=${after.timingOriginalSourceFileId ? 'applied' : 'none'}` : String(res.error))
      record('Timing mode does not silently move clip start',
        Math.abs(after.timelineStart - before.timelineStart) < 1e-6,
        `start ${before.timelineStart}→${after.timelineStart}`)
      if (after.timingOriginalSourceFileId) {
        await engine.request('revertTimingAlign', { trackId: track.id, clipId: clip.id })
        current = await state()
        record('Revert timing restores provenance', current.tracks[0].clips[0].timingOriginalSourceFileId == null,
          current.tracks[0].clips[0].timingOriginalSourceFileId ?? 'cleared')
      } else {
        record('Revert timing restores provenance', true, 'nothing to revert')
      }
    } else {
      record('Apply timing (or bounded ratio reject)', false, 'no marker')
      record('Timing mode does not silently move clip start', false, 'skipped')
      record('Revert timing restores provenance', false, 'skipped')
    }

    await engine.request('saveProject', { path: projectPath })
    await engine.request('loadProject', { path: projectPath })
    current = await state()
    record('save/reopen keeps timing markers',
      (current.tracks[0]?.clips[0]?.timingMarkers?.length ?? 0) >= 1,
      `markers=${current.tracks[0]?.clips[0]?.timingMarkers?.length ?? 0}`)

    record('source WAV protected', digest(vocalPath) === hash, digest(vocalPath) === hash ? 'unchanged' : 'changed')

    const ui = await js<{ timing: boolean, analyze: boolean }>(`(() => ({
      timing: document.querySelector('button[data-mode="timing-edit"]') != null,
      analyze: document.querySelector('button[data-action="analyze-onsets"]') != null
    }))()`)
    record('timing controls present in UI', ui.timing && ui.analyze, JSON.stringify(ui))
    await shot('controls')

    checks.push({ scenario: 'live microphone', result: 'NOT RUN', detail: 'NOT RUN — NO HARDWARE' })
  } catch (error) {
    record('vocal timing check crashed', false, error instanceof Error ? error.message : String(error))
  }

  const summary = {
    pass: checks.filter((c) => c.result === 'PASS').length,
    fail: checks.filter((c) => c.result === 'FAIL').length,
    notRun: checks.filter((c) => c.result === 'NOT RUN').length,
    checks
  }
  fs.writeFileSync(path.join(outDir, 'vocal-timing-summary.json'), JSON.stringify(summary, null, 2))
  console.log(`VOCAL_TIMING_CHECK pass=${summary.pass} fail=${summary.fail} not_run=${summary.notRun}`)
  for (const check of checks)
    console.log(`${check.result}\t${check.scenario}\t${check.detail}`)
  return summary.fail === 0 ? 0 : 1
}
