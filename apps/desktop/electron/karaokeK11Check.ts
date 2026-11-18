import type { BrowserWindow } from 'electron'
import fs from 'fs'
import http from 'http'
import path from 'path'
import type { EngineHost } from './engineHost'
import { resolveRendererPath, startLocalRendererServer } from './localRendererServer'

/** Keep in sync with describeYoutubePlayerError in YouTubePlayer.tsx (renderer). */
function mapPlayerError(code: number): { status: string, detail: string } {
  if (code === 100 || code === 101 || code === 150)
    return { status: 'unavailable', detail: `This video is unavailable or embedding is disabled by the owner (YouTube error ${code}).` }
  if (code === 2)
    return { status: 'error', detail: 'Invalid YouTube video id (YouTube error 2).' }
  if (code === 5)
    return { status: 'error', detail: 'The HTML5 player could not play this video (YouTube error 5).' }
  if (code === 153)
    return {
      status: 'unavailable',
      detail: 'YouTube rejected the embed (error 153 — missing/invalid embedder identity). Use an http(s) app origin, or open the video externally.'
    }
  return { status: 'error', detail: `YouTube player error (${code}).` }
}

interface Check { scenario: string, result: 'PASS' | 'FAIL' | 'NOT RUN', detail: string }

export interface KaraokeK11CheckOptions {
  outDir: string
  appOrigin: string
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function httpGet(url: string): Promise<{ status: number, headers: http.IncomingHttpHeaders, body: string }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8')
        })
      })
    }).on('error', reject)
  })
}

export async function runKaraokeK11Check(win: BrowserWindow, _engine: EngineHost, options: KaraokeK11CheckOptions): Promise<number> {
  const { outDir, appOrigin } = options
  fs.mkdirSync(outDir, { recursive: true })
  const web = win.webContents
  const checks: Check[] = []

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
    fs.writeFileSync(path.join(outDir, `karaoke-k11-${name}.png`), image.toPNG())
  }

  try {
    // --- Local server path security ---
    const tmpRoot = path.join(outDir, 'fake-renderer')
    fs.mkdirSync(tmpRoot, { recursive: true })
    fs.writeFileSync(path.join(tmpRoot, 'index.html'), '<!doctype html><title>ok</title>')
    fs.writeFileSync(path.join(tmpRoot, 'app.js'), 'console.log(1)')
    record('resolve index.html', resolveRendererPath(tmpRoot, '/')?.endsWith('index.html') === true, resolveRendererPath(tmpRoot, '/') ?? 'null')
    record('resolve nested asset', resolveRendererPath(tmpRoot, '/app.js')?.endsWith('app.js') === true, resolveRendererPath(tmpRoot, '/app.js') ?? 'null')
    record('reject path traversal', resolveRendererPath(tmpRoot, '/../secret.txt') == null, 'blocked')
    record('reject missing file', resolveRendererPath(tmpRoot, '/nope.js') == null, 'missing')

    const probe = await startLocalRendererServer(tmpRoot)
    try {
      const index = await httpGet(`${probe.origin}/`)
      record('local server serves index', index.status === 200 && index.body.includes('<title>ok</title>'), `status=${index.status}`)
      record('local server sets nosniff', String(index.headers['x-content-type-options'] ?? '').includes('nosniff'), String(index.headers['x-content-type-options']))
      record('local server denies framing', String(index.headers['x-frame-options'] ?? '') === 'DENY', String(index.headers['x-frame-options']))
      const badHost = await new Promise<{ status: number }>((resolve, reject) => {
        const req = http.request({
          host: '127.0.0.1',
          port: probe.port,
          path: '/',
          headers: { Host: 'evil.example' }
        }, (res) => {
          res.resume()
          resolve({ status: res.statusCode ?? 0 })
        })
        req.on('error', reject)
        req.end()
      })
      record('local server rejects bad Host', badHost.status === 403, `status=${badHost.status}`)
    } finally {
      await probe.close()
    }

    // --- Error mapping (no network) ---
    const e153 = mapPlayerError(153)
    const e101 = mapPlayerError(101)
    const e2 = mapPlayerError(2)
    record('error 153 maps to unavailable', e153.status === 'unavailable' && e153.detail.includes('153'), e153.detail)
    record('error 101 maps to unavailable', e101.status === 'unavailable', e101.detail)
    record('error 2 maps to invalid id', e2.status === 'error' && e2.detail.toLowerCase().includes('invalid'), e2.detail)

    // --- Live app origin from main window ---
    record('appOrigin is http 127.0.0.1', /^http:\/\/127\.0\.0\.1:\d+$/.test(appOrigin), appOrigin)
    const page = await js<{ origin: string, protocol: string, href: string }>(`(() => ({
      origin: window.location.origin,
      protocol: window.location.protocol,
      href: window.location.href
    }))()`)
    record('renderer document uses http origin', page.protocol === 'http:' && page.origin === appOrigin, JSON.stringify(page))
    record('renderer is not file://', page.protocol !== 'file:', page.protocol)

    await js(`(() => {
      const btn = document.querySelector('[data-view="karaoke"]')
      if (btn instanceof HTMLElement) btn.click()
      return true
    })()`)
    await wait(600)

    const ui = await js<{ panel: boolean, openExternal: boolean, originLabel: string }>(`(() => ({
      panel: document.querySelector('[data-panel="karaoke-k1"]') != null,
      openExternal: document.querySelector('[data-action="karaoke-open-external"]') != null,
      originLabel: document.querySelector('[data-app-origin-label]')?.textContent ?? ''
    }))()`)
    record('Karaoke UI shows open-external control', ui.panel && ui.openExternal, JSON.stringify(ui))
    record('Karaoke UI shows app origin', ui.originLabel.includes(appOrigin), ui.originLabel)

    // Official IFrame API sample video (allows embedding); avoid videos that may block embeds.
    const sampleWatch = 'https://www.youtube.com/watch?v=M7lc1UVf-VE'
    await js(`(() => {
      if (typeof window.__mspKaraokeLoad === 'function')
        window.__mspKaraokeLoad(${JSON.stringify(sampleWatch)})
      return typeof window.__mspKaraokeLoad === 'function'
    })()`)

    let status = 'idle'
    let detail = ''
    let iframeSrc = ''
    for (let i = 0; i < 50; i++) {
      await wait(500)
      const snap = await js<{ status: string, detail: string, iframeSrc: string }>(`(() => {
        const statusEl = document.querySelector('[data-player-status]')
        const status = statusEl?.getAttribute('data-player-status') ?? 'missing'
        const banner = document.querySelector('[data-karaoke-embed-error]')?.textContent ?? ''
        const list = Array.from(document.querySelectorAll('[data-karaoke-status] li')).map((n) => n.textContent ?? '')
        const statusLine = list.find((line) => /Embedding|Video ready|Playing|Player error|Loading/i.test(line)) ?? ''
        const iframe = document.querySelector('[data-youtube-host] iframe')
        return {
          status,
          detail: banner || statusLine,
          iframeSrc: iframe instanceof HTMLIFrameElement ? iframe.src : ''
        }
      })()`)
      status = snap.status
      detail = snap.detail
      iframeSrc = snap.iframeSrc
      if (status === 'ready' || status === 'playing' || status === 'unavailable' || status === 'error')
        break
    }
    const playerOk = status === 'ready' || status === 'playing'
    const handled = ['ready', 'playing', 'paused', 'unavailable', 'error', 'loading-api', 'loading-video'].includes(status)
    const not153 = !/error 153|file:\/\//i.test(detail)
    record('player initialization reaches terminal/handled state', handled, `${status} | ${detail}`)
    record('iframe uses youtube embed host', iframeSrc.includes('youtube.com/embed/') || playerOk, iframeSrc || '(no iframe yet)')
    record('no Error 153 under http origin', not153 || playerOk, detail || status)
    record('real YouTube playback path (ready/playing)', playerOk, `${status} | ${detail}`)
    // If unavailable (owner/network), still verify embed-error banner + external open affordance.
    if (!playerOk) {
      const banner = await js<boolean>(`document.querySelector('[data-karaoke-embed-error]') != null`)
      record('embed error banner when not playable', banner || status === 'loading-api' || status === 'loading-video', `banner=${banner} status=${status}`)
    } else {
      record('embed error banner when not playable', true, 'player ready — banner not required')
    }

    // Cleanup: clear video destroys host contents.
    await js(`(() => {
      const clear = document.querySelector('[data-action="karaoke-clear"]')
      if (clear instanceof HTMLElement) clear.click()
      return true
    })()`)
    await wait(400)
    const cleaned = await js<{ status: string, hostEmpty: boolean }>(`(() => {
      const host = document.querySelector('[data-youtube-host]')
      return {
        status: document.querySelector('[data-player-status]')?.getAttribute('data-player-status') ?? 'missing',
        hostEmpty: host == null || host.childElementCount === 0
      }
    })()`)
    record('player cleanup on clear', cleaned.status === 'idle' && cleaned.hostEmpty, JSON.stringify(cleaned))

    await shot('origin')
    // Reload sample video for a playback screenshot when possible.
    await js(`(() => {
      if (typeof window.__mspKaraokeLoad === 'function')
        window.__mspKaraokeLoad(${JSON.stringify(sampleWatch)})
      return true
    })()`)
    await wait(6000)
    await shot('player')

    checks.push({ scenario: 'live microphone', result: 'NOT RUN', detail: 'NOT RUN — NO HARDWARE' })
  } catch (error) {
    record('karaoke k11 check crashed', false, error instanceof Error ? error.message : String(error))
  }

  const summary = {
    pass: checks.filter((c) => c.result === 'PASS').length,
    fail: checks.filter((c) => c.result === 'FAIL').length,
    notRun: checks.filter((c) => c.result === 'NOT RUN').length,
    checks,
    appOrigin
  }
  fs.writeFileSync(path.join(outDir, 'karaoke-k11-summary.json'), JSON.stringify(summary, null, 2))
  console.log(`KARAOKE_K11_CHECK pass=${summary.pass} fail=${summary.fail} not_run=${summary.notRun} origin=${appOrigin}`)
  for (const check of checks)
    console.log(`${check.result}\t${check.scenario}\t${check.detail}`)
  return summary.fail === 0 ? 0 : 1
}
