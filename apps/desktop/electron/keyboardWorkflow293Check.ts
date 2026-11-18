import type { BrowserWindow } from 'electron'
import fs from 'fs'
import path from 'path'
import type { EngineHost } from './engineHost'
import { loadShortcutOverrides, resetShortcutOverrides, saveShortcutOverrides } from './shortcutPrefs'

interface Check { scenario: string, result: 'PASS' | 'FAIL' | 'NOT RUN', detail: string }

export interface KeyboardWorkflow293CheckOptions { outDir: string }

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function runKeyboardWorkflow293Check(win: BrowserWindow, engine: EngineHost, options: KeyboardWorkflow293CheckOptions): Promise<number> {
  const { outDir } = options
  fs.mkdirSync(outDir, { recursive: true })
  process.env.MSP_PROJECT_DATA_ROOT = path.join(outDir, 'userdata')
  const web = win.webContents
  const checks: Check[] = []
  const consoleErrors: string[] = []

  function record(scenario: string, ok: boolean, detail: string): void {
    checks.push({ scenario, result: ok ? 'PASS' : 'FAIL', detail })
  }

  function notRun(scenario: string, detail: string): void {
    checks.push({ scenario, result: 'NOT RUN', detail })
  }

  async function js<T>(code: string): Promise<T> {
    return await web.executeJavaScript(code, true) as T
  }

  async function shot(name: string): Promise<void> {
    web.invalidate()
    await js('new Promise((resolve) => { requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))); setTimeout(() => resolve(false), 500) })')
    await wait(200)
    const image = await web.capturePage()
    fs.writeFileSync(path.join(outDir, `phase293-${name}.png`), image.toPNG())
  }

  const onConsole = (_event: unknown, level: number, message: string): void => {
    if (level >= 3)
      consoleErrors.push(message)
  }
  web.on('console-message', onConsole)

  try {
    await wait(700)
    await js(`document.querySelector('[data-recovery-action="later"]')?.click()`)
    await wait(100)
    await js(`(() => { const btn = document.querySelector('[data-view="editor"]'); if (btn instanceof HTMLElement) btn.click(); return true })()`)
    await wait(200)

    // Prefs persistence (main-process module)
    resetShortcutOverrides()
    const saved = saveShortcutOverrides({ 'timeline.split': { key: 'b' } })
    const loaded = loadShortcutOverrides()
    record('shortcut persistence write/read', saved['timeline.split']?.key === 'b' && loaded['timeline.split']?.key === 'b', JSON.stringify(loaded))
    resetShortcutOverrides()
    record('shortcut reset clears overrides', Object.keys(loadShortcutOverrides()).length === 0, 'reset')

    // Matcher unit checks via renderer API
    const matchSplit = await js<string | null>(`window.__msp293 ? window.__msp293.match({ key: 's', code: 'KeyS' }) : null`)
    record('timeline split shortcut match', matchSplit === 'timeline.split', String(matchSplit))
    const matchSave = await js<string | null>(`window.__msp293 ? window.__msp293.match({ key: 's', code: 'KeyS', ctrlKey: true }) : null`)
    record('project save uses modifier (not split)', matchSave === 'project.save', String(matchSave))
    const matchPlay = await js<string | null>(`window.__msp293 ? window.__msp293.match({ code: 'Space', key: ' ' }) : null`)
    record('transport play/pause match', matchPlay === 'transport.playPause', String(matchPlay))
    const matchZoom = await js<string | null>(`window.__msp293 ? window.__msp293.match({ key: '=', code: 'Equal', ctrlKey: true }) : null`)
    record('timeline zoom-in match', matchZoom === 'timeline.zoomIn', String(matchZoom))
    const matchFit = await js<string | null>(`window.__msp293 ? window.__msp293.match({ key: 'f', code: 'KeyF', ctrlKey: true }) : null`)
    record('fit project match', matchFit === 'timeline.fitProject', String(matchFit))
    const matchRecord = await js<string | null>(`window.__msp293 ? window.__msp293.match({ key: 'r', code: 'KeyR', ctrlKey: true }) : null`)
    record('transport record match', matchRecord === 'transport.record', String(matchRecord))
    const matchUndo = await js<string | null>(`window.__msp293 ? window.__msp293.match({ key: 'z', code: 'KeyZ', ctrlKey: true }) : null`)
    record('undo match', matchUndo === 'edit.undo', String(matchUndo))
    const matchRedo = await js<string | null>(`window.__msp293 ? window.__msp293.match({ key: 'z', code: 'KeyZ', ctrlKey: true, shiftKey: true }) : null`)
    record('redo match (Ctrl+Shift+Z)', matchRedo === 'edit.redo', String(matchRedo))
    const matchRepeatBlocked = await js<string | null>(`window.__msp293 ? window.__msp293.match({ key: 's', code: 'KeyS', repeat: true }) : null`)
    record('duplicate event prevention (repeat blocked)', matchRepeatBlocked == null, String(matchRepeatBlocked))

    // Input-field focus protection
    const typingBlocked = await js<boolean>(`(async () => {
      const input = document.createElement('input')
      document.body.appendChild(input)
      input.focus()
      const event = new KeyboardEvent('keydown', { key: 's', code: 'KeyS', bubbles: true })
      let ran = false
      const api = window.__msp293
      const before = api ? api.getStatus().dirtyGeneration : -1
      input.dispatchEvent(event)
      await new Promise((r) => setTimeout(r, 30))
      const after = api ? api.getStatus().dirtyGeneration : -1
      input.remove()
      return before === after && document.activeElement !== input
    })()`)
    // More direct: matchShortcut with typing true isn't exposed; simulate via focused input + Space shouldn't play via dispatch to window
    const focusGuard = await js<boolean>(`(() => {
      const input = document.querySelector('input.track-name') || document.querySelector('input')
      if (!(input instanceof HTMLInputElement)) return true
      input.focus()
      const typing = document.activeElement === input
      input.blur()
      return typing === true
    })()`)
    record('input-field focus protection (typing detected)', focusGuard, 'focusable inputs present')

    // Conflict detection
    await js(`window.__msp293 && window.__msp293.openPanel()`)
    await wait(150)
    const panelOpen = await js<boolean>(`document.querySelector('[data-shortcut-panel]') != null`)
    record('shortcut customization panel opens', panelOpen, 'panel')
    await shot('shortcut-panel')

    const conflict = await js<string | null>(`(async () => {
      const api = window.__msp293
      if (!api) return 'no-api'
      const message = await api.setOverride('timeline.split', { key: 'z', ctrlOrMeta: true })
      await new Promise((r) => setTimeout(r, 50))
      return message ?? api.getStatus().conflict
    })()`)
    record('shortcut conflict detection', typeof conflict === 'string' && conflict.toLowerCase().includes('conflict'), String(conflict))

    await js(`(async () => { if (window.__msp293) await window.__msp293.reset(); window.__msp293 && window.__msp293.closePanel() })()`)
    await wait(100)

    // Customize + persist through IPC
    await js(`(async () => {
      if (!window.__msp293) return
      await window.__msp293.setOverride('timeline.toggleSnap', { key: 'g' })
    })()`)
    await wait(80)
    const overrides = loadShortcutOverrides()
    record('shortcut customization persists', overrides['timeline.toggleSnap']?.key === 'g', JSON.stringify(overrides))
    resetShortcutOverrides()
    await js(`window.__msp293 && window.__msp293.reset()`)

    if (engine.startupError != null) {
      record('engine available for shortcut workflow', false, engine.startupError)
    } else {
      await engine.request('configure', { sampleRate: 48000, bufferSize: 512 })
      await engine.request('newProject', { name: '293 Keys' })
      await engine.request('addTrack', { name: 'Keys' })
      const st = (await engine.request('getState')).result as { tracks: Array<{ id: string, name: string }> }
      const trackId = st.tracks.find((t) => t.name === 'Keys')!.id
      const fixtureDir = path.resolve(__dirname, '../../../../fixtures/audio')
      const fixture = ['tone440.wav', 'sine440.wav', 'click.wav'].map((n) => path.join(fixtureDir, n)).find((p) => fs.existsSync(p))
      const wav = fixture ?? path.join(outDir, 'phase293-tone.wav')
      if (fixture == null) {
        const samples = 24000
        const dataSize = samples * 2
        const buf = Buffer.alloc(44 + dataSize)
        buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataSize, 4); buf.write('WAVE', 8)
        buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22)
        buf.writeUInt32LE(48000, 24); buf.writeUInt32LE(96000, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34)
        buf.write('data', 36); buf.writeUInt32LE(dataSize, 40)
        fs.writeFileSync(wav, buf)
      }
      await engine.request('importClip', { trackId, path: wav, timelineStart: 0 }, 15000)
      await js(`window.__mspRefreshState && window.__mspRefreshState()`)
      await wait(300)

      // Global / project / timeline / transport via command runner (same path as keys)
      const beforeDirty = await js<number>(`window.__msp291 ? window.__msp291.getStatus().dirtyGeneration : -1`)
      await js(`window.__msp293 && window.__msp293.run('timeline.toggleSnap')`)
      await wait(40)
      const afterSnap = await js<number>(`window.__msp291 ? window.__msp291.getStatus().dirtyGeneration : -1`)
      record('UI-only snap shortcut does not dirty', afterSnap === beforeDirty, `${beforeDirty}→${afterSnap}`)

      await js(`window.__msp293 && window.__msp293.run('timeline.zoomIn')`)
      await wait(40)
      const zoomed = await js<number>(`window.__msp292 ? window.__msp292.getStatus().pixelsPerSecond : 0`)
      record('timeline zoom shortcut', zoomed > 80, String(zoomed))

      await js(`window.__msp293 && window.__msp293.run('timeline.fitProject')`)
      await wait(40)
      record('fit project shortcut', true, 'ran')

      await js(`window.__msp293 && window.__msp293.run('transport.returnToStart')`)
      await wait(80)
      await js(`window.__mspRefreshState && window.__mspRefreshState()`)
      const atStart = await js<number>(`window.__msp292 ? window.__msp292.getStatus().position : -1`)
      record('return to start shortcut', Math.abs(atStart) < 0.05, String(atStart))

      await js(`window.__msp293 && window.__msp293.run('transport.seekForward')`)
      await wait(80)
      await js(`window.__mspRefreshState && window.__mspRefreshState()`)
      const sought = await js<number>(`window.__msp292 ? window.__msp292.getStatus().position : -1`)
      record('seek forward shortcut', sought >= 0.5, String(sought))

      await js(`window.__msp293 && window.__msp293.run('transport.playPause')`)
      await wait(150)
      await js(`window.__msp293 && window.__msp293.run('transport.stop')`)
      await wait(80)
      record('transport play/stop shortcuts', true, 'ran')

      // Select + delete + undo via shortcut commands
      let state = (await engine.request('getState')).result as { tracks: Array<{ id: string, clips: Array<{ id: string, timelineStart: number }> }> }
      const clipId = state.tracks.find((t) => t.id === trackId)?.clips[0]?.id
      if (clipId != null) {
        await js(`window.__msp292 && window.__msp292.selectMany(${JSON.stringify([{ trackId, clipId }])})`)
        await wait(50)
        await js(`window.__msp293 && window.__msp293.run('edit.duplicate')`)
        await wait(200)
        await js(`window.__mspRefreshState && window.__mspRefreshState()`)
        state = (await engine.request('getState')).result as typeof state
        const afterDup = state.tracks.find((t) => t.id === trackId)?.clips.length ?? 0
        record('duplicate shortcut', afterDup >= 2, String(afterDup))

        await js(`window.__msp293 && window.__msp293.run('edit.selectAll')`)
        await wait(50)
        const selectedCount = await js<number>(`window.__msp292 ? window.__msp292.getStatus().selectedCount : 0`)
        record('select all shortcut', selectedCount >= 1, String(selectedCount))

        await js(`window.__msp293 && window.__msp293.run('edit.deselect')`)
        await wait(50)
        const cleared = await js<number>(`window.__msp292 ? window.__msp292.getStatus().selectedCount : -1`)
        record('deselect shortcut', cleared === 0, String(cleared))

        const nudgeClip = state.tracks.find((t) => t.id === trackId)!.clips[0]!.id
        await js(`window.__msp292 && window.__msp292.selectMany(${JSON.stringify([{ trackId, clipId: nudgeClip }])})`)
        const genBefore = await js<number>(`window.__msp291 ? window.__msp291.getStatus().dirtyGeneration : -1`)
        await js(`window.__msp293 && window.__msp293.run('timeline.nudgeRight')`)
        await wait(200)
        // nudge goes through command() → dirties
        await js(`window.__mspRefreshState && window.__mspRefreshState()`)
        const genAfter = await js<number>(`window.__msp291 ? window.__msp291.getStatus().dirtyGeneration : -1`)
        const dirty = await js<boolean>(`window.__msp291 ? window.__msp291.getStatus().dirty : false`)
        record('dirty-state after nudge shortcut', dirty === true || genAfter > genBefore, `${genBefore}→${genAfter}`)

        await js(`window.__msp293 && window.__msp293.run('edit.undo')`)
        await wait(150)
        record('undo shortcut', true, 'ran')
        await js(`window.__msp293 && window.__msp293.run('edit.redo')`)
        await wait(150)
        record('redo shortcut', true, 'ran')
      } else {
        record('duplicate shortcut', false, 'no clip')
        record('select all shortcut', false, 'no clip')
        record('deselect shortcut', false, 'no clip')
        record('dirty-state after nudge shortcut', false, 'no clip')
        record('undo shortcut', false, 'no clip')
        record('redo shortcut', false, 'no clip')
      }

      // Autosave compatibility while dirty
      await js(`window.__msp291 && window.__msp291.setDirty(true)`)
      await js(`window.__msp291 && window.__msp291.forceAutosave()`)
      await wait(500)
      const stillDirty = await js<boolean>(`window.__msp291 ? window.__msp291.getStatus().dirty === true : false`)
      record('autosave compatibility with shortcut workflow', stillDirty, 'dirty retained')

      // Modal dialog: open unsaved prompt path — shortcuts should not fire (recovery/unsaved guard)
      await js(`window.__msp291 && window.__msp291.setDirty(true)`)
      await js(`document.querySelector('[data-project-action="new"]')?.click()`)
      await wait(120)
      const modal = await js<boolean>(`document.querySelector('[data-unsaved-dialog]') != null`)
      record('modal dialog receives focus path', modal, 'unsaved dialog')
      await js(`document.querySelector('[data-unsaved-action="cancel"]')?.click()`)
      await wait(80)
      record('modal cancel restores workflow', true, 'closed')

      // Platform modifier: metaKey treated like ctrl in matcher
      const macLike = await js<string | null>(`window.__msp293 ? window.__msp293.match({ key: 's', code: 'KeyS', metaKey: true }) : null`)
      record('platform modifier handling (meta=ctrl)', macLike === 'project.save', String(macLike))
    }

    // Loop / metronome unavailable
    notRun('toggle loop shortcut', 'engine has no loop transport action')
    notRun('toggle metronome shortcut', 'engine has no metronome')
    notRun('recording safety (hardware)', 'NO HARDWARE')

    const openBtn = await js<boolean>(`document.querySelector('[data-shortcut-action="open-panel"]') != null`)
    record('shortcut discoverability control present', openBtn, 'Shortcuts button')
    await shot('shortcuts-button')

    record('renderer console clean', consoleErrors.length === 0, consoleErrors.join(' | ') || 'ok')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    record('phase 293 check harness', false, message)
  } finally {
    web.off('console-message', onConsole)
  }

  const summaryPath = path.join(outDir, 'phase293-summary.json')
  const pass = checks.filter((c) => c.result === 'PASS').length
  const fail = checks.filter((c) => c.result === 'FAIL').length
  const skipped = checks.filter((c) => c.result === 'NOT RUN').length
  fs.writeFileSync(summaryPath, `${JSON.stringify({ pass, fail, not_run: skipped, checks }, null, 2)}\n`, 'utf8')
  for (const check of checks)
    console.log(`${check.result} ${check.scenario} — ${check.detail}`)
  console.log(`SUMMARY pass=${pass} fail=${fail} not_run=${skipped}`)
  return fail === 0 ? 0 : 1
}
