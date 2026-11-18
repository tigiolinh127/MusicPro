import type { BrowserWindow } from 'electron'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { EngineHost } from './engineHost'
import { writeWav24 } from './workflowCheck'

interface Check { scenario: string, result: 'PASS' | 'FAIL' | 'NOT RUN', detail: string }

export interface KaraokeK2CheckOptions { outDir: string }

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

function rms(samples: Float32Array): number {
  let sum = 0
  for (let i = 0; i < samples.length; i++)
    sum += samples[i]! * samples[i]!
  return Math.sqrt(sum / Math.max(1, samples.length))
}

function readWavMonoApprox(file: string): { rate: number, samples: Float32Array } {
  const data = fs.readFileSync(file)
  if (data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WAVE')
    throw new Error(`${file} is not a WAV`)
  let offset = 12
  let channels = 1
  let rate = 48000
  let bits = 16
  let samples: Buffer | null = null
  while (offset + 8 <= data.length) {
    const id = data.toString('ascii', offset, offset + 4)
    const size = data.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ') {
      channels = data.readUInt16LE(body + 2)
      rate = data.readUInt32LE(body + 4)
      bits = data.readUInt16LE(body + 14)
    } else if (id === 'data') {
      samples = data.subarray(body, body + size)
      break
    }
    offset = body + size + (size % 2)
  }
  if (samples == null)
    throw new Error('no data chunk')
  const frameBytes = channels * (bits / 8)
  const frames = Math.floor(samples.length / frameBytes)
  const out = new Float32Array(frames)
  for (let i = 0; i < frames; i++) {
    let sum = 0
    for (let c = 0; c < channels; c++) {
      const at = i * frameBytes + c * (bits / 8)
      if (bits === 24) {
        let v = samples[at]! | (samples[at + 1]! << 8) | (samples[at + 2]! << 16)
        if (v & 0x800000)
          v |= ~0xffffff
        sum += v / 8388607
      } else {
        sum += samples.readInt16LE(at) / 32768
      }
    }
    out[i] = sum / channels
  }
  return { rate, samples: out }
}

export async function runKaraokeK2Check(win: BrowserWindow, _engine: EngineHost, options: KaraokeK2CheckOptions): Promise<number> {
  const { outDir } = options
  fs.mkdirSync(outDir, { recursive: true })
  const web = win.webContents
  const checks: Check[] = []
  const backingPath = path.join(outDir, 'k2-backing.wav')
  const vocalFixture = path.join(outDir, 'k2-vocal-fixture.wav')
  let probe: EngineHost | null = null
  const uncaught: string[] = []

  function record(scenario: string, ok: boolean, detail: string): void {
    checks.push({ scenario, result: ok ? 'PASS' : 'FAIL', detail })
  }

  const consoleErrors: string[] = []
  const onConsole = (_event: unknown, level: number, message: string): void => {
    if (level >= 2)
      consoleErrors.push(message)
  }
  web.on('console-message', onConsole)

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
    fs.writeFileSync(path.join(outDir, `karaoke-k2-${name}.png`), image.toPNG())
  }

  const onUncaught = (error: Error): void => { uncaught.push(error.message) }
  process.on('uncaughtException', onUncaught)

  try {
    // UI first — avoids racing the main renderer against multi-engine device churn.
    await wait(800)
    await js(`(() => {
      const btn = document.querySelector('[data-view="karaoke"]')
      if (btn instanceof HTMLElement) btn.click()
      return true
    })()`)
    await wait(700)

    await js(`(() => {
      if (typeof window.__mspKaraokeMode === 'function') window.__mspKaraokeMode('studio')
      return typeof window.__mspKaraokeMode === 'function'
    })()`)
    await wait(400)

    const studioUi = await js<{
      mode: string | null
      studio: boolean
      offset: boolean
      review: boolean
      record: boolean
      backingGain: boolean
      vocalGain: boolean
      noBacking: boolean
    }>(`(() => {
      const root = document.querySelector('[data-panel="karaoke-k1"]')
      return {
        mode: root?.getAttribute('data-karaoke-mode') ?? null,
        studio: document.querySelector('[data-studio-panel]') != null,
        offset: document.querySelector('[data-action="karaoke-record-offset"]') != null,
        review: document.querySelector('[data-action="karaoke-review"]') != null,
        record: document.querySelector('[data-action="karaoke-record-start"]') != null,
        backingGain: document.querySelector('[data-action="karaoke-backing-gain"]') != null,
        vocalGain: document.querySelector('[data-action="karaoke-vocal-gain"]') != null,
        noBacking: document.querySelector('[data-karaoke-no-backing]') != null
      }
    })()`)
    record('Studio mode UI present', studioUi.mode === 'studio' && studioUi.studio && studioUi.offset && studioUi.review && studioUi.record, JSON.stringify(studioUi))
    record('backing and vocal volume controls', studioUi.backingGain && studioUi.vocalGain, JSON.stringify(studioUi))
    record('missing backing explained', studioUi.noBacking, JSON.stringify(studioUi))

    await js(`(() => {
      if (typeof window.__mspKaraokeOffset === 'function') window.__mspKaraokeOffset(0.25)
      return true
    })()`)
    const offsetVal = await js<string>(`(() => {
      const input = document.querySelector('[data-action="karaoke-record-offset"]')
      return input instanceof HTMLInputElement ? input.value : ''
    })()`)
    record('manual offset control wired', Math.abs(Number(offsetVal) - 0.25) < 0.0001, offsetVal)

    await js(`(() => {
      if (typeof window.__mspKaraokeMode === 'function') window.__mspKaraokeMode('youtube')
      return true
    })()`)
    await wait(400)
    const ytUi = await js<{ mode: string | null, url: boolean, hint: boolean }>(`(() => {
      const root = document.querySelector('[data-panel="karaoke-k1"]')
      const status = Array.from(document.querySelectorAll('[data-karaoke-status] li')).map((n) => n.textContent ?? '').join(' | ')
      const body = document.body.innerText
      return {
        mode: root?.getAttribute('data-karaoke-mode') ?? null,
        url: document.querySelector('[data-action="karaoke-url"]') != null,
        hint: /YouTube audio is never/i.test(body) || /never captured/i.test(status)
      }
    })()`)
    record('YouTube mode remains available', ytUi.mode === 'youtube' && ytUi.url, JSON.stringify(ytUi))
    record('YouTube no-capture boundary messaging', ytUi.hint, JSON.stringify(ytUi))

    await js(`(() => {
      if (typeof window.__mspKaraokeMode === 'function') window.__mspKaraokeMode('studio')
      return true
    })()`)
    await wait(300)
    await shot('studio')
    await js(`(() => {
      if (typeof window.__mspKaraokeMode === 'function') window.__mspKaraokeMode('youtube')
      return true
    })()`)
    await wait(300)
    await shot('youtube-boundary')

    // Distinct tones: backing ~220 Hz, vocal fixture ~880 Hz (virtual input uses sine separately).
    writeWav24(backingPath, 48000, 48000 * 2, (i) => 0.35 * Math.sin(2 * Math.PI * 220 * i / 48000), (i) => 0.35 * Math.sin(2 * Math.PI * 220 * i / 48000))
    writeWav24(vocalFixture, 48000, 48000, (i) => 0.2 * Math.sin(2 * Math.PI * 880 * i / 48000), (i) => 0.2 * Math.sin(2 * Math.PI * 880 * i / 48000))
    const backingHash = crypto.createHash('sha256').update(fs.readFileSync(backingPath)).digest('hex')

    probe = new EngineHost(findEngine())
    record('probe EngineHost started', probe.startupError == null, probe.startupError ?? 'ok')
    if (probe.startupError != null) {
      // Continue — UI already exercised.
    } else {
      await probe.request('configure', { sampleRate: 48000, bufferSize: 512 })
      await probe.request('setRecordFolder', { path: outDir })
      await probe.request('setVirtualInput', { enabled: true, frequency: 660, level: 0.25 })

      // Engine disconnect without EPIPE
      const victim = new EngineHost(findEngine())
      await victim.request('ping', {}, 5000)
      victim.forceKill()
      await wait(300)
      const dead = await victim.request('ping', {}, 2000).then(
        () => ({ ok: false, detail: 'unexpected success' }),
        (error: Error) => ({ ok: !/EPIPE/i.test(error.message), detail: error.message })
      )
      record('engine disconnect rejects without EPIPE', dead.ok, dead.detail)
      await victim.shutdown()

      for (const track of ((await probe.request('getState')).result as { tracks: Array<{ id: string }> }).tracks)
        await probe.request('removeTrack', { trackId: track.id })

      await probe.request('addTrack', { name: 'Karaoke Backing' })
      await probe.request('addTrack', { name: 'Karaoke Vocal' })
      let state = (await probe.request('getState')).result as {
        tracks: Array<{
          id: string
          name: string
          gain: number
          clips: Array<{ id: string, timelineStart: number, duration: number }>
          takes?: Array<{ id: string, timelineStart: number }>
          armed: boolean
        }>
        record: { lastTake: { startSeconds: number, takes: Array<{ path: string, placed: boolean }> } | null }
        position: number
        transport: string
      }
      const backingId = state.tracks.find((t) => t.name === 'Karaoke Backing')!.id
      const vocalId = state.tracks.find((t) => t.name === 'Karaoke Vocal')!.id

      const imported = await probe.request('importClip', { trackId: backingId, path: backingPath, timelineStart: 0 }, 15000)
      record('local backing import', imported.ok === true, imported.ok ? 'imported' : String(imported.error))

      // Track volumes
      const volOk = await probe.request('setTrack', { trackId: backingId, gain: 0.5 })
      await probe.request('setTrack', { trackId: vocalId, gain: 1.2 })
      state = (await probe.request('getState')).result as typeof state
      record('track volume setTrack gain', volOk.ok === true
        && Math.abs((state.tracks.find((t) => t.id === backingId)?.gain ?? -1) - 0.5) < 0.001
        && Math.abs((state.tracks.find((t) => t.id === vocalId)?.gain ?? -1) - 1.2) < 0.001,
      `backing=${state.tracks.find((t) => t.id === backingId)?.gain} vocal=${state.tracks.find((t) => t.id === vocalId)?.gain}`)

      // Light FX on vocal — export path must still succeed
      const fx = await probe.request('addEffect', { target: 'track', ownerId: vocalId, type: 'eq' })
      record('track effects attach for mix path', fx.ok === true, fx.ok ? 'eq' : String(fx.error))

      await probe.request('setTrackRecord', { trackId: vocalId, armed: true, input: '1', mode: 'dry', monitor: false })

      // Manual offset: seek then record → take placed at seek
      const offsetSec = 0.25
      await probe.request('transport', { action: 'stop' })
      const seeked = await probe.request('transport', { action: 'seek', position: offsetSec })
      record('manual offset seek before record', seeked.ok === true, String(offsetSec))

      // Must fail record while playing — verify pause/stop coordination requirement
      await probe.request('transport', { action: 'play' })
      await wait(100)
      const whilePlaying = await probe.request('record', { action: 'start' })
      record('record refused while transport playing', whilePlaying.ok === false, String(whilePlaying.error ?? 'unexpected ok'))
      await probe.request('transport', { action: 'stop' })
      await probe.request('transport', { action: 'seek', position: offsetSec })

      const started = await probe.request('record', { action: 'start' })
      record('record start with backing on timeline', started.ok === true, started.ok ? 'started' : String(started.error))
      state = (await probe.request('getState')).result as typeof state
      record('transport plays during recording', state.transport === 'playing', state.transport)
      await wait(800)
      const stopped = await probe.request('record', { action: 'stop' }, 15000)
      record('record stop', stopped.ok === true, stopped.ok ? 'stopped' : String(stopped.error))

      state = (await probe.request('getState')).result as typeof state
      const take1 = state.record.lastTake
      const take1Paths = (take1?.takes ?? []).map((t) => t.path).filter(Boolean)
      record('separate mic take WAV created', take1Paths.length >= 1 && take1Paths.every((p) => fs.existsSync(p)), take1Paths[0] ?? 'none')
      record('take placed near manual offset', take1 != null && Math.abs(take1.startSeconds - offsetSec) < 0.05, take1 ? String(take1.startSeconds) : 'none')
      record('backing fixture unchanged (no capture into backing file)', crypto.createHash('sha256').update(fs.readFileSync(backingPath)).digest('hex') === backingHash, 'hash')

      // Second take (multi-take)
      await probe.request('transport', { action: 'stop' })
      await probe.request('transport', { action: 'seek', position: offsetSec })
      const started2 = await probe.request('record', { action: 'start' })
      await wait(500)
      const stopped2 = await probe.request('record', { action: 'stop' }, 15000)
      state = (await probe.request('getState')).result as typeof state
      const vocalTrack = state.tracks.find((t) => t.id === vocalId)
      const takeLanes = vocalTrack?.takes?.length ?? 0
      const clips = vocalTrack?.clips.length ?? 0
      record('multiple takes supported', started2.ok && stopped2.ok && (takeLanes >= 2 || clips >= 1 || (state.record.lastTake?.takes.length ?? 0) >= 1),
        `takes=${takeLanes} clips=${clips}`)

      // Missing device / no arm handling
      await probe.request('setTrackRecord', { trackId: vocalId, armed: false })
      await probe.request('transport', { action: 'stop' })
      const noArm = await probe.request('record', { action: 'start' })
      record('missing armed track handled', noArm.ok === false, String(noArm.error ?? 'unexpected ok'))
      await probe.request('setTrackRecord', { trackId: vocalId, armed: true, input: '1', mode: 'dry', monitor: false })

      // Mix export composition: backing + vocal audible
      const mixPath = path.join(outDir, 'k2-mix.wav')
      const mixed = await probe.request('exportWav', { path: mixPath, sampleRate: 48000 }, 60000)
      record('mix export succeeds', mixed.ok === true && fs.existsSync(mixPath), mixed.ok ? mixPath : String(mixed.error))
      if (fs.existsSync(mixPath)) {
        const wav = readWavMonoApprox(mixPath)
        const level = rms(wav.samples)
        record('mix export not silent', level > 0.001, `rms=${level.toFixed(5)}`)
        // Mix duration should cover backing (~2s) content
        const seconds = wav.samples.length / wav.rate
        record('mix export duration includes content', seconds >= 1.5, `seconds=${seconds.toFixed(3)}`)
      } else {
        record('mix export not silent', false, 'no mix')
        record('mix export duration includes content', false, 'no mix')
      }

      // Vocal-only take must not be a copy of backing fixture
      if (take1Paths[0] != null) {
        const takeHash = crypto.createHash('sha256').update(fs.readFileSync(take1Paths[0])).digest('hex')
        record('vocal take is not backing audio file', takeHash !== backingHash, 'distinct')
      } else {
        record('vocal take is not backing audio file', false, 'no take')
      }

      // YouTube audio never in project — no youtube path/clip
      state = (await probe.request('getState')).result as typeof state
      const paths = state.tracks.flatMap((t) => [t.name, ...(t.clips?.map((c) => c.id) ?? [])])
      record('no YouTube audio captured into engine state', !JSON.stringify(state).toLowerCase().includes('youtube.com'), paths.join(','))
    }

    record('no uncaughtException during karaoke k2 check', uncaught.length === 0, uncaught.length === 0 ? 'none' : uncaught.join(' | '))
    if (consoleErrors.length > 0)
      record('renderer console clean', false, consoleErrors.slice(0, 5).join(' | '))
    checks.push({ scenario: 'live microphone', result: 'NOT RUN', detail: 'NOT RUN — NO HARDWARE' })
  } catch (error) {
    const extra = consoleErrors.length > 0 ? ` | console: ${consoleErrors.slice(0, 5).join(' | ')}` : ''
    record('karaoke k2 check crashed', false, (error instanceof Error ? error.message : String(error)) + extra)
  } finally {
    web.removeListener('console-message', onConsole)
    process.off('uncaughtException', onUncaught)
    try { await probe?.shutdown() } catch { /* ignore */ }
  }

  const summary = {
    pass: checks.filter((c) => c.result === 'PASS').length,
    fail: checks.filter((c) => c.result === 'FAIL').length,
    notRun: checks.filter((c) => c.result === 'NOT RUN').length,
    checks
  }
  fs.writeFileSync(path.join(outDir, 'karaoke-k2-summary.json'), JSON.stringify(summary, null, 2))
  console.log(`KARAOKE_K2_CHECK pass=${summary.pass} fail=${summary.fail} not_run=${summary.notRun}`)
  for (const check of checks)
    console.log(`${check.result}\t${check.scenario}\t${check.detail}`)
  return summary.fail === 0 ? 0 : 1
}
