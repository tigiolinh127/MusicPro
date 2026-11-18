import type { BrowserWindow } from 'electron'
import fs from 'fs'
import path from 'path'
import type { EngineHost } from './engineHost'
import { writeWav24 } from './workflowCheck'

interface Check { scenario: string, result: 'PASS' | 'FAIL' | 'NOT RUN', detail: string }

export interface Dynamics284CheckOptions { outDir: string }

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function runDynamics284Check(win: BrowserWindow, engine: EngineHost, options: Dynamics284CheckOptions): Promise<number> {
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
    fs.writeFileSync(path.join(outDir, `phase284-${name}.png`), image.toPNG())
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

    const wav = path.join(outDir, 'phase284-tone.wav')
    writeWav24(wav, 48000, 48000, (i) => 0.55 * Math.sin(2 * Math.PI * 440 * i / 48000), (i) => 0.55 * Math.sin(2 * Math.PI * 440 * i / 48000))

    if (engine.startupError != null) {
      record('engine available for dynamics', false, engine.startupError)
    } else {
      await engine.request('configure', { sampleRate: 48000, bufferSize: 512 })
      await engine.request('addTrack', { name: 'DYN 284' })
      const st = (await engine.request('getState')).result as { tracks: Array<{ id: string, name: string }> }
      const trackId = st.tracks.find((t) => t.name === 'DYN 284')!.id
      await engine.request('importClip', { trackId, path: wav, timelineStart: 0 }, 15000)

      const added = await engine.request('addEffect', { target: 'track', ownerId: trackId, type: 'compressor' })
      const compId = (added.result as { createdEffectId?: string }).createdEffectId
        ?? ((await engine.request('getState')).result as { tracks: Array<{ id: string, effects: Array<{ id: string, type: string }> }> })
          .tracks.find((t) => t.id === trackId)!.effects.find((e) => e.type === 'compressor')!.id
      record('compressor effect added', typeof compId === 'string' && compId.length > 0, String(compId))

      await engine.request('setEffect', {
        effectId: compId,
        params: { threshold: -18, ratio: 4, attack: 1, release: 50, makeup: 0, knee: 0 }
      })
      const hard = await engine.request('getDynamicsCurve', { effectId: compId })
      const hardCurve = hard.result as { inputDb: number[], outputDb: number[], reductionDb: number[] }
      const idx = hardCurve.inputDb.findIndex((db) => Math.abs(db + 6) < 0.6)
      const gr = idx >= 0 ? hardCurve.reductionDb[idx] : -1
      record('hard-knee threshold/ratio mapping (~9 dB GR at -6)', gr > 8.5 && gr < 9.5, `gr@~-6=${gr}`)

      await engine.request('setEffect', { effectId: compId, params: { knee: 12 } })
      const soft = await engine.request('getDynamicsCurve', { effectId: compId })
      const softCurve = soft.result as { inputDb: number[], reductionDb: number[] }
      const thrIdx = softCurve.inputDb.findIndex((db) => Math.abs(db + 18) < 0.6)
      const midGr = thrIdx >= 0 ? softCurve.reductionDb[thrIdx] : -1
      record('soft knee mid-threshold GR (~1.125 dB)', midGr > 1.0 && midGr < 1.3, `gr@thr=${midGr}`)

      await engine.request('setEffect', { effectId: compId, params: { makeup: 6, knee: 0 } })
      const mk = await engine.request('getDynamicsCurve', { effectId: compId })
      const mkCurve = mk.result as { inputDb: number[], outputDb: number[] }
      const mkIdx = mkCurve.inputDb.findIndex((db) => Math.abs(db + 6) < 0.6)
      const out = mkIdx >= 0 ? mkCurve.outputDb[mkIdx] : -999
      record('makeup reflected on transfer curve', out > -9.5 && out < -8.5, `out@~-6=${out}`)

      const limAdd = await engine.request('addEffect', { target: 'track', ownerId: trackId, type: 'limiter' })
      const limId = (limAdd.result as { createdEffectId?: string }).createdEffectId
        ?? ((await engine.request('getState')).result as { tracks: Array<{ id: string, effects: Array<{ id: string, type: string }> }> })
          .tracks.find((t) => t.id === trackId)!.effects.find((e) => e.type === 'limiter')!.id
      record('limiter effect added', typeof limId === 'string' && limId.length > 0, String(limId))
      await engine.request('setEffect', { effectId: limId, params: { ceiling: -6, release: 20, attack: 0.05 } })
      const limCurve = await engine.request('getDynamicsCurve', { effectId: limId })
      const lim = limCurve.result as { kind: string, inputDb: number[], outputDb: number[] }
      const limOut = lim.outputDb[lim.inputDb.length - 1]
      record('limiter sample-peak ceiling on curve', lim.kind === 'sample-peak' && limOut > -6.2 && limOut < -5.8,
        `kind=${lim.kind} out0=${limOut}`)

      await engine.request('transport', { action: 'play' })
      await wait(900)
      const meters = await engine.request('getMeters')
      const effects = (meters.result as { effects?: Array<{ id: string, reduction: number }> }).effects ?? []
      const liveGr = effects.find((e) => e.id === compId)?.reduction ?? -1
      record('live gain-reduction meter from DSP', liveGr >= 0, `gr=${liveGr}`)
      await engine.request('transport', { action: 'stop' })

      await engine.request('setEffect', { effectId: compId, enabled: false })
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

      const ui = await js<{ panel: boolean, canvas: boolean, reset: boolean, bypass: boolean, gr: boolean }>(`(() => ({
        panel: document.querySelector('[data-panel="dynamics-284"]') != null,
        canvas: document.querySelector('[data-dynamics-canvas]') != null,
        reset: document.querySelector('[data-action="dynamics-reset"]') != null,
        bypass: document.querySelector('[data-action="dynamics-bypass"]') != null,
        gr: document.querySelector('[data-gr-meter]') != null
      }))()`)
      record('dynamics editor controls present', ui.panel && ui.canvas && ui.reset && ui.bypass && ui.gr, JSON.stringify(ui))

      const bypassLabel = await js<string>(`(() => {
        const out = document.querySelector('[data-gr-value]')
        return out instanceof HTMLElement ? out.textContent ?? '' : ''
      })()`)
      record('bypass clears GR indication', /bypass/i.test(bypassLabel), bypassLabel)

      await engine.request('setEffect', { effectId: compId, enabled: true, params: { knee: 6, makeup: 0, threshold: -18 } })
      await js(`(() => {
        const btn = document.querySelector('[data-action="dynamics-reset"]')
        if (btn instanceof HTMLElement) btn.click()
        return true
      })()`)
      await wait(500)
      await js(`(async () => { if (typeof window.__mspRefreshState === 'function') await window.__mspRefreshState(); return true })()`)
      const afterReset = (await engine.request('getState')).result as {
        tracks: Array<{ id: string, effects: Array<{ id: string, params: Record<string, number> }> }>
      }
      const params = afterReset.tracks.find((t) => t.id === trackId)!.effects.find((e) => e.id === compId)!.params
      record('reset restores default compressor params',
        Math.abs((params.threshold ?? 99) + 18) < 1e-3 && Math.abs(params.knee ?? 99) < 1e-6 && Math.abs(params.makeup ?? 99) < 1e-6,
        JSON.stringify(params))

      const projectPath = path.join(outDir, 'phase284-project.json')
      await engine.request('setEffect', { effectId: compId, params: { knee: 8, ratio: 3 } })
      await engine.request('setEffect', { effectId: limId, params: { ceiling: -0.5 } })
      await engine.request('saveProject', { path: projectPath })
      await engine.request('loadProject', { path: projectPath }, 20000)
      const loaded = (await engine.request('getState')).result as {
        tracks: Array<{ name: string, effects: Array<{ type: string, params: Record<string, number> }> }>
      }
      const loadedComp = loaded.tracks.find((t) => t.name === 'DYN 284')!.effects.find((e) => e.type === 'compressor')!
      const loadedLim = loaded.tracks.find((t) => t.name === 'DYN 284')!.effects.find((e) => e.type === 'limiter')!
      record('save/load restores knee and limiter ceiling',
        Math.abs((loadedComp.params.knee ?? 0) - 8) < 1e-4
        && Math.abs((loadedComp.params.ratio ?? 0) - 3) < 1e-4
        && Math.abs((loadedLim.params.ceiling ?? 0) + 0.5) < 1e-4,
        JSON.stringify({ comp: loadedComp.params, lim: loadedLim.params }))

      const exportPath = path.join(outDir, 'phase284-export.wav')
      const exp = await engine.request('exportWav', { path: exportPath, sampleRate: 48000 }, 60000)
      record('export with compressor+limiter succeeds', exp.ok === true && fs.existsSync(exportPath), String(exp.error ?? exportPath))
    }

    const victimPath = process.env.MUSICSTUDIO_ENGINE
      ?? path.resolve(__dirname, '../../../../build/MusicStudioEngine.exe')
    const { EngineHost } = await import('./engineHost')
    const victim = new EngineHost(victimPath)
    await victim.request('ping', {}, 5000).catch(() => undefined)
    victim.forceKill()
    await wait(200)
    const dead = await victim.request('getDynamicsCurve', { type: 'compressor' }, 2000).then(
      () => ({ ok: false, detail: 'unexpected ok' }),
      (error: Error) => ({ ok: !/EPIPE/i.test(error.message), detail: error.message })
    )
    record('engine unavailable rejects without EPIPE', dead.ok, dead.detail)
    await victim.shutdown()

    await shot('dynamics')
    record('no renderer console errors', consoleErrors.length === 0, consoleErrors.length === 0 ? 'none' : consoleErrors.slice(0, 4).join(' | '))
    checks.push({ scenario: 'live microphone', result: 'NOT RUN', detail: 'NOT RUN — NO HARDWARE' })
  } catch (error) {
    record('dynamics 284 check crashed', false, error instanceof Error ? error.message : String(error))
  } finally {
    web.removeListener('console-message', onConsole)
  }

  const summary = {
    pass: checks.filter((c) => c.result === 'PASS').length,
    fail: checks.filter((c) => c.result === 'FAIL').length,
    notRun: checks.filter((c) => c.result === 'NOT RUN').length,
    checks
  }
  fs.writeFileSync(path.join(outDir, 'phase284-summary.json'), JSON.stringify(summary, null, 2))
  console.log(`DYNAMICS_284_CHECK pass=${summary.pass} fail=${summary.fail} not_run=${summary.notRun}`)
  for (const check of checks)
    console.log(`${check.result}\t${check.scenario}\t${check.detail}`)
  return summary.fail === 0 ? 0 : 1
}
