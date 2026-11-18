import type { BrowserWindow } from 'electron'
import fs from 'fs'
import path from 'path'
import type { EngineHost } from './engineHost'
import { writeWav24 } from './workflowCheck'

interface Check { scenario: string, result: 'PASS' | 'FAIL' | 'NOT RUN', detail: string }

export interface Crossfade282CheckOptions { outDir: string }

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function runCrossfade282Check(win: BrowserWindow, engine: EngineHost, options: Crossfade282CheckOptions): Promise<number> {
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
    fs.writeFileSync(path.join(outDir, `phase282-${name}.png`), image.toPNG())
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

    const wav = path.join(outDir, 'phase282-tone.wav')
    writeWav24(wav, 48000, 48000, (i) => 0.3 * Math.sin(2 * Math.PI * 440 * i / 48000), (i) => 0.3 * Math.sin(2 * Math.PI * 440 * i / 48000))

    if (engine.startupError != null) {
      record('engine available for crossfade', false, engine.startupError)
    } else {
      await engine.request('configure', { sampleRate: 48000, bufferSize: 512 })
      await engine.request('addTrack', { name: 'Crossfade 282' })
      const st = (await engine.request('getState')).result as { tracks: Array<{ id: string, name: string }> }
      const trackId = st.tracks.find((t) => t.name === 'Crossfade 282')!.id
      await engine.request('importClip', { trackId, path: wav, timelineStart: 0 }, 15000)
      await engine.request('importClip', { trackId, path: wav, timelineStart: 0.9 }, 15000)
      const withClips = (await engine.request('getState')).result as {
        tracks: Array<{ id: string, clips: Array<{ id: string, timelineStart: number, duration: number, fadeIn: number, fadeOut: number, crossfadePartnerId?: string, crossfadeCurve?: string, fadeOutCurve?: string, fadeInCurve?: string }> }>
      }
      const clips = [...withClips.tracks.find((t) => t.id === trackId)!.clips].sort((a, b) => a.timelineStart - b.timelineStart)
      record('two overlapping clips imported', clips.length === 2 && clips[1].timelineStart < clips[0].timelineStart + clips[0].duration,
        JSON.stringify(clips.map((c) => ({ id: c.id, start: c.timelineStart, dur: c.duration }))))

      await engine.request('transport', { action: 'seek', position: 0 })
      await wait(400)

      const ui = await js<{ panel: boolean, duration: boolean, preview: boolean, apply: boolean, auto: boolean }>(`(() => ({
        panel: document.querySelector('[data-panel="crossfade-282"]') != null,
        duration: document.querySelector('[data-action="crossfade-duration"]') != null,
        preview: document.querySelector('[data-action="crossfade-preview"]') != null,
        apply: document.querySelector('[data-action="crossfade-apply"]') != null,
        auto: document.querySelector('[data-action="auto-crossfade-enabled"]') != null
      }))()`)
      record('crossfade inspector controls present', ui.panel && ui.duration && ui.preview && ui.apply && ui.auto, JSON.stringify(ui))

      await engine.request('previewCrossfade', {
        trackId,
        leftClipId: clips[0].id,
        rightClipId: clips[1].id,
        duration: 0.05,
        curve: 'equalPower'
      })
      const previewed = (await engine.request('getState')).result as typeof withClips
      const pClips = [...previewed.tracks.find((t) => t.id === trackId)!.clips].sort((a, b) => a.timelineStart - b.timelineStart)
      record('preview sets complementary fades', Math.abs(pClips[0].fadeOut - 0.05) < 0.01 && Math.abs(pClips[1].fadeIn - 0.05) < 0.01
        && pClips[0].fadeOutCurve === 'equalPower' && pClips[1].fadeInCurve === 'equalPower',
        JSON.stringify({ left: pClips[0], right: pClips[1] }))

      await engine.request('cancelCrossfadePreview', {})
      const cancelled = (await engine.request('getState')).result as typeof withClips
      const cClips = [...cancelled.tracks.find((t) => t.id === trackId)!.clips].sort((a, b) => a.timelineStart - b.timelineStart)
      record('cancel preview restores fades', Math.abs(cClips[0].fadeOut - clips[0].fadeOut) < 1e-4 && Math.abs(cClips[1].fadeIn - clips[1].fadeIn) < 1e-4,
        JSON.stringify({ left: cClips[0].fadeOut, right: cClips[1].fadeIn }))

      await engine.request('applyCrossfade', {
        trackId,
        leftClipId: clips[0].id,
        rightClipId: clips[1].id,
        duration: 0.04,
        curve: 'sCurve'
      })
      const applied = (await engine.request('getState')).result as typeof withClips
      const aClips = [...applied.tracks.find((t) => t.id === trackId)!.clips].sort((a, b) => a.timelineStart - b.timelineStart)
      record('apply links clips with sCurve', aClips[0].crossfadePartnerId === aClips[1].id && aClips[1].crossfadePartnerId === aClips[0].id
        && aClips[0].crossfadeCurve === 'sCurve' && Math.abs(aClips[0].fadeOut - 0.04) < 0.01,
        JSON.stringify({ left: aClips[0], right: aClips[1] }))

      await engine.request('undo')
      const undone = (await engine.request('getState')).result as typeof withClips
      const uClips = [...undone.tracks.find((t) => t.id === trackId)!.clips].sort((a, b) => a.timelineStart - b.timelineStart)
      record('undo restores prior fade state', !uClips[0].crossfadePartnerId && Math.abs(uClips[0].fadeOut - clips[0].fadeOut) < 1e-4,
        JSON.stringify(uClips.map((c) => ({ fadeOut: c.fadeOut, fadeIn: c.fadeIn, partner: c.crossfadePartnerId }))))

      await engine.request('redo')
      const redone = (await engine.request('getState')).result as typeof withClips
      const rClips = [...redone.tracks.find((t) => t.id === trackId)!.clips].sort((a, b) => a.timelineStart - b.timelineStart)
      record('redo restores crossfade link', rClips[0].crossfadePartnerId === rClips[1].id, JSON.stringify(rClips[0]))

      await engine.request('setAutoCrossfade', { trackId, enabled: true, durationMs: 25, curve: 'linear' })
      const autoState = (await engine.request('getState')).result as {
        tracks: Array<{ id: string, autoCrossfadeEnabled?: boolean, autoCrossfadeMs?: number, autoCrossfadeCurve?: string }>
      }
      const autoTrack = autoState.tracks.find((t) => t.id === trackId)!
      record('auto-crossfade settings persist in state', autoTrack.autoCrossfadeEnabled === true
        && Math.abs((autoTrack.autoCrossfadeMs ?? 0) - 25) < 1e-6 && autoTrack.autoCrossfadeCurve === 'linear',
        JSON.stringify(autoTrack))

      // Move right clip to create a fresh overlap; auto should apply.
      await engine.request('moveClip', { trackId, clipId: clips[1].id, timelineStart: 0.85 })
      const moved = (await engine.request('getState')).result as typeof withClips
      const mClips = [...moved.tracks.find((t) => t.id === trackId)!.clips].sort((a, b) => a.timelineStart - b.timelineStart)
      record('auto-crossfade on move', mClips[0].crossfadePartnerId === mClips[1].id && Math.abs(mClips[0].fadeOut - 0.025) < 0.01,
        JSON.stringify({ left: mClips[0].fadeOut, right: mClips[1].fadeIn, partner: mClips[0].crossfadePartnerId }))

      await engine.request('setAutoCrossfade', { trackId, enabled: false, durationMs: 25, curve: 'linear' })
      await engine.request('revertCrossfade', { trackId, leftClipId: mClips[0].id, rightClipId: mClips[1].id })
      const cleared = (await engine.request('getState')).result as typeof withClips
      const clClips = [...cleared.tracks.find((t) => t.id === trackId)!.clips].sort((a, b) => a.timelineStart - b.timelineStart)
      record('revert clears crossfade', !clClips[0].crossfadePartnerId && clClips[0].fadeOut === 0 && clClips[1].fadeIn === 0,
        JSON.stringify(clClips.map((c) => ({ fadeIn: c.fadeIn, fadeOut: c.fadeOut, partner: c.crossfadePartnerId }))))

      // Invalid overlap: clips far apart
      await engine.request('moveClip', { trackId, clipId: clips[1].id, timelineStart: 5 })
      const bad = await engine.request('applyCrossfade', {
        trackId,
        leftClipId: clips[0].id,
        rightClipId: clips[1].id,
        duration: 0.05,
        curve: 'linear'
      }).then(
        (r) => ({ ok: r.ok === true, error: String(r.error ?? '') }),
        (error: Error) => ({ ok: false, error: error.message })
      )
      record('rejects non-overlapping pair', bad.ok === false, bad.error)

      const projectPath = path.join(outDir, 'phase282-project.json')
      await engine.request('moveClip', { trackId, clipId: clips[1].id, timelineStart: 0.9 })
      await engine.request('applyCrossfade', {
        trackId,
        leftClipId: clips[0].id,
        rightClipId: clips[1].id,
        duration: 0.03,
        curve: 'equalPower'
      })
      await engine.request('setAutoCrossfade', { trackId, enabled: true, durationMs: 30, curve: 'equalPower' })
      await engine.request('saveProject', { path: projectPath })
      await engine.request('loadProject', { path: projectPath }, 20000)
      const loaded = (await engine.request('getState')).result as {
        tracks: Array<{
          id: string
          name: string
          autoCrossfadeEnabled?: boolean
          autoCrossfadeMs?: number
          autoCrossfadeCurve?: string
          clips: Array<{ crossfadePartnerId?: string, crossfadeCurve?: string, fadeOut: number, fadeIn: number }>
        }>
      }
      const loadedTrack = loaded.tracks.find((t) => t.name === 'Crossfade 282')!
      const lClips = [...loadedTrack.clips].sort((a, b) => (a.fadeOut > 0 ? -1 : 1))
      record('save/load restores crossfade + auto settings', loadedTrack.autoCrossfadeEnabled === true
        && Math.abs((loadedTrack.autoCrossfadeMs ?? 0) - 30) < 1e-6
        && loadedTrack.autoCrossfadeCurve === 'equalPower'
        && loadedTrack.clips.some((c) => Boolean(c.crossfadePartnerId)),
        JSON.stringify({ auto: loadedTrack.autoCrossfadeEnabled, ms: loadedTrack.autoCrossfadeMs, clips: lClips }))

      const exportPath = path.join(outDir, 'phase282-export.wav')
      const exp = await engine.request('exportWav', { path: exportPath, sampleRate: 48000 }, 60000)
      record('export with crossfade succeeds', exp.ok === true && fs.existsSync(exportPath), String(exp.error ?? exportPath))
    }

    await shot('crossfade-panel')
    record('no renderer console errors', consoleErrors.length === 0, consoleErrors.length === 0 ? 'none' : consoleErrors.slice(0, 4).join(' | '))
    checks.push({ scenario: 'live microphone', result: 'NOT RUN', detail: 'NOT RUN — NO HARDWARE' })
  } catch (error) {
    record('crossfade 282 check crashed', false, error instanceof Error ? error.message : String(error))
  } finally {
    web.removeListener('console-message', onConsole)
  }

  const summary = {
    pass: checks.filter((c) => c.result === 'PASS').length,
    fail: checks.filter((c) => c.result === 'FAIL').length,
    notRun: checks.filter((c) => c.result === 'NOT RUN').length,
    checks
  }
  fs.writeFileSync(path.join(outDir, 'phase282-summary.json'), JSON.stringify(summary, null, 2))
  console.log(`CROSSFADE_282_CHECK pass=${summary.pass} fail=${summary.fail} not_run=${summary.notRun}`)
  for (const check of checks)
    console.log(`${check.result}\t${check.scenario}\t${check.detail}`)
  return summary.fail === 0 ? 0 : 1
}
