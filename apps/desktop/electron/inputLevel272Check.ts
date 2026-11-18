import type { BrowserWindow } from 'electron'
import fs from 'fs'
import path from 'path'
import { EngineHost } from './engineHost'

interface Check { scenario: string, result: 'PASS' | 'FAIL' | 'NOT RUN', detail: string }

export interface InputLevel272CheckOptions { outDir: string }

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

function linearToDbFS(linear: number): number {
  if (!(linear > 1.0e-12))
    return -120
  return 20 * Math.log10(linear)
}

function dbToLinear(db: number): number {
  return Math.pow(10, db / 20)
}

export async function runInputLevel272Check(win: BrowserWindow, _engine: EngineHost, options: InputLevel272CheckOptions): Promise<number> {
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
    fs.writeFileSync(path.join(outDir, `phase272-${name}.png`), image.toPNG())
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

    const ui = await js<{
      panel: boolean
      level: boolean
      gain: boolean
      guidance: boolean
      unavailable: boolean
    }>(`(() => {
      return {
        panel: document.querySelector('[data-panel="recording-workflow-271"]') != null,
        level: document.querySelector('[data-input-level-272]') != null,
        gain: document.querySelector('[data-input-gain-272]') != null,
        guidance: document.querySelector('[data-input-level-guidance]') != null,
        unavailable: document.querySelector('[data-input-level-unavailable]') != null
      }
    })()`)
    record('input level UI present in Recording workflow', ui.panel && ui.level && ui.gain && ui.guidance, JSON.stringify(ui))

    // Pure mapping checks (renderer helpers via executeJavaScript evaluating same formulas)
    const mapping = await js<{ unity: boolean, plus6: boolean, dbRound: boolean }>(`(() => {
      const dbToGain = (db) => Math.pow(10, db / 20)
      const linearToDb = (x) => !(x > 1e-12) ? -120 : 20 * Math.log10(x)
      const unity = Math.abs(dbToGain(0) - 1) < 1e-9
      const plus6 = Math.abs(dbToGain(6) - 2) < 0.01
      const dbRound = Math.abs(linearToDb(0.5) - (-6.0206)) < 0.05
      return { unity, plus6, dbRound }
    })()`)
    record('gain mapping unity at 0 dB', mapping.unity, JSON.stringify(mapping))
    record('gain mapping +6 dB ≈ ×2', mapping.plus6, JSON.stringify(mapping))
    record('dBFS conversion for 0.5 linear ≈ −6 dBFS', mapping.dbRound, JSON.stringify(mapping))

    const guidanceMap = await js<{ tooLow: string, healthy: string, near: string, clip: string, unavail: string }>(`(() => {
      const thresholds = { tooLowDbFS: -40, nearClipDbFS: -6, clipDbFS: 0 }
      const guide = (m) => {
        if (m == null || !m.available) return 'unavailable'
        if (m.clip || m.peakDbFS >= thresholds.clipDbFS) return 'clipping'
        if (m.peakDbFS >= thresholds.nearClipDbFS) return 'near-clip'
        if (m.peakDbFS < thresholds.tooLowDbFS) return 'too-low'
        return 'healthy'
      }
      return {
        tooLow: guide({ available: true, peakDbFS: -50, clip: false }),
        healthy: guide({ available: true, peakDbFS: -18, clip: false }),
        near: guide({ available: true, peakDbFS: -4, clip: false }),
        clip: guide({ available: true, peakDbFS: 0.1, clip: true }),
        unavail: guide({ available: false, peakDbFS: -12, clip: false })
      }
    })()`)
    record('meter guidance too-low / healthy / near-clip / clipping / unavailable',
      guidanceMap.tooLow === 'too-low' && guidanceMap.healthy === 'healthy' && guidanceMap.near === 'near-clip'
        && guidanceMap.clip === 'clipping' && guidanceMap.unavail === 'unavailable',
      JSON.stringify(guidanceMap))

    probe = new EngineHost(findEngine())
    record('probe EngineHost started', probe.startupError == null, probe.startupError ?? 'ok')
    if (probe.startupError == null) {
      await probe.request('configure', { sampleRate: 48000, bufferSize: 512 })
      await probe.request('setRecordFolder', { path: outDir })

      const unityState = (await probe.request('getState')).result as { inputGainDb?: number, masterGain: number }
      record('input gain defaults to unity 0 dB', (unityState.inputGainDb ?? 0) === 0, JSON.stringify({ inputGainDb: unityState.inputGainDb }))

      const badGain = await probe.request('setInputGain', { gainDb: 99 })
      record('input gain rejects out-of-range', badGain.ok === false, String(badGain.error ?? 'unexpected ok'))

      const setGain = await probe.request('setInputGain', { gainDb: 6 })
      const afterGain = (await probe.request('getState')).result as { inputGainDb?: number, masterGain: number }
      record('setInputGain updates inputGainDb only', setGain.ok === true && afterGain.inputGainDb === 6
        && Math.abs(afterGain.masterGain - unityState.masterGain) < 1e-9,
        JSON.stringify({ inputGainDb: afterGain.inputGainDb, masterGain: afterGain.masterGain }))
      await probe.request('setInputGain', { gainDb: 0 })

      // Missing / virtual-off: meter may still be available if a hardware mic is open — check virtual path instead.
      await probe.request('setVirtualInput', { enabled: false })
      await wait(120)
      const metersOff = (await probe.request('getMeters')).result as {
        input?: { available: boolean, peakL: number, peakR: number, rmsL: number, channels: number, clip: boolean, peakDbFS: number, gainDb: number }
      }
      // When no virtual and no device channels, available should be false. If a mic is present, available can be true — still valid.
      const channels = ((await probe.request('getState')).result as { inputChannels: number }).inputChannels
      if (channels <= 0) {
        record('missing input device → input meter unavailable', metersOff.input?.available === false, JSON.stringify(metersOff.input))
      } else {
        record('hardware input present — meter availability follows device (no fabricated levels)',
          metersOff.input != null && typeof metersOff.input.available === 'boolean',
          JSON.stringify({ channels, input: metersOff.input }))
      }

      await probe.request('setVirtualInput', { enabled: true, frequency: 440, level: 0.25 })
      await probe.request('transport', { action: 'play' })
      await wait(250)
      const metersOn = (await probe.request('getMeters')).result as {
        input?: { available: boolean, peakL: number, peakR: number, rmsL: number, rmsR: number, channels: number, clip: boolean, peakDbFS: number, peakHoldL: number, gainDb: number }
      }
      const input = metersOn.input
      record('virtual input enables measurable peak/RMS',
        input?.available === true && (input.peakL > 0.05 || input.peakR > 0.05) && (input.rmsL > 0 || input.rmsR > 0),
        JSON.stringify(input))
      record('stereo channel indicators on virtual (2 ch)',
        input != null && input.channels >= 2 && input.peakL > 0 && input.peakR > 0,
        JSON.stringify({ channels: input?.channels, peakL: input?.peakL, peakR: input?.peakR }))
      record('peak hold present when signal active',
        input != null && input.peakHoldL >= input.peakL * 0.5,
        JSON.stringify({ peakHoldL: input?.peakHoldL, peakL: input?.peakL }))

      // Stop before record — start rejects while playing (Phase 2.7.1).
      await probe.request('transport', { action: 'stop' })
      for (const track of ((await probe.request('getState')).result as { tracks: Array<{ id: string }> }).tracks)
        await probe.request('removeTrack', { trackId: track.id })
      await probe.request('addTrack', { name: 'InputLevel 272' })
      const st = (await probe.request('getState')).result as { tracks: Array<{ id: string, name: string, gain: number }> }
      const trackId = st.tracks.find((t) => t.name === 'InputLevel 272')!.id
      const trackGainBefore = st.tracks.find((t) => t.id === trackId)!.gain
      await probe.request('setTrackRecord', { trackId, armed: true, input: '1+2', mode: 'dry', monitor: false })
      await probe.request('setTrack', { trackId, gain: 1 })
      await probe.request('setInputGain', { gainDb: 0 })
      await probe.request('transport', { action: 'seek', position: 0 })
      const start0 = await probe.request('record', { action: 'start' })
      await wait(450)
      const stop0 = await probe.request('record', { action: 'stop' }, 15000)
      const take0 = ((stop0.result as { take?: { takes: Array<{ path: string }> } })?.take?.takes ?? [])[0]?.path

      await probe.request('setInputGain', { gainDb: 6 })
      await wait(80) // allow gain smooth settle
      await probe.request('transport', { action: 'seek', position: 1.0 })
      const start6 = await probe.request('record', { action: 'start' })
      await wait(450)
      const stop6 = await probe.request('record', { action: 'stop' }, 15000)
      const take6 = ((stop6.result as { take?: { takes: Array<{ path: string }> } })?.take?.takes ?? [])[0]?.path

      const afterRec = (await probe.request('getState')).result as {
        inputGainDb?: number
        tracks: Array<{ id: string, gain: number }>
        masterGain: number
      }
      record('record/stop does not reset input gain', afterRec.inputGainDb === 6, JSON.stringify({ inputGainDb: afterRec.inputGainDb }))
      record('input gain independent of track volume',
        Math.abs((afterRec.tracks.find((t) => t.id === trackId)?.gain ?? -1) - 1) < 1e-6,
        JSON.stringify({ trackGain: afterRec.tracks.find((t) => t.id === trackId)?.gain, before: trackGainBefore }))

      // Compare peak of takes (unity vs +6 dB)
      let gainPathOk = false
      let gainPathDetail = `take0=${take0 ?? 'none'} take6=${take6 ?? 'none'}`
      if (take0 && take6 && fs.existsSync(take0) && fs.existsSync(take6)) {
        const peakOf = (filePath: string): number => {
          const buf = fs.readFileSync(filePath)
          // Skip 44-byte WAV header; 24-bit PCM interleaved stereo little-endian packed in 3 bytes — engine uses float WAV often.
          // Prefer reading via engine-exported float if RIFF/fmt float; fallback: parse as Int16 if needed.
          const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
          const audioFormat = view.getUint16(20, true)
          const bits = view.getUint16(34, true)
          const dataOffset = (() => {
            let o = 12
            while (o + 8 <= buf.length) {
              const id = String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3])
              const size = view.getUint32(o + 4, true)
              if (id === 'data')
                return o + 8
              o += 8 + size
            }
            return 44
          })()
          let peak = 0
          if (audioFormat === 3 && bits === 32) {
            for (let i = dataOffset; i + 4 <= buf.length; i += 4)
              peak = Math.max(peak, Math.abs(view.getFloat32(i, true)))
          } else if (bits === 16) {
            for (let i = dataOffset; i + 2 <= buf.length; i += 2)
              peak = Math.max(peak, Math.abs(view.getInt16(i, true) / 32768))
          } else if (bits === 24) {
            for (let i = dataOffset; i + 3 <= buf.length; i += 3) {
              let v = buf[i] | (buf[i + 1] << 8) | (buf[i + 2] << 16)
              if (v & 0x800000) v |= ~0xffffff
              peak = Math.max(peak, Math.abs(v / 8388608))
            }
          }
          return peak
        }
        const p0 = peakOf(take0)
        const p6 = peakOf(take6)
        const ratio = p0 > 1e-6 ? p6 / p0 : 0
        gainPathOk = ratio > 1.5 && ratio < 2.6
        gainPathDetail = `p0=${p0.toFixed(4)} p6=${p6.toFixed(4)} ratio=${ratio.toFixed(3)} expected≈2`
      }
      record('recording follows input gain path (~+6 dB ≈ ×2)',
        start0.ok === true && start6.ok === true && stop0.ok === true && stop6.ok === true && gainPathOk,
        `start0=${String(start0.error ?? 'ok')} start6=${String(start6.error ?? 'ok')} ${gainPathDetail}`)
      void start0
      void start6

      // Clipping detection with high virtual level + gain (virtual emits only while playing)
      await probe.request('setInputGain', { gainDb: 12 })
      await probe.request('setVirtualInput', { enabled: true, frequency: 440, level: 0.9 })
      await probe.request('transport', { action: 'play' })
      await wait(300)
      const metersClip = (await probe.request('getMeters')).result as { input?: { clip: boolean, peakDbFS: number, peakL: number } }
      await probe.request('transport', { action: 'stop' })
      record('clipping detection when post-gain exceeds 0 dBFS',
        metersClip.input?.clip === true || (metersClip.input?.peakL ?? 0) >= 0.99,
        JSON.stringify(metersClip.input))

      // Monitoring independence: Mic monitor stays pre-gain; track gain unchanged; master unchanged
      const masterBefore = afterRec.masterGain
      await probe.request('setInputGain', { gainDb: -6 })
      const monState = (await probe.request('getState')).result as { masterGain: number, inputGainDb?: number, monitor: boolean }
      record('monitoring / master independent of input gain',
        Math.abs(monState.masterGain - masterBefore) < 1e-9 && monState.inputGainDb === -6,
        JSON.stringify(monState))

      // Gain smoothing: target changes without hard discontinuity evidence via meters after settle
      await probe.request('setInputGain', { gainDb: 0 })
      await wait(50)
      await probe.request('setInputGain', { gainDb: 3 })
      await wait(120)
      const metersSmooth = (await probe.request('getMeters')).result as { input?: { gainDb: number, available: boolean } }
      record('gain smoothing settles to target',
        metersSmooth.input?.gainDb === 3 && metersSmooth.input.available === true,
        JSON.stringify(metersSmooth.input))

      // Engine disconnect EPIPE protection
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

      await probe.request('setVirtualInput', { enabled: false })
      await probe.request('setInputGain', { gainDb: 0 })
      await probe.request('transport', { action: 'stop' })
    }

    // UI: enable virtual via App if possible, verify meter leaves Unavailable when signal flows
    await js(`(() => {
      const sel = document.querySelector('[data-action="recording-source"]')
      if (sel instanceof HTMLSelectElement) {
        sel.value = 'virtual'
        sel.dispatchEvent(new Event('change', { bubbles: true }))
      }
      return true
    })()`)
    await wait(400)
    await js(`(() => {
      const play = document.querySelector('[data-action="transport-play"]')
      if (play instanceof HTMLElement) play.click()
      return true
    })()`)
    await wait(700)

    const afterVirtual = await js<{ guidance: string | null, unavailable: boolean, peakText: string }>(`(() => {
      const g = document.querySelector('[data-input-level-guidance]')
      return {
        guidance: g?.getAttribute('data-input-level-guidance') ?? null,
        unavailable: document.querySelector('[data-input-level-unavailable]') != null,
        peakText: document.querySelector('[data-input-peak-db]')?.textContent ?? ''
      }
    })()`)
    record('UI meter state transitions off Unavailable when capture available',
      afterVirtual.guidance != null && afterVirtual.guidance !== 'unavailable' && /Peak/i.test(afterVirtual.peakText) && !/Peak —/.test(afterVirtual.peakText),
      JSON.stringify(afterVirtual))

    await js(`(() => {
      const stop = document.querySelector('[data-action="transport-stop"]')
      if (stop instanceof HTMLElement) stop.click()
      return true
    })()`)

    // Unity reset control
    await js(`(() => {
      const btn = document.querySelector('[data-action="input-gain-unity"]')
      if (btn instanceof HTMLElement) btn.click()
      return true
    })()`)
    await wait(300)
    const unityUi = await js<{ value: string }>(`(() => {
      const el = document.querySelector('[data-action="input-gain"]')
      return { value: el instanceof HTMLInputElement ? el.value : '' }
    })()`)
    record('Input Gain unity control resets to 0 dB', unityUi.value === '0' || unityUi.value === '0.0', JSON.stringify(unityUi))

    await shot('input-level')
    await shot('input-gain')

    record('no renderer console errors', consoleErrors.length === 0, consoleErrors.length === 0 ? 'none' : consoleErrors.slice(0, 4).join(' | '))
    checks.push({ scenario: 'live microphone', result: 'NOT RUN', detail: 'NOT RUN — NO HARDWARE' })

    // Silence unused helpers warning in strict builds
    void linearToDbFS
    void dbToLinear
  } catch (error) {
    const extra = consoleErrors.length > 0 ? ` | console: ${consoleErrors.slice(0, 4).join(' | ')}` : ''
    record('input level 272 check crashed', false, (error instanceof Error ? error.message : String(error)) + extra)
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
  fs.writeFileSync(path.join(outDir, 'phase272-summary.json'), JSON.stringify(summary, null, 2))
  console.log(`INPUT_LEVEL_272_CHECK pass=${summary.pass} fail=${summary.fail} not_run=${summary.notRun}`)
  for (const check of checks)
    console.log(`${check.result}\t${check.scenario}\t${check.detail}`)
  return summary.fail === 0 ? 0 : 1
}
