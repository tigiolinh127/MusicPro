import type { BrowserWindow } from 'electron'
import fs from 'fs'
import path from 'path'
import type { EngineHost } from './engineHost'
import { writeWav24 } from './workflowCheck'

interface Check { scenario: string, result: 'PASS' | 'FAIL' | 'NOT RUN', detail: string }

export interface ClipStretch281CheckOptions { outDir: string }

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function runClipStretch281Check(win: BrowserWindow, engine: EngineHost, options: ClipStretch281CheckOptions): Promise<number> {
  const { outDir } = options
  fs.mkdirSync(outDir, { recursive: true })
  const web = win.webContents
  const checks: Check[] = []
  const consoleErrors: string[] = []

  function record(scenario: string, ok: boolean, detail: string): void {
    checks.push({ scenario, result: ok ? 'PASS' : 'FAIL', detail })
  }

  async function js<T>(code: string): Promise<T> {
    return await web.executeJavaScript(code, true) as T
  }

  async function shot(name: string): Promise<void> {
    web.invalidate()
    await js('new Promise((resolve) => { requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))); setTimeout(() => resolve(false), 500) })')
    await wait(200)
    const image = await web.capturePage()
    fs.writeFileSync(path.join(outDir, `phase281-${name}.png`), image.toPNG())
  }

  const onConsole = (_event: unknown, level: number, message: string): void => {
    if (level >= 3)
      consoleErrors.push(message)
  }
  web.on('console-message', onConsole)

  try {
    await wait(700)
    await js(`(() => {
      const btn = document.querySelector('[data-view="editor"]')
      if (btn instanceof HTMLElement) btn.click()
      return true
    })()`)
    await wait(400)

    const wav = path.join(outDir, 'phase281-tone.wav')
    writeWav24(wav, 48000, 48000, (i) => 0.3 * Math.sin(2 * Math.PI * 440 * i / 48000), (i) => 0.3 * Math.sin(2 * Math.PI * 440 * i / 48000))

    if (engine.startupError != null) {
      record('engine available for stretch', false, engine.startupError)
    } else {
      await engine.request('configure', { sampleRate: 48000, bufferSize: 512 })
      await engine.request('addTrack', { name: 'Stretch 281' })
      const st = (await engine.request('getState')).result as { tracks: Array<{ id: string, name: string }> }
      const trackId = st.tracks.find((t) => t.name === 'Stretch 281')!.id
      await engine.request('importClip', { trackId, path: wav, timelineStart: 0 }, 15000)
      const withClip = (await engine.request('getState')).result as {
        tracks: Array<{ id: string, clips: Array<{ id: string, duration: number }> }>
      }
      const clip = withClip.tracks.find((t) => t.id === trackId)!.clips[0]
      record('clip imported for stretch UI', clip != null && clip.duration > 0.5, JSON.stringify(clip))

      // Select clip in UI via timeline is hard; ensure panel exists and drive engine + refresh
      await js(`(() => {
        const btn = document.querySelector('[data-view="editor"]')
        if (btn instanceof HTMLElement) btn.click()
        return true
      })()`)
      await wait(500)

      // Force a getState refresh by poking transport
      await engine.request('transport', { action: 'seek', position: 0 })
      await wait(400)

      const ui = await js<{ panel: boolean, ratio: boolean, preview: boolean, apply: boolean }>(`(() => ({
        panel: document.querySelector('[data-panel="clip-stretch-281"]') != null,
        ratio: document.querySelector('[data-action="stretch-ratio"]') != null,
        preview: document.querySelector('[data-action="stretch-preview"]') != null,
        apply: document.querySelector('[data-action="stretch-apply"]') != null
      }))()`)
      record('clip stretch inspector controls present', ui.panel && ui.ratio && ui.preview && ui.apply, JSON.stringify(ui))

      await engine.request('applyClipStretch', { trackId, clipId: clip.id, mode: 'timeStretch', ratio: 1.25 }, 60000)
      const after = (await engine.request('getState')).result as {
        tracks: Array<{ id: string, clips: Array<{ duration: number, stretchMode?: string, stretchRatio?: number, stretchOriginalDuration?: number }> }>
      }
      const aClip = after.tracks.find((t) => t.id === trackId)!.clips[0]
      record('apply stretch updates duration + metadata', aClip.stretchMode === 'timeStretch'
        && Math.abs((aClip.stretchRatio ?? 0) - 1.25) < 1e-6
        && Math.abs(aClip.duration - clip.duration * 1.25) < 0.08,
        JSON.stringify(aClip))

      await engine.request('undo')
      const undone = (await engine.request('getState')).result as typeof after
      const uClip = undone.tracks.find((t) => t.id === trackId)!.clips[0]
      record('undo restores clip duration', Math.abs(uClip.duration - clip.duration) < 0.05 && !uClip.stretchMode,
        JSON.stringify(uClip))

      await engine.request('applyClipStretch', { trackId, clipId: clip.id, mode: 'speed', ratio: 2 }, 60000)
      const sped = (await engine.request('getState')).result as typeof after
      const sClip = sped.tracks.find((t) => t.id === trackId)!.clips[0]
      record('speed mode halves duration', sClip.stretchMode === 'speed' && Math.abs(sClip.duration - clip.duration * 0.5) < 0.08,
        JSON.stringify(sClip))

      await engine.request('revertClipStretch', { trackId, clipId: clip.id })
      const rev = (await engine.request('getState')).result as typeof after
      const rClip = rev.tracks.find((t) => t.id === trackId)!.clips[0]
      record('revert restores original', Math.abs(rClip.duration - clip.duration) < 0.05, JSON.stringify(rClip))

      const exportPath = path.join(outDir, 'phase281-export.wav')
      await engine.request('applyClipStretch', { trackId, clipId: clip.id, mode: 'timeStretch', ratio: 0.9 }, 60000)
      const exp = await engine.request('exportWav', { path: exportPath, sampleRate: 48000 }, 60000)
      record('export after stretch succeeds', exp.ok === true && fs.existsSync(exportPath), String(exp.error ?? exportPath))
    }

    const victimPath = process.env.MUSICSTUDIO_ENGINE
      ?? path.resolve(__dirname, '../../../../build/MusicStudioEngine.exe')
    const { EngineHost } = await import('./engineHost')
    const victim = new EngineHost(victimPath)
    await victim.request('ping', {}, 5000).catch(() => undefined)
    victim.forceKill()
    await wait(200)
    const dead = await victim.request('applyClipStretch', { trackId: 'x', clipId: 'y', mode: 'speed', ratio: 1.1 }, 2000).then(
      () => ({ ok: false, detail: 'unexpected ok' }),
      (error: Error) => ({ ok: !/EPIPE/i.test(error.message), detail: error.message })
    )
    record('engine unavailable rejects without EPIPE', dead.ok, dead.detail)
    await victim.shutdown()

    await shot('clip-stretch-panel')
    record('no renderer console errors', consoleErrors.length === 0, consoleErrors.length === 0 ? 'none' : consoleErrors.slice(0, 4).join(' | '))
    checks.push({ scenario: 'live microphone', result: 'NOT RUN', detail: 'NOT RUN — NO HARDWARE' })
    checks.push({ scenario: 'edge-drag stretch handle', result: 'NOT RUN', detail: 'Deferred — conflicts with trim/fade hit targets; inspector controls only' })
  } catch (error) {
    record('clip stretch 281 check crashed', false, error instanceof Error ? error.message : String(error))
  } finally {
    web.removeListener('console-message', onConsole)
  }

  const summary = {
    pass: checks.filter((c) => c.result === 'PASS').length,
    fail: checks.filter((c) => c.result === 'FAIL').length,
    notRun: checks.filter((c) => c.result === 'NOT RUN').length,
    checks
  }
  fs.writeFileSync(path.join(outDir, 'phase281-summary.json'), JSON.stringify(summary, null, 2))
  console.log(`CLIP_STRETCH_281_CHECK pass=${summary.pass} fail=${summary.fail} not_run=${summary.notRun}`)
  for (const check of checks)
    console.log(`${check.result}\t${check.scenario}\t${check.detail}`)
  return summary.fail === 0 ? 0 : 1
}
