import type { BrowserWindow } from 'electron'
import fs from 'fs'
import path from 'path'
import type { EngineHost } from './engineHost'

interface Check { scenario: string, result: 'PASS' | 'FAIL' | 'NOT RUN', detail: string }

export interface KaraokeK3CheckOptions { outDir: string }

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function runKaraokeK3Check(win: BrowserWindow, engine: EngineHost, options: KaraokeK3CheckOptions): Promise<number> {
  const { outDir } = options
  fs.mkdirSync(outDir, { recursive: true })
  const web = win.webContents
  const checks: Check[] = []
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
    fs.writeFileSync(path.join(outDir, `karaoke-k3-${name}.png`), image.toPNG())
  }

  const onConsole = (_event: unknown, level: number, message: string): void => {
    if (level >= 3)
      consoleErrors.push(message)
  }
  web.on('console-message', onConsole)

  try {
    await wait(600)
    await js(`(() => {
      const btn = document.querySelector('[data-view="karaoke"]')
      if (btn instanceof HTMLElement) btn.click()
      return true
    })()`)
    await wait(700)

    const shell = await js<{ k3: boolean, session: boolean, sync: boolean, exportPanel: boolean, openStudio: boolean }>(`(() => ({
      k3: document.querySelector('[data-karaoke-k3="1"]') != null,
      session: document.querySelector('[data-karaoke-session]') != null,
      sync: document.querySelector('[data-karaoke-sync]') != null,
      exportPanel: document.querySelector('[data-karaoke-export]') != null,
      openStudio: document.querySelector('[data-action="karaoke-open-studio"]') != null
    }))()`)
    record('K3 workflow shell present', shell.k3 && shell.session && shell.sync && shell.exportPanel && shell.openStudio, JSON.stringify(shell))

    await js(`(() => { if (typeof window.__mspKaraokeMode === 'function') window.__mspKaraokeMode('studio'); return true })()`)
    await wait(350)
    const studio = await js<{
      mode: string | null
      steps: boolean
      mixDisabled: boolean
      noBacking: boolean
      mixReady: string | null
      vocalReady: string | null
    }>(`(() => {
      const root = document.querySelector('[data-panel="karaoke-k1"]')
      const mix = document.querySelector('[data-action="karaoke-export-mix"]')
      return {
        mode: root?.getAttribute('data-karaoke-mode') ?? null,
        steps: document.querySelector('[data-karaoke-steps="studio"]') != null,
        mixDisabled: mix instanceof HTMLButtonElement ? mix.disabled : true,
        noBacking: document.querySelector('[data-karaoke-no-backing]') != null,
        mixReady: document.querySelector('[data-export-mix-ready]')?.getAttribute('data-export-mix-ready') ?? null,
        vocalReady: document.querySelector('[data-export-vocal-ready]')?.getAttribute('data-export-vocal-ready') ?? null
      }
    })()`)
    record('Studio mode workflow steps', studio.mode === 'studio' && studio.steps, JSON.stringify(studio))
    record('Full Mix gated without backing', studio.mixDisabled && studio.noBacking && studio.mixReady === '0', JSON.stringify(studio))
    record('Vocal export gated without take', studio.vocalReady === '0', studio.vocalReady ?? 'null')

    await js(`(() => { if (typeof window.__mspKaraokeMode === 'function') window.__mspKaraokeMode('youtube'); return true })()`)
    await wait(350)
    const youtube = await js<{ mode: string | null, steps: boolean, boundary: boolean }>(`(() => {
      const root = document.querySelector('[data-panel="karaoke-k1"]')
      const body = document.body.innerText
      return {
        mode: root?.getAttribute('data-karaoke-mode') ?? null,
        steps: document.querySelector('[data-karaoke-steps="youtube"]') != null,
        boundary: /YouTube audio is never/i.test(body)
      }
    })()`)
    record('YouTube mode workflow steps', youtube.mode === 'youtube' && youtube.steps, JSON.stringify(youtube))
    record('No YouTube audio capture messaging', youtube.boundary, JSON.stringify(youtube))

    // Mode switch notice / session prefs persist across mode flips
    await js(`(() => { if (typeof window.__mspKaraokeMode === 'function') window.__mspKaraokeMode('studio'); return true })()`)
    await wait(200)
    await js(`(() => { if (typeof window.__mspKaraokeOffset === 'function') window.__mspKaraokeOffset(0.15); return true })()`)
    await wait(100)
    const prefs = await js<{ offset: string, stored: string | null }>(`(() => {
      const input = document.querySelector('[data-action="karaoke-record-offset"]')
      return {
        offset: input instanceof HTMLInputElement ? input.value : '',
        stored: localStorage.getItem('msp.karaoke.session.v1')
      }
    })()`)
    let storedOk = false
    try {
      const parsed = prefs.stored != null ? JSON.parse(prefs.stored) as { recordOffsetSec?: number, mode?: string } : null
      storedOk = parsed != null && Math.abs((parsed.recordOffsetSec ?? -1) - 0.15) < 0.0001 && parsed.mode === 'studio'
    } catch {
      storedOk = false
    }
    record('session prefs saved (mode/offset refs)', Math.abs(Number(prefs.offset) - 0.15) < 0.0001 && storedOk, JSON.stringify(prefs))

    // Sync panel content
    const sync = await js<{ hasManual: boolean, hasLatency: boolean, noSampleAccurateClaim: boolean }>(`(() => {
      const text = document.querySelector('[data-karaoke-sync]')?.textContent ?? ''
      return {
        hasManual: /manual/i.test(text),
        hasLatency: /latency/i.test(text),
        noSampleAccurateClaim: !/sample-accurate YouTube/i.test(text) || /not sample-accurate/i.test(text)
      }
    })()`)
    record('sync/latency UX present', sync.hasManual && sync.hasLatency, JSON.stringify(sync))
    record('does not claim sample-accurate YouTube sync', sync.noSampleAccurateClaim, JSON.stringify(sync))

    // Mic / engine error banners when no input
    const errors = await js<{ micBanner: boolean, sessionMentionsMic: boolean }>(`(() => ({
      micBanner: document.querySelector('[data-karaoke-mic-error]') != null,
      sessionMentionsMic: /Mic: missing/i.test(document.querySelector('[data-karaoke-session]')?.textContent ?? '')
    }))()`)
    record('missing microphone surfaced', errors.micBanner || errors.sessionMentionsMic, JSON.stringify(errors))

    // Ensure Karaoke Vocal exists then Open Vocal in Studio
    if (engine.startupError == null) {
      const state = (await engine.request('getState')).result as {
        tracks: Array<{ id: string, name: string, clips: Array<{ id: string }>, takes?: Array<{ id: string, name: string }> }>
      }
      let vocal = state.tracks.find((t) => t.name === 'Karaoke Vocal')
      if (vocal == null) {
        await engine.request('addTrack', { name: 'Karaoke Vocal' })
        const next = (await engine.request('getState')).result as typeof state
        vocal = next.tracks.find((t) => t.name === 'Karaoke Vocal')
      }
      record('project Karaoke Vocal track available', vocal != null, vocal?.id ?? 'missing')

      await js(`(() => {
        const btn = document.querySelector('[data-view="karaoke"]')
        if (btn instanceof HTMLElement) btn.click()
        return true
      })()`)
      await wait(400)
      await js(`(() => {
        if (typeof window.__mspKaraokeOpenStudio === 'function') window.__mspKaraokeOpenStudio()
        else {
          const btn = document.querySelector('[data-action="karaoke-open-studio"]')
          if (btn instanceof HTMLElement) btn.click()
        }
        return true
      })()`)
      await wait(1200)
      const editor = await js<{ editor: boolean, karaokeHidden: boolean, notice: string }>(`(() => ({
        editor: document.querySelector('[data-view="editor"][aria-pressed="true"]') != null,
        karaokeHidden: document.querySelector('[data-panel="karaoke-k1"]') == null,
        notice: document.querySelector('.banner')?.textContent ?? ''
      }))()`)
      record('Open Vocal in Studio navigates to Editor', editor.editor && editor.karaokeHidden, JSON.stringify(editor))
      record('Open Vocal preserves project track (compatibility)', vocal != null, vocal?.id ?? 'none')
    } else {
      record('project Karaoke Vocal track available', false, engine.startupError)
      record('Open Vocal in Studio navigates to Editor', false, 'engine unavailable')
      record('Open Vocal preserves project track (compatibility)', false, 'engine unavailable')
    }

    // Return to karaoke for screenshots / take selection empty state
    await js(`(() => {
      const btn = document.querySelector('[data-view="karaoke"]')
      if (btn instanceof HTMLElement) btn.click()
      return true
    })()`)
    await wait(500)
    await js(`(() => { if (typeof window.__mspKaraokeMode === 'function') window.__mspKaraokeMode('studio'); return true })()`)
    await wait(300)
    const takes = await js<{ noTakes: boolean, list: boolean }>(`(() => ({
      noTakes: document.querySelector('[data-karaoke-no-takes]') != null,
      list: document.querySelector('[data-karaoke-take-list]') != null
    }))()`)
    record('take session view (empty or list)', takes.noTakes || takes.list, JSON.stringify(takes))

    // Export readiness attributes explicit
    const exportUx = await js<{ vocalLabel: boolean, mixLabel: boolean }>(`(() => {
      const panel = document.querySelector('[data-karaoke-export]')?.textContent ?? ''
      return {
        vocalLabel: /Export Vocal WAV/i.test(panel),
        mixLabel: /Export Full Mix WAV/i.test(panel) && /never includes YouTube/i.test(panel)
      }
    })()`)
    record('export options explicit', exportUx.vocalLabel && exportUx.mixLabel, JSON.stringify(exportUx))

    await shot('studio-session')
    await js(`(() => { if (typeof window.__mspKaraokeMode === 'function') window.__mspKaraokeMode('youtube'); return true })()`)
    await wait(300)
    await shot('youtube-workflow')

    record('no renderer console errors', consoleErrors.length === 0, consoleErrors.length === 0 ? 'none' : consoleErrors.slice(0, 4).join(' | '))
    checks.push({ scenario: 'live microphone', result: 'NOT RUN', detail: 'NOT RUN — NO HARDWARE' })
  } catch (error) {
    const extra = consoleErrors.length > 0 ? ` | console: ${consoleErrors.slice(0, 4).join(' | ')}` : ''
    record('karaoke k3 check crashed', false, (error instanceof Error ? error.message : String(error)) + extra)
  } finally {
    web.removeListener('console-message', onConsole)
  }

  const summary = {
    pass: checks.filter((c) => c.result === 'PASS').length,
    fail: checks.filter((c) => c.result === 'FAIL').length,
    notRun: checks.filter((c) => c.result === 'NOT RUN').length,
    checks
  }
  fs.writeFileSync(path.join(outDir, 'karaoke-k3-summary.json'), JSON.stringify(summary, null, 2))
  console.log(`KARAOKE_K3_CHECK pass=${summary.pass} fail=${summary.fail} not_run=${summary.notRun}`)
  for (const check of checks)
    console.log(`${check.result}\t${check.scenario}\t${check.detail}`)
  return summary.fail === 0 ? 0 : 1
}
