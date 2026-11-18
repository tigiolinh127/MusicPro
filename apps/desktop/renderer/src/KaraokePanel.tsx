import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  DeviceList,
  EngineState,
  RecordInputName,
  RecordModeName,
  RecordTake,
  TakeState,
  TrackState
} from '../../../../packages/shared/src/protocol'
import { LiveAutoTunePanel } from './LiveAutoTunePanel'
import { dbText, dbToGain, gainToDb } from './Mixer'
import { YouTubePlayer, youtubeWatchUrl, type YoutubePlayerStatus } from './YouTubePlayer'
import { parseYoutubeVideoId } from './youtubeUrl'

type Command = (op: string, payload?: Record<string, unknown>, timeoutMs?: number) => Promise<boolean>
type CommandState = (op: string, payload?: Record<string, unknown>, timeoutMs?: number) => Promise<Partial<EngineState> | null>

export type KaraokeMode = 'youtube' | 'studio'

export interface KaraokeTakeMeta {
  videoId: string
  videoPositionSec: number
  recordedAt: string
  takePaths: string[]
  mode?: KaraokeMode
  recordOffsetSec?: number
  takeStartSeconds?: number
}

export interface KaraokeSessionPrefs {
  mode: KaraokeMode
  url: string
  videoId: string | null
  recordOffsetSec: number
}

const SESSION_PREFS_KEY = 'msp.karaoke.session.v1'

function formatTime(seconds: number): string {
  const s = Math.max(0, seconds)
  const m = Math.floor(s / 60)
  const r = s - m * 60
  return `${m}:${r.toFixed(1).padStart(4, '0')}`
}

function takePaths(take: RecordTake | null | undefined): string[] {
  if (take == null)
    return []
  return take.takes.map((item) => item.path).filter((path) => path.length > 0)
}

function loadSessionPrefs(): Partial<KaraokeSessionPrefs> {
  try {
    const raw = localStorage.getItem(SESSION_PREFS_KEY)
    if (raw == null)
      return {}
    const parsed = JSON.parse(raw) as Partial<KaraokeSessionPrefs>
    return parsed ?? {}
  } catch {
    return {}
  }
}

function saveSessionPrefs(prefs: KaraokeSessionPrefs): void {
  try {
    localStorage.setItem(SESSION_PREFS_KEY, JSON.stringify(prefs))
  } catch {
    // Quota / private mode — ignore; engine project still holds audio.
  }
}

function GainSlider(props: {
  label: string
  gain: number
  disabled?: boolean
  action: string
  onCommit: (gain: number) => void
}) {
  const db = gainToDb(props.gain)
  return (
    <label className="field karaoke-gain">
      {props.label}
      <span className="karaoke-gain-value">{dbText(props.gain)}</span>
      <input
        type="range"
        min={-60}
        max={12}
        step={0.5}
        aria-label={props.label}
        data-action={props.action}
        value={db}
        disabled={props.disabled}
        onChange={(event) => props.onCommit(dbToGain(Number(event.target.value)))}
      />
    </label>
  )
}

export function KaraokePanel(props: {
  state: EngineState | null
  devices: DeviceList | null
  inputDevice: string
  outputDevice: string
  sampleRate: string
  bufferSize: string
  onInputDevice: (value: string) => void
  command: Command
  commandState: CommandState
  onApplyDevices: () => Promise<void>
  onChooseRecordFolder: () => Promise<void>
  onNotice: (message: string | null) => void
  onError: (message: string | null) => void
  onOpenVocalInStudio: () => void | Promise<void>
}) {
  const prefs = useMemo(() => loadSessionPrefs(), [])
  const [mode, setMode] = useState<KaraokeMode>(prefs.mode === 'youtube' ? 'youtube' : 'studio')
  const [url, setUrl] = useState(prefs.url ?? '')
  const [videoId, setVideoId] = useState<string | null>(prefs.videoId ?? null)
  const [playerStatus, setPlayerStatus] = useState<YoutubePlayerStatus>('idle')
  const [playerDetail, setPlayerDetail] = useState<string | null>(null)
  const [videoTime, setVideoTime] = useState(0)
  const videoTimeRef = useRef(0)
  const [meta, setMeta] = useState<KaraokeTakeMeta | null>(null)
  const [busy, setBusy] = useState(false)
  /** Manual seconds nudge applied via transport seek before record — not measured hardware latency. */
  const [recordOffsetSec, setRecordOffsetSec] = useState(typeof prefs.recordOffsetSec === 'number' ? prefs.recordOffsetSec : 0)
  const [selectedTakeId, setSelectedTakeId] = useState<string | null>(null)
  const playerTimeHandler = useCallback((seconds: number) => {
    videoTimeRef.current = seconds
    setVideoTime(seconds)
  }, [])

  const recording = props.state?.record?.state === 'recording'
  const transport = props.state?.transport ?? 'stopped'
  const playing = transport === 'playing'
  const engineDisconnected = props.state == null
  const inputChannels = props.state?.inputChannels ?? 0
  const reportedLatencyMs = props.state?.reportedLatencyMs
  const virtualInput = props.state?.record?.virtualInput?.enabled === true
  const noMic = !virtualInput && inputChannels <= 0
  const tracks = props.state?.tracks ?? []
  const karaokeTrack = useMemo(
    () => tracks.find((track) => track.name === 'Karaoke Vocal') ?? tracks.find((track) => track.armed) ?? undefined,
    [tracks]
  )
  const backingTrack = useMemo(
    () => tracks.find((track) => track.name === 'Karaoke Backing'),
    [tracks]
  )
  const lastTake = props.state?.record?.lastTake ?? null
  const engineTakes: TakeState[] = karaokeTrack?.takes ?? []
  const lastTakePaths = takePaths(lastTake)
  const vocalExportPath = useMemo(() => {
    if (selectedTakeId != null) {
      const lane = engineTakes.find((t) => t.id === selectedTakeId)
      // Take lanes reference sources; export uses last recorded file path when available.
      if (lane != null && lastTakePaths[0] != null)
        return lastTakePaths[0]
    }
    if (meta?.takePaths?.[0] != null)
      return meta.takePaths[0]
    return lastTakePaths[0] ?? null
  }, [selectedTakeId, engineTakes, lastTakePaths, meta])
  const hasVocalMaterial = engineTakes.length > 0 || (karaokeTrack?.clips.length ?? 0) > 0 || lastTakePaths.length > 0
  const hasBackingClip = (backingTrack?.clips.length ?? 0) > 0
  const backingClipLabel = backingTrack?.clips[0] != null
    ? `${backingTrack.name} · @ ${formatTime(backingTrack.clips[0].timelineStart)} (${formatTime(backingTrack.clips[0].duration)})`
    : 'No local backing WAV'
  const sourceLabel = mode === 'youtube'
    ? (videoId != null ? `YouTube · ${videoId}` : 'YouTube · no video loaded')
    : backingClipLabel
  const vocalExportReady = vocalExportPath != null
  const mixExportReady = hasBackingClip && hasVocalMaterial
  const selectedTake = engineTakes.find((t) => t.id === selectedTakeId) ?? engineTakes.at(-1) ?? null

  useEffect(() => {
    saveSessionPrefs({ mode, url, videoId, recordOffsetSec })
  }, [mode, url, videoId, recordOffsetSec])

  useEffect(() => {
    if (selectedTakeId == null && engineTakes.length > 0)
      setSelectedTakeId(engineTakes[engineTakes.length - 1]!.id)
    if (selectedTakeId != null && engineTakes.every((t) => t.id !== selectedTakeId))
      setSelectedTakeId(engineTakes.at(-1)?.id ?? null)
  }, [engineTakes, selectedTakeId])

  async function ensureKaraokeTrack(): Promise<TrackState | null> {
    const existing = props.state?.tracks.find((track) => track.name === 'Karaoke Vocal')
    if (existing != null) {
      if (!existing.armed)
        await props.command('setTrackRecord', { trackId: existing.id, armed: true, monitor: existing.monitorInput })
      return existing
    }
    const next = await props.commandState('addTrack', { name: 'Karaoke Vocal' })
    const created = (next?.tracks ?? props.state?.tracks ?? []).find((track) => track.name === 'Karaoke Vocal')
      ?? (next?.tracks ?? []).at(-1)
    if (created == null)
      return null
    await props.command('setTrackRecord', { trackId: created.id, armed: true, input: '1' as RecordInputName, mode: 'dry' as RecordModeName, monitor: false })
    return created
  }

  async function ensureBackingTrack(): Promise<TrackState | null> {
    if (backingTrack != null)
      return backingTrack
    const next = await props.commandState('addTrack', { name: 'Karaoke Backing' })
    return (next?.tracks ?? []).find((item) => item.name === 'Karaoke Backing') ?? (next?.tracks ?? []).at(-1) ?? null
  }

  async function prepareTransportForRecord(seekSeconds: number): Promise<boolean> {
    if (playing || transport === 'paused') {
      const stopped = await props.command('transport', { action: 'stop' })
      if (!stopped)
        return false
    }
    return await props.command('transport', { action: 'seek', position: Math.max(0, seekSeconds) })
  }

  async function loadVideo(): Promise<void> {
    const parsed = parseYoutubeVideoId(url)
    if (!parsed.ok) {
      props.onError(parsed.error)
      setVideoId(null)
      return
    }
    props.onError(null)
    setPlayerDetail(null)
    setVideoId(parsed.videoId)
  }

  async function startRecording(): Promise<void> {
    if (engineDisconnected) {
      props.onError('The audio engine is disconnected. Restart Music Studio Pro or check MusicStudioEngine.')
      return
    }
    if (noMic) {
      props.onError('No microphone input is open. Choose an input device and Apply devices, or enable the virtual test signal.')
      return
    }
    setBusy(true)
    props.onNotice(null)
    props.onError(null)
    const track = await ensureKaraokeTrack()
    if (track == null) {
      setBusy(false)
      props.onError('Could not prepare a karaoke vocal track.')
      return
    }

    const seekTo = mode === 'studio'
      ? Math.max(0, recordOffsetSec)
      : Math.max(0, props.state?.position ?? 0)
    const prepared = await prepareTransportForRecord(seekTo)
    if (!prepared) {
      setBusy(false)
      props.onError('Could not prepare the transport for recording (stop/seek failed).')
      return
    }

    const positionSec = mode === 'youtube' ? videoTimeRef.current : seekTo
    setMeta({
      videoId: mode === 'youtube' ? (videoId ?? '') : '',
      videoPositionSec: positionSec,
      recordedAt: new Date().toISOString(),
      takePaths: [],
      mode,
      recordOffsetSec: mode === 'studio' ? recordOffsetSec : undefined,
      takeStartSeconds: seekTo
    })

    if (mode === 'youtube' && videoId != null) {
      try {
        const playBtn = document.querySelector('[data-action="karaoke-play"]')
        if (playBtn instanceof HTMLElement)
          playBtn.click()
      } catch { /* ignore */ }
    }

    const started = await props.command('record', { action: 'start' })
    setBusy(false)
    if (!started) {
      props.onError('Recording did not start. Arm Karaoke Vocal, stop transport if it is playing, and ensure the engine is connected.')
      return
    }
    props.onNotice(
      mode === 'studio'
        ? (hasBackingClip
          ? `Studio recording @ ${formatTime(seekTo)} · backing plays · mic → Karaoke Vocal only`
          : `Studio recording @ ${formatTime(seekTo)} · mic only (import a local backing WAV for Full Mix)`)
        : (videoId != null
          ? `YouTube mode recording · video ${videoId} @ ${formatTime(positionSec)} (approx.). YouTube audio is never captured.`
          : `YouTube mode recording · no video · engine @ ${formatTime(seekTo)}`)
    )
  }

  async function stopRecording(): Promise<void> {
    if (engineDisconnected) {
      props.onError('The audio engine is disconnected — cannot finalize the take.')
      return
    }
    setBusy(true)
    const next = await props.commandState('record', { action: 'stop' }, 30000)
    setBusy(false)
    const take = (next as EngineState | null)?.take ?? props.state?.record?.lastTake ?? null
    const paths = takePaths(take)
    const startSeconds = take?.startSeconds
    setMeta((current) => current == null ? {
      videoId: videoId ?? '',
      videoPositionSec: 0,
      recordedAt: new Date().toISOString(),
      takePaths: paths,
      mode,
      takeStartSeconds: startSeconds
    } : {
      ...current,
      takePaths: paths.length > 0 ? paths : current.takePaths,
      takeStartSeconds: typeof startSeconds === 'number' ? startSeconds : current.takeStartSeconds
    })
    if (take == null || paths.length === 0) {
      props.onError('Recording stopped but no vocal take file was produced. Check disk space and the record folder.')
      return
    }
    props.onNotice(
      mode === 'youtube'
        ? `Vocal take ready (${paths.length} file${paths.length === 1 ? '' : 's'}) at ${formatTime(take.startSeconds)}. YouTube audio was not recorded.`
        : `Vocal take ready (${paths.length} file${paths.length === 1 ? '' : 's'}) placed at ${formatTime(take.startSeconds)}. Select it below or Open Vocal in Studio.`
    )
  }

  async function reviewPlayback(): Promise<void> {
    if (engineDisconnected) {
      props.onError('The audio engine is disconnected.')
      return
    }
    if (!hasVocalMaterial && !hasBackingClip) {
      props.onError('Nothing to review yet. Record a vocal or import a backing WAV.')
      return
    }
    const start = selectedTake?.timelineStart
      ?? meta?.takeStartSeconds
      ?? lastTake?.startSeconds
      ?? Math.max(0, recordOffsetSec)
    setBusy(true)
    props.onError(null)
    if (playing)
      await props.command('transport', { action: 'stop' })
    const seeked = await props.command('transport', { action: 'seek', position: Math.max(0, start) })
    const played = seeked && await props.command('transport', { action: 'play' })
    setBusy(false)
    if (!played) {
      props.onError('Could not start review playback.')
      return
    }
    props.onNotice(`Reviewing from ${formatTime(start)} (vocal + local backing only — never YouTube).`)
  }

  async function stopPlayback(): Promise<void> {
    if (engineDisconnected) {
      props.onError('The audio engine is disconnected.')
      return
    }
    await props.command('transport', { action: 'stop' })
  }

  async function exportVocal(): Promise<void> {
    if (!vocalExportReady || vocalExportPath == null) {
      props.onError('No vocal take is available to export. Record a take first.')
      return
    }
    try {
      const payload: KaraokeTakeMeta = meta ?? {
        videoId: videoId ?? '',
        videoPositionSec: 0,
        recordedAt: new Date().toISOString(),
        takePaths: [vocalExportPath],
        mode
      }
      const saved = await window.studio.exportKaraokeVocal(vocalExportPath, { ...payload })
      if (saved == null) {
        props.onNotice('Export cancelled.')
        return
      }
      props.onNotice(`Saved vocal WAV (+ karaoke metadata sidecar): ${saved}`)
      props.onError(null)
    } catch (error) {
      props.onError(error instanceof Error ? error.message : 'Could not export the vocal WAV.')
    }
  }

  async function importBacking(): Promise<void> {
    const path = await window.studio.pickWav()
    if (path == null)
      return
    if (!path.toLowerCase().endsWith('.wav')) {
      props.onError('Only WAV backing files are supported. Convert MP3/other formats to WAV before import.')
      return
    }
    setBusy(true)
    const track = await ensureBackingTrack()
    if (track == null) {
      setBusy(false)
      props.onError('Could not create a backing track.')
      return
    }
    const ok = await props.command('importClip', { trackId: track.id, path, timelineStart: 0 }, 30000)
    setBusy(false)
    if (ok)
      props.onNotice('Authorized local backing WAV imported on Karaoke Backing. Required for Full Mix export.')
    else
      props.onError('Backing import failed. Use a readable WAV file.')
  }

  async function exportMix(): Promise<void> {
    if (engineDisconnected) {
      props.onError('The audio engine is disconnected — cannot export.')
      return
    }
    if (!hasBackingClip) {
      props.onError('Full Mix requires an authorized local backing WAV in Studio mode. Export Vocal WAV instead, or import backing first. YouTube audio is never included.')
      return
    }
    if (!hasVocalMaterial) {
      props.onError('No vocal take on Karaoke Vocal yet. Record before exporting a full mix, or export will be backing-only.')
    }
    const path = await window.studio.pickExportWav()
    if (path == null)
      return
    const rate = Number(props.sampleRate) || props.state?.sampleRate || 48000
    const ok = await props.command('exportWav', { path, sampleRate: rate }, 120000)
    if (ok)
      props.onNotice(`Exported Full Mix WAV (local tracks + volumes/FX). YouTube audio is never included: ${path}`)
    else
      props.onError('Mix export failed. Check the destination path and that the engine is connected.')
  }

  async function nudgeLastTake(): Promise<void> {
    const track = karaokeTrack
    const clip = track?.clips.at(-1)
    if (track == null || clip == null) {
      props.onError('No vocal clip to nudge. Record a take first.')
      return
    }
    const nextStart = Math.max(0, clip.timelineStart + recordOffsetSec)
    const ok = await props.command('moveClip', { trackId: track.id, clipId: clip.id, timelineStart: nextStart })
    if (ok)
      props.onNotice(`Moved last vocal clip to ${formatTime(nextStart)} (manual offset ${recordOffsetSec.toFixed(3)} s). Not hardware-measured.`)
  }

  function clearStatus(): void {
    props.onNotice(null)
    props.onError(null)
    setPlayerDetail(null)
  }

  function switchMode(next: KaraokeMode): void {
    if (recording) {
      props.onError('Stop recording before switching Karaoke modes.')
      return
    }
    setMode(next)
    props.onNotice(
      next === 'studio'
        ? 'Studio Karaoke: local backing + mic on the shared engine timeline. Full Mix export available when backing is imported.'
        : 'YouTube Karaoke: reference video only. Vocals record independently; YouTube audio is never captured or mixed.'
    )
  }

  useEffect(() => {
    const host = window as Window & {
      __mspKaraokeLoad?: (value: string) => void
      __mspKaraokeMode?: (value: KaraokeMode) => void
      __mspKaraokeOffset?: (seconds: number) => void
      __mspKaraokeOpenStudio?: () => void
      __mspKaraokeSelectTake?: (takeId: string) => void
    }
    host.__mspKaraokeLoad = (value: string) => {
      setMode('youtube')
      setUrl(value)
      const parsed = parseYoutubeVideoId(value)
      if (parsed.ok) {
        props.onError(null)
        setPlayerDetail(null)
        setVideoId(parsed.videoId)
      } else {
        props.onError(parsed.error)
        setVideoId(null)
      }
    }
    host.__mspKaraokeMode = (value: KaraokeMode) => {
      if (value === 'youtube' || value === 'studio')
        setMode(value)
    }
    host.__mspKaraokeOffset = (seconds: number) => {
      if (Number.isFinite(seconds))
        setRecordOffsetSec(seconds)
    }
    host.__mspKaraokeOpenStudio = () => { void props.onOpenVocalInStudio() }
    host.__mspKaraokeSelectTake = (takeId: string) => setSelectedTakeId(takeId)
    return () => {
      delete host.__mspKaraokeLoad
      delete host.__mspKaraokeMode
      delete host.__mspKaraokeOffset
      delete host.__mspKaraokeOpenStudio
      delete host.__mspKaraokeSelectTake
    }
  })

  const sessionLines = [
    `Source: ${sourceLabel}`,
    engineDisconnected ? 'Engine: disconnected' : 'Engine: connected',
    `Recording: ${recording ? 'active' : 'idle'} · Transport: ${transport} @ ${formatTime(props.state?.position ?? 0)}`,
    noMic ? 'Mic: missing — choose a device or virtual test signal' : (virtualInput ? 'Mic: virtual test signal' : `Mic: ${inputChannels} ch`),
    `Takes on Karaoke Vocal: ${engineTakes.length} · Clips: ${karaokeTrack?.clips.length ?? 0}`,
    selectedTake != null
      ? `Selected take: ${selectedTake.name} @ ${formatTime(selectedTake.timelineStart)}`
      : 'Selected take: none',
    `Export Vocal: ${vocalExportReady ? 'ready' : 'unavailable'}`,
    `Export Full Mix: ${mixExportReady ? 'ready' : (hasBackingClip ? 'needs vocal take' : 'needs local backing WAV')}`
  ]

  return (
    <section className="karaoke" data-panel="karaoke-k1" data-karaoke-mode={mode} data-karaoke-k3="1" aria-label="Karaoke">
      <div className="karaoke-mode-bar" role="tablist" aria-label="Karaoke mode">
        <button
          type="button"
          role="tab"
          data-action="karaoke-mode-studio"
          aria-selected={mode === 'studio'}
          className={mode === 'studio' ? 'primary' : undefined}
          disabled={recording || busy}
          onClick={() => switchMode('studio')}
        >Studio Karaoke</button>
        <button
          type="button"
          role="tab"
          data-action="karaoke-mode-youtube"
          aria-selected={mode === 'youtube'}
          className={mode === 'youtube' ? 'primary' : undefined}
          disabled={recording || busy}
          onClick={() => switchMode('youtube')}
        >YouTube Karaoke</button>
        <button type="button" data-action="karaoke-clear-status" disabled={busy} onClick={clearStatus}>Clear status</button>
        <button
          type="button"
          data-action="karaoke-open-studio"
          disabled={busy || recording || karaokeTrack == null}
          onClick={() => { void props.onOpenVocalInStudio() }}
        >Open Vocal in Studio</button>
      </div>

      <div className="karaoke-main karaoke-main-k3">
        <div className="karaoke-player-card">
          {mode === 'youtube' ? (
            <>
              <h2>YouTube Karaoke</h2>
              <ol className="karaoke-steps" data-karaoke-steps="youtube">
                <li>Paste an embeddable YouTube URL and Load video</li>
                <li>Select a microphone (or virtual test signal)</li>
                <li>Record — vocal is independent; YouTube audio is never captured</li>
                <li>Review, then Export Vocal WAV (+ metadata)</li>
              </ol>
              <p className="hint">
                For a song+vocal mix, switch to Studio Karaoke and import an authorized local backing WAV.
              </p>
              <label className="field">
                YouTube URL
                <input
                  aria-label="YouTube URL"
                  data-action="karaoke-url"
                  value={url}
                  placeholder="https://www.youtube.com/watch?v=…"
                  onChange={(event) => setUrl(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter')
                      void loadVideo()
                  }}
                />
              </label>
              <div className="karaoke-actions">
                <button type="button" data-action="karaoke-load" className="primary" disabled={busy} onClick={() => void loadVideo()}>Load video</button>
                <button type="button" data-action="karaoke-clear" disabled={videoId == null || busy} onClick={() => { setVideoId(null); setPlayerDetail(null) }}>Clear</button>
                <button
                  type="button"
                  data-action="karaoke-open-external"
                  disabled={videoId == null || busy}
                  onClick={() => {
                    if (videoId == null)
                      return
                    void window.studio.openYoutubeExternal(youtubeWatchUrl(videoId)).then(
                      () => props.onNotice('Opened the video in your system browser.'),
                      (error: Error) => props.onError(error.message)
                    )
                  }}
                >Open on YouTube</button>
              </div>
              {(playerStatus === 'unavailable' || playerStatus === 'error') && (
                <p className="workflow-banner" data-karaoke-embed-error role="alert">
                  {playerDetail ?? 'This video cannot be embedded.'} You can still record vocals, or open the video externally.
                </p>
              )}
              <YouTubePlayer
                videoId={videoId}
                onStatus={(status, detail) => {
                  setPlayerStatus(status)
                  setPlayerDetail(detail ?? null)
                }}
                onTime={playerTimeHandler}
              />
              <p className="hint" data-karaoke-time>Video time (approx.): {formatTime(videoTime)}</p>
              <p className="hint" data-app-origin-label>App origin: {typeof window !== 'undefined' ? window.location.origin : ''}</p>
            </>
          ) : (
            <>
              <h2>Studio Karaoke</h2>
              <ol className="karaoke-steps" data-karaoke-steps="studio">
                <li>Import an authorized local backing WAV</li>
                <li>Select a microphone and set balance</li>
                <li>Record while backing plays on the shared transport</li>
                <li>Review / select takes · Open Vocal in Studio for comps &amp; processing</li>
                <li>Export Vocal WAV and/or Full Mix WAV</li>
              </ol>
              <div className="karaoke-studio-card" data-studio-panel="1">
                <p className="path" data-backing-label title={backingTrack?.path ?? ''}>{backingClipLabel}</p>
                <div className="karaoke-actions">
                  <button type="button" data-action="karaoke-import-backing" className="primary" disabled={busy || recording} onClick={() => void importBacking()}>
                    {hasBackingClip ? 'Replace backing WAV' : 'Import backing WAV'}
                  </button>
                  <button type="button" data-action="karaoke-review" disabled={busy || recording || engineDisconnected} onClick={() => void reviewPlayback()}>Playback / Review</button>
                  <button type="button" data-action="karaoke-stop-playback" disabled={busy || recording || (!playing && transport !== 'paused')} onClick={() => void stopPlayback()}>Stop</button>
                </div>
                <p className="hint">Backing import accepts WAV only (engine Phase 0). Convert MP3 to WAV externally if needed.</p>
                <GainSlider
                  label="Backing volume"
                  action="karaoke-backing-gain"
                  gain={backingTrack?.gain ?? 1}
                  disabled={backingTrack == null || recording || busy}
                  onCommit={(gain) => {
                    if (backingTrack != null)
                      void props.command('setTrack', { trackId: backingTrack.id, gain })
                  }}
                />
                <GainSlider
                  label="Vocal track volume"
                  action="karaoke-vocal-gain"
                  gain={karaokeTrack?.gain ?? 1}
                  disabled={karaokeTrack == null || recording || busy}
                  onCommit={(gain) => {
                    if (karaokeTrack != null)
                      void props.command('setTrack', { trackId: karaokeTrack.id, gain })
                  }}
                />
                <label className="field">
                  Manual record offset (seconds)
                  <input
                    type="number"
                    step={0.001}
                    data-action="karaoke-record-offset"
                    aria-label="Manual record offset seconds"
                    value={recordOffsetSec}
                    disabled={recording || busy}
                    onChange={(event) => setRecordOffsetSec(Number(event.target.value) || 0)}
                  />
                </label>
                <button type="button" data-action="karaoke-nudge-take" disabled={busy || recording || karaokeTrack?.clips.length === 0} onClick={() => void nudgeLastTake()}>
                  Nudge last vocal clip by offset
                </button>
              </div>
            </>
          )}
        </div>

        <aside className="karaoke-side">
          <section className="karaoke-session" data-karaoke-session="1" aria-label="Karaoke session">
            <h2>Session</h2>
            <ul data-karaoke-session-lines>
              {sessionLines.map((line) => <li key={line}>{line}</li>)}
            </ul>
            <div className="karaoke-actions">
              <button type="button" data-action="karaoke-review" disabled={busy || recording || engineDisconnected} onClick={() => void reviewPlayback()}>Playback / Review</button>
              <button type="button" data-action="karaoke-stop-playback" disabled={busy || recording || (!playing && transport !== 'paused')} onClick={() => void stopPlayback()}>Stop</button>
            </div>
            <h3 className="karaoke-subhead">Takes</h3>
            {engineTakes.length === 0 ? (
              <p className="hint" data-karaoke-no-takes>No takes on Karaoke Vocal yet. Record to add takes without duplicating files — paths stay in the project.</p>
            ) : (
              <ul className="karaoke-take-list" data-karaoke-take-list>
                {engineTakes.map((take) => (
                  <li key={take.id}>
                    <button
                      type="button"
                      data-action="karaoke-select-take"
                      data-take-id={take.id}
                      aria-pressed={selectedTake?.id === take.id}
                      className={selectedTake?.id === take.id ? 'primary' : undefined}
                      disabled={busy || recording}
                      onClick={() => setSelectedTakeId(take.id)}
                    >
                      {take.name} · {formatTime(take.timelineStart)} ({formatTime(take.duration)}){take.muted ? ' · muted' : ''}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="karaoke-sync" data-karaoke-sync="1" aria-label="Synchronization">
            <h2>Sync &amp; latency</h2>
            <ul data-karaoke-sync-lines>
              {mode === 'studio' ? (
                <>
                  <li>Local backing shares the engine transport with vocal takes</li>
                  <li>Manual record offset: {recordOffsetSec.toFixed(3)} s (seek before record / optional clip nudge)</li>
                  <li>Offset is a manual aid — not measured hardware input latency</li>
                </>
              ) : (
                <>
                  <li>YouTube sync is approximate wall-clock only — not sample-accurate</li>
                  <li>YouTube iframe audio is never routed into takes or exports</li>
                </>
              )}
              <li>
                Device output latency (reported):{' '}
                {typeof reportedLatencyMs === 'number' ? `${reportedLatencyMs.toFixed(1)} ms` : 'unavailable'}
              </li>
              <li>Mic monitoring uses track Monitor while transport plays; Live Auto-Tune latency is DSP-only</li>
            </ul>
          </section>

          <section className="karaoke-mic" aria-label="Microphone and recording">
            <h2>Vocal recording</h2>
            {engineDisconnected && (
              <p className="workflow-banner" data-karaoke-engine-error role="alert">Audio engine disconnected. Recording and export are unavailable until it reconnects.</p>
            )}
            {noMic && !engineDisconnected && (
              <p className="workflow-banner" data-karaoke-mic-error role="alert">No microphone input. Choose a device and Apply devices, or use the virtual test signal.</p>
            )}
            <label className="field">
              Microphone / input device
              <select
                aria-label="Karaoke input device"
                data-action="karaoke-input-device"
                value={props.inputDevice}
                disabled={recording || busy}
                onChange={(event) => props.onInputDevice(event.target.value)}
              >
                <option value="">No input</option>
                {(props.devices?.inputs ?? []).map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
            </label>
            <button type="button" data-action="karaoke-apply-devices" disabled={recording || busy} onClick={() => void props.onApplyDevices()}>Apply devices</button>
            <label className="field">
              Record from
              <select
                aria-label="Karaoke record from"
                data-action="karaoke-record-source"
                value={virtualInput ? 'virtual' : 'device'}
                disabled={recording || busy}
                onChange={(event) => void props.command('setVirtualInput', { enabled: event.target.value === 'virtual' })}
              >
                <option value="device">Audio device input{inputChannels ? ` (${inputChannels} ch)` : ' (none open)'}</option>
                <option value="virtual">Test signal (virtual)</option>
              </select>
            </label>
            <p className="path" title={props.state?.record?.folder ?? ''}>Folder: {props.state?.record?.folder ?? ''}</p>
            <button type="button" disabled={recording || busy} onClick={() => void props.onChooseRecordFolder()}>Choose folder</button>
            {karaokeTrack != null && (
              <div className="record-track" aria-label="Karaoke vocal track settings">
                <span className="record-name">● {karaokeTrack.name || karaokeTrack.id}{karaokeTrack.armed ? ' (armed)' : ''}</span>
                <button
                  type="button"
                  aria-pressed={karaokeTrack.armed}
                  data-action="karaoke-arm"
                  disabled={recording || busy}
                  onClick={() => void props.command('setTrackRecord', { trackId: karaokeTrack.id, armed: !karaokeTrack.armed })}
                >{karaokeTrack.armed ? 'Disarm' : 'Record Arm'}</button>
                <button
                  type="button"
                  aria-pressed={karaokeTrack.monitorInput}
                  data-action="karaoke-monitor"
                  disabled={busy}
                  onClick={() => void props.command('setTrackRecord', { trackId: karaokeTrack.id, monitor: !karaokeTrack.monitorInput })}
                >Monitor {karaokeTrack.monitorInput ? 'on' : 'off'}</button>
              </div>
            )}
            <div className="karaoke-actions">
              <button
                type="button"
                className={`record-button${recording ? ' on' : ''}`}
                data-action="karaoke-record-start"
                disabled={recording || busy || engineDisconnected || noMic}
                onClick={() => void startRecording()}
              >Record</button>
              <button
                type="button"
                data-action="karaoke-record-stop"
                disabled={!recording || busy}
                onClick={() => void stopRecording()}
              >Stop</button>
            </div>
          </section>

          <section className="karaoke-export" data-karaoke-export="1" aria-label="Export">
            <h2>Export</h2>
            <p className="hint" data-export-vocal-ready={vocalExportReady ? '1' : '0'}>
              Export Vocal WAV — copies the recorded take and writes a `.karaoke.json` sidecar. YouTube audio is never included.
            </p>
            <p className="hint" data-export-mix-ready={mixExportReady ? '1' : '0'}>
              Export Full Mix WAV — requires a local backing WAV on Karaoke Backing. Uses the mixer (volumes/FX). Never includes YouTube iframe audio.
            </p>
            <div className="karaoke-actions">
              <button type="button" data-action="karaoke-export-vocal" disabled={!vocalExportReady || busy} onClick={() => void exportVocal()}>Export Vocal WAV</button>
              <button type="button" data-action="karaoke-export-mix" disabled={busy || recording || engineDisconnected || !hasBackingClip} onClick={() => void exportMix()}>Export Full Mix WAV</button>
            </div>
            {!hasBackingClip && (
              <p className="workflow-banner" data-karaoke-no-backing role="status">
                No local backing file — Full Mix is unavailable. Export Vocal WAV only, or import an authorized backing WAV in Studio mode.
              </p>
            )}
          </section>

          <LiveAutoTunePanel />
        </aside>
      </div>
    </section>
  )
}
