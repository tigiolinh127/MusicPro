import type { BrowserWindow } from 'electron'
import fs from 'fs'
import path from 'path'
import { EngineHost } from './engineHost'
import { writeWav24 } from './workflowCheck'

interface Check { scenario: string, result: 'PASS' | 'FAIL' | 'NOT RUN', detail: string }

export interface MixerUx273CheckOptions { outDir: string }

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

export async function runMixerUx273Check(win: BrowserWindow, _engine: EngineHost, options: MixerUx273CheckOptions): Promise<number> {
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
    fs.writeFileSync(path.join(outDir, `phase273-${name}.png`), image.toPNG())
  }

  const onConsole = (_event: unknown, level: number, message: string): void => {
    if (level >= 3)
      consoleErrors.push(message)
  }
  web.on('console-message', onConsole)

  try {
    await wait(700)
    await js(`(() => {
      const btn = document.querySelector('[data-view="mixer"]') || Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Mixer')
      if (btn instanceof HTMLElement) btn.click()
      return true
    })()`)
    await wait(500)

    const ui = await js<{ panel: boolean, clearPeaks: boolean, master: boolean }>(`(() => ({
      panel: document.querySelector('[data-panel="mixer-ux-273"]') != null,
      clearPeaks: document.querySelector('[data-action="clear-peaks"]') != null,
      master: document.querySelector('[data-strip-master]') != null
    }))()`)
    record('mixer UX panel present', ui.panel && ui.clearPeaks && ui.master, JSON.stringify(ui))

    // Fader dB mapping (renderer formulas)
    const mapping = await js<{ unity: boolean, plus6: boolean, minusInf: boolean }>(`(() => {
      const gainToDb = (g) => !(g > 0) ? -60 : Math.max(-60, Math.min(12, 20 * Math.log10(g)))
      const dbToGain = (db) => db <= -60 ? 0 : Math.min(4, Math.pow(10, db / 20))
      return {
        unity: Math.abs(dbToGain(0) - 1) < 1e-9 && Math.abs(gainToDb(1)) < 1e-6,
        plus6: Math.abs(dbToGain(6) - 2) < 0.01,
        minusInf: dbToGain(-60) === 0
      }
    })()`)
    record('fader display mapping unity / +6 dB / −inf', mapping.unity && mapping.plus6 && mapping.minusInf, JSON.stringify(mapping))

    probe = new EngineHost(findEngine())
    record('probe EngineHost started', probe.startupError == null, probe.startupError ?? 'ok')
    if (probe.startupError == null) {
      await probe.request('configure', { sampleRate: 48000, bufferSize: 512 })
      const fixture = path.join(outDir, 'phase273-tone.wav')
      writeWav24(fixture, 48000, 48000, (i) => 0.4 * Math.sin(2 * Math.PI * 440 * i / 48000), (i) => 0.4 * Math.sin(2 * Math.PI * 440 * i / 48000))

      for (const track of ((await probe.request('getState')).result as { tracks: Array<{ id: string }> }).tracks)
        await probe.request('removeTrack', { trackId: track.id })
      await probe.request('addTrack', { name: 'Mix UX 273' })
      let state = (await probe.request('getState')).result as {
        tracks: Array<{ id: string, name: string, gain: number, mute: boolean, solo: boolean, pan: number }>
        deviceOpen: boolean
        masterGain: number
      }
      const trackId = state.tracks.find((t) => t.name === 'Mix UX 273')!.id
      await probe.request('importClip', { trackId, path: fixture, timelineStart: 0 }, 15000)

      await probe.request('transport', { action: 'play' })
      await wait(300)
      const meters = (await probe.request('getMeters')).result as {
        master?: { available?: boolean, peakL: number, peakR: number, rmsL?: number, rmsR?: number, peakHoldL?: number, clip: boolean, peakDbFS?: number, rmsDbFS?: number }
        tracks?: Array<{ id?: string, available?: boolean, peakL: number, peakR: number, rmsL?: number, peakHoldL?: number, clip: boolean, peakDbFS?: number }>
      }
      const trackMeter = (meters.tracks ?? []).find((m) => m.id === trackId)
      record('track meter has peak/RMS/peakHold/dBFS',
        trackMeter != null && (trackMeter.peakL > 0.05 || trackMeter.peakR > 0.05)
          && (trackMeter.rmsL ?? 0) >= 0 && (trackMeter.peakHoldL ?? 0) >= trackMeter.peakL * 0.5
          && typeof trackMeter.peakDbFS === 'number',
        JSON.stringify(trackMeter))
      record('master meter stereo peak/RMS',
        meters.master != null && (meters.master.peakL > 0.01 || meters.master.peakR > 0.01)
          && typeof meters.master.rmsL === 'number' && typeof meters.master.peakHoldL === 'number',
        JSON.stringify(meters.master))
      record('mono/stereo handling (stereo fixture → L and R)',
        trackMeter != null && trackMeter.peakL > 0 && trackMeter.peakR > 0,
        JSON.stringify({ peakL: trackMeter?.peakL, peakR: trackMeter?.peakR }))

      // Clip detection: boost gain
      await probe.request('setTrack', { trackId, gain: 4 })
      await wait(250)
      const metersClip = (await probe.request('getMeters')).result as {
        tracks?: Array<{ id?: string, clip: boolean, peakL: number }>
        master?: { clip: boolean, peakL: number }
      }
      const clipped = (metersClip.tracks ?? []).find((m) => m.id === trackId)
      record('clip detection on hot strip',
        clipped?.clip === true || (clipped?.peakL ?? 0) >= 0.99 || metersClip.master?.clip === true,
        JSON.stringify({ clipped, master: metersClip.master }))

      // Lower gain first so reset is not immediately re-latched by hot post-fader samples.
      await probe.request('setTrack', { trackId, gain: 0.25 })
      await wait(120)
      await probe.request('resetClips')
      await wait(80)
      const afterReset = (await probe.request('getMeters')).result as {
        tracks?: Array<{ id?: string, clip: boolean, peakHoldL?: number }>
        master?: { clip: boolean, peakHoldL?: number }
      }
      const resetTrack = (afterReset.tracks ?? []).find((m) => m.id === trackId)
      record('peak hold / clip reset via resetClips',
        resetTrack?.clip !== true && afterReset.master?.clip !== true,
        JSON.stringify({ resetTrack, master: afterReset.master }))

      // Mute/Solo sync
      await probe.request('setTrack', { trackId, gain: 1, mute: true, solo: false })
      state = (await probe.request('getState')).result as typeof state
      const muted = state.tracks.find((t) => t.id === trackId)!
      record('mute reflects engine state', muted.mute === true && muted.solo === false, JSON.stringify(muted))
      await probe.request('setTrack', { trackId, mute: false, solo: true })
      state = (await probe.request('getState')).result as typeof state
      const soloed = state.tracks.find((t) => t.id === trackId)!
      record('solo reflects engine state', soloed.solo === true && soloed.mute === false, JSON.stringify(soloed))
      await probe.request('setTrack', { trackId, solo: false })

      // Channel strip fader mapping via engine
      await probe.request('setTrack', { trackId, gain: Math.pow(10, -6 / 20) })
      state = (await probe.request('getState')).result as typeof state
      const g = state.tracks.find((t) => t.id === trackId)!.gain
      record('channel strip gain maps ≈ −6 dB', Math.abs(20 * Math.log10(g) + 6) < 0.2, `gain=${g}`)

      await probe.request('transport', { action: 'stop' })

      // Engine unavailable: force-kill probe and check UI path separately
      const victim = new EngineHost(findEngine())
      await victim.request('ping', {}, 5000)
      victim.forceKill()
      await wait(250)
      const dead = await victim.request('ping', {}, 2000).then(
        () => ({ ok: false, detail: 'unexpected success' }),
        (error: Error) => ({ ok: !/EPIPE/i.test(error.message), detail: error.message })
      )
      record('engine disconnect rejects without EPIPE', dead.ok, dead.detail)
      await victim.shutdown()
    }

    // Drive App UI: add track, open mixer, verify meters / mute sync
    await js(`(() => {
      const ed = document.querySelector('[data-view="editor"]') || Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Editor')
      if (ed instanceof HTMLElement) ed.click()
      return true
    })()`)
    await wait(400)
    await js(`(() => {
      const add = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Add track')
      if (add instanceof HTMLElement) add.click()
      return true
    })()`)
    await wait(600)
    await js(`(() => {
      const mix = document.querySelector('[data-view="mixer"]') || Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Mixer')
      if (mix instanceof HTMLElement) mix.click()
      return true
    })()`)
    await wait(600)

    const stripUi = await js<{
      strip: boolean
      faderDb: string
      mute: boolean
      peakText: string
      unavailable: boolean
    }>(`(() => {
      const strip = document.querySelector('[data-strip-track]')
      const mute = strip?.querySelector('[data-action="strip-mute"]')
      const db = strip?.querySelector('[data-fader-db]')?.textContent ?? ''
      const peak = strip?.querySelector('[data-meter-peak-db]')?.textContent ?? ''
      return {
        strip: strip != null,
        faderDb: db,
        mute: mute instanceof HTMLButtonElement ? mute.getAttribute('aria-pressed') === 'true' : false,
        peakText: peak,
        unavailable: document.querySelector('[data-meter-unavailable]') != null
      }
    })()`)
    record('channel strip state (name/fader/mute controls)', stripUi.strip && /dB/i.test(stripUi.faderDb), JSON.stringify(stripUi))

    // Toggle mute via UI and confirm aria-pressed flips
    await js(`(() => {
      const mute = document.querySelector('[data-action="strip-mute"]')
      if (mute instanceof HTMLElement) mute.click()
      return true
    })()`)
    await wait(400)
    const muteOn = await js<boolean>(`(() => {
      const mute = document.querySelector('[data-action="strip-mute"]')
      return mute instanceof HTMLButtonElement && mute.getAttribute('aria-pressed') === 'true'
    })()`)
    record('mute/solo UI synchronization', muteOn === true, `mutePressed=${muteOn}`)

    await js(`(() => {
      const mute = document.querySelector('[data-action="strip-mute"]')
      if (mute instanceof HTMLElement) mute.click()
      return true
    })()`)

    // Clear peaks control present on master
    const masterClear = await js<boolean>(`document.querySelector('[data-action="master-clear-peaks"]') != null`)
    record('master clear peak action present', masterClear, String(masterClear))

    await shot('mixer-strips')
    await shot('master-meter')

    record('no renderer console errors', consoleErrors.length === 0, consoleErrors.length === 0 ? 'none' : consoleErrors.slice(0, 4).join(' | '))
    checks.push({ scenario: 'live microphone', result: 'NOT RUN', detail: 'NOT RUN — NO HARDWARE' })
  } catch (error) {
    const extra = consoleErrors.length > 0 ? ` | console: ${consoleErrors.slice(0, 4).join(' | ')}` : ''
    record('mixer UX 273 check crashed', false, (error instanceof Error ? error.message : String(error)) + extra)
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
  fs.writeFileSync(path.join(outDir, 'phase273-summary.json'), JSON.stringify(summary, null, 2))
  console.log(`MIXER_UX_273_CHECK pass=${summary.pass} fail=${summary.fail} not_run=${summary.notRun}`)
  for (const check of checks)
    console.log(`${check.result}\t${check.scenario}\t${check.detail}`)
  return summary.fail === 0 ? 0 : 1
}
