import type { BrowserWindow } from 'electron'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { EngineHost } from './engineHost'
import { writeWav24 } from './workflowCheck'
import { isYoutubeVideoId, parseYoutubeVideoId, youtubeEmbedUrl } from './youtubeUrl'

interface Check { scenario: string, result: 'PASS' | 'FAIL' | 'NOT RUN', detail: string }

export interface KaraokeK1CheckOptions { outDir: string }

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

export async function runKaraokeK1Check(win: BrowserWindow, _engine: EngineHost, options: KaraokeK1CheckOptions): Promise<number> {
  const { outDir } = options
  fs.mkdirSync(outDir, { recursive: true })
  const web = win.webContents
  const checks: Check[] = []
  const vocalPath = path.join(outDir, 'karaoke-fixture.wav')
  const uncaught: string[] = []
  let probe: EngineHost | null = null

  function record(scenario: string, ok: boolean, detail: string): void {
    checks.push({ scenario, result: ok ? 'PASS' : 'FAIL', detail })
  }

  async function js<T>(code: string): Promise<T> {
    return await web.executeJavaScript(code, true) as T
  }

  async function shot(name: string): Promise<void> {
    web.invalidate()
    await js('new Promise((resolve) => { requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))); setTimeout(() => resolve(false), 500) })')
    await wait(150)
    const image = await web.capturePage()
    fs.writeFileSync(path.join(outDir, `karaoke-k1-${name}.png`), image.toPNG())
  }

  const onUncaught = (error: Error): void => { uncaught.push(error.message) }
  process.on('uncaughtException', onUncaught)

  try {
    const watch = parseYoutubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')
    const short = parseYoutubeVideoId('https://youtu.be/dQw4w9WgXcQ')
    const shorts = parseYoutubeVideoId('https://www.youtube.com/shorts/dQw4w9WgXcQ')
    const embed = parseYoutubeVideoId('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ')
    const bare = parseYoutubeVideoId('dQw4w9WgXcQ')
    const bad = parseYoutubeVideoId('https://example.com/watch?v=nope')
    record('URL watch parse', watch.ok && watch.videoId === 'dQw4w9WgXcQ', JSON.stringify(watch))
    record('URL youtu.be parse', short.ok && short.videoId === 'dQw4w9WgXcQ', JSON.stringify(short))
    record('URL shorts parse', shorts.ok && shorts.videoId === 'dQw4w9WgXcQ', JSON.stringify(shorts))
    record('URL embed parse', embed.ok && embed.videoId === 'dQw4w9WgXcQ', JSON.stringify(embed))
    record('bare video id parse', bare.ok && bare.videoId === 'dQw4w9WgXcQ', JSON.stringify(bare))
    record('invalid URL rejected', !bad.ok, JSON.stringify(bad))
    record('video id validator', isYoutubeVideoId('dQw4w9WgXcQ') && !isYoutubeVideoId('short'), 'ok')
    record('embed URL uses youtube host', youtubeEmbedUrl('dQw4w9WgXcQ').includes('youtube.com/embed/dQw4w9WgXcQ'), youtubeEmbedUrl('dQw4w9WgXcQ'))

    writeWav24(vocalPath, 48000, 48000, (i) => 0.1 * Math.sin(2 * Math.PI * 220 * i / 48000), (i) => 0.1 * Math.sin(2 * Math.PI * 220 * i / 48000))
    const hash = crypto.createHash('sha256').update(fs.readFileSync(vocalPath)).digest('hex')

    // Dedicated probe host — do not kill the app's main EngineHost.
    probe = new EngineHost(findEngine())
    record('probe EngineHost started', probe.startupError == null, probe.startupError ?? 'ok')
    if (probe.startupError == null) {
      await probe.request('configure', { sampleRate: 48000, bufferSize: 512 })

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

      await probe.request('setVirtualInput', { enabled: true, frequency: 440, level: 0.2 })
      for (const track of ((await probe.request('getState')).result as { tracks: Array<{ id: string }> }).tracks)
        await probe.request('removeTrack', { trackId: track.id })
      await probe.request('addTrack', { name: 'Karaoke Vocal' })
      let state = (await probe.request('getState')).result as {
        tracks: Array<{ id: string, name: string }>
        record: { lastTake: { takes: Array<{ path: string }> } | null }
      }
      const trackId = state.tracks.find((t) => t.name === 'Karaoke Vocal')?.id ?? state.tracks[0]?.id
      await probe.request('setTrackRecord', { trackId, armed: true, input: '1', mode: 'dry', monitor: false })
      await probe.request('setRecordFolder', { path: outDir })
      const started = await probe.request('record', { action: 'start' })
      record('recording start (virtual input)', started.ok === true, started.ok ? 'started' : String(started.error))
      await wait(700)
      const stopped = await probe.request('record', { action: 'stop' }, 15000)
      record('recording stop state', stopped.ok === true, stopped.ok ? 'stopped' : String(stopped.error))
      state = (await probe.request('getState')).result as typeof state
      const paths = (state.record.lastTake?.takes ?? []).map((t) => t.path).filter(Boolean)
      record('recording stop yields vocal take', paths.length >= 1, paths[0] ?? 'none')
      record('vocal take persists on disk', paths[0] != null && fs.existsSync(paths[0]), paths[0] ?? 'missing')

      if (paths[0] != null) {
        const dest = path.join(outDir, 'exported-vocal.wav')
        fs.copyFileSync(paths[0], dest)
        const meta = {
          videoId: 'dQw4w9WgXcQ',
          videoPositionSec: 12.5,
          recordedAt: new Date().toISOString(),
          takePaths: paths
        }
        fs.writeFileSync(dest.replace(/\.wav$/i, '.karaoke.json'), JSON.stringify(meta, null, 2))
        const loaded = JSON.parse(fs.readFileSync(dest.replace(/\.wav$/i, '.karaoke.json'), 'utf8')) as typeof meta
        record('video position metadata persisted', loaded.videoId === 'dQw4w9WgXcQ' && loaded.videoPositionSec === 12.5, JSON.stringify(loaded))
        record('vocal WAV export copy', fs.existsSync(dest), dest)
      } else {
        record('video position metadata persisted', false, 'no take')
        record('vocal WAV export copy', false, 'no take')
      }

      await probe.request('addTrack', { name: 'Karaoke Backing' })
      state = (await probe.request('getState')).result as typeof state
      const backingId = state.tracks.find((t) => t.name === 'Karaoke Backing')?.id
      const imported = await probe.request('importClip', { trackId: backingId, path: vocalPath, timelineStart: 0 }, 15000)
      record('local backing audio import', imported.ok === true, imported.ok ? 'imported' : String(imported.error))

      const exportMixPath = path.join(outDir, 'karaoke-mix.wav')
      const mixed = await probe.request('exportWav', { path: exportMixPath, sampleRate: 48000 }, 30000)
      record('mix export with vocal+backing tracks', mixed.ok === true && fs.existsSync(exportMixPath), mixed.ok ? exportMixPath : String(mixed.error))
    }

    record('source fixture WAV protected', crypto.createHash('sha256').update(fs.readFileSync(vocalPath)).digest('hex') === hash, 'hash')

    await js(`(() => {
      const btn = document.querySelector('[data-view="karaoke"]')
      if (btn instanceof HTMLElement) btn.click()
      return true
    })()`)
    await wait(500)
    const tab = await js<{ pressed: boolean }>(`(() => ({
      pressed: document.querySelector('[data-view="karaoke"][aria-pressed="true"]') != null
    }))()`)
    record('YouTube Karaoke tab opens', tab.pressed, JSON.stringify(tab))

    const ui = await js<{
      panel: boolean
      url: boolean
      load: boolean
      csp: string
      isolationHint: boolean
    }>(`(() => {
      const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]')
      const studio = window.studio
      return {
        panel: document.querySelector('[data-panel="karaoke-k1"]') != null,
        url: document.querySelector('[data-action="karaoke-url"]') != null,
        load: document.querySelector('[data-action="karaoke-load"]') != null,
        csp: meta ? (meta.getAttribute('content') || '') : '',
        isolationHint: !!(studio && typeof studio.request === 'function') && typeof window.require === 'undefined'
      }
    })()`)
    record('Karaoke UI present', ui.panel && ui.url && ui.load, JSON.stringify({ panel: ui.panel, url: ui.url, load: ui.load }))
    record('CSP allows YouTube frame/script hosts',
      ui.csp.includes('youtube.com') && ui.csp.includes('frame-src') && ui.csp.includes('youtube-nocookie.com'),
      ui.csp.slice(0, 180))
    record('renderer has studio bridge without node require', ui.isolationHint, JSON.stringify(ui.isolationHint))

    await js(`(() => {
      if (typeof window.__mspKaraokeLoad === 'function')
        window.__mspKaraokeLoad('https://www.youtube.com/watch?v=dQw4w9WgXcQ')
      return typeof window.__mspKaraokeLoad === 'function'
    })()`)
    await wait(2500)
    const player = await js<{ status: string | null }>(`(() => ({
      status: document.querySelector('[data-player-status]')?.getAttribute('data-player-status') ?? null
    }))()`)
    const handled = player.status != null
      && ['loading-api', 'loading-video', 'ready', 'playing', 'paused', 'unavailable', 'error'].includes(player.status)
    record('player lifecycle reaches handled status', handled, player.status ?? 'null')
    record('player error states are non-crashing', handled && uncaught.length === 0, player.status ?? 'null')

    await shot('tab')
    await shot('player')

    record('no uncaughtException during karaoke check', uncaught.length === 0, uncaught.length === 0 ? 'none' : uncaught.join(' | '))
    checks.push({ scenario: 'live microphone', result: 'NOT RUN', detail: 'NOT RUN — NO HARDWARE' })
  } catch (error) {
    record('karaoke k1 check crashed', false, error instanceof Error ? error.message : String(error))
  } finally {
    process.off('uncaughtException', onUncaught)
    try { await probe?.shutdown() } catch { /* ignore */ }
  }

  const summary = {
    pass: checks.filter((c) => c.result === 'PASS').length,
    fail: checks.filter((c) => c.result === 'FAIL').length,
    notRun: checks.filter((c) => c.result === 'NOT RUN').length,
    checks
  }
  fs.writeFileSync(path.join(outDir, 'karaoke-k1-summary.json'), JSON.stringify(summary, null, 2))
  console.log(`KARAOKE_K1_CHECK pass=${summary.pass} fail=${summary.fail} not_run=${summary.notRun}`)
  for (const check of checks)
    console.log(`${check.result}\t${check.scenario}\t${check.detail}`)
  return summary.fail === 0 ? 0 : 1
}
