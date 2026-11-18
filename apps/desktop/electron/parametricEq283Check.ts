import type { BrowserWindow } from 'electron'
import fs from 'fs'
import path from 'path'
import type { EngineHost } from './engineHost'
import { writeWav24 } from './workflowCheck'

interface Check { scenario: string, result: 'PASS' | 'FAIL' | 'NOT RUN', detail: string }

export interface ParametricEq283CheckOptions { outDir: string }

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function runParametricEq283Check(win: BrowserWindow, engine: EngineHost, options: ParametricEq283CheckOptions): Promise<number> {
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
    fs.writeFileSync(path.join(outDir, `phase283-${name}.png`), image.toPNG())
  }

  const onConsole = (_event: unknown, level: number, message: string): void => {
    if (level >= 3)
      consoleErrors.push(message)
  }
  web.on('console-message', onConsole)

  try {
    await wait(700)
    await js(`(() => {
      const btn = document.querySelector('[data-view="mixer"]')
      if (btn instanceof HTMLElement) btn.click()
      return true
    })()`)
    await wait(500)

    const wav = path.join(outDir, 'phase283-tone.wav')
    writeWav24(wav, 48000, 48000, (i) => 0.3 * Math.sin(2 * Math.PI * 1000 * i / 48000), (i) => 0.3 * Math.sin(2 * Math.PI * 1000 * i / 48000))

    if (engine.startupError != null) {
      record('engine available for parametric EQ', false, engine.startupError)
    } else {
      await engine.request('configure', { sampleRate: 48000, bufferSize: 512 })
      await engine.request('addTrack', { name: 'EQ 283' })
      const st = (await engine.request('getState')).result as { tracks: Array<{ id: string, name: string }>, sampleRate: number }
      const trackId = st.tracks.find((t) => t.name === 'EQ 283')!.id
      await engine.request('importClip', { trackId, path: wav, timelineStart: 0 }, 15000)
      const added = await engine.request('addEffect', { target: 'track', ownerId: trackId, type: 'eq' })
      const effectId = (added.result as { createdEffectId?: string }).createdEffectId
        ?? ((await engine.request('getState')).result as { tracks: Array<{ id: string, effects: Array<{ id: string, type: string }> }> })
          .tracks.find((t) => t.id === trackId)!.effects.find((e) => e.type === 'eq')!.id
      record('EQ effect added', typeof effectId === 'string' && effectId.length > 0, String(effectId))

      await engine.request('setEffect', {
        effectId,
        params: { band2Freq: 1000, band2Gain: 6, band2Q: 1.4, band2Type: 1, band2Enabled: 1 }
      })
      const response = await engine.request('getEqResponse', { effectId, sampleRate: 48000 })
      const curve = response.result as { frequenciesHz: number[], magnitudesDb: number[] }
      const near1k = curve.frequenciesHz.findIndex((hz) => Math.abs(hz - 1000) < 80)
      const peakDb = near1k >= 0 ? curve.magnitudesDb[near1k] : -999
      record('EQ response maps gain near centre', peakDb > 4 && peakDb < 8, `db@~1k=${peakDb}`)

      await engine.request('setEffect', { effectId, params: { band2Enabled: 0 } })
      const bypassed = await engine.request('getEqResponse', { effectId, sampleRate: 48000 })
      const bypassCurve = bypassed.result as { magnitudesDb: number[] }
      const flat = bypassCurve.magnitudesDb.every((db) => Math.abs(db) < 0.35)
      record('band bypass flattens response contribution', flat, `max|db|=${Math.max(...bypassCurve.magnitudesDb.map(Math.abs))}`)

      await engine.request('setEffect', { effectId, params: { band2Enabled: 1, band2Gain: 6 } })
      await engine.request('setSpectrumTap', { enabled: true, target: 'track', ownerId: trackId })
      await engine.request('transport', { action: 'play' })
      await wait(900)
      const meters = await engine.request('getMeters')
      const spectrum = (meters.result as { spectrum?: { available: boolean, magnitudesDb: number[], fftSize: number, tap: string } }).spectrum
      record('spectrum available while playing', spectrum?.available === true && (spectrum.magnitudesDb?.length ?? 0) > 8
        && spectrum.fftSize === 2048 && spectrum.tap.includes('post-insert'),
        JSON.stringify(spectrum))
      await engine.request('transport', { action: 'stop' })

      await engine.request('setSpectrumTap', { enabled: false })
      const quiet = await engine.request('getMeters')
      const off = (quiet.result as { spectrum?: { available: boolean } }).spectrum
      record('spectrum unavailable when tap cleared', off?.available === false, JSON.stringify(off))

      // Pull engine state into React, open Mixer, select the track FX rack.
      await js(`(async () => {
        if (typeof window.__mspRefreshState === 'function') await window.__mspRefreshState()
        const btn = document.querySelector('[data-view="mixer"]')
        if (btn instanceof HTMLElement) btn.click()
        await new Promise((r) => setTimeout(r, 200))
        const strip = document.querySelector('[data-strip-track="${trackId}"]')
        const fx = strip?.querySelector('.fx-button')
        if (fx instanceof HTMLElement) fx.click()
        return true
      })()`)
      await wait(900)
      const ui = await js<{ panel: boolean, canvas: boolean, reset: boolean, bypass: boolean, strip: boolean }>(`(() => ({
        panel: document.querySelector('[data-panel="parametric-eq-283"]') != null,
        canvas: document.querySelector('[data-eq-canvas]') != null,
        reset: document.querySelector('[data-action="eq-reset"]') != null,
        bypass: document.querySelector('[data-action="eq-bypass"]') != null,
        strip: document.querySelector('[data-strip-track="${trackId}"]') != null
      }))()`)
      record('parametric EQ editor controls present', ui.panel && ui.canvas && ui.reset && ui.bypass, JSON.stringify(ui))

      await js(`(() => {
        const btn = document.querySelector('[data-action="eq-reset"]')
        if (btn instanceof HTMLElement) btn.click()
        return true
      })()`)
      await wait(500)
      await js(`(async () => { if (typeof window.__mspRefreshState === 'function') await window.__mspRefreshState(); return true })()`)
      const afterReset = (await engine.request('getState')).result as {
        tracks: Array<{ id: string, effects: Array<{ id: string, params: Record<string, number> }> }>
      }
      const params = afterReset.tracks.find((t) => t.id === trackId)!.effects.find((e) => e.id === effectId)!.params
      record('reset restores default gains', Math.abs(params.band2Gain ?? 99) < 1e-6 && Math.abs(params.outputGain ?? 99) < 1e-6,
        JSON.stringify(params))

      const projectPath = path.join(outDir, 'phase283-project.json')
      await engine.request('setEffect', { effectId, params: { band3Gain: -3, band3Freq: 2500, band3Enabled: 1 } })
      await engine.request('saveProject', { path: projectPath })
      await engine.request('loadProject', { path: projectPath }, 20000)
      const loaded = (await engine.request('getState')).result as {
        tracks: Array<{ name: string, effects: Array<{ type: string, params: Record<string, number> }> }>
      }
      const loadedEq = loaded.tracks.find((t) => t.name === 'EQ 283')!.effects.find((e) => e.type === 'eq')!
      record('save/load restores EQ params', Math.abs((loadedEq.params.band3Gain ?? 0) + 3) < 1e-4
        && Math.abs((loadedEq.params.band3Freq ?? 0) - 2500) < 1e-3
        && (loadedEq.params.band3Enabled ?? 0) >= 0.5,
        JSON.stringify(loadedEq.params))

      const exportPath = path.join(outDir, 'phase283-export.wav')
      const exp = await engine.request('exportWav', { path: exportPath, sampleRate: 48000 }, 60000)
      record('export with EQ succeeds', exp.ok === true && fs.existsSync(exportPath), String(exp.error ?? exportPath))
    }

    const victimPath = process.env.MUSICSTUDIO_ENGINE
      ?? path.resolve(__dirname, '../../../../build/MusicStudioEngine.exe')
    const { EngineHost } = await import('./engineHost')
    const victim = new EngineHost(victimPath)
    await victim.request('ping', {}, 5000).catch(() => undefined)
    victim.forceKill()
    await wait(200)
    const dead = await victim.request('getEqResponse', { params: { band1Gain: 3 } }, 2000).then(
      () => ({ ok: false, detail: 'unexpected ok' }),
      (error: Error) => ({ ok: !/EPIPE/i.test(error.message), detail: error.message })
    )
    record('engine unavailable rejects without EPIPE', dead.ok, dead.detail)
    await victim.shutdown()

    await shot('parametric-eq')
    record('no renderer console errors', consoleErrors.length === 0, consoleErrors.length === 0 ? 'none' : consoleErrors.slice(0, 4).join(' | '))
    checks.push({ scenario: 'live microphone', result: 'NOT RUN', detail: 'NOT RUN — NO HARDWARE' })
  } catch (error) {
    record('parametric EQ 283 check crashed', false, error instanceof Error ? error.message : String(error))
  } finally {
    web.removeListener('console-message', onConsole)
  }

  const summary = {
    pass: checks.filter((c) => c.result === 'PASS').length,
    fail: checks.filter((c) => c.result === 'FAIL').length,
    notRun: checks.filter((c) => c.result === 'NOT RUN').length,
    checks
  }
  fs.writeFileSync(path.join(outDir, 'phase283-summary.json'), JSON.stringify(summary, null, 2))
  console.log(`PARAMETRIC_EQ_283_CHECK pass=${summary.pass} fail=${summary.fail} not_run=${summary.notRun}`)
  for (const check of checks)
    console.log(`${check.result}\t${check.scenario}\t${check.detail}`)
  return summary.fail === 0 ? 0 : 1
}
