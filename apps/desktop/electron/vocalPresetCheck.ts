import type { BrowserWindow } from 'electron'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import type { EngineHost } from './engineHost'
import { writeWav24 } from './workflowCheck'

interface Effect { id: string, type: string, enabled: boolean }
interface Track {
  id: string
  effects: Effect[]
  vocalPresetId?: string
  vocalPresetBypassed?: boolean
  clips: Array<{ id: string, timingMarkers?: unknown[], breathRegions?: unknown[] }>
}
interface Preset { id: string, name: string, factory: boolean }
interface State { tracks: Track[], vocalPresets?: Preset[] }
interface Check { scenario: string, result: 'PASS' | 'FAIL' | 'NOT RUN', detail: string }

export interface VocalPresetCheckOptions { outDir: string }

const rate = 48000

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function digest(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

export async function runVocalPresetCheck(win: BrowserWindow, engine: EngineHost, options: VocalPresetCheckOptions): Promise<number> {
  const { outDir } = options
  fs.mkdirSync(outDir, { recursive: true })
  const web = win.webContents
  const checks: Check[] = []
  const vocalPath = path.join(outDir, 'preset-vocal.wav')
  const projectPath = path.join(outDir, 'preset-project.msp.json')

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
    fs.writeFileSync(path.join(outDir, `vocal-preset-${name}.png`), image.toPNG())
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

  try {
    writeWav24(vocalPath, rate, rate, (i) => 0.2 * Math.sin(2 * Math.PI * 220 * i / rate), (i) => 0.2 * Math.sin(2 * Math.PI * 220 * i / rate))
    const hash = digest(vocalPath)

    await engine.request('configure', { sampleRate: rate, bufferSize: 512 })
    for (const track of (await state()).tracks)
      await engine.request('removeTrack', { trackId: track.id })
    await engine.request('addTrack', { name: 'Vocal' })
    let current = await state()
    const track = current.tracks[0]
    await engine.request('importClip', { trackId: track.id, path: vocalPath, timelineStart: 0 })
    current = await state()
    record('clip imported', current.tracks[0]?.clips?.length === 1, `clips=${current.tracks[0]?.clips?.length ?? 0}`)

    const factories = (current.vocalPresets ?? []).filter((p) => p.factory)
    record('factory presets present', factories.length >= 6, `factory=${factories.length}`)

    const clean = factories.find((p) => p.name === 'Clean Vocal') ?? factories[0]
    const apply1 = await engine.request('applyVocalPreset', { trackId: track.id, presetId: clean.id })
    current = await state()
    const count1 = current.tracks[0].effects.length
    record('Apply preset', apply1.ok === true && count1 >= 1 && current.tracks[0].vocalPresetId === clean.id,
      apply1.ok ? `effects=${count1}` : String(apply1.error))

    const apply2 = await engine.request('applyVocalPreset', { trackId: track.id, presetId: clean.id })
    current = await state()
    record('Repeated Apply does not duplicate', apply2.ok === true && current.tracks[0].effects.length === count1,
      `effects=${current.tracks[0].effects.length}`)

    await engine.request('bypassVocalPreset', { trackId: track.id, bypassed: true })
    current = await state()
    record('Bypass disables effects', current.tracks[0].vocalPresetBypassed === true
      && current.tracks[0].effects.every((e) => !e.enabled), 'bypassed')

    await engine.request('bypassVocalPreset', { trackId: track.id, bypassed: false })
    await engine.request('revertVocalPreset', { trackId: track.id })
    current = await state()
    record('Revert clears preset', current.tracks[0].vocalPresetId == null || current.tracks[0].vocalPresetId === '',
      current.tracks[0].vocalPresetId ?? 'cleared')

    await engine.request('applyVocalPreset', { trackId: track.id, presetId: clean.id })
    const saveCustom = await engine.request('saveCustomVocalPreset', { trackId: track.id, name: 'My Vocal' })
    current = await state()
    const custom = (current.vocalPresets ?? []).find((p) => !p.factory && p.name === 'My Vocal')
    record('Save custom preset', saveCustom.ok === true && custom != null, custom?.id ?? String(saveCustom.error))

    const bad = await engine.request('deleteCustomVocalPreset', { presetId: clean.id })
    record('Factory delete refused', bad.ok === false, String(bad.error))

    await engine.request('saveProject', { path: projectPath })
    await engine.request('loadProject', { path: projectPath })
    current = await state()
    record('save/reopen keeps custom + track preset',
      (current.vocalPresets ?? []).some((p) => p.name === 'My Vocal')
      && (current.tracks[0]?.vocalPresetId?.length ?? 0) > 0,
      `presets=${current.vocalPresets?.length ?? 0}`)

    record('source WAV protected', digest(vocalPath) === hash, digest(vocalPath) === hash ? 'unchanged' : 'changed')

    await reloadPage()
    // Select the vocal clip so the inspector binds a track (presets also fall back to tracks[0]).
    await js(`(() => {
      const clip = document.querySelector('.clip')
      if (clip instanceof HTMLElement) clip.click()
      return true
    })()`)
    await wait(400)
    const ui = await js<{ panel: boolean, select: boolean, apply: boolean }>(`(() => ({
      panel: document.querySelector('[data-panel="vocal-presets"]') != null,
      select: document.querySelector('[data-action="vocal-preset-select"]') != null,
      apply: document.querySelector('[data-action="vocal-preset-apply"]') != null
    }))()`)
    record('Vocal Presets UI present', ui.panel && ui.select && ui.apply, JSON.stringify(ui))
    await shot('panel')

    // Click apply via UI if possible
    const point = await js<{ x: number, y: number } | null>(`(() => {
      const el = document.querySelector('[data-action="vocal-preset-apply"]')
      if (el == null) return null
      el.scrollIntoView({ block: 'nearest' })
      const r = el.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    })()`)
    if (point != null) {
      await click(point.x, point.y)
      record('UI Apply control clickable', true, 'clicked')
    } else {
      record('UI Apply control clickable', false, 'missing')
    }
    await shot('controls')

    checks.push({ scenario: 'live microphone', result: 'NOT RUN', detail: 'NOT RUN — NO HARDWARE' })
  } catch (error) {
    record('vocal preset check crashed', false, error instanceof Error ? error.message : String(error))
  }

  const summary = {
    pass: checks.filter((c) => c.result === 'PASS').length,
    fail: checks.filter((c) => c.result === 'FAIL').length,
    notRun: checks.filter((c) => c.result === 'NOT RUN').length,
    checks
  }
  fs.writeFileSync(path.join(outDir, 'vocal-preset-summary.json'), JSON.stringify(summary, null, 2))
  console.log(`VOCAL_PRESET_CHECK pass=${summary.pass} fail=${summary.fail} not_run=${summary.notRun}`)
  for (const check of checks)
    console.log(`${check.result}\t${check.scenario}\t${check.detail}`)
  return summary.fail === 0 ? 0 : 1
}
