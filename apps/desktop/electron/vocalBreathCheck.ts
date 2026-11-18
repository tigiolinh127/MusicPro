import type { BrowserWindow } from 'electron'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import type { EngineHost } from './engineHost'
import { writeWav24 } from './workflowCheck'

interface BreathRegion {
  id: string
  kind: string
  timelineStart: number
  timelineEnd: number
  gainDb: number
  ignored: boolean
}
interface Clip {
  id: string
  timelineStart: number
  duration: number
  breathRegions?: BreathRegion[]
  breathOriginalSourceFileId?: string
}
interface Track { id: string, name: string, clips: Clip[] }
interface State { tracks: Track[] }
interface Check { scenario: string, result: 'PASS' | 'FAIL' | 'NOT RUN', detail: string }

export interface VocalBreathCheckOptions { outDir: string }

const rate = 48000

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function digest(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

export async function runVocalBreathCheck(win: BrowserWindow, engine: EngineHost, options: VocalBreathCheckOptions): Promise<number> {
  const { outDir } = options
  fs.mkdirSync(outDir, { recursive: true })
  const web = win.webContents
  const checks: Check[] = []
  const vocalPath = path.join(outDir, 'breath-vocal.wav')
  const projectPath = path.join(outDir, 'breath-project.msp.json')

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
    fs.writeFileSync(path.join(outDir, `vocal-breath-${name}.png`), image.toPNG())
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
    // Phrase · silence · breath-like noise · phrase
    writeWav24(vocalPath, rate, rate * 2, (i) => {
      const t = i / rate
      if (t >= 0.1 && t < 0.45)
        return 0.3 * Math.sin(2 * Math.PI * 220 * t)
      if (t >= 0.7 && t < 0.95) {
        const n = ((i * 1103515245 + 12345) >>> 16) / 32768 - 1
        return 0.04 * n
      }
      if (t >= 1.2 && t < 1.6)
        return 0.3 * Math.sin(2 * Math.PI * 330 * t)
      return 0
    }, (i) => {
      const t = i / rate
      if (t >= 0.1 && t < 0.45)
        return 0.3 * Math.sin(2 * Math.PI * 220 * t)
      if (t >= 0.7 && t < 0.95) {
        const n = ((i * 1103515245 + 12345) >>> 16) / 32768 - 1
        return 0.04 * n
      }
      if (t >= 1.2 && t < 1.6)
        return 0.3 * Math.sin(2 * Math.PI * 330 * t)
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
    record('clip imported for breath', clip != null, clip?.id ?? 'missing')

    await reloadPage()
    const breathOn = await press('button[data-mode="breath-edit"]')
    record('Breath Edit mode toggles on', breathOn, breathOn ? 'on' : 'missing button')

    await engine.request('analyzeBreath', { trackId: track.id, clipId: clip.id })
    await reloadPage()
    await press('button[data-mode="breath-edit"]')
    current = await state()
    const regions = current.tracks[0].clips[0].breathRegions ?? []
    record('Analyze creates regions', regions.length >= 1, `regions=${regions.length}`)
    await shot('regions')

    const detected = regions[0]
    if (detected != null) {
      await engine.request('ignoreBreathRegion', {
        trackId: track.id,
        clipId: clip.id,
        regionId: detected.id,
        ignored: true
      })
      current = await state()
      const ignored = (current.tracks[0].clips[0].breathRegions ?? []).find((r) => r.id === detected.id)
      record('ignore region', ignored?.ignored === true, `ignored=${ignored?.ignored}`)
      for (const region of current.tracks[0].clips[0].breathRegions ?? []) {
        await engine.request('removeBreathRegion', {
          trackId: track.id,
          clipId: clip.id,
          regionId: region.id
        })
      }
    } else {
      record('ignore region', false, 'no detected region')
    }

    const addRes = await engine.request('addBreathRegion', {
      trackId: track.id,
      clipId: clip.id,
      timelineStart: 0.5,
      timelineEnd: 0.65,
      gainDb: -6
    })
    current = await state()
    const afterAdd = current.tracks[0].clips[0].breathRegions ?? []
    const manual = afterAdd.find((r) => r.kind === 'manual')
    record('manual region add', addRes.ok === true && manual != null,
      addRes.ok ? `regions=${afterAdd.length}` : String(addRes.error))

    if (manual != null) {
      await engine.request('setBreathRegion', {
        trackId: track.id,
        clipId: clip.id,
        regionId: manual.id,
        timelineStart: 0.52,
        timelineEnd: 0.68,
        gainDb: -12,
        fadeIn: 0.01,
        fadeOut: 0.01
      })
      current = await state()
      const updated = (current.tracks[0].clips[0].breathRegions ?? []).find((r) => r.id === manual.id)
      record('boundary/gain/fade update',
        updated != null && Math.abs(updated.gainDb + 12) < 0.1 && Math.abs(updated.timelineStart - 0.52) < 0.02,
        `gain=${updated?.gainDb} start=${updated?.timelineStart}`)
    } else {
      record('boundary/gain/fade update', false, 'no manual region')
    }

    const preview = await engine.request('previewBreath', { trackId: track.id, clipId: clip.id })
    record('Preview breath', preview.ok === true, preview.ok ? 'ok' : String(preview.error))
    await engine.request('cancelBreathPreview', { trackId: track.id, clipId: clip.id })

    const apply = await engine.request('applyBreath', { trackId: track.id, clipId: clip.id })
    current = await state()
    record('Apply breath', apply.ok === true && !!current.tracks[0].clips[0].breathOriginalSourceFileId,
      apply.ok ? 'applied' : String(apply.error))

    const beforeStart = current.tracks[0].clips[0].timelineStart
    record('Breath mode does not move clip start', Math.abs(beforeStart) < 1e-9, `start=${beforeStart}`)

    await engine.request('revertBreath', { trackId: track.id, clipId: clip.id })
    current = await state()
    record('Revert breath', current.tracks[0].clips[0].breathOriginalSourceFileId == null,
      current.tracks[0].clips[0].breathOriginalSourceFileId ?? 'cleared')

    await engine.request('saveProject', { path: projectPath })
    await engine.request('loadProject', { path: projectPath })
    current = await state()
    record('save/reopen keeps regions',
      (current.tracks[0]?.clips[0]?.breathRegions?.length ?? 0) >= 1,
      `regions=${current.tracks[0]?.clips[0]?.breathRegions?.length ?? 0}`)

    record('source WAV protected', digest(vocalPath) === hash, digest(vocalPath) === hash ? 'unchanged' : 'changed')

    const ui = await js<{ breath: boolean, analyze: boolean }>(`(() => ({
      breath: document.querySelector('button[data-mode="breath-edit"]') != null,
      analyze: document.querySelector('button[data-action="analyze-breath"]') != null
    }))()`)
    record('breath controls present in UI', ui.breath && ui.analyze, JSON.stringify(ui))
    await shot('controls')

    checks.push({ scenario: 'live microphone', result: 'NOT RUN', detail: 'NOT RUN — NO HARDWARE' })
  } catch (error) {
    record('vocal breath check crashed', false, error instanceof Error ? error.message : String(error))
  }

  const summary = {
    pass: checks.filter((c) => c.result === 'PASS').length,
    fail: checks.filter((c) => c.result === 'FAIL').length,
    notRun: checks.filter((c) => c.result === 'NOT RUN').length,
    checks
  }
  fs.writeFileSync(path.join(outDir, 'vocal-breath-summary.json'), JSON.stringify(summary, null, 2))
  console.log(`VOCAL_BREATH_CHECK pass=${summary.pass} fail=${summary.fail} not_run=${summary.notRun}`)
  for (const check of checks)
    console.log(`${check.result}\t${check.scenario}\t${check.detail}`)
  return summary.fail === 0 ? 0 : 1
}
