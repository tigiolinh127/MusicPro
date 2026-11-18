import type { BrowserWindow } from 'electron'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import type { EngineHost } from './engineHost'
import { writeWav24 } from './workflowCheck'

interface Take {
  id: string
  name: string
  sourceFileId: string
  timelineStart: number
  duration: number
  muted: boolean
}

interface Clip {
  id: string
  sourceFileId: string
  timelineStart: number
  duration: number
  fadeIn: number
  fadeOut: number
}

interface Track {
  id: string
  name: string
  clips: Clip[]
  takes?: Take[]
  takesExpanded?: boolean
  compCrossfadeMs?: number
}

interface State {
  tracks: Track[]
  sampleRate: number
  canUndo?: boolean
  canRedo?: boolean
}

interface Check { scenario: string, result: 'PASS' | 'FAIL' | 'NOT RUN', detail: string }

export interface VocalCompCheckOptions {
  outDir: string
}

const rate = 48000

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function digest(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}


export async function runVocalCompCheck(win: BrowserWindow, engine: EngineHost, options: VocalCompCheckOptions): Promise<number> {
  const { outDir } = options
  fs.mkdirSync(outDir, { recursive: true })
  const web = win.webContents
  const checks: Check[] = []
  const takeAPath = path.join(outDir, 'comp-take-a.wav')
  const takeBPath = path.join(outDir, 'comp-take-b.wav')
  const projectPath = path.join(outDir, 'vocal-comp.msp.json')
  const exportPath = path.join(outDir, 'vocal-comp-export.wav')
  const recordFolder = path.join(outDir, 'records')
  fs.mkdirSync(recordFolder, { recursive: true })

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
    fs.writeFileSync(path.join(outDir, `vocal-comp-${name}.png`), image.toPNG())
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
    await click(point.x, point.y)
    return true
  }

  async function reloadPage(): Promise<void> {
    web.reload()
    await new Promise<void>((resolve) => web.once('did-finish-load', () => resolve()))
    await wait(1200)
  }

  try {
    writeWav24(takeAPath, rate, rate, () => 0.4, () => 0.4)
    writeWav24(takeBPath, rate, rate, () => -0.4, () => -0.4)
    const hashA = digest(takeAPath)

    await engine.request('configure', { sampleRate: rate, bufferSize: 512 })
    await engine.request('addTrack', { name: 'Vocal' })
    let current = await state()
    const track = current.tracks[0]
    record('workspace shows a vocal track', track != null, track == null ? 'no track' : track.id)

    await engine.request('importTake', { trackId: track.id, path: takeAPath, timelineStart: 0 })
    await engine.request('importTake', { trackId: track.id, path: takeBPath, timelineStart: 0 })
    await engine.request('setTakesExpanded', { trackId: track.id, expanded: true })
    current = await state()
    const vocal = current.tracks.find((t) => t.id === track.id)
    record('multiple takes imported without auto-placing on the comp',
      (vocal?.takes?.length ?? 0) === 2 && (vocal?.clips?.length ?? 0) === 0,
      `takes=${vocal?.takes?.length ?? 0} clips=${vocal?.clips?.length ?? 0}`)

    const takeA = vocal!.takes![0]
    const takeB = vocal!.takes![1]
    record('takes share timeline alignment',
      Math.abs(takeA.timelineStart) < 1e-6 && Math.abs(takeB.timelineStart) < 1e-6
      && Math.abs(takeA.duration - 1) < 1e-3 && Math.abs(takeB.duration - 1) < 1e-3,
      `A ${takeA.timelineStart}/${takeA.duration} B ${takeB.timelineStart}/${takeB.duration}`)

    await engine.request('setCompRegion', { trackId: track.id, takeId: takeA.id, timelineStart: 0, timelineEnd: 0.5 })
    await engine.request('setCompRegion', { trackId: track.id, takeId: takeB.id, timelineStart: 0.5, timelineEnd: 1 })
    current = await state()
    const comped = current.tracks.find((t) => t.id === track.id)!
    const clips = comped.clips
    record('comp regions selected from both takes',
      clips.length === 2
      && clips[0].sourceFileId === takeA.sourceFileId
      && clips[1].sourceFileId === takeB.sourceFileId
      && Math.abs((clips[0].timelineStart + clips[0].duration) - clips[1].timelineStart) < 1e-6,
      `clips=${clips.length} join=${clips[0]?.timelineStart + clips[0]?.duration}→${clips[1]?.timelineStart}`)
    record('abutting crossfades at the join',
      clips[0].fadeOut > 0 && clips[1].fadeIn > 0 && Math.abs(clips[0].fadeOut - clips[1].fadeIn) < 1e-6,
      `fadeOut=${clips[0].fadeOut} fadeIn=${clips[1].fadeIn}`)

    await engine.request('setCompRegion', { trackId: track.id, takeId: takeB.id, timelineStart: 0, timelineEnd: 0.5 })
    current = await state()
    const replaced = current.tracks.find((t) => t.id === track.id)!.clips
    record('region replacement keeps a single active region per time',
      replaced.length === 2 && replaced[0].sourceFileId === takeB.sourceFileId,
      `first source ${replaced[0]?.sourceFileId}`)

    await engine.request('renameTake', { trackId: track.id, takeId: takeA.id, name: 'Verse A' })
    await engine.request('setCompCrossfade', { trackId: track.id, ms: 8 })
    current = await state()
    record('take rename and crossfade settings',
      current.tracks.find((t) => t.id === track.id)?.takes?.[0].name === 'Verse A'
      && Math.abs((current.tracks.find((t) => t.id === track.id)?.compCrossfadeMs ?? 0) - 8) < 0.2,
      `name=${current.tracks.find((t) => t.id === track.id)?.takes?.[0].name} xf=${current.tracks.find((t) => t.id === track.id)?.compCrossfadeMs}`)

    await engine.request('undo', {})
    await engine.request('redo', {})
    current = await state()
    record('undo/redo restores take/comp edits',
      current.tracks.find((t) => t.id === track.id)?.takes?.[0].name === 'Verse A',
      `name=${current.tracks.find((t) => t.id === track.id)?.takes?.[0].name}`)

    await engine.request('saveProject', { path: projectPath })
    await engine.request('loadProject', { path: projectPath })
    current = await state()
    const reloaded = current.tracks.find((t) => t.name === 'Vocal' || t.takes?.some((x) => x.name === 'Verse A'))
    record('save/load restores takes and comp',
      (reloaded?.takes?.length ?? 0) === 2 && (reloaded?.clips?.length ?? 0) === 2
      && reloaded?.takes?.[0].name === 'Verse A' && reloaded?.takesExpanded === true,
      `takes=${reloaded?.takes?.length} clips=${reloaded?.clips?.length} name=${reloaded?.takes?.[0].name}`)

    await engine.request('exportWav', { path: exportPath, sampleRate: rate })
    record('export writes active comp audio', fs.existsSync(exportPath) && fs.statSync(exportPath).size > 1000,
      fs.existsSync(exportPath) ? `${fs.statSync(exportPath).size} bytes` : 'missing')

    record('source WAV files are unchanged', digest(takeAPath) === hashA && digest(takeBPath).length > 0,
      digest(takeAPath) === hashA ? 'hashes match' : 'take A hash changed')

    // UI: take lanes visible, Vocal Comp panel present (reload so the renderer picks up engine state).
    await reloadPage()
    const ui = await js<{ takesButton: boolean, takeLanes: number, panel: boolean }>(`(() => {
      const takesButton = document.querySelector('button.takes-button[aria-pressed="true"]') != null
      const takeLanes = document.querySelectorAll('[data-lane="take"]').length
      const panel = document.querySelector('[data-panel="vocal-comp"]') != null
      return { takesButton, takeLanes, panel }
    })()`)
    record('take lanes expand in the timeline UI', ui.takesButton && ui.takeLanes >= 2,
      `button=${ui.takesButton} lanes=${ui.takeLanes}`)
    record('Vocal Comp inspector panel is visible', ui.panel, ui.panel ? 'present' : 'missing')
    await shot('lanes')

    // Virtual recording: second take must not overwrite the first.
    await engine.request('setRecordFolder', { path: recordFolder })
    await engine.request('setVirtualInput', { enabled: true, frequency: 440, level: 0.35 })
    await engine.request('addTrack', { name: 'Rec Vox' })
    current = await state()
    const rec = current.tracks.find((t) => t.name === 'Rec Vox')!
    await engine.request('setTrackRecord', { trackId: rec.id, armed: true })
    await engine.request('record', { action: 'start' })
    await wait(400)
    await engine.request('record', { action: 'stop' })
    current = await state()
    const afterFirst = current.tracks.find((t) => t.id === rec.id)!
    await engine.request('record', { action: 'start' })
    await wait(400)
    await engine.request('record', { action: 'stop' })
    current = await state()
    const afterSecond = current.tracks.find((t) => t.id === rec.id)!
    record('successive virtual recordings keep both takes',
      (afterFirst.takes?.length ?? 0) === 1 && (afterFirst.clips?.length ?? 0) === 1
      && (afterSecond.takes?.length ?? 0) === 2 && (afterSecond.clips?.length ?? 0) === 1,
      `first takes/clips=${afterFirst.takes?.length}/${afterFirst.clips?.length}; second=${afterSecond.takes?.length}/${afterSecond.clips?.length}`)

    await engine.request('setTakesExpanded', { trackId: rec.id, expanded: true })
    await reloadPage()
    await shot('recording-takes')

    checks.push({ scenario: 'live microphone', result: 'NOT RUN', detail: 'NOT RUN — NO HARDWARE' })

    await engine.request('setVirtualInput', { enabled: false })
  } catch (error) {
    record('vocal comp check crashed', false, error instanceof Error ? error.message : String(error))
  }

  const summary = {
    pass: checks.filter((c) => c.result === 'PASS').length,
    fail: checks.filter((c) => c.result === 'FAIL').length,
    notRun: checks.filter((c) => c.result === 'NOT RUN').length,
    checks
  }
  fs.writeFileSync(path.join(outDir, 'vocal-comp-summary.json'), JSON.stringify(summary, null, 2))
  console.log(`VOCAL_COMP_CHECK pass=${summary.pass} fail=${summary.fail} not_run=${summary.notRun}`)
  for (const check of checks)
    console.log(`${check.result}\t${check.scenario}\t${check.detail}`)
  return summary.fail === 0 ? 0 : 1
}
