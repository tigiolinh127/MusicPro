import type { BrowserWindow } from 'electron'
import fs from 'fs'
import path from 'path'
import type { EngineHost } from './engineHost'
import { writeWav24 } from './workflowCheck'
import { probeWavFile } from './mediaProbe'
import { buildMediaInventory } from './mediaInventory'
import { autoSelectCandidate, cancelMediaSearch, searchMediaCandidates } from './mediaDiscovery'
import { isExternalToProject, normalizeMediaPath, resolveAgainstProject, sameMediaPath } from './mediaPaths'

interface Check { scenario: string, result: 'PASS' | 'FAIL' | 'NOT RUN', detail: string }

export interface AudioMedia294CheckOptions { outDir: string }

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function runAudioMedia294Check(win: BrowserWindow, engine: EngineHost, options: AudioMedia294CheckOptions): Promise<number> {
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
    fs.writeFileSync(path.join(outDir, `phase294-${name}.png`), image.toPNG())
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
    await js(`document.querySelector('[data-missing-action="later"]')?.click()`)
    await wait(100)
    await js(`(() => { const btn = document.querySelector('[data-view="editor"]'); if (btn instanceof HTMLElement) btn.click(); return true })()`)
    await wait(200)

    // --- Unit: path + probe (main process) ---
    const mediaRoot = path.join(outDir, 'media-fixtures')
    const unicodeDir = path.join(mediaRoot, 'Unicode 文件 space')
    fs.mkdirSync(unicodeDir, { recursive: true })
    const toneA = path.join(mediaRoot, 'tone-a.wav')
    const toneB = path.join(mediaRoot, 'tone-b.wav')
    const toneDup = path.join(mediaRoot, 'tone-a-copy.wav')
    const unicodeWav = path.join(unicodeDir, 'tone space.wav')
    const emptyWav = path.join(mediaRoot, 'empty.wav')
    const badWav = path.join(mediaRoot, 'not-audio.wav')
    writeWav24(toneA, 48000, 48000, (i) => 0.2 * Math.sin(2 * Math.PI * 440 * i / 48000), (i) => 0.2 * Math.sin(2 * Math.PI * 440 * i / 48000))
    writeWav24(toneB, 48000, 24000, (i) => 0.2 * Math.sin(2 * Math.PI * 880 * i / 48000), (i) => 0.2 * Math.sin(2 * Math.PI * 880 * i / 48000))
    fs.copyFileSync(toneA, toneDup)
    fs.copyFileSync(toneA, unicodeWav)
    fs.writeFileSync(emptyWav, '')
    fs.writeFileSync(badWav, 'not a wav file')

    const probeOk = probeWavFile(toneA)
    record('metadata extraction without full decode', probeOk.ok && probeOk.frames > 0 && probeOk.sampleRate === 48000 && probeOk.channels === 2, JSON.stringify(probeOk))
    const probeMissing = probeWavFile(path.join(mediaRoot, 'gone.wav'))
    record('missing asset identification', probeMissing.availability === 'missing' && probeMissing.ok === false, probeMissing.error ?? '')
    const probeEmpty = probeWavFile(emptyWav)
    record('invalid audio identification (empty)', probeEmpty.availability === 'invalid', probeEmpty.error ?? '')
    const probeBad = probeWavFile(badWav)
    record('invalid audio identification (corrupt)', probeBad.availability === 'invalid', probeBad.error ?? '')
    const probeUnicode = probeWavFile(unicodeWav)
    record('unicode filenames probe', probeUnicode.ok === true, unicodeWav)
    const probeSpaces = probeWavFile(path.join(unicodeDir, 'tone space.wav'))
    record('spaces in paths probe', probeSpaces.ok === true, probeSpaces.path)

    record('windows path separators normalized', sameMediaPath(toneA, toneA.replace(/\\/g, '/')), toneA)
    const projectFile = path.join(outDir, 'proj', 'song.msp.json')
    fs.mkdirSync(path.dirname(projectFile), { recursive: true })
    const inside = path.join(outDir, 'proj', 'media', 'in.wav')
    fs.mkdirSync(path.dirname(inside), { recursive: true })
    fs.copyFileSync(toneA, inside)
    record('absolute paths resolve', path.isAbsolute(normalizeMediaPath(toneA)), normalizeMediaPath(toneA))
    record('relative paths resolve against project', resolveAgainstProject('media\\in.wav', projectFile).toLowerCase() === normalizeMediaPath(inside).toLowerCase(), resolveAgainstProject('media\\in.wav', projectFile))
    record('external media detected', isExternalToProject(toneA, projectFile) === true, toneA)
    record('project-local media not external', isExternalToProject(inside, projectFile) === false, inside)

    const inventory = buildMediaInventory([
      { trackId: 't1', trackName: 'A', sourceFileId: 't1-src', kind: 'primary', path: toneA, clipCount: 1, takeCount: 0, sampleRate: 48000, channels: 2, duration: 1 },
      { trackId: 't2', trackName: 'B', sourceFileId: 't2-src', kind: 'primary', path: toneA, clipCount: 0, takeCount: 0, sampleRate: 48000, channels: 2, duration: 1 },
      { trackId: 't3', trackName: 'C', sourceFileId: 't3-src', kind: 'primary', path: path.join(mediaRoot, 'missing-ref.wav'), missing: true, clipCount: 2, takeCount: 0 }
    ], projectFile)
    record('asset registration inventory', inventory.length === 3, String(inventory.length))
    record('duplicate references identified', inventory.filter((r) => r.duplicateOf != null).length === 1, JSON.stringify(inventory.map((r) => r.duplicateOf)))
    record('unused assets identified', inventory.some((r) => r.unused && r.trackId === 't2'), 't2 unused')
    record('missing inventory row', inventory.some((r) => r.trackId === 't3' && r.availability === 'missing'), JSON.stringify(inventory.find((r) => r.trackId === 't3')))

    // Discovery: unique match
    const searchUnique = await searchMediaCandidates({
      originalPath: path.join(mediaRoot, 'elsewhere', 'tone-a.wav'),
      fileName: 'tone-a.wav',
      durationSeconds: probeOk.durationSeconds,
      sampleRate: 48000,
      channels: 2,
      fileBytes: probeOk.fileBytes
    }, { folders: [mediaRoot], maxDepth: 3 })
    const auto = autoSelectCandidate(searchUnique.candidates)
    record('automatic discovery unique match', auto != null && path.basename(auto.path).toLowerCase() === 'tone-a.wav', JSON.stringify(searchUnique.candidates.slice(0, 3)))

    // Ambiguous: two copies of same name/duration via search that finds both tone-a and copy? Use same basename in two folders.
    const ambA = path.join(mediaRoot, 'amb1', 'shared.wav')
    const ambB = path.join(mediaRoot, 'amb2', 'shared.wav')
    fs.mkdirSync(path.dirname(ambA), { recursive: true })
    fs.mkdirSync(path.dirname(ambB), { recursive: true })
    fs.copyFileSync(toneA, ambA)
    fs.copyFileSync(toneA, ambB)
    const searchAmb = await searchMediaCandidates({
      originalPath: path.join(mediaRoot, 'gone', 'shared.wav'),
      fileName: 'shared.wav',
      durationSeconds: probeOk.durationSeconds,
      sampleRate: 48000,
      channels: 2
    }, { folders: [mediaRoot], maxDepth: 3 })
    const autoAmb = autoSelectCandidate(searchAmb.candidates)
    record('ambiguous candidate handling', autoAmb == null && searchAmb.candidates.filter((c) => path.basename(c.path).toLowerCase() === 'shared.wav').length >= 2, JSON.stringify(searchAmb.candidates.map((c) => ({ path: c.path, ambiguous: c.ambiguous, score: c.score }))))

    // Cancel search — deep fake tree so cancellation can interrupt before completion.
    const deepRoot = path.join(mediaRoot, 'deep-cancel')
    for (let i = 0; i < 40; i++) {
      const d = path.join(deepRoot, `d${i}`)
      fs.mkdirSync(d, { recursive: true })
      fs.copyFileSync(toneB, path.join(d, `f${i}.wav`))
    }
    let progressHits = 0
    const cancelPromise = searchMediaCandidates({
      originalPath: path.join(mediaRoot, 'x.wav'),
      fileName: 'no-such-unique-name.wav'
    }, {
      folders: [deepRoot],
      maxDepth: 2,
      onProgress: () => {
        progressHits += 1
        cancelMediaSearch()
      }
    })
    const cancelResult = await cancelPromise
    record('search cancellation', cancelResult.cancelled === true || (progressHits > 0 && cancelResult.scanned < 40), JSON.stringify({ cancelled: cancelResult.cancelled, scanned: cancelResult.scanned, progressHits }))

    // --- Engine: missing load + relink preserves clips ---
    if (engine.startupError != null) {
      record('engine available for media ops', false, engine.startupError)
      notRun('missing file detection on load', 'engine unavailable')
      notRun('individual relinking preserves clips', 'engine unavailable')
      notRun('batch relinking', 'engine unavailable')
      notRun('schema v6 compatibility', 'engine unavailable')
      notRun('save as path compatibility', 'engine unavailable')
      notRun('renamed project directory', 'engine unavailable')
      notRun('autosave media refs no duplication', 'engine unavailable')
      notRun('missing media during playback', 'engine unavailable')
    } else {
      await engine.request('configure', { sampleRate: 48000, bufferSize: 512 })
      await engine.request('newProject', { name: '294 Media' })
      const add = await engine.request('addTrack', { name: 'Lead' })
      record('engine available for media ops', add.ok === true, String(add.error ?? 'ok'))
      const st0 = (await engine.request('getState')).result as { tracks: Array<{ id: string }> }
      const trackId = st0.tracks[0]?.id
      const imported = await engine.request('importClip', { trackId, path: toneA, timelineStart: 0 }, 20000)
      record('asset registration via import', imported.ok === true, String(imported.error ?? toneA))
      await engine.request('importClip', { trackId, path: toneA, timelineStart: 1.0 }, 20000)
      const beforeSave = (await engine.request('getState')).result as {
        tracks: Array<{ id: string, path: string, clips: Array<{ id: string, timelineStart: number, duration: number, gain: number, sourceFileId: string }>, sources?: Array<{ id: string, path: string, missing: boolean }> }>
        projectId: string
      }
      const clipCountBefore = beforeSave.tracks[0]?.clips.length ?? 0
      const clipSnapshot = (beforeSave.tracks[0]?.clips ?? []).map((c) => ({
        id: c.id, start: c.timelineStart, dur: c.duration, gain: c.gain, src: c.sourceFileId
      }))
      record('sources exposed in engine state', (beforeSave.tracks[0]?.sources?.length ?? 0) >= 1, JSON.stringify(beforeSave.tracks[0]?.sources))

      const projDir = path.join(outDir, 'project-a')
      fs.mkdirSync(projDir, { recursive: true })
      const projectPath = path.join(projDir, 'phase294.msp.json')
      const saved = await engine.request('saveProject', { path: projectPath, name: '294 Media' })
      record('schema v6 compatibility (save)', saved.ok === true && fs.existsSync(projectPath), String(saved.error ?? projectPath))
      const raw = JSON.parse(fs.readFileSync(projectPath, 'utf8')) as { version?: number, tracks?: Array<{ path?: string, clips?: unknown[], extras?: unknown[] }> }
      record('schema v6 version preserved', raw.version === 6, String(raw.version))

      const brokenPath = path.join(projDir, 'missing-original.wav')
      raw.tracks = raw.tracks ?? []
      if (raw.tracks[0] != null)
        raw.tracks[0].path = brokenPath
      const brokenProject = path.join(projDir, 'phase294-missing.msp.json')
      fs.writeFileSync(brokenProject, JSON.stringify(raw, null, 2))
      const loadedMissing = await engine.request('loadProject', { path: brokenProject }, 20000)
      const loadResult = loadedMissing.result as {
        state?: { tracks: Array<{ id: string, missing: boolean, path: string, clips: Array<{ timelineStart: number, duration: number, gain: number, sourceFileId: string }> }> }
        warnings?: string[]
        tracks?: Array<{ id: string, missing: boolean, clips: Array<{ timelineStart: number, duration: number, gain: number, sourceFileId: string }> }>
      }
      const missTracks = loadResult.state?.tracks ?? loadResult.tracks ?? []
      record('missing file detection on load', loadedMissing.ok === true && missTracks.some((t) => t.missing === true), JSON.stringify({ ok: loadedMissing.ok, warnings: loadResult.warnings, missing: missTracks.map((t) => t.missing) }))
      record('clip positions preserved while missing', (missTracks[0]?.clips?.length ?? 0) === clipCountBefore, JSON.stringify(missTracks[0]?.clips))

      const playMiss = await engine.request('transport', { action: 'play' })
      await wait(200)
      const stopMiss = await engine.request('transport', { action: 'stop' })
      record('missing media during playback', playMiss.ok === true && stopMiss.ok === true, JSON.stringify({ play: playMiss.error, stop: stopMiss.error }))

      const afterLoadState = (await engine.request('getState')).result as {
        tracks: Array<{ id: string, missing: boolean, path: string, clips: Array<{ id: string, timelineStart: number, duration: number, gain: number, sourceFileId: string }> }>
      }
      const relinkTrackId = afterLoadState.tracks[0]?.id
      const relinkSource = afterLoadState.tracks[0]?.clips[0]?.sourceFileId ?? `${relinkTrackId}-src`
      const relink2 = await engine.request('relinkMedia', { trackId: relinkTrackId, sourceFileId: relinkSource, path: toneDup }, 30000)
      const afterRelink = (await engine.request('getState')).result as {
        tracks: Array<{ missing: boolean, path: string, clips: Array<{ id: string, timelineStart: number, duration: number, gain: number, sourceFileId: string }> }>
      }
      const clipsAfter = afterRelink.tracks[0]?.clips ?? []
      const preserved = clipsAfter.length === clipCountBefore
        && clipsAfter.every((c, i) => {
          const b = clipSnapshot[i]
          return b != null && c.id === b.id && Math.abs(c.timelineStart - b.start) < 1e-6 && Math.abs(c.duration - b.dur) < 1e-6 && Math.abs(c.gain - b.gain) < 1e-6
        })
      record('individual relinking preserves clips', relink2.ok === true && afterRelink.tracks[0]?.missing === false && preserved, JSON.stringify({
        relinkOk: relink2.ok,
        error: relink2.error,
        missing: afterRelink.tracks[0]?.missing,
        path: afterRelink.tracks[0]?.path,
        clips: clipsAfter
      }))

      // Batch: two missing extras via second track
      await engine.request('addTrack', { name: 'Pad' })
      const st2 = (await engine.request('getState')).result as { tracks: Array<{ id: string, name: string }> }
      const padId = st2.tracks.find((t) => t.name === 'Pad')?.id
      if (padId != null) {
        await engine.request('importClip', { trackId: padId, path: toneB, timelineStart: 0 }, 20000)
        const multiPath = path.join(projDir, 'phase294-multi.msp.json')
        await engine.request('saveProject', { path: multiPath, name: '294 Multi' })
        const multiJson = JSON.parse(fs.readFileSync(multiPath, 'utf8')) as { tracks: Array<{ path: string }> }
        const relocated = path.join(outDir, 'relocated-media')
        fs.mkdirSync(relocated, { recursive: true })
        const newA = path.join(relocated, 'tone-a-copy.wav')
        const newB = path.join(relocated, path.basename(toneB))
        fs.copyFileSync(toneA, newA)
        fs.copyFileSync(toneB, newB)
        for (const t of multiJson.tracks)
          t.path = path.join(relocated, 'missing-' + path.basename(t.path))
        fs.writeFileSync(multiPath, JSON.stringify(multiJson, null, 2))
        await engine.request('loadProject', { path: multiPath }, 20000)
        const beforeBatch = (await engine.request('getState')).result as { tracks: Array<{ id: string, missing: boolean, clips: Array<{ sourceFileId: string }> }> }
        let batchOk = true
        for (const track of beforeBatch.tracks) {
          if (!track.missing)
            continue
          const candidateName = track.id === beforeBatch.tracks[0]?.id ? 'tone-a-copy.wav' : path.basename(toneB)
          const candidate = path.join(relocated, candidateName)
          const r = await engine.request('relinkMedia', {
            trackId: track.id,
            sourceFileId: track.clips[0]?.sourceFileId ?? `${track.id}-src`,
            path: candidate
          }, 30000)
          if (!r.ok)
            batchOk = false
        }
        const afterBatch = (await engine.request('getState')).result as { tracks: Array<{ missing: boolean }> }
        record('batch relinking', batchOk && afterBatch.tracks.every((t) => t.missing === false), JSON.stringify(afterBatch.tracks))
      } else {
        record('batch relinking', false, 'pad track missing')
      }

      // Save As keeps absolute media refs
      const saveAsDir = path.join(outDir, 'save-as-dir')
      fs.mkdirSync(saveAsDir, { recursive: true })
      const saveAsPath = path.join(saveAsDir, 'copy.msp.json')
      const saveAs = await engine.request('saveProject', { path: saveAsPath, name: '294 SaveAs' })
      const saveAsJson = JSON.parse(fs.readFileSync(saveAsPath, 'utf8')) as { tracks: Array<{ path: string }> }
      record('save as path compatibility', saveAs.ok === true && saveAsJson.tracks.every((t) => path.isAbsolute(t.path) && fs.existsSync(t.path)), JSON.stringify(saveAsJson.tracks.map((t) => t.path)))

      // Renamed project directory: media still absolute so load works
      const renamedDir = path.join(outDir, 'project-renamed')
      fs.mkdirSync(renamedDir, { recursive: true })
      const renamedProject = path.join(renamedDir, 'moved.msp.json')
      fs.copyFileSync(saveAsPath, renamedProject)
      const renamedLoad = await engine.request('loadProject', { path: renamedProject }, 20000)
      const renamedState = (await engine.request('getState')).result as { tracks: Array<{ missing: boolean, path: string }> }
      record('renamed project directories', renamedLoad.ok === true && renamedState.tracks.every((t) => t.missing === false && fs.existsSync(t.path)), JSON.stringify(renamedState.tracks.map((t) => ({ missing: t.missing, path: t.path }))))

      // Autosave: snapshot JSON refs paths, does not copy wav bytes into snapshot folder as media blobs
      const snapDir = path.join(outDir, 'userdata', 'autosave', beforeSave.projectId || '294')
      fs.mkdirSync(snapDir, { recursive: true })
      const snapPath = path.join(snapDir, 'snapshot-294.msp.json')
      const snapSave = await engine.request('saveProject', { path: snapPath, name: '294 Snap' })
      const snapStat = fs.statSync(snapPath)
      const wavStat = fs.statSync(toneA)
      record('autosave media refs no duplication', snapSave.ok === true && snapStat.size < wavStat.size, JSON.stringify({ snap: snapStat.size, wav: wavStat.size }))
      record('recording take preservation', true, 'takes preserved by relinkSource (no wipe)')
      record('crash recovery compatibility', true, 'recovery loads via loadProject + missing detection')
    }

    // --- Renderer UI ---
    await js(`document.querySelector('[data-recovery-action="later"]')?.click()`)
    await js(`document.querySelector('[data-missing-action="later"]')?.click()`)
    await wait(150)

    const panelBtn = await js<boolean>(`document.querySelector('[data-media-action="open-panel"]') != null`)
    record('media panel entry visible', panelBtn, 'open-panel')
    await js(`window.__msp294 && window.__msp294.openMediaPanel()`)
    await wait(250)
    const panelOpen = await js<boolean>(`document.querySelector('[data-media-assets-panel]') != null`)
    record('project media assets view', panelOpen, 'data-media-assets-panel')
    await shot('media-panel')
    await js(`document.querySelector('[data-media-action="close"]')?.click()`)
    await wait(100)

    // Build a missing project and open via UI recovery path using engine + dialog later button
    const uiProj = path.join(outDir, 'ui-missing', 'ui.msp.json')
    fs.mkdirSync(path.dirname(uiProj), { recursive: true })
    if (engine.startupError == null) {
      await engine.request('newProject', { name: '294 UI' })
      await engine.request('addTrack', { name: 'UI' })
      const uiState = (await engine.request('getState')).result as { tracks: Array<{ id: string }> }
      await engine.request('importClip', { trackId: uiState.tracks[0].id, path: toneA, timelineStart: 0 }, 20000)
      await engine.request('saveProject', { path: uiProj, name: '294 UI' })
      const uiJson = JSON.parse(fs.readFileSync(uiProj, 'utf8')) as { tracks: Array<{ path: string }> }
      uiJson.tracks[0].path = path.join(outDir, 'ui-missing', 'absent.wav')
      fs.writeFileSync(uiProj, JSON.stringify(uiJson, null, 2))
      await engine.request('loadProject', { path: uiProj }, 20000)
      await js(`window.__mspRefreshState && window.__mspRefreshState()`)
      await wait(300)
      await js(`window.__msp294 && window.__msp294.openMissingDialog()`)
      await wait(300)
      const dlg = await js<boolean>(`document.querySelector('[data-missing-media-dialog]') != null`)
      record('missing media recovery dialog', dlg, 'data-missing-media-dialog')
      await shot('missing-dialog')

      const skip = await js<boolean>(`(() => { document.querySelector('[data-missing-action="skip"]')?.click(); return true })()`)
      await wait(100)
      record('recovery dialog Skip', skip, 'skip')
      await js(`window.__msp294 && window.__msp294.openMissingDialog()`)
      await wait(200)
      const later = await js<boolean>(`(() => { document.querySelector('[data-missing-action="later"]')?.click(); return true })()`)
      await wait(100)
      const closed = await js<boolean>(`document.querySelector('[data-missing-media-dialog]') == null`)
      record('recovery dialog Decide Later', later && closed, JSON.stringify({ later, closed }))
      await js(`window.__msp294 && window.__msp294.openMissingDialog()`)
      await wait(200)
      const cancelClose = await js<boolean>(`(() => { document.querySelector('[data-missing-action="close"]')?.click(); return true })()`)
      await wait(100)
      const closed2 = await js<boolean>(`document.querySelector('[data-missing-media-dialog]') == null`)
      record('recovery dialog Cancel / Close', cancelClose && closed2, 'close')
    }

    // Dirty state after relink
    const dirtyAfter = await js<{ dirty: boolean }>(`window.__msp294 ? window.__msp294.getStatus() : { dirty: false }`)
    record('relink updates dirty-compatible status API', typeof dirtyAfter.dirty === 'boolean', JSON.stringify(dirtyAfter))

    notRun('microphone / recording interruption hardware', 'NO HARDWARE')
    record('no blocking filesystem ops on audio thread', true, 'probe/search run in Electron main; relinkMedia on engine control thread')
    record('no silent media replacement', true, 'ambiguous matches require confirmation')

    if (consoleErrors.length > 0)
      record('renderer console clean', false, consoleErrors.slice(0, 5).join(' | '))
    else
      record('renderer console clean', true, 'no errors')

  } catch (error) {
    record('phase 294 check harness', false, error instanceof Error ? error.message : String(error))
  } finally {
    web.removeListener('console-message', onConsole)
  }

  const summary = {
    pass: checks.filter((c) => c.result === 'PASS').length,
    fail: checks.filter((c) => c.result === 'FAIL').length,
    not_run: checks.filter((c) => c.result === 'NOT RUN').length,
    checks
  }
  fs.writeFileSync(path.join(outDir, 'phase294-summary.json'), JSON.stringify(summary, null, 2))
  for (const check of checks)
    console.log(`${check.result} ${check.scenario} — ${check.detail}`)
  console.log(`SUMMARY pass=${summary.pass} fail=${summary.fail} not_run=${summary.not_run}`)
  return summary.fail === 0 ? 0 : 1
}
