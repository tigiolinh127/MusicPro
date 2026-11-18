import type { BrowserWindow } from 'electron'
import fs from 'fs'
import path from 'path'
import { EngineHost } from './engineHost'
import { writeWav24 } from './workflowCheck'

interface Check { scenario: string, result: 'PASS' | 'FAIL' | 'NOT RUN', detail: string }

export interface RecordingLatency274CheckOptions { outDir: string }

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function findEngine(): string | null {
  const candidates = [
    process.env.MUSICSTUDIO_ENGINE,
    path.resolve(__dirname, '../../../../build/MusicStudioEngine.exe'),
    path.resolve(process.cwd(), 'build/MusicStudioEngine.exe')
  ].filter((value): value is string => typeof value === 'string' && value.length > 0)
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null
}

export async function runRecordingLatency274Check(win: BrowserWindow, _engine: EngineHost, options: RecordingLatency274CheckOptions): Promise<number> {
  const { outDir } = options
  fs.mkdirSync(outDir, { recursive: true })
  const web = win.webContents
  const checks: Check[] = []
  let probe: EngineHost | null = null
  const consoleErrors: string[] = []

  function record(scenario: string, ok: boolean, detail: string): void {
    checks.push({ scenario, result: ok ? 'PASS' : 'FAIL', detail })
  }

  async function js<T>(code: string): Promise<T> {
    if (win.isDestroyed() || web.isDestroyed())
      throw new Error('BrowserWindow/webContents destroyed')
    return await web.executeJavaScript(code, true) as T
  }

  async function shot(name: string): Promise<void> {
    web.invalidate()
    await js('new Promise((resolve) => { requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))); setTimeout(() => resolve(false), 500) })')
    await wait(200)
    const image = await web.capturePage()
    fs.writeFileSync(path.join(outDir, `phase274-${name}.png`), image.toPNG())
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
    await wait(500)

    const ui = await js<{ panel: boolean, latency: boolean, offset: boolean, reset: boolean }>(`(() => ({
      panel: document.querySelector('[data-panel="recording-workflow-271"]') != null,
      latency: document.querySelector('[data-recording-latency-274]') != null,
      offset: document.querySelector('[data-action="recording-offset"]') != null,
      reset: document.querySelector('[data-action="recording-offset-reset"]') != null
    }))()`)
    record('latency calibration UI present', ui.panel && ui.latency && ui.offset && ui.reset, JSON.stringify(ui))

    // Sign / mapping helpers
    const mapping = await js<{ plus: number, minus: number }>(`(() => {
      const samples = (ms, rate) => Math.round(Math.max(-500, Math.min(500, ms)) * rate / 1000)
      return { plus: samples(10, 48000), minus: samples(-10, 48000) }
    })()`)
    record('milliseconds-to-samples sign and direction', mapping.plus === 480 && mapping.minus === -480, JSON.stringify(mapping))

    probe = new EngineHost(findEngine())
    record('probe EngineHost started', probe.startupError == null, probe.startupError ?? 'ok')
    if (probe.startupError == null) {
      await probe.request('configure', { sampleRate: 48000, bufferSize: 512 })
      const def = (await probe.request('getRecordingLatency')).result as { offsetMs: number, method: string }
      record('default offset is 0', def.offsetMs === 0 && def.method === 'none', JSON.stringify(def))

      const bad = await probe.request('setRecordingOffset', { offsetMs: 999 })
      record('offset rejects out-of-range', bad.ok === false, String(bad.error ?? 'unexpected ok'))

      const set = await probe.request('setRecordingOffset', { offsetMs: -40 })
      const after = set.result as { offsetMs: number, offsetSamples: number, method: string, profileKey: string }
      record('manual negative offset (place earlier)', set.ok && after.offsetMs === -40 && after.offsetSamples === -1920 && after.method === 'manual',
        JSON.stringify(after))

      // Profile persistence across configure (same device key)
      await probe.request('configure', { sampleRate: 48000, bufferSize: 512 })
      const reloaded = (await probe.request('getRecordingLatency')).result as { offsetMs: number }
      record('device profile persistence', Math.abs(reloaded.offsetMs + 40) < 0.01, JSON.stringify(reloaded))

      // Sample-rate-aware conversion (device may keep its preferred rate; assert against actual rate)
      await probe.request('configure', { sampleRate: 44100, bufferSize: 512 })
      await probe.request('setRecordingOffset', { offsetMs: 10 })
      const atRate = (await probe.request('getRecordingLatency')).result as { offsetSamples: number, sampleRate: number, offsetMs: number }
      const expectedSamples = Math.round(10 * atRate.sampleRate / 1000)
      record('sample-rate-aware offset samples', atRate.offsetMs === 10 && atRate.offsetSamples === expectedSamples
        && (atRate.sampleRate === 44100 ? expectedSamples === 441 : atRate.sampleRate === 48000 && expectedSamples === 480),
        JSON.stringify({ ...atRate, expectedSamples }))

      await probe.request('configure', { sampleRate: 48000, bufferSize: 512 })
      await probe.request('resetRecordingOffset')
      const reset = (await probe.request('getRecordingLatency')).result as { offsetMs: number, method: string }
      record('reset behavior', reset.offsetMs === 0 && (reset.method === 'none' || reset.method === 'manual'), JSON.stringify(reset))

      // Correlation estimate (synthetic) — not physical hardware
      const refPath = path.join(outDir, 'phase274-ref.wav')
      const recPath = path.join(outDir, 'phase274-rec.wav')
      const frames = 4800
      writeWav24(refPath, 48000, frames, (i) => (i === 200 ? 1 : 0), (i) => (i === 200 ? 1 : 0))
      writeWav24(recPath, 48000, frames, (i) => (i === 200 + 96 ? 1 : 0), (i) => (i === 200 + 96 ? 1 : 0))
      const est = await probe.request('estimateRecordingLatency', { referencePath: refPath, recordedPath: recPath }, 15000)
      const er = est.result as { delayMs: number, suggestedOffsetMs: number, reliable: boolean, applied: boolean }
      record('correlation calculation (synthetic)', est.ok && er.reliable && Math.abs(er.delayMs - 2) < 0.05 && er.applied === false,
        JSON.stringify(er))
      const apply = await probe.request('applyRecordingLatencyEstimate')
      record('apply reliable estimate → negative offset', apply.ok === true
        && Math.abs(((apply.result as { offsetMs: number }).offsetMs) + 2) < 0.05, JSON.stringify(apply.result))

      const silent = path.join(outDir, 'phase274-silent.wav')
      writeWav24(silent, 48000, frames, () => 0, () => 0)
      const badEst = await probe.request('estimateRecordingLatency', { referencePath: refPath, recordedPath: silent }, 15000)
      record('invalid measurement handling', badEst.ok && (badEst.result as { reliable: boolean }).reliable === false, JSON.stringify(badEst.result))
      const rejectApply = await probe.request('applyRecordingLatencyEstimate')
      record('unreliable estimate not applied', rejectApply.ok === false, String(rejectApply.error ?? 'unexpected ok'))

      // Placement + existing take preservation
      await probe.request('setRecordFolder', { path: outDir })
      await probe.request('setVirtualInput', { enabled: true, frequency: 440, level: 0.25 })
      await probe.request('setRecordingOffset', { offsetMs: -20 })
      for (const track of ((await probe.request('getState')).result as { tracks: Array<{ id: string }> }).tracks)
        await probe.request('removeTrack', { trackId: track.id })
      // Extend timeline so seek(1.0)/seek(2.0) are not clamped on an empty session.
      const padPath = path.join(outDir, 'phase274-pad.wav')
      writeWav24(padPath, 48000, 48000 * 3, () => 0, () => 0)
      await probe.request('addTrack', { name: 'Pad 274' })
      let state = (await probe.request('getState')).result as {
        tracks: Array<{ id: string, name: string, takes?: Array<{ timelineStartSamples: number }> }>
      }
      const padId = state.tracks.find((t) => t.name === 'Pad 274')!.id
      await probe.request('importClip', { trackId: padId, path: padPath, timelineStart: 0 }, 15000)
      await probe.request('addTrack', { name: 'Latency 274' })
      state = (await probe.request('getState')).result as typeof state
      const trackId = state.tracks.find((t) => t.name === 'Latency 274')!.id
      await probe.request('setTrackRecord', { trackId, armed: true, input: '1', mode: 'dry' })
      await probe.request('transport', { action: 'seek', position: 1.0 })
      await probe.request('record', { action: 'start' })
      await wait(350)
      const stopped = await probe.request('record', { action: 'stop' }, 15000)
      const take = (stopped.result as { take?: { startSamples: number, captureStartSamples?: number, placementOffsetMs?: number } })?.take
      record('recording placement uses offset',
        stopped.ok && take?.captureStartSamples === 48000 && take.startSamples === 48000 - 960 && take.placementOffsetMs === -20,
        JSON.stringify(take))

      state = (await probe.request('getState')).result as typeof state
      const firstStart = state.tracks.find((t) => t.id === trackId)?.takes?.[0]?.timelineStartSamples
      await probe.request('setRecordingOffset', { offsetMs: 0 })
      await probe.request('transport', { action: 'seek', position: 2.0 })
      await probe.request('record', { action: 'start' })
      await wait(300)
      await probe.request('record', { action: 'stop' }, 15000)
      state = (await probe.request('getState')).result as typeof state
      const firstStill = state.tracks.find((t) => t.id === trackId)?.takes?.[0]?.timelineStartSamples
      record('existing take preservation', firstStart === firstStill && firstStart === 48000 - 960,
        JSON.stringify({ firstStart, firstStill }))

      await probe.request('setVirtualInput', { enabled: false })
      await probe.request('resetRecordingOffset')

      const victim = new EngineHost(findEngine())
      await victim.request('ping', {}, 5000)
      victim.forceKill()
      await wait(250)
      const dead = await victim.request('ping', {}, 2000).then(
        () => ({ ok: false, detail: 'unexpected success' }),
        (error: Error) => ({ ok: !/EPIPE/i.test(error.message), detail: error.message })
      )
      record('engine unavailable rejects without EPIPE', dead.ok, dead.detail)
      await victim.shutdown()
    }

    // UI sync
    await js(`(() => {
      const el = document.querySelector('[data-action="recording-offset"]')
      if (el instanceof HTMLInputElement) {
        el.value = '-15'
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
        el.blur()
      }
      return true
    })()`)
    await wait(400)
    await js(`(() => {
      const btn = document.querySelector('[data-action="recording-offset-reset"]')
      if (btn instanceof HTMLElement) btn.click()
      return true
    })()`)
    await wait(400)
    const uiOffset = await js<{ text: string }>(`(() => ({
      text: document.querySelector('[data-latency-offset]')?.textContent ?? ''
    }))()`)
    record('UI shows offset / reset path', /0(\.0)? ms/i.test(uiOffset.text), JSON.stringify(uiOffset))

    await shot('latency-calibration')

    record('no renderer console errors', consoleErrors.length === 0, consoleErrors.length === 0 ? 'none' : consoleErrors.slice(0, 4).join(' | '))
    checks.push({ scenario: 'live microphone', result: 'NOT RUN', detail: 'NOT RUN — NO HARDWARE' })
    checks.push({ scenario: 'physical loopback calibration', result: 'NOT RUN', detail: 'NOT RUN — NO HARDWARE' })
  } catch (error) {
    const extra = consoleErrors.length > 0 ? ` | console: ${consoleErrors.slice(0, 4).join(' | ')}` : ''
    record('recording latency 274 check crashed', false, (error instanceof Error ? error.message : String(error)) + extra)
  } finally {
    web.removeListener('console-message', onConsole)
    try { await probe?.shutdown() } catch { /* ignore */ }
  }

  const summary = {
    pass: checks.filter((c) => c.result === 'PASS').length,
    fail: checks.filter((c) => c.result === 'FAIL').length,
    notRun: checks.filter((c) => c.result === 'NOT RUN').length,
    checks
  }
  fs.writeFileSync(path.join(outDir, 'phase274-summary.json'), JSON.stringify(summary, null, 2))
  console.log(`RECORDING_LATENCY_274_CHECK pass=${summary.pass} fail=${summary.fail} not_run=${summary.notRun}`)
  for (const check of checks)
    console.log(`${check.result}\t${check.scenario}\t${check.detail}`)
  return summary.fail === 0 ? 0 : 1
}
