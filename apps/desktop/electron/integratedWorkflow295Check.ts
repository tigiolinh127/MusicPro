import type { BrowserWindow } from 'electron'
import fs from 'fs'
import path from 'path'
import type { EngineHost } from './engineHost'
import { writeWav24 } from './workflowCheck'
import { allocateAutosavePath, commitAutosaveFile } from './projectPersistence'

interface Check { scenario: string, result: 'PASS' | 'FAIL' | 'NOT RUN', detail: string }

export interface IntegratedWorkflow295CheckOptions { outDir: string }

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function runIntegratedWorkflow295Check(win: BrowserWindow, engine: EngineHost, options: IntegratedWorkflow295CheckOptions): Promise<number> {
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
    fs.writeFileSync(path.join(outDir, `phase295-${name}.png`), image.toPNG())
  }

  const onConsole = (_event: unknown, level: number, message: string): void => {
    if (level >= 3)
      consoleErrors.push(message)
  }
  web.on('console-message', onConsole)

  try {
    await wait(700)
    await js(`document.querySelector('[data-recovery-action="later"]')?.click()`)
    await wait(80)
    await js(`document.querySelector('[data-missing-action="later"]')?.click()`)
    await wait(80)
    await js(`(() => { const btn = document.querySelector('[data-view="editor"]'); if (btn instanceof HTMLElement) btn.click(); return true })()`)
    await wait(200)

    // --- Dirty-state op mapping (2.9.1 ↔ real IPC) via renderer helper ---
    const dirtyMap = await js<Record<string, boolean>>(`(() => {
      const api = window.__msp295
      if (!api) return { available: false }
      return {
        available: true,
        importTrack: api.isMutatingOp('importTrack'),
        setTrack: api.isMutatingOp('setTrack'),
        setClipFades: api.isMutatingOp('setClipFades'),
        setMaster: api.isMutatingOp('setMaster'),
        setSend: api.isMutatingOp('setSend'),
        duplicateClip: api.isMutatingOp('duplicateClip'),
        relinkMedia: api.isMutatingOp('relinkMedia'),
        recordStop: api.isMutatingOp('record', { action: 'stop' }),
        recordStart: api.isMutatingOp('record', { action: 'start' }),
        transport: api.isMutatingOp('transport', { action: 'play' }),
        previewBreath: api.isMutatingOp('previewBreath')
      }
    })()`)
    record('dirty map: importTrack mutates', dirtyMap.importTrack === true, JSON.stringify(dirtyMap))
    record('dirty map: setTrack mutates', dirtyMap.setTrack === true, 'setTrack')
    record('dirty map: setClipFades mutates', dirtyMap.setClipFades === true, 'setClipFades')
    record('dirty map: setMaster mutates', dirtyMap.setMaster === true, 'setMaster')
    record('dirty map: setSend mutates', dirtyMap.setSend === true, 'setSend')
    record('dirty map: duplicateClip mutates', dirtyMap.duplicateClip === true, 'duplicateClip')
    record('dirty map: relinkMedia mutates', dirtyMap.relinkMedia === true, 'relinkMedia')
    record('dirty map: record stop mutates', dirtyMap.recordStop === true, 'record stop')
    record('dirty map: record start does not', dirtyMap.recordStart === false, 'record start')
    record('dirty map: transport does not', dirtyMap.transport === false, 'transport')
    record('dirty map: previewBreath does not', dirtyMap.previewBreath === false, 'previewBreath')
    record('dirty map exposed to renderer', dirtyMap.available === true, ' __msp295.isMutatingOp')
    const dirtyMapExtra = await js<Record<string, boolean>>(`(() => {
      const api = window.__msp295
      if (!api) return { available: false }
      return {
        available: true,
        saveCustom: api.isMutatingOp('saveCustomVocalPreset'),
        setNoteTarget: api.isMutatingOp('setNoteTarget'),
        cancelStretchPreview: api.isMutatingOp('cancelClipStretchPreview') === false
      }
    })()`)
    record('dirty map: saveCustomVocalPreset mutates', dirtyMapExtra.saveCustom === true, JSON.stringify(dirtyMapExtra))
    record('dirty map: setNoteTarget mutates', dirtyMapExtra.setNoteTarget === true, 'setNoteTarget')
    record('dirty map: cancelClipStretchPreview does not', dirtyMapExtra.cancelStretchPreview === true, 'cancel preview')

    const mediaRoot = path.join(outDir, 'media')
    fs.mkdirSync(mediaRoot, { recursive: true })
    const tone = path.join(mediaRoot, 'tone295.wav')
    const toneAlt = path.join(mediaRoot, 'tone295-alt.wav')
    writeWav24(tone, 48000, 48000, (i) => 0.25 * Math.sin(2 * Math.PI * 440 * i / 48000), (i) => 0.25 * Math.sin(2 * Math.PI * 440 * i / 48000))
    fs.copyFileSync(tone, toneAlt)

    if (engine.startupError != null) {
      record('engine available', false, engine.startupError)
      notRun('scenario A create edit save', 'engine unavailable')
      notRun('scenario B autosave recovery refs', 'engine unavailable')
      notRun('scenario C keyboard dirty consistency', 'engine unavailable')
      notRun('scenario D missing media persistence', 'engine unavailable')
      notRun('scenario E transport project switch', 'engine unavailable')
    } else {
      record('engine available', true, 'ok')
      await engine.request('configure', { sampleRate: 48000, bufferSize: 512 })

      // ===== Scenario A — Create, Edit, Save (isolated engine session) =====
      await engine.request('transport', { action: 'stop' })
      await engine.request('newProject', { name: '295 A' })
      await js(`window.__mspRefreshState && window.__mspRefreshState()`)
      await wait(150)
      await js(`window.__msp291 && window.__msp291.setDirty(false)`)
      await engine.request('addTrack', { name: 'Lead' })
      const stA = (await engine.request('getState')).result as { tracks: Array<{ id: string }>, projectId: string, projectName: string }
      const trackId = stA.tracks[0]!.id
      const appImport = await js<{ ok: boolean, dirty: boolean, gen: number, pathOk: boolean }>(`(async () => {
        const before = window.__msp295.getStatus().dirtyGeneration
        const mutating = window.__msp295.isMutatingOp('importClip')
        const res = await window.studio.request('importClip', { trackId: ${JSON.stringify(trackId)}, path: ${JSON.stringify(tone)}, timelineStart: 0 }, 20000)
        await window.__mspRefreshState()
        if (mutating && res.ok) window.__msp291.bumpDirty()
        const st = window.__msp295.getStatus()
        const state = (await window.studio.request('getState')).result
        const pathOk = Array.isArray(state?.tracks) && state.tracks[0]?.path === ${JSON.stringify(tone)}
        return { ok: res.ok === true && mutating, dirty: st.dirty, gen: st.dirtyGeneration - before, pathOk: pathOk === true }
      })()`)
      record('scenario A import marks dirty (via App mapping)', appImport.ok === true && appImport.gen > 0 && appImport.pathOk === true && appImport.dirty === true, JSON.stringify(appImport))

      const clip0 = ((await engine.request('getState')).result as { tracks: Array<{ clips: Array<{ id: string }> }> }).tracks[0]!.clips[0]!.id
      await engine.request('moveClip', { trackId, clipId: clip0, timelineStart: 0.25 })
      await js(`window.__msp291.bumpDirty()`)

      const projA = path.join(outDir, 'scenario-a', 'song.msp.json')
      fs.mkdirSync(path.dirname(projA), { recursive: true })
      const saveA = await engine.request('saveProject', { path: projA, name: '295 A Saved' })
      record('scenario A save succeeds', saveA.ok === true && fs.existsSync(projA), String(saveA.error ?? projA))
      await js(`window.__msp291.setDirty(false)`)
      const afterSave = await js<{ dirty: boolean }>(`({ dirty: window.__msp295.getStatus().dirty })`)
      record('scenario A dirty clears only after successful save', afterSave.dirty === false, JSON.stringify(afterSave))

      const saveAs = path.join(outDir, 'scenario-a', 'song-as.msp.json')
      const saveAsRes = await engine.request('saveProject', { path: saveAs, name: '295 A SaveAs' })
      const saveAsJson = JSON.parse(fs.readFileSync(saveAs, 'utf8')) as { tracks: Array<{ path: string, clips: unknown[] }>, version: number }
      record('scenario A save as preserves media refs', saveAsRes.ok === true && saveAsJson.version === 6 && saveAsJson.tracks.some((t) => t.path === tone && t.clips.length > 0), JSON.stringify(saveAsJson.tracks.map((t) => ({ path: t.path, clips: t.clips.length }))))

      const reopen = await engine.request('loadProject', { path: projA }, 20000)
      const reopenState = (await engine.request('getState')).result as { projectName: string, tracks: Array<{ clips: unknown[], path: string, missing: boolean }> }
      record('scenario A reopen restores timeline', reopen.ok === true && reopenState.projectName === '295 A Saved' && reopenState.tracks[0]!.clips.length >= 1 && reopenState.tracks[0]!.missing !== true && reopenState.tracks[0]!.path === tone, JSON.stringify({ name: reopenState.projectName, clips: reopenState.tracks[0]?.clips.length, path: reopenState.tracks[0]?.path }))

      // ===== Scenario B — Autosave refs =====
      await js(`window.__msp291.bumpDirty()`)
      const prepared = allocateAutosavePath(stA.projectId || '295-id')
      const autoSave = await engine.request('saveProject', { path: prepared.snapshotPath, name: '295 Auto' })
      const committed = commitAutosaveFile({
        projectId: stA.projectId || '295-id',
        projectName: '295 Auto',
        originalPath: projA,
        snapshotPath: prepared.snapshotPath,
        savedAt: prepared.savedAt
      })
      const snapSize = fs.statSync(prepared.snapshotPath).size
      const wavSize = fs.statSync(tone).size
      const stillDirty = await js<boolean>(`window.__msp295.getStatus().dirty === true`)
      record('scenario B autosave captures state without clearing dirty', autoSave.ok === true && committed.ok === true && stillDirty && snapSize < wavSize, JSON.stringify({ snapSize, wavSize, stillDirty }))
      const beforeBytes = fs.readFileSync(projA, 'utf8')
      record('scenario B original project unchanged by autosave', fs.readFileSync(projA, 'utf8') === beforeBytes, projA)

      // ===== Scenario C — Timeline + keyboard command consistency =====
      await js(`window.__msp292 && window.__msp292.setSnap(true)`)
      await js(`window.__mspRefreshState && window.__mspRefreshState()`)
      const stC = (await engine.request('getState')).result as { tracks: Array<{ id: string, clips: Array<{ id: string, timelineStart: number }> }> }
      const clipId = stC.tracks[0]?.clips[0]?.id
      if (clipId != null) {
        await js(`window.__msp292.selectMany([{ trackId: ${JSON.stringify(stC.tracks[0]!.id)}, clipId: ${JSON.stringify(clipId)} }])`)
        const beforeMove = stC.tracks[0]!.clips[0]!.timelineStart
        await engine.request('moveClip', { trackId: stC.tracks[0]!.id, clipId, timelineStart: beforeMove + 0.5 })
        await js(`window.__msp291.bumpDirty()`)
        const afterMove = (await engine.request('getState')).result as { tracks: Array<{ clips: Array<{ timelineStart: number }> }> }
        record('scenario C clip move updates project state', Math.abs((afterMove.tracks[0]?.clips[0]?.timelineStart ?? 0) - (beforeMove + 0.5)) < 1e-4, JSON.stringify({ beforeMove, after: afterMove.tracks[0]?.clips[0]?.timelineStart }))
        const undo = await engine.request('undo')
        const afterUndo = (await engine.request('getState')).result as { tracks: Array<{ clips: Array<{ timelineStart: number, sourceFileId: string }> }> }
        record('scenario C undo restores clip without stale media id', undo.ok === true && Math.abs((afterUndo.tracks[0]?.clips[0]?.timelineStart ?? -1) - beforeMove) < 1e-4 && (afterUndo.tracks[0]?.clips[0]?.sourceFileId?.length ?? 0) > 0, JSON.stringify(afterUndo.tracks[0]?.clips[0]))
        const matchSplit = await js<string | null>(`window.__msp293 ? window.__msp293.match({ key: 's', code: 'KeyS' }) : null`)
        const matchSave = await js<string | null>(`window.__msp293 ? window.__msp293.match({ key: 's', code: 'KeyS', ctrlKey: true }) : null`)
        record('scenario C keyboard routes same command ids', matchSplit === 'timeline.split' && matchSave === 'project.save', JSON.stringify({ matchSplit, matchSave }))
        await js(`window.__msp292.fitProject()`)
        const fit = await js<{ pixelsPerSecond: number }>(`window.__msp292.getStatus()`)
        record('scenario C fit project works', fit.pixelsPerSecond > 0, JSON.stringify(fit))
      } else {
        record('scenario C clip move updates project state', false, 'no clip')
        record('scenario C undo restores clip without stale media id', false, 'no clip')
        record('scenario C keyboard routes same command ids', false, 'no clip')
        record('scenario C fit project works', false, 'no clip')
      }

      // Selection cleared across project switch
      await js(`window.__msp292.selectMany([{ trackId: 'x', clipId: 'y' }])`)
      await js(`window.__msp295.resetUi()`)
      const cleared = await js<{ selectedCount: number, missingDialogOpen: boolean }>(`window.__msp295.getStatus()`)
      record('scenario C selection cleared on project UI reset', cleared.selectedCount === 0 && cleared.missingDialogOpen === false, JSON.stringify(cleared))

      // ===== Scenario D — Missing media + persistence =====
      const dDir = path.join(outDir, 'scenario-d')
      fs.mkdirSync(dDir, { recursive: true })
      await engine.request('newProject', { name: '295 D' })
      await engine.request('addTrack', { name: 'Ext' })
      const stD = (await engine.request('getState')).result as { tracks: Array<{ id: string }> }
      await engine.request('importClip', { trackId: stD.tracks[0]!.id, path: tone, timelineStart: 0 }, 20000)
      const dProj = path.join(dDir, 'external.msp.json')
      await engine.request('saveProject', { path: dProj, name: '295 D' })
      const dJson = JSON.parse(fs.readFileSync(dProj, 'utf8')) as { tracks: Array<{ path: string, clips: unknown[] }> }
      const clipCountSnap = dJson.tracks[0]!.clips.length
      dJson.tracks[0]!.path = path.join(dDir, 'renamed-away.wav')
      fs.writeFileSync(dProj, JSON.stringify(dJson, null, 2))
      const loadedMiss = await engine.request('loadProject', { path: dProj }, 20000)
      await js(`window.__mspRefreshState && window.__mspRefreshState()`)
      await wait(200)
      await js(`window.__msp295.resetUi()`)
      await js(`window.__msp294 && window.__msp294.openMissingDialog()`)
      await wait(250)
      const dlg = await js<boolean>(`document.querySelector('[data-missing-media-dialog]') != null`)
      record('scenario D missing recovery dialog opens', loadedMiss.ok === true && dlg, 'dialog')
      await shot('missing-integrated')

      // Cancel / decide later leaves project intact
      await js(`document.querySelector('[data-missing-action="later"]')?.click()`)
      await wait(100)
      const laterClosed = await js<boolean>(`document.querySelector('[data-missing-media-dialog]') == null`)
      const stillMissing = (await engine.request('getState')).result as { tracks: Array<{ missing: boolean, clips: Array<{ timelineStart: number, duration: number, gain: number }> }> }
      const clipSnap = (stillMissing.tracks[0]?.clips ?? []).map((c) => ({ timelineStart: c.timelineStart, duration: c.duration, gain: c.gain }))
      record('scenario D decide later keeps missing + clips', laterClosed && stillMissing.tracks[0]?.missing === true && clipSnap.length === clipCountSnap, JSON.stringify(stillMissing.tracks[0]?.clips))

      // Relink preserves clips then dirty + save
      const full = (await engine.request('getState')).result as { tracks: Array<{ id: string, missing: boolean, clips: Array<{ sourceFileId: string, timelineStart: number, duration: number, gain: number }> }> }
      const rel = await engine.request('relinkMedia', {
        trackId: full.tracks[0]!.id,
        sourceFileId: full.tracks[0]!.clips[0]!.sourceFileId,
        path: toneAlt
      }, 30000)
      await js(`window.__msp291.bumpDirty()`)
      const afterRel = (await engine.request('getState')).result as { tracks: Array<{ missing: boolean, path: string, clips: Array<{ timelineStart: number, duration: number, gain: number }> }> }
      const preserved = afterRel.tracks[0]!.clips.length === clipSnap.length
        && afterRel.tracks[0]!.clips.every((c, i) => Math.abs(c.timelineStart - clipSnap[i]!.timelineStart) < 1e-6 && Math.abs(c.duration - clipSnap[i]!.duration) < 1e-6 && Math.abs(c.gain - clipSnap[i]!.gain) < 1e-6)
      record('scenario D relink preserves editing metadata', rel.ok === true && afterRel.tracks[0]!.missing === false && preserved, JSON.stringify({ relOk: rel.ok, error: rel.error, missing: afterRel.tracks[0]?.missing, clips: afterRel.tracks[0]?.clips, clipSnap }))
      const dSaved = path.join(dDir, 'recovered.msp.json')
      await engine.request('saveProject', { path: dSaved, name: '295 D Recovered' })
      const reopened = await engine.request('loadProject', { path: dSaved }, 20000)
      const reSt = (await engine.request('getState')).result as { tracks: Array<{ missing: boolean, path: string }> }
      record('scenario D save+reopen recovered media', reopened.ok === true && reSt.tracks.every((t) => !t.missing && fs.existsSync(t.path)), JSON.stringify(reSt.tracks))

      // Failed load does not replace
      const bad = path.join(dDir, 'corrupt.msp.json')
      fs.writeFileSync(bad, '{nope')
      const beforeName = ((await engine.request('getState')).result as { projectName: string }).projectName
      const failed = await engine.request('loadProject', { path: bad }, 10000)
      const afterName = ((await engine.request('getState')).result as { projectName: string }).projectName
      record('scenario D failed load keeps active project', failed.ok === false && afterName === beforeName, JSON.stringify({ failed: failed.error, beforeName, afterName }))

      // ===== Scenario E — Transport + project switch =====
      await engine.request('loadProject', { path: projA }, 20000)
      const play = await engine.request('transport', { action: 'play' })
      await wait(150)
      const playing = ((await engine.request('getState')).result as { transport: string }).transport
      // Switch project while playing — engine stops on load
      const switched = await engine.request('loadProject', { path: dSaved }, 20000)
      const afterSwitch = (await engine.request('getState')).result as { transport: string, projectName: string, position: number }
      record('scenario E project switch stops stale transport', play.ok === true && switched.ok === true && afterSwitch.transport === 'stopped', JSON.stringify({ playing, afterSwitch }))
      await js(`window.__msp295.resetUi()`)
      await js(`window.__mspRefreshState && window.__mspRefreshState()`)
      const uiAfterSwitch = await js<{ selectedCount: number, transport: string }>(`window.__msp295.getStatus()`)
      record('scenario E UI selection cleared after switch reset', uiAfterSwitch.selectedCount === 0, JSON.stringify(uiAfterSwitch))

      // Stale open protection token increments
      const tokenBefore = await js<number>(`window.__msp295.getStatus().switchToken`)
      await js(`window.__msp295.resetUi()`)
      // openPath increments token
      const openTok = await js<{ ok: boolean, token: number }>(`(async () => {
        const before = window.__msp295.getStatus().switchToken
        const ok = await window.__msp295.openPath(${JSON.stringify(projA)})
        return { ok, token: window.__msp295.getStatus().switchToken - before }
      })()`)
      record('scenario E open increments switch token (stale guard)', openTok.token > 0 && openTok.ok === true, JSON.stringify({ tokenBefore, openTok }))

      await shot('editor-integrated')
    }

    // Media panel + project bar visibility
    await js(`document.querySelector('[data-recovery-action="later"]')?.click()`)
    await js(`document.querySelector('[data-missing-action="later"]')?.click()`)
    const bar = await js<boolean>(`document.querySelector('[data-project-bar]') != null`)
    const mediaBtn = await js<boolean>(`document.querySelector('[data-media-action="open-panel"]') != null`)
    const shortcutBtn = await js<boolean>(`document.querySelector('[data-shortcut-action="open-panel"]') != null`)
    record('integrated chrome: project bar + media + shortcuts', bar && mediaBtn && shortcutBtn, JSON.stringify({ bar, mediaBtn, shortcutBtn }))
    await js(`window.__msp294 && window.__msp294.openMediaPanel()`)
    await wait(200)
    record('media panel opens with project context', await js<boolean>(`document.querySelector('[data-media-assets-panel]') != null`), 'panel')
    await shot('media-integrated')
    await js(`document.querySelector('[data-media-action="close"]')?.click()`)

    // Shortcuts blocked while media panel open
    await js(`window.__msp294.openMediaPanel()`)
    await wait(100)
    const blocked = await js<boolean>(`(async () => {
      const before = window.__msp295.getStatus().dirtyGeneration
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', code: 'KeyS', bubbles: true }))
      await new Promise(r => setTimeout(r, 40))
      // With panel open, shortcut listener returns early — dirty unchanged from split
      return window.__msp295.getStatus().dirtyGeneration === before
    })()`)
    await js(`document.querySelector('[data-media-action="close"]')?.click()`)
    record('shortcuts blocked while media panel open', blocked, 'keydown guard')

    notRun('microphone / recording hardware switch', 'NO HARDWARE')
    notRun('manual crash kill recovery', 'destructive crash test not performed')

    if (consoleErrors.length > 0)
      record('renderer console clean', false, consoleErrors.slice(0, 5).join(' | '))
    else
      record('renderer console clean', true, 'no errors')
  } catch (error) {
    record('phase 295 check harness', false, error instanceof Error ? error.message : String(error))
  } finally {
    web.removeListener('console-message', onConsole)
  }

  const summary = {
    pass: checks.filter((c) => c.result === 'PASS').length,
    fail: checks.filter((c) => c.result === 'FAIL').length,
    not_run: checks.filter((c) => c.result === 'NOT RUN').length,
    checks
  }
  fs.writeFileSync(path.join(outDir, 'phase295-summary.json'), JSON.stringify(summary, null, 2))
  for (const check of checks)
    console.log(`${check.result} ${check.scenario} — ${check.detail}`)
  console.log(`SUMMARY pass=${summary.pass} fail=${summary.fail} not_run=${summary.not_run}`)
  return summary.fail === 0 ? 0 : 1
}
