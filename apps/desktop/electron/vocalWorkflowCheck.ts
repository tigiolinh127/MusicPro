import type { BrowserWindow } from 'electron'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import type { EngineHost } from './engineHost'
import { writeWav24 } from './workflowCheck'

interface Clip {
  id: string
  timingOriginalSourceFileId?: string
  breathOriginalSourceFileId?: string
  originalSourceFileId?: string
}
interface Track {
  id: string
  clips: Clip[]
  takes?: unknown[]
  vocalPresetId?: string
  effects: unknown[]
}
interface Workflow {
  order?: string[]
  previews?: { pitch?: boolean, breath?: boolean, preset?: boolean }
  liveAutoTuneInExport?: boolean
  note?: string
}
interface State {
  tracks: Track[]
  vocalWorkflow?: Workflow
  vocalPresets?: unknown[]
}
interface Check { scenario: string, result: 'PASS' | 'FAIL' | 'NOT RUN', detail: string }

export interface VocalWorkflowCheckOptions { outDir: string }

const rate = 48000

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function digest(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

export async function runVocalWorkflowCheck(win: BrowserWindow, engine: EngineHost, options: VocalWorkflowCheckOptions): Promise<number> {
  const { outDir } = options
  fs.mkdirSync(outDir, { recursive: true })
  const web = win.webContents
  const checks: Check[] = []
  const vocalPath = path.join(outDir, 'workflow-vocal.wav')
  const projectPath = path.join(outDir, 'workflow-project.msp.json')
  const exportPath = path.join(outDir, 'workflow-export.wav')

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
    fs.writeFileSync(path.join(outDir, `vocal-workflow-${name}.png`), image.toPNG())
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

    const workflow = current.vocalWorkflow
    record('vocalWorkflow in getState',
      workflow != null
      && (workflow.order?.length ?? 0) >= 7
      && workflow.liveAutoTuneInExport === false
      && typeof workflow.note === 'string',
      JSON.stringify({ order: workflow?.order?.length, live: workflow?.liveAutoTuneInExport }))

    await engine.request('importTake', { trackId: track.id, path: vocalPath, timelineStart: 0 })
    current = await state()
    record('multi-take with comp clip',
      (current.tracks[0].takes?.length ?? 0) >= 1 && current.tracks[0].clips.length === 1,
      `takes=${current.tracks[0].takes?.length ?? 0}`)

    const clipId = current.tracks[0].clips[0].id
    await engine.request('analyzeOnsets', { trackId: track.id, clipId })
    await engine.request('analyzeBreath', { trackId: track.id, clipId })
    await engine.request('applyVocalPreset', { trackId: track.id, presetId: 'factory-clean-vocal' })
    current = await state()
    record('preset after analysis stages',
      (current.tracks[0].vocalPresetId?.length ?? 0) > 0 && current.tracks[0].effects.length >= 1,
      current.tracks[0].vocalPresetId ?? 'none')

    await engine.request('previewVocalPreset', { trackId: track.id, presetId: 'factory-warm-vocal' })
    current = await state()
    record('preset preview flagged', current.vocalWorkflow?.previews?.preset === true, JSON.stringify(current.vocalWorkflow?.previews))

    const exported = await engine.request('exportWav', { path: exportPath })
    current = await state()
    record('export succeeds with preview ended',
      exported.ok === true && current.vocalWorkflow?.previews?.preset === false,
      exported.ok ? 'ended' : String(exported.error))

    await engine.request('saveProject', { path: projectPath })
    await engine.request('loadProject', { path: projectPath })
    current = await state()
    record('save/reopen keeps preset + clips',
      (current.tracks[0]?.vocalPresetId?.length ?? 0) > 0 && (current.tracks[0]?.clips?.length ?? 0) === 1,
      current.tracks[0]?.vocalPresetId ?? 'missing')

    record('source WAV protected', digest(vocalPath) === hash, digest(vocalPath) === hash ? 'unchanged' : 'changed')

    await reloadPage()
    await js(`(() => {
      const clip = document.querySelector('.clip')
      if (clip instanceof HTMLElement) clip.click()
      return true
    })()`)
    await wait(400)
    const ui = await js<{ panel: boolean, stages: number, timing: boolean, mix: boolean }>(`(() => {
      const panel = document.querySelector('[data-panel="vocal-workflow"]')
      const stages = document.querySelectorAll('[data-panel="vocal-workflow"] [data-stage]')
      return {
        panel: panel != null,
        stages: stages.length,
        timing: document.querySelector('[data-action="workflow-stage-timing"]') != null,
        mix: document.querySelector('[data-action="workflow-stage-mix"]') != null
      }
    })()`)
    record('Vocal Workflow UI present', ui.panel && ui.stages >= 7 && ui.timing && ui.mix, JSON.stringify(ui))
    await shot('panel')

    await js(`(() => {
      const btn = document.querySelector('[data-action="workflow-stage-presets"]')
      if (btn instanceof HTMLElement) btn.click()
      return true
    })()`)
    await wait(300)
    const stage = await js<{ selected: boolean }>(`(() => ({
      selected: document.querySelector('[data-stage="presets"].selected') != null
    }))()`)
    record('stage navigation selects presets', stage.selected, JSON.stringify(stage))
    await shot('stages')

    checks.push({ scenario: 'live microphone', result: 'NOT RUN', detail: 'NOT RUN — NO HARDWARE' })
  } catch (error) {
    record('vocal workflow check crashed', false, error instanceof Error ? error.message : String(error))
  }

  const summary = {
    pass: checks.filter((c) => c.result === 'PASS').length,
    fail: checks.filter((c) => c.result === 'FAIL').length,
    notRun: checks.filter((c) => c.result === 'NOT RUN').length,
    checks
  }
  fs.writeFileSync(path.join(outDir, 'vocal-workflow-summary.json'), JSON.stringify(summary, null, 2))
  console.log(`VOCAL_WORKFLOW_CHECK pass=${summary.pass} fail=${summary.fail} not_run=${summary.notRun}`)
  for (const check of checks)
    console.log(`${check.result}\t${check.scenario}\t${check.detail}`)
  return summary.fail === 0 ? 0 : 1
}
