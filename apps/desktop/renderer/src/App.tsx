import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react'
import { masterBusId, type AutomationInterpolation, type AutomationLaneState, type AutomationPointState, type BreathRegion, type ClipState, type DeviceList, type EffectTarget, type EngineState, type InputMeter, type LoudnessResultEvent, type RecordInputName, type RecordModeName, type RecordTake, type StripMeter, type TakeState, type TimingMarker, type TrackState } from '../../../../packages/shared/src/protocol'
import { automationParams, isAutomated, laneFor, type AutoParam } from './automation'
import { Mixer } from './Mixer'
import { publishMeters } from './meterStore'
import { publishSpectrum } from './spectrumStore'
import { LiveAutoTunePanel } from './LiveAutoTunePanel'
import { ClipStretchPanel } from './ClipStretchPanel'
import { CrossfadePanel } from './CrossfadePanel'
import { LoudnessPanel } from './LoudnessPanel'
import { type LoudnessTargetId } from './loudnessTargets'
import { RecordingWorkflowPanel } from './RecordingWorkflowPanel'
import { RecordingMixWorkflowPanel, type RecordingMixStep } from './RecordingMixWorkflowPanel'
import { LivePitchPanel } from './LivePitchPanel'
import { PitchPanel } from './PitchPanel'
import { KaraokePanel } from './KaraokePanel'
import { VocalPresetsPanel } from './VocalPresetsPanel'
import { VocalWorkflowPanel, type VocalWorkflowStage } from './VocalWorkflowPanel'
import { ProjectBar, RecoveryDialog, UnsavedDialog } from './ProjectBar'
import { isProjectMutatingOp, PROJECT_RESET_OPS, type RecentProjectEntry, type RecoverySnapshot } from './projectTypes'
import {
  DEFAULT_BEATS_PER_BAR,
  DEFAULT_TIMELINE_BPM,
  barDuration,
  beatDuration,
  centerScrollLeft,
  clampPixelsPerSecond,
  collectSnapTargets,
  fitPixelsPerSecond,
  gridSize,
  placeTime as placeTimeMath,
  scrollLeftForZoom,
  selectionKey
} from './timelineMath'
import { ShortcutPanel } from './ShortcutPanel'
import { MediaAssetsPanel } from './MediaAssetsPanel'
import { MissingMediaDialog, type MediaSearchCandidate } from './MissingMediaDialog'
import {
  collectMissingMedia,
  collectProjectMediaAssets,
  type MissingMediaItem,
  type ProjectMediaAsset
} from './mediaAssets'
import {
  findConflicts,
  labelForCommand,
  matchShortcut,
  mergeShortcuts,
  type KeyBinding,
  type ShortcutCommandId,
  type ShortcutOverrides
} from './shortcuts'

function isEngineDisconnectMessage(message: string | undefined | null): boolean {
  if (message == null || message.length === 0)
    return false
  return /audio engine is not running|EPIPE|write after end|engine disconnected|engine host/i.test(message)
}

function scrollPanel(selector: string): void {
  const el = document.querySelector(selector)
  if (el instanceof HTMLElement)
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
}

const defaultLaneHeight = 164
const takeLaneHeight = 56
const autoHeight = 96
const rulerHeight = 28
const autoPad = 10
const laneHeightMin = 96
const laneHeightMax = 280

// Editor rows: each track's clip (comp) lane, optional take lanes, optional automation; bus/master
// automation lanes come after the tracks when shown.
type Row =
  | { kind: 'track', key: string, track: TrackState, top: number, height: number }
  | { kind: 'take', key: string, track: TrackState, take: TakeState, top: number, height: number }
  | { kind: 'auto', key: string, target: EffectTarget, ownerId: string, owner: string, lanes: AutomationLaneState[], params: AutoParam[], param?: AutoParam, lane?: AutomationLaneState, top: number, height: number }

type AutoRow = Extract<Row, { kind: 'auto' }>
type TakeRow = Extract<Row, { kind: 'take' }>

interface AutoSelection {
  key: string
  param: string
  index: number
}

function takeSummary(take: RecordTake | null | undefined): string {
  if (take == null)
    return ''
  const files = take.takes.map((item) => `${fileName(item.path)} (${item.seconds.toFixed(2)} s${item.placed ? ', on the timeline' : ''})`)
  return [files.length > 0 ? `Recorded ${files.join(', ')}.` : 'Nothing was recorded.', ...take.warnings].join(' ')
}

interface PeakSet {
  min: number[]
  max: number[]
  start: number
  end: number
}

interface Selection {
  trackId: string
  clipId: string
}

type DragMode = 'move' | 'trim-left' | 'trim-right' | 'fade-in' | 'fade-out'

interface DragState {
  mode: DragMode
  trackId: string
  clipId: string
  origin: number
  current: number
}

function formatTime(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0
  const whole = Math.floor(safe)
  const minutes = Math.floor(whole / 60)
  const remain = whole % 60
  const tenth = Math.floor((safe - whole) * 10)
  return `${minutes}:${remain.toString().padStart(2, '0')}.${tenth}`
}

function gainText(gain: number): string {
  if (gain <= 0.0001)
    return '-inf dB'
  return `${(20 * Math.log10(gain)).toFixed(1)} dB`
}

function fileName(filePath: string): string {
  const parts = filePath.split(/[/\\]/)
  return parts[parts.length - 1] || 'Empty track'
}

function meterClass(peak: number): string {
  if (peak >= 1)
    return 'clip'
  if (peak >= 0.7)
    return 'hot'
  return ''
}

function clipsOf(track: TrackState | undefined): ClipState[] {
  return track?.clips ?? []
}

function takesOf(track: TrackState | undefined): TakeState[] {
  return track?.takes ?? []
}

function placeTime(
  seconds: number,
  snap: boolean,
  pixelsPerSecond: number,
  sampleRate: number,
  targets: number[] = []
): number {
  return placeTimeMath(seconds, snap, pixelsPerSecond, sampleRate, targets)
}

export function App() {
  const [state, setState] = useState<EngineState | null>(null)
  const [devices, setDevices] = useState<DeviceList | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [position, setPosition] = useState(0)
  const draggingSeek = useRef(false)
  const [peaks, setPeaks] = useState({ left: 0, right: 0 })
  const [view, setView] = useState<'editor' | 'mixer' | 'karaoke'>('editor')
  const [engineConnected, setEngineConnected] = useState(true)
  const [mixStep, setMixStep] = useState<RecordingMixStep>('prepare')
  const [inputMeter, setInputMeter] = useState<InputMeter | null>(null)
  const [effectMeters, setEffectMeters] = useState<Record<string, number>>({})
  const [outputDevice, setOutputDevice] = useState('')
  const [inputDevice, setInputDevice] = useState('')
  const [sampleRate, setSampleRate] = useState('48000')
  const [bufferSize, setBufferSize] = useState('512')
  const [exportRate, setExportRate] = useState('48000')
  const [lastExportPath, setLastExportPath] = useState<string | null>(null)
  const [loudnessReport, setLoudnessReport] = useState<LoudnessResultEvent | null>(null)
  const [loudnessAnalyzing, setLoudnessAnalyzing] = useState(false)
  const [loudnessProgress, setLoudnessProgress] = useState(0)
  const [loudnessTargetId, setLoudnessTargetId] = useState<LoudnessTargetId>('streaming')
  const [loudnessCustomLufs, setLoudnessCustomLufs] = useState(-14)
  const [pixelsPerSecond, setPixelsPerSecond] = useState(80)
  const [snap, setSnap] = useState(true)
  const [laneHeight, setLaneHeight] = useState(defaultLaneHeight)
  const [timelineBpm, setTimelineBpm] = useState(DEFAULT_TIMELINE_BPM)
  const [multiSelected, setMultiSelected] = useState<Selection[]>([])
  const [snapGuide, setSnapGuide] = useState<number | null>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, trackId: string, clipId: string } | null>(null)
  const [shortcutOverrides, setShortcutOverrides] = useState<ShortcutOverrides>({})
  const [shortcutPanelOpen, setShortcutPanelOpen] = useState(false)
  const [shortcutCapturing, setShortcutCapturing] = useState<ShortcutCommandId | null>(null)
  const [shortcutConflict, setShortcutConflict] = useState<string | null>(null)
  const [mediaPanelOpen, setMediaPanelOpen] = useState(false)
  const [missingDialogOpen, setMissingDialogOpen] = useState(false)
  const [missingItems, setMissingItems] = useState<MissingMediaItem[]>([])
  const [missingActiveKey, setMissingActiveKey] = useState<string | null>(null)
  const [mediaEnriched, setMediaEnriched] = useState<Record<string, { fileBytes?: number, availability?: string, error?: string, format?: string }>>({})
  const [mediaBusyKey, setMediaBusyKey] = useState<string | null>(null)
  const [mediaSearchBusy, setMediaSearchBusy] = useState(false)
  const [mediaSearchScanned, setMediaSearchScanned] = useState(0)
  const [mediaSearchFolder, setMediaSearchFolder] = useState<string | null>(null)
  const [mediaCandidates, setMediaCandidates] = useState<MediaSearchCandidate[]>([])
  const [mediaCandidateError, setMediaCandidateError] = useState<string | null>(null)
  const missingDialogGuard = useRef(false)
  const projectSwitchToken = useRef(0)
  const shortcutBusy = useRef(false)
  const shortcutPlatform = typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('mac') ? 'mac' : 'win'
  const activeShortcuts = useMemo(() => mergeShortcuts(shortcutOverrides), [shortcutOverrides])
  const [vocalStage, setVocalStage] = useState<VocalWorkflowStage>('record')
  const [timingEdit, setTimingEdit] = useState(false)
  const [pendingTiming, setPendingTiming] = useState<{ trackId: string, clipId: string, markerId: string, timeline: number } | null>(null)
  const [breathEdit, setBreathEdit] = useState(false)
  const [selectedBreath, setSelectedBreath] = useState<{ trackId: string, clipId: string, regionId: string } | null>(null)
  const [selected, setSelected] = useState<Selection | null>(null)
  const [scrollVersion, setScrollVersion] = useState(0)
  const clipboard = useRef<Selection | null>(null)
  const peakCache = useRef(new Map<string, PeakSet>())
  const [peakVersion, setPeakVersion] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const verticalRef = useRef<HTMLDivElement>(null)
  const [autoOpen, setAutoOpen] = useState<Record<string, boolean>>({})
  const [showBusLanes, setShowBusLanes] = useState(false)
  const [autoChoice, setAutoChoice] = useState<Record<string, string>>({})
  const [autoInterp, setAutoInterp] = useState<AutomationInterpolation>('linear')
  const [autoSelected, setAutoSelected] = useState<AutoSelection | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [projectPath, setProjectPath] = useState<string | null>(null)
  const [projectDirty, setProjectDirty] = useState(false)
  const dirtyGeneration = useRef(0)
  const savedGeneration = useRef(0)
  const saveInFlight = useRef(false)
  const autosaveBusy = useRef(false)
  const [autosaveBusyUi, setAutosaveBusyUi] = useState(false)
  const [autosaveEnabled, setAutosaveEnabled] = useState(true)
  const [autosaveIntervalMs, setAutosaveIntervalMs] = useState(120_000)
  const [lastAutosaveAt, setLastAutosaveAt] = useState<string | null>(null)
  const [recentProjects, setRecentProjects] = useState<RecentProjectEntry[]>([])
  const [recoveryOffer, setRecoveryOffer] = useState<RecoverySnapshot | null>(null)
  const [unsavedPrompt, setUnsavedPrompt] = useState<{ title: string, resolve: (choice: 'save' | 'dont-save' | 'cancel') => void } | null>(null)
  const projectPathRef = useRef<string | null>(null)
  const projectDirtyRef = useRef(false)
  const stateRef = useRef<EngineState | null>(null)
  const selectedSetRef = useRef<Selection[]>([])
  const timelineUiRef = useRef({ pixelsPerSecond: 80, snap: true, laneHeight: defaultLaneHeight, bpm: DEFAULT_TIMELINE_BPM, position: 0, arrangementEnd: 0 })
  projectPathRef.current = projectPath
  // Generation counters are the source of truth; keep the ref aligned for async/status reads.
  projectDirtyRef.current = dirtyGeneration.current !== savedGeneration.current
  stateRef.current = state
  const projectName = (state?.projectName != null && state.projectName.length > 0) ? state.projectName : 'Untitled'
  const projectId = (state?.projectId != null && state.projectId.length > 0) ? state.projectId : ''
  const tail = state?.renderTail ?? { enabled: true, maxSeconds: 10, thresholdDb: -90 }
  const tailLengths = [...new Set([2, 5, 10, 30, 60, tail.maxSeconds])].sort((a, b) => a - b)
  const tailFloors = [...new Set([-60, -80, -90, -100, -120, tail.thresholdDb])].sort((a, b) => b - a)

  async function refresh(): Promise<void> {
    let current: { ok: boolean, error?: string, result?: unknown }
    let listed: { ok: boolean, error?: string, result?: unknown }
    try {
      current = await window.studio.request('getState')
      listed = await window.studio.request('listDevices')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setEngineConnected(false)
      setError(isEngineDisconnectMessage(message) ? message : `Could not reach the audio engine: ${message}`)
      return
    }
    if (!current.ok) {
      if (isEngineDisconnectMessage(current.error))
        setEngineConnected(false)
      setError(current.error ?? 'Could not read the audio engine.')
    } else if (current.result != null) {
      setEngineConnected(true)
      const next = current.result as EngineState
      setState(next)
      if (!draggingSeek.current)
        setPosition(next.position)
      if (next.deviceError)
        setError(next.deviceError)
    }
    if (listed.ok && listed.result != null) {
      const next = listed.result as DeviceList
      setDevices(next)
      setOutputDevice((value) => value || next.current.outputDevice || next.outputs[0] || '')
      setInputDevice((value) => value || next.current.inputDevice || '')
      setSampleRate(String(next.current.sampleRate || next.sampleRates[0] || 48000))
      setBufferSize(String(next.current.bufferSize || next.bufferSizes[0] || 512))
      setExportRate(String(next.current.sampleRate || 48000))
    } else if (!listed.ok) {
      if (isEngineDisconnectMessage(listed.error))
        setEngineConnected(false)
      setError(listed.error ?? 'Could not list audio devices.')
    }
  }

  // GUI-check hook: main-process engine ops don't update React state until refresh.
  useEffect(() => {
    const host = window as Window & {
      __mspRefreshState?: () => Promise<void>
      __msp291?: {
        getStatus: () => {
          dirty: boolean
          path: string | null
          name: string
          projectId: string
          lastAutosaveAt: string | null
          autosaveEnabled: boolean
          autosaveBusy: boolean
          dirtyGeneration: number
          savedGeneration: number
        }
        forceAutosave: () => Promise<void>
        setDirty: (value: boolean) => void
        bumpDirty: () => void
      }
      __msp292?: {
        getStatus: () => {
          dirty: boolean
          dirtyGeneration: number
          pixelsPerSecond: number
          snap: boolean
          laneHeight: number
          bpm: number
          selectedCount: number
          selected: Selection | null
          position: number
          arrangementEnd: number
        }
        fitProject: () => void
        fitSelection: () => void
        centerPlayhead: () => void
        zoom: (next: number) => void
        setSnap: (value: boolean) => void
        setLaneHeight: (value: number) => void
        selectMany: (items: Selection[]) => void
        clearSelection: () => void
      }
    }
    host.__mspRefreshState = () => refresh()
    host.__msp291 = {
      getStatus: () => ({
        dirty: projectDirtyRef.current,
        path: projectPathRef.current,
        name: stateRef.current?.projectName ?? 'Untitled',
        projectId: stateRef.current?.projectId ?? '',
        lastAutosaveAt,
        autosaveEnabled,
        autosaveBusy: autosaveBusy.current,
        dirtyGeneration: dirtyGeneration.current,
        savedGeneration: savedGeneration.current
      }),
      forceAutosave: () => runAutosave(),
      setDirty: (value: boolean) => {
        if (value) {
          dirtyGeneration.current += 1
          projectDirtyRef.current = true
          setProjectDirty(true)
        } else {
          savedGeneration.current = dirtyGeneration.current
          projectDirtyRef.current = false
          setProjectDirty(false)
        }
      },
      bumpDirty: () => {
        dirtyGeneration.current += 1
        projectDirtyRef.current = true
        setProjectDirty(true)
      }
    }
    host.__msp292 = {
      getStatus: () => ({
        dirty: projectDirtyRef.current,
        dirtyGeneration: dirtyGeneration.current,
        pixelsPerSecond: timelineUiRef.current.pixelsPerSecond,
        snap: timelineUiRef.current.snap,
        laneHeight: timelineUiRef.current.laneHeight,
        bpm: timelineUiRef.current.bpm,
        selectedCount: selectedSetRef.current.length,
        selected: selectedSetRef.current[0] ?? null,
        position: timelineUiRef.current.position,
        arrangementEnd: timelineUiRef.current.arrangementEnd
      }),
      fitProject: () => fitProjectToViewport(),
      fitSelection: () => fitSelectionToViewport(),
      centerPlayhead: () => centerPlayheadInView(),
      zoom: (next: number) => zoomTimeline(next),
      setSnap: (value: boolean) => setSnap(value),
      setLaneHeight: (value: number) => setLaneHeight(Math.max(laneHeightMin, Math.min(laneHeightMax, value))),
      selectMany: (items: Selection[]) => applyClipSelection(items),
      clearSelection: () => clearClipSelection()
    }
    ;(host as Window & { __msp293?: unknown }).__msp293 = {
      getStatus: () => ({
        dirty: projectDirtyRef.current,
        dirtyGeneration: dirtyGeneration.current,
        panelOpen: shortcutPanelOpen,
        capturing: shortcutCapturing,
        overrideCount: Object.keys(shortcutOverrides).length,
        conflict: shortcutConflict,
        recording: stateRef.current?.record?.state === 'recording'
      }),
      openPanel: () => setShortcutPanelOpen(true),
      closePanel: () => { setShortcutPanelOpen(false); setShortcutCapturing(null) },
      run: (id: ShortcutCommandId) => runShortcutCommand(id),
      setOverride: (id: ShortcutCommandId, binding: KeyBinding): Promise<string | null> => persistShortcutOverride(id, binding),
      reset: async () => {
        const empty = await window.studio.resetShortcutOverrides()
        setShortcutOverrides(empty as ShortcutOverrides)
        setShortcutConflict(null)
      },
      match: (init: { key?: string, code?: string, ctrlKey?: boolean, metaKey?: boolean, shiftKey?: boolean, altKey?: boolean, repeat?: boolean }) => {
        const event = new KeyboardEvent('keydown', {
          key: init.key ?? '',
          code: init.code ?? '',
          ctrlKey: init.ctrlKey === true,
          metaKey: init.metaKey === true,
          shiftKey: init.shiftKey === true,
          altKey: init.altKey === true,
          bubbles: true
        })
        Object.defineProperty(event, 'repeat', { value: init.repeat === true })
        const hit = matchShortcut(event, mergeShortcuts(shortcutOverrides), {
          view: 'editor',
          typing: false,
          recording: stateRef.current?.record?.state === 'recording'
        })
        return hit?.id ?? null
      }
    }
    ;(host as Window & { __msp294?: unknown }).__msp294 = {
      getStatus: () => ({
        dirty: projectDirtyRef.current,
        dirtyGeneration: dirtyGeneration.current,
        mediaPanelOpen,
        missingDialogOpen,
        missingCount: collectMissingMedia(stateRef.current).length,
        assetCount: collectProjectMediaAssets(stateRef.current, projectPathRef.current).length,
        externalCount: collectProjectMediaAssets(stateRef.current, projectPathRef.current).filter((a) => a.external).length,
        projectPath: projectPathRef.current
      }),
      openMediaPanel: () => {
        setMediaPanelOpen(true)
        void refreshMediaEnrichment(collectProjectMediaAssets(stateRef.current, projectPathRef.current))
      },
      closeMediaPanel: () => setMediaPanelOpen(false),
      openMissingDialog: () => offerMissingMediaRecovery(stateRef.current),
      closeMissingDialog: () => {
        missingDialogGuard.current = false
        setMissingDialogOpen(false)
      },
      collectAssets: () => collectProjectMediaAssets(stateRef.current, projectPathRef.current),
      collectMissing: () => collectMissingMedia(stateRef.current)
    }
    ;(host as Window & { __msp295?: unknown }).__msp295 = {
      getStatus: () => ({
        dirty: projectDirtyRef.current,
        dirtyGeneration: dirtyGeneration.current,
        path: projectPathRef.current,
        name: stateRef.current?.projectName ?? 'Untitled',
        projectId: stateRef.current?.projectId ?? '',
        transport: stateRef.current?.transport ?? 'stopped',
        recording: stateRef.current?.record?.state === 'recording',
        selectedCount: selectedSetRef.current.length,
        missingDialogOpen,
        mediaPanelOpen,
        missingCount: collectMissingMedia(stateRef.current).length,
        switchToken: projectSwitchToken.current
      }),
      isMutatingOp: (op: string, payload?: Record<string, unknown>) => isProjectMutatingOp(op, payload),
      newProject: () => newProject(),
      openPath: (filePath: string) => openProjectAt(filePath),
      beginSwitch: (title: string) => beginProjectSwitch(title),
      resetUi: () => resetEphemeralProjectUi()
    }
    return () => {
      delete host.__mspRefreshState
      delete host.__msp291
      delete host.__msp292
      delete (host as Window & { __msp293?: unknown }).__msp293
      delete (host as Window & { __msp294?: unknown }).__msp294
      delete (host as Window & { __msp295?: unknown }).__msp295
    }
  })

  useEffect(() => {
    void (async () => {
      try {
        const recent = await window.studio.listRecentProjects()
        setRecentProjects(recent)
        const settings = await window.studio.getAutosaveSettings()
        setAutosaveEnabled(settings.enabled)
        setAutosaveIntervalMs(settings.intervalMs)
        const shortcuts = await window.studio.getShortcutOverrides()
        setShortcutOverrides(shortcuts as ShortcutOverrides)
        const recovery = await window.studio.listRecoverySnapshots()
        const first = recovery.find((item) => item.available) ?? recovery[0] ?? null
        if (first != null)
          setRecoveryOffer(first)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        setNotice(`Project services unavailable: ${message}`)
      }
    })()
  }, [])

  useEffect(() => {
    const unsubscribe = window.studio.onCloseRequest(() => {
      void (async () => {
        if (missingDialogGuard.current)
          dismissMissingMediaDialog()
        const ok = await confirmLeave('Quit Music Studio Pro?')
        window.studio.replyCloseRequest(ok)
      })()
    })
    return unsubscribe
  })

  useEffect(() => {
    if (!autosaveEnabled)
      return
    const timer = window.setInterval(() => { void runAutosave() }, autosaveIntervalMs)
    return () => window.clearInterval(timer)
  }, [autosaveEnabled, autosaveIntervalMs])

  useEffect(() => {
    const unsubscribe = window.studio.onEvent((event) => {
      if (event.event === 'error') {
        setError(event.message)
        return
      }
      if (event.event === 'ready' && event.message)
        setError(event.message)
      if (event.event === 'recordFinished') {
        const why = event.reason === 'device' ? 'Recording stopped because the audio device failed.' : 'Recording stopped at the maximum take length.'
        setNotice(`${why} ${takeSummary(event.take)}`)
        void refresh()
        return
      }
      if (event.event === 'loudnessProgress') {
        setLoudnessProgress(event.total > 0 ? event.done / event.total : 0)
        return
      }
      if (event.event === 'loudnessResult') {
        setLoudnessReport(event)
        setLoudnessAnalyzing(false)
        setLoudnessProgress(1)
        if (event.ok)
          setNotice('Loudness analysis finished for the exported mix.')
        else if (event.cancelled)
          setNotice('Loudness analysis cancelled.')
        else
          setError(event.error || 'Loudness analysis failed.')
        return
      }
      if (event.event === 'meter') {
        if (!draggingSeek.current)
          setPosition(event.position)
        setPeaks({ left: event.peakL, right: event.peakR })
        const next: Record<string, StripMeter> = {}
        for (const meter of event.tracks ?? [])
          next[`t:${meter.id ?? ''}`] = meter
        for (const meter of event.buses ?? [])
          next[`b:${meter.id ?? ''}`] = meter
        publishMeters(next, event.master)
        publishSpectrum(event.spectrum ?? null)
        setInputMeter(event.input ?? null)
        const reductions: Record<string, number> = {}
        for (const meter of event.effects ?? [])
          reductions[meter.id] = meter.reduction
        setEffectMeters(reductions)
        setState((current) => current == null ? current : {
          ...current,
          transport: event.transport,
          position: event.position,
          duration: event.duration,
          monitor: event.monitor,
          deviceOpen: event.deviceOpen,
          inputGainDb: event.input?.gainDb ?? current.inputGainDb,
          record: current.record == null || event.recording == null ? current.record : { ...current.record, state: event.recording ? 'recording' : 'idle' }
        })
      }
    })
    void refresh()
    return unsubscribe
  }, [])

  // Sends a command and applies the returned engine state. Returns that state ({} for commands
  // that return something else), or null when the engine rejected the command.
  function markDirtyFromExternalOp(op: string, payload: Record<string, unknown> = {}): void {
    if (!isProjectMutatingOp(op, payload))
      return
    dirtyGeneration.current += 1
    projectDirtyRef.current = true
    setProjectDirty(true)
  }

  async function commandState(op: string, payload: Record<string, unknown> = {}, timeoutMs = 10000): Promise<Partial<EngineState> | null> {
    const switchTokenAtStart = projectSwitchToken.current
    let response: { ok: boolean, error?: string, result?: unknown }
    try {
      response = await window.studio.request(op, payload, timeoutMs)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setEngineConnected(false)
      setError(isEngineDisconnectMessage(message) ? message : `The audio engine rejected the command: ${message}`)
      return null
    }
    if (switchTokenAtStart !== projectSwitchToken.current)
      return null
    if (!response.ok) {
      if (isEngineDisconnectMessage(response.error))
        setEngineConnected(false)
      setError(response.error ?? 'The audio engine rejected the command.')
      if (switchTokenAtStart === projectSwitchToken.current)
        await refresh()
      return null
    }
    if (switchTokenAtStart !== projectSwitchToken.current)
      return null
    setEngineConnected(true)
    setError(null)
    if (PROJECT_RESET_OPS.has(op)) {
      dirtyGeneration.current = 0
      savedGeneration.current = 0
      projectDirtyRef.current = false
      setProjectDirty(false)
    } else if (isProjectMutatingOp(op, payload)) {
      dirtyGeneration.current += 1
      projectDirtyRef.current = true
      setProjectDirty(true)
    }
    if (response.result != null && typeof response.result === 'object' && 'transport' in (response.result as object)) {
      const next = response.result as EngineState
      setState(next)
      if (!draggingSeek.current)
        setPosition(next.position)
      if (next.deviceError)
        setError(next.deviceError)
      return next
    }
    return {}
  }

  async function command(op: string, payload: Record<string, unknown> = {}, timeoutMs = 10000): Promise<boolean> {
    return (await commandState(op, payload, timeoutMs)) != null
  }

  function markManualSaveClean(generationAtStart: number): void {
    // Edits during an async save keep the dirty indicator until a later successful save.
    if (dirtyGeneration.current === generationAtStart) {
      savedGeneration.current = generationAtStart
      projectDirtyRef.current = false
      setProjectDirty(false)
    }
  }

  function dismissMissingMediaDialog(): void {
    missingDialogGuard.current = false
    setMissingDialogOpen(false)
    setMediaCandidates([])
    setMediaCandidateError(null)
  }

  function askUnsaved(title: string, options?: { ignoreRecoveryOffer?: boolean }): Promise<'save' | 'dont-save' | 'cancel'> {
    if (!projectDirtyRef.current)
      return Promise.resolve('dont-save')
    // Never stack on an existing unsaved prompt. Missing-media uses the guard ref so closing
    // the dialog in the same turn (before re-render) does not falsely cancel leave/quit.
    if (unsavedPrompt != null || missingDialogGuard.current)
      return Promise.resolve('cancel')
    if (recoveryOffer != null && options?.ignoreRecoveryOffer !== true)
      return Promise.resolve('cancel')
    return new Promise((resolve) => {
      setUnsavedPrompt({ title, resolve })
    })
  }

  async function persistToPath(filePath: string, nameHint?: string): Promise<boolean> {
    const generationAtStart = dirtyGeneration.current
    saveInFlight.current = true
    try {
      const stem = filePath.replace(/^.*[/\\]/, '').replace(/\.json$/i, '')
      const name = nameHint ?? (stem.length > 0 ? stem : projectName)
      const response = await window.studio.request('saveProject', { path: filePath, name }, 20000)
      if (!response.ok) {
        setError(response.error ?? 'The project could not be saved.')
        return false
      }
      const result = response.result as { projectId?: string, projectName?: string } | undefined
      setProjectPath(filePath)
      if (result?.projectName != null || name.length > 0) {
        setState((current) => current == null ? current : {
          ...current,
          projectName: result?.projectName ?? name,
          projectId: result?.projectId ?? current.projectId
        })
      }
      markManualSaveClean(generationAtStart)
      const id = result?.projectId ?? projectId
      const recent = await window.studio.rememberRecentProject({
        path: filePath,
        name: result?.projectName ?? name,
        projectId: id
      })
      setRecentProjects(recent)
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setError(`The project could not be saved: ${message}`)
      return false
    } finally {
      saveInFlight.current = false
    }
  }

  async function saveProjectAs(): Promise<boolean> {
    const filePath = await window.studio.pickSaveProject()
    if (filePath == null)
      return false
    // Never silently overwrite a different open project's path without an explicit Save As choice.
    return await persistToPath(filePath)
  }

  async function saveProject(): Promise<boolean> {
    if (projectPathRef.current != null)
      return await persistToPath(projectPathRef.current, projectName)
    return await saveProjectAs()
  }

  async function confirmLeave(title: string, options?: { ignoreRecoveryOffer?: boolean }): Promise<boolean> {
    const choice = await askUnsaved(title, options)
    if (choice === 'cancel')
      return false
    if (choice === 'dont-save')
      return true
    const saved = await saveProject()
    return saved
  }

  /** Clear ephemeral UI that must not leak across projects (selection, media recovery, menus). */
  function resetEphemeralProjectUi(): void {
    void window.studio.cancelMediaSearch()
    missingDialogGuard.current = false
    setMissingDialogOpen(false)
    setMissingItems([])
    setMissingActiveKey(null)
    setMediaCandidates([])
    setMediaCandidateError(null)
    setMediaSearchBusy(false)
    setMediaSearchFolder(null)
    setMediaSearchScanned(0)
    setMediaPanelOpen(false)
    setMediaBusyKey(null)
    setMediaEnriched({})
    setContextMenu(null)
    setSnapGuide(null)
    setPendingTiming(null)
    setSelectedBreath(null)
    clipboard.current = null
    clearClipSelection()
  }

  /**
   * Stop recording/playback before New/Open/Recover so engine project switches cannot fail
   * with "Stop recording first" and transport state cannot leak across projects.
   */
  async function stopTransportForProjectSwitch(): Promise<boolean> {
    const current = stateRef.current
    if (current?.record?.state === 'recording') {
      const stopped = await commandState('record', { action: 'stop' }, 30000)
      if (stopped == null) {
        setError('Stop recording before changing project. The take could not be finished.')
        return false
      }
    }
    if (stateRef.current?.transport === 'playing' || stateRef.current?.transport === 'paused') {
      await command('transport', { action: 'stop' })
    }
    return true
  }

  async function beginProjectSwitch(title: string): Promise<boolean> {
    if (recoveryOffer != null || unsavedPrompt != null)
      return false
    // Close stacked media recovery before unsaved prompt so dialogs never nest.
    if (missingDialogOpen || missingDialogGuard.current)
      dismissMissingMediaDialog()
    if (!(await stopTransportForProjectSwitch()))
      return false
    if (!(await confirmLeave(title)))
      return false
    resetEphemeralProjectUi()
    return true
  }

  async function newProject(): Promise<void> {
    if (!(await beginProjectSwitch('Create a new project?')))
      return
    const token = ++projectSwitchToken.current
    const next = await commandState('newProject', { name: 'Untitled' })
    if (token !== projectSwitchToken.current)
      return
    if (next == null)
      return
    setProjectPath(null)
    setLastAutosaveAt(null)
    setNotice(null)
    peakCache.current.clear()
    setPeakVersion((value) => value + 1)
    setPosition(0)
  }

  async function openProjectAt(filePath: string): Promise<boolean> {
    const token = ++projectSwitchToken.current
    const response = await window.studio.request('loadProject', { path: filePath }, 20000)
    if (token !== projectSwitchToken.current)
      return false
    if (!response.ok) {
      setError(response.error ?? 'The project could not be opened.')
      // Do not replace the active project on failure.
      return false
    }
    peakCache.current.clear()
    setPeakVersion((value) => value + 1)
    const payload = response.result as { state?: EngineState, warnings?: string[] } | EngineState | undefined
    const nested = payload != null && typeof payload === 'object' && 'state' in payload
      ? (payload as { state?: EngineState, warnings?: string[] })
      : null
    const loadedState = nested?.state ?? (payload as EngineState | undefined)
    if (token !== projectSwitchToken.current)
      return false
    dirtyGeneration.current = 0
    savedGeneration.current = 0
    projectDirtyRef.current = false
    setProjectDirty(false)
    setProjectPath(filePath)
    setLastAutosaveAt(null)
    setNotice(null)
    setPosition(0)
    if (loadedState != null)
      setState(loadedState)
    const warnings = nested?.warnings ?? []
    setError(warnings.length > 0 ? warnings.join(' ') : null)
    const recent = await window.studio.rememberRecentProject({
      path: filePath,
      name: loadedState?.projectName ?? filePath.replace(/^.*[/\\]/, '').replace(/\.json$/i, ''),
      projectId: loadedState?.projectId ?? ''
    })
    if (token !== projectSwitchToken.current)
      return false
    setRecentProjects(recent)
    await refresh()
    if (token !== projectSwitchToken.current)
      return false
    offerMissingMediaRecovery(loadedState ?? stateRef.current)
    return true
  }

  async function loadProject(): Promise<void> {
    if (!(await beginProjectSwitch('Open another project?')))
      return
    const filePath = await window.studio.pickOpenProject()
    if (filePath == null)
      return
    await openProjectAt(filePath)
  }

  async function openRecent(entry: RecentProjectEntry): Promise<void> {
    if (!entry.available) {
      setError(`Recent project is unavailable: ${entry.path}`)
      return
    }
    if (!(await beginProjectSwitch('Open another project?')))
      return
    const ok = await openProjectAt(entry.path)
    if (!ok) {
      const recent = await window.studio.removeRecentProject(entry.path)
      setRecentProjects(recent)
    }
  }

  async function runAutosave(): Promise<void> {
    if (!autosaveEnabled || autosaveBusy.current || saveInFlight.current)
      return
    if (!projectDirtyRef.current)
      return
    const current = stateRef.current
    if (current == null)
      return
    if (current.record?.state === 'recording')
      return
    const id = current.projectId
    if (id == null || id.length === 0)
      return
    autosaveBusy.current = true
    setAutosaveBusyUi(true)
    try {
      const prepared = await window.studio.prepareAutosave(id)
      const response = await window.studio.request('saveProject', {
        path: prepared.snapshotPath,
        name: current.projectName ?? 'Untitled'
      }, 20000)
      if (!response.ok) {
        setNotice(response.error ?? 'Autosave failed.')
        return
      }
      const committed = await window.studio.commitAutosave({
        projectId: id,
        projectName: current.projectName ?? 'Untitled',
        originalPath: projectPathRef.current,
        snapshotPath: prepared.snapshotPath,
        savedAt: prepared.savedAt
      })
      if (!committed.ok) {
        setNotice(committed.error ?? 'Autosave validation failed.')
        return
      }
      setLastAutosaveAt(committed.savedAt ?? prepared.savedAt)
      // Autosave must not clear dirty state.
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setNotice(`Autosave failed: ${message}`)
    } finally {
      autosaveBusy.current = false
      setAutosaveBusyUi(false)
    }
  }

  function offerMissingMediaRecovery(loaded: EngineState | null | undefined): void {
    if (loaded == null)
      return
    // Avoid stacking on recovery/unsaved dialogs or a second missing-media dialog.
    if (recoveryOffer != null || unsavedPrompt != null || missingDialogGuard.current)
      return
    const items = collectMissingMedia(loaded)
    if (items.length === 0)
      return
    missingDialogGuard.current = true
    setMissingItems(items)
    setMissingActiveKey(items[0]?.key ?? null)
    setMediaCandidates([])
    setMediaCandidateError(null)
    setMissingDialogOpen(true)
  }

  async function refreshMediaEnrichment(assets: ProjectMediaAsset[]): Promise<void> {
    const next: Record<string, { fileBytes?: number, availability?: string, error?: string, format?: string }> = {}
    for (const asset of assets) {
      if (!asset.path)
        continue
      try {
        const probe = await window.studio.probeMedia(asset.path)
        next[asset.key] = {
          fileBytes: probe.fileBytes,
          availability: probe.availability,
          error: probe.error,
          format: probe.format
        }
      } catch (error) {
        next[asset.key] = {
          availability: 'unverified',
          error: error instanceof Error ? error.message : String(error)
        }
      }
    }
    setMediaEnriched(next)
  }

  async function relinkMediaAsset(trackId: string, sourceFileId: string, filePath: string): Promise<boolean> {
    const ok = await command('relinkMedia', { trackId, sourceFileId, path: filePath }, 60000)
    if (!ok)
      return false
    setNotice(`Relinked ${filePath.replace(/^.*[/\\]/, '')}`)
    return true
  }

  async function locateAndRelink(asset: { key: string, trackId: string, sourceFileId: string }): Promise<void> {
    setMediaBusyKey(asset.key)
    try {
      const picked = await window.studio.pickWav()
      if (picked == null)
        return
      const probe = await window.studio.probeMedia(picked)
      if (!probe.ok) {
        setMediaCandidateError(probe.error ?? 'Selected file is not valid audio.')
        setError(probe.error ?? 'Selected file is not valid audio.')
        return
      }
      const ok = await relinkMediaAsset(asset.trackId, asset.sourceFileId, picked)
      if (ok) {
        setMissingItems((items) => items.map((item) => item.key === asset.key ? { ...item, status: 'relinked' } : item))
        setMediaCandidates([])
      }
    } finally {
      setMediaBusyKey(null)
    }
  }

  async function searchFolderForActiveMissing(): Promise<void> {
    const active = missingItems.find((item) => item.key === missingActiveKey) ?? missingItems[0]
    if (active == null)
      return
    const folder = await window.studio.pickFolder()
    if (folder == null)
      return
    setMediaSearchBusy(true)
    setMediaCandidateError(null)
    setMediaCandidates([])
    setMediaSearchScanned(0)
    setMediaSearchFolder(folder)
    const unsub = window.studio.onMediaSearchProgress((progress) => {
      setMediaSearchScanned(progress.scanned)
      setMediaSearchFolder(progress.folder)
      if (!progress.searching)
        setMediaSearchBusy(false)
    })
    try {
      const result = await window.studio.searchMedia({
        originalPath: active.originalPath,
        fileName: active.fileName,
        durationSeconds: active.durationSeconds > 0 ? active.durationSeconds : undefined,
        sampleRate: active.sampleRate > 0 ? active.sampleRate : undefined,
        channels: active.channels > 0 ? active.channels : undefined
      }, {
        projectFilePath: projectPathRef.current,
        folders: [folder],
        rememberFolder: true
      })
      if (result.cancelled) {
        setMediaCandidateError('Search cancelled.')
        return
      }
      const mapped: MediaSearchCandidate[] = result.candidates.map((c) => ({
        path: c.path,
        score: c.score,
        rank: c.rank,
        ambiguous: c.ambiguous,
        durationSeconds: typeof c.probe?.durationSeconds === 'number' ? c.probe.durationSeconds as number : undefined,
        sampleRate: typeof c.probe?.sampleRate === 'number' ? c.probe.sampleRate as number : undefined,
        channels: typeof c.probe?.channels === 'number' ? c.probe.channels as number : undefined,
        fileBytes: typeof c.probe?.fileBytes === 'number' ? c.probe.fileBytes as number : undefined
      }))
      setMediaCandidates(mapped)
      const auto = mapped.find((c) => !c.ambiguous && c.score >= 75)
      const strong = mapped.filter((c) => !c.ambiguous && c.score >= 75)
      if (strong.length === 1 && auto != null) {
        setNotice(`Found a unique match for ${active.fileName}. Confirm Relink to apply.`)
      } else if (mapped.length === 0) {
        setMediaCandidateError('No matching audio files found in that folder.')
      }
    } catch (error) {
      setMediaCandidateError(error instanceof Error ? error.message : String(error))
    } finally {
      unsub()
      setMediaSearchBusy(false)
    }
  }

  async function relinkFromCandidate(filePath: string): Promise<void> {
    const active = missingItems.find((item) => item.key === missingActiveKey) ?? missingItems[0]
    if (active == null)
      return
    setMediaBusyKey(active.key)
    try {
      const probe = await window.studio.probeMedia(filePath)
      if (!probe.ok) {
        setMediaCandidateError(probe.error ?? 'Candidate failed validation.')
        return
      }
      const ok = await relinkMediaAsset(active.trackId, active.sourceFileId, filePath)
      if (ok) {
        setMissingItems((items) => items.map((item) => item.key === active.key ? { ...item, status: 'relinked' } : item))
        setMediaCandidates([])
        const remaining = missingItems.filter((item) => item.key !== active.key && item.status === 'pending')
        if (remaining[0] != null)
          setMissingActiveKey(remaining[0].key)
      }
    } finally {
      setMediaBusyKey(null)
    }
  }

  async function relinkAllMissingByName(): Promise<void> {
    const pending = missingItems.filter((item) => item.status === 'pending')
    for (const item of pending) {
      setMissingActiveKey(item.key)
      const folder = item.originalPath ? item.originalPath.replace(/[/\\][^/\\]+$/, '') : null
      const folders = [
        ...(folder != null && folder.length > 0 ? [folder] : []),
        ...(projectPathRef.current != null ? [projectPathRef.current.replace(/[/\\][^/\\]+$/, '')] : [])
      ]
      setMediaSearchBusy(true)
      try {
        const result = await window.studio.searchMedia({
          originalPath: item.originalPath,
          fileName: item.fileName,
          durationSeconds: item.durationSeconds > 0 ? item.durationSeconds : undefined,
          sampleRate: item.sampleRate > 0 ? item.sampleRate : undefined,
          channels: item.channels > 0 ? item.channels : undefined
        }, {
          projectFilePath: projectPathRef.current,
          folders,
          rememberFolder: false
        })
        const strong = result.candidates.filter((c) => !c.ambiguous && c.score >= 75)
        if (strong.length !== 1) {
          setMediaCandidates(result.candidates.map((c) => ({
            path: c.path,
            score: c.score,
            rank: c.rank,
            ambiguous: c.ambiguous
          })))
          setMediaCandidateError(`Could not auto-relink ${item.fileName}: ${strong.length === 0 ? 'no unique match' : 'ambiguous matches'}.`)
          break
        }
        const ok = await relinkMediaAsset(item.trackId, item.sourceFileId, strong[0].path)
        if (ok) {
          setMissingItems((items) => items.map((row) => row.key === item.key ? { ...row, status: 'relinked' } : row))
        } else {
          break
        }
      } finally {
        setMediaSearchBusy(false)
      }
    }
  }

  async function recoverSnapshot(offer: RecoverySnapshot): Promise<void> {
    if (!offer.available) {
      setError(offer.error ?? 'That recovery snapshot is not available.')
      return
    }
    // Dismiss recovery dialog before unsaved prompt so dialogs never stack.
    setRecoveryOffer(null)
    if (!(await stopTransportForProjectSwitch())) {
      setRecoveryOffer(offer)
      return
    }
    if (!(await confirmLeave('Recover an autosave snapshot?', { ignoreRecoveryOffer: true }))) {
      setRecoveryOffer(offer)
      return
    }
    resetEphemeralProjectUi()
    const dest = await window.studio.pickSaveRecoveryCopy()
    if (dest == null) {
      setRecoveryOffer(offer)
      return
    }
    const copied = await window.studio.copyRecoveryWorkingCopy(offer.snapshotPath, dest)
    if (!copied.ok) {
      setError(copied.error ?? 'Could not create a recovery working copy.')
      setRecoveryOffer(offer)
      return
    }
    const ok = await openProjectAt(dest)
    if (!ok)
      setRecoveryOffer(offer)
  }

  async function discardSnapshot(offer: RecoverySnapshot): Promise<void> {
    await window.studio.discardRecovery(offer.projectId)
    setRecoveryOffer(null)
    setNotice('Recovery snapshot discarded.')
  }

  const duration = state?.duration ?? 0
  const rate = state?.sampleRate || 48000
  const trackOf = (id: string): TrackState | undefined => state?.tracks.find((track) => track.id === id)
  const selectedTrack = selected == null ? undefined : trackOf(selected.trackId)
  const selectedClip = clipsOf(selectedTrack).find((clip) => clip.id === selected?.clipId)
  const selectedSet = useMemo(() => {
    const map = new Map<string, Selection>()
    for (const item of multiSelected)
      map.set(selectionKey(item.trackId, item.clipId), item)
    if (selected != null)
      map.set(selectionKey(selected.trackId, selected.clipId), selected)
    return [...map.values()]
  }, [selected, multiSelected])
  selectedSetRef.current = selectedSet
  timelineUiRef.current = {
    pixelsPerSecond,
    snap,
    laneHeight,
    bpm: timelineBpm,
    position,
    arrangementEnd: timelineUiRef.current.arrangementEnd
  }

  function clearClipSelection(): void {
    selectedSetRef.current = []
    setSelected(null)
    setMultiSelected([])
    setContextMenu(null)
  }

  function selectClip(next: Selection | null, additive = false): void {
    setContextMenu(null)
    if (next == null) {
      clearClipSelection()
      return
    }
    if (!additive) {
      setSelected(next)
      setMultiSelected([next])
      return
    }
    const key = selectionKey(next.trackId, next.clipId)
    const exists = selectedSet.some((item) => selectionKey(item.trackId, item.clipId) === key)
    if (exists) {
      const remaining = selectedSet.filter((item) => selectionKey(item.trackId, item.clipId) !== key)
      setMultiSelected(remaining)
      setSelected(remaining[0] ?? null)
      return
    }
    setSelected(next)
    setMultiSelected([...selectedSet, next])
  }

  function applyClipSelection(items: Selection[]): void {
    setContextMenu(null)
    if (items.length === 0) {
      clearClipSelection()
      return
    }
    selectedSetRef.current = items
    setSelected(items[0]!)
    setMultiSelected(items)
  }

  function allClipEdges(excludeClipId?: string): number[] {
    const clips: Array<{ id: string, timelineStart: number, duration: number }> = []
    for (const track of state?.tracks ?? []) {
      for (const clip of clipsOf(track))
        clips.push({ id: clip.id, timelineStart: clip.timelineStart, duration: clip.duration })
    }
    return collectSnapTargets({ playhead: position, clips: [], clipIds: clips, excludeClipId })
  }

  function snapPlace(seconds: number, excludeClipId?: string): number {
    return placeTime(seconds, snap, pixelsPerSecond, rate, allClipEdges(excludeClipId))
  }

  useEffect(() => {
    if (selected == null)
      return
    if (selectedClip == null) {
      clearClipSelection()
      return
    }
    setMultiSelected((current) => current.filter((item) => {
      const track = trackOf(item.trackId)
      return clipsOf(track).some((clip) => clip.id === item.clipId)
    }))
  }, [selected, selectedClip, state?.tracks])

  const rows = useMemo(() => {
    const list: Row[] = []
    let top = 0
    const addAuto = (target: EffectTarget, ownerId: string, owner: string, lanes: AutomationLaneState[], params: AutoParam[]): void => {
      const key = `${target}:${ownerId}`
      const param = params.find((item) => item.param === autoChoice[key])
        ?? params.find((item) => isAutomated(lanes, item.param))
        ?? params.find((item) => laneFor(lanes, item.param) != null)
        ?? params[0]
      list.push({ kind: 'auto', key, target, ownerId, owner, lanes, params, param, lane: param == null ? undefined : laneFor(lanes, param.param), top, height: autoHeight })
      top += autoHeight
    }
    for (const track of state?.tracks ?? []) {
      list.push({ kind: 'track', key: `track:${track.id}`, track, top, height: laneHeight })
      top += laneHeight
      if (track.takesExpanded === true) {
        for (const take of takesOf(track)) {
          list.push({ kind: 'take', key: `take:${track.id}:${take.id}`, track, take, top, height: takeLaneHeight })
          top += takeLaneHeight
        }
      }
      if (autoOpen[track.id] === true)
        addAuto('track', track.id, track.name || track.id, track.automation ?? [], automationParams('track', track))
    }
    if (showBusLanes) {
      for (const bus of state?.buses ?? [])
        addAuto('bus', bus.id, bus.name, bus.automation ?? [], automationParams('bus', bus))
      addAuto('master', masterBusId, 'Master', state?.masterAutomation ?? [], automationParams('master', { gain: state?.masterGain ?? 1, effects: state?.masterEffects ?? [] }))
    }
    return list
  }, [state, autoOpen, showBusLanes, autoChoice, laneHeight])

  const autoTarget = (row: AutoRow): Record<string, unknown> => row.target === 'master'
    ? { target: 'master', param: row.param?.param }
    : { target: row.target, ownerId: row.ownerId, param: row.param?.param }

  async function addAutomationPoint(row: AutoRow, time: number, value: number): Promise<void> {
    if (row.param == null)
      return
    const next = await commandState('addAutomationPoint', { ...autoTarget(row), time, value, interpolation: autoInterp })
    if (next?.pointIndex != null)
      setAutoSelected({ key: row.key, param: row.param.param, index: next.pointIndex })
  }

  async function moveAutomationPoint(row: AutoRow, index: number, time: number, value: number, interpolation?: AutomationInterpolation): Promise<void> {
    if (row.param == null)
      return
    const next = await commandState('moveAutomationPoint', { ...autoTarget(row), index, time, value, ...(interpolation == null ? {} : { interpolation }) })
    if (next?.pointIndex != null)
      setAutoSelected({ key: row.key, param: row.param.param, index: next.pointIndex })
  }

  async function deleteAutomationPoint(row: AutoRow, index: number): Promise<void> {
    if (row.param == null)
      return
    setAutoSelected(null)
    await command('deleteAutomationPoint', { ...autoTarget(row), index })
  }

  const recording = state?.record?.state === 'recording'
  const armedTracks = (state?.tracks ?? []).filter((track) => track.armed)
  const masterAuto = isAutomated(state?.masterAutomation, 'volume')

  async function prepareTransportForRecord(): Promise<boolean> {
    const transport = state?.transport ?? 'stopped'
    // Engine rejects record start while playing; stop first so arrangement can back the take.
    if (transport === 'playing' || transport === 'paused') {
      const stopped = await command('transport', { action: 'stop' })
      if (!stopped)
        return false
    }
    return true
  }

  async function toggleRecording(): Promise<void> {
    if (recording) {
      const next = await commandState('record', { action: 'stop' }, 30000)
      if (next == null) {
        setError('Could not stop recording. Check that the audio engine is still connected.')
        return
      }
      const finished = (next as { take?: RecordTake }).take
      if (finished != null) {
        setNotice(takeSummary(finished))
        // Hand off to vocal edit without moving existing takes — expand lanes for recorded tracks.
        const trackIds = [...new Set((finished.takes ?? []).map((item) => item.trackId).filter(Boolean))]
        for (const trackId of trackIds)
          void command('setTakesExpanded', { trackId, expanded: true })
        const firstTrackId = trackIds[0]
        if (firstTrackId != null) {
          const track = (next.tracks ?? state?.tracks ?? []).find((item) => item.id === firstTrackId)
          const clip = track?.clips.at(-1) ?? track?.clips[0]
          if (clip != null)
            setSelected({ trackId: firstTrackId, clipId: clip.id })
        }
        setVocalStage('comp')
        setMixStep('edit')
        setTimingEdit(false)
        setBreathEdit(false)
      } else {
        setNotice('Recording stopped. No take was produced — earlier takes are unchanged.')
      }
      return
    }
    if (armedTracks.length === 0) {
      setError('Arm at least one track (R) before recording.')
      return
    }
    if (state == null || state.deviceOpen !== true) {
      setError('Audio engine/device is not ready. Apply devices and try again.')
      return
    }
    const virtual = state.record?.virtualInput?.enabled === true
    if (!virtual && (state.inputChannels ?? 0) <= 0) {
      setError('No microphone input is open. Choose an input device and Apply devices, or enable the virtual test signal.')
      return
    }
    setNotice(null)
    setError(null)
    const prepared = await prepareTransportForRecord()
    if (!prepared) {
      setError('Could not stop playback before recording.')
      return
    }
    const started = await command('record', { action: 'start' })
    if (started) {
      setMixStep('record')
      setVocalStage('record')
      setNotice(`Recording ${armedTracks.length} armed track${armedTracks.length === 1 ? '' : 's'} from the playhead — arrangement plays as backing. Earlier takes stay intact.`)
    }
  }

  async function reviewLastTake(): Promise<void> {
    if (state == null) {
      setError('The audio engine is disconnected.')
      return
    }
    if (recording) {
      setError('Stop recording before reviewing.')
      return
    }
    const start = state.record?.lastTake?.startSeconds
      ?? armedTracks.flatMap((t) => t.takes ?? []).at(-1)?.timelineStart
      ?? armedTracks.flatMap((t) => t.clips).at(-1)?.timelineStart
      ?? 0
    if (state.transport === 'playing')
      await command('transport', { action: 'stop' })
    const seeked = await command('transport', { action: 'seek', position: Math.max(0, start) })
    const played = seeked && await command('transport', { action: 'play' })
    if (!played) {
      setError('Could not start review playback.')
      return
    }
    setNotice(`Reviewing from ${formatTime(start)}. Use Stop when finished.`)
    setError(null)
  }

  async function retakeFromLastStart(): Promise<void> {
    if (recording) {
      setError('Stop the current recording before retaking.')
      return
    }
    if (armedTracks.length === 0) {
      setError('Arm a track before retaking.')
      return
    }
    const start = state?.record?.lastTake?.startSeconds ?? state?.position ?? 0
    setNotice(null)
    setError(null)
    await prepareTransportForRecord()
    const seeked = await command('transport', { action: 'seek', position: Math.max(0, start) })
    if (!seeked) {
      setError('Could not seek for retake.')
      return
    }
    const started = await command('record', { action: 'start' })
    if (started)
      setNotice(`Retake from ${formatTime(start)} — previous takes remain on the track.`)
  }

  async function chooseRecordFolder(): Promise<void> {
    const folder = await window.studio.pickFolder()
    if (folder != null)
      await command('setRecordFolder', { path: folder })
  }

  const arrangementEnd = useMemo(() => {
    let end = duration
    for (const track of state?.tracks ?? []) {
      for (const clip of clipsOf(track))
        end = Math.max(end, clip.timelineStart + clip.duration)
      for (const take of takesOf(track))
        end = Math.max(end, take.timelineStart + take.duration)
    }
    return end
  }, [state, duration])
  timelineUiRef.current.arrangementEnd = arrangementEnd

  function zoomTimeline(nextRaw: number, anchorTime = position): void {
    const next = clampPixelsPerSecond(nextRaw)
    const scroller = scrollRef.current
    const old = pixelsPerSecond
    if (scroller != null) {
      scroller.scrollLeft = scrollLeftForZoom({
        anchorTime,
        oldPixelsPerSecond: old,
        newPixelsPerSecond: next,
        oldScrollLeft: scroller.scrollLeft
      })
    }
    setPixelsPerSecond(next)
    setScrollVersion((value) => value + 1)
  }

  function fitProjectToViewport(): void {
    const width = scrollRef.current?.clientWidth ?? 800
    const end = Math.max(arrangementEnd, duration, 1)
    zoomTimeline(fitPixelsPerSecond(end, width, 1.5), 0)
    if (scrollRef.current != null)
      scrollRef.current.scrollLeft = 0
  }

  function fitSelectionToViewport(): void {
    const clips = selectedSet
      .map((item) => {
        const track = trackOf(item.trackId)
        return clipsOf(track).find((clip) => clip.id === item.clipId)
      })
      .filter((clip): clip is ClipState => clip != null)
    if (clips.length === 0) {
      fitProjectToViewport()
      return
    }
    const start = Math.min(...clips.map((clip) => clip.timelineStart))
    const end = Math.max(...clips.map((clip) => clip.timelineStart + clip.duration))
    const width = scrollRef.current?.clientWidth ?? 800
    const pps = fitPixelsPerSecond(end - start, width, 0.5)
    zoomTimeline(pps, start)
    if (scrollRef.current != null)
      scrollRef.current.scrollLeft = Math.max(0, start * pps - 24)
  }

  function centerPlayheadInView(): void {
    const width = scrollRef.current?.clientWidth ?? 800
    if (scrollRef.current != null)
      scrollRef.current.scrollLeft = centerScrollLeft(position, pixelsPerSecond, width)
    setScrollVersion((value) => value + 1)
  }

  const peakKey = useMemo(() => {
    const scroll = scrollRef.current?.scrollLeft ?? 0
    const viewStart = scroll / pixelsPerSecond
    const viewEnd = viewStart + 20
    return (state?.tracks ?? []).map((track) => {
      const clips = clipsOf(track).map((clip) => `${clip.id}:${clip.sourceFileId}:${clip.sourceOffset.toFixed(3)}:${clip.duration.toFixed(3)}:${clip.timelineStart.toFixed(3)}`).join(',')
      const takes = takesOf(track).map((take) => `${take.id}:${take.sourceFileId}:${take.timelineStart.toFixed(3)}:${take.duration.toFixed(3)}`).join(',')
      return `${track.id}:${track.duration}:${track.missing}:${clips}:${takes}:${viewStart.toFixed(1)}:${viewEnd.toFixed(1)}:${pixelsPerSecond}`
    }).join('|')
  }, [state, pixelsPerSecond, scrollVersion])

  useEffect(() => {
    if (state == null)
      return
    let cancelled = false
    const jobs: Array<{ key: string, trackId: string, sourceFileId: string, start: number, end: number, buckets: number }> = []
    const scroll = scrollRef.current?.scrollLeft ?? 0
    const viewStart = scroll / pixelsPerSecond
    const viewWidth = scrollRef.current?.clientWidth ?? 800
    const viewEnd = viewStart + viewWidth / pixelsPerSecond
    for (const track of state.tracks) {
      if (track.missing)
        continue
      const sources = new Map<string, number>()
      for (const clip of clipsOf(track))
        sources.set(clip.sourceFileId, Math.max(sources.get(clip.sourceFileId) ?? 0, clip.sourceOffset + clip.duration, track.duration))
      for (const take of takesOf(track))
        sources.set(take.sourceFileId, Math.max(sources.get(take.sourceFileId) ?? 0, take.duration, track.duration))
      for (const [sourceFileId, endRaw] of sources) {
        const end = Math.max(endRaw, 0.001)
        const overview = `${track.id}|${sourceFileId}|0|${end.toFixed(3)}|1024`
        if (!peakCache.current.has(overview))
          jobs.push({ key: overview, trackId: track.id, sourceFileId, start: 0, end, buckets: 1024 })
      }
      for (const clip of clipsOf(track)) {
        const clipEnd = clip.timelineStart + clip.duration
        if (clipEnd < viewStart || clip.timelineStart > viewEnd)
          continue
        const width = Math.max(8, clip.duration * pixelsPerSecond)
        const overviewEnd = Math.max(track.duration, clip.sourceOffset + clip.duration, 0.001)
        const overview = peakCache.current.get(`${track.id}|${clip.sourceFileId}|0|${overviewEnd.toFixed(3)}|1024`)
        const span = overview == null ? 1 : Math.max(0.001, overview.end - overview.start)
        const visibleBuckets = overview == null ? 0 : (clip.duration / span) * overview.max.length
        if (width > visibleBuckets * 2) {
          const start = clip.sourceOffset
          const end = clip.sourceOffset + clip.duration
          const buckets = Math.max(16, Math.min(512, Math.round(width)))
          const key = `${track.id}|${clip.sourceFileId}|${start.toFixed(4)}|${end.toFixed(4)}|${buckets}`
          if (!peakCache.current.has(key))
            jobs.push({ key, trackId: track.id, sourceFileId: clip.sourceFileId, start, end, buckets })
        }
      }
    }
    void (async () => {
      for (const job of jobs.slice(0, 8)) {
        if (cancelled || peakCache.current.has(job.key))
          continue
        const response = await window.studio.request('waveform', {
          trackId: job.trackId,
          sourceFileId: job.sourceFileId,
          start: job.start,
          end: job.end,
          buckets: job.buckets
        }, 20000)
        if (cancelled || !response.ok || response.result == null)
          continue
        const result = response.result as { min?: number[], max?: number[] }
        if (!Array.isArray(result.min) || !Array.isArray(result.max))
          continue
        peakCache.current.set(job.key, { min: result.min, max: result.max, start: job.start, end: job.end })
        setPeakVersion((value) => value + 1)
      }
    })()
    return () => { cancelled = true }
  }, [peakKey, state])

  function choosePeaks(trackId: string, sourceId: string, start: number, end: number): PeakSet | undefined {
    let best: PeakSet | undefined
    let bestScore = -1
    for (const [key, value] of peakCache.current) {
      if (!key.startsWith(`${trackId}|${sourceId}|`))
        continue
      if (value.start <= start + 1.0e-3 && value.end + 1.0e-3 >= end) {
        const score = value.max.length / Math.max(0.001, value.end - value.start)
        if (score > bestScore) {
          best = value
          bestScore = score
        }
      }
    }
    return best
  }

  async function importWav(trackId: string): Promise<void> {
    const filePath = await window.studio.pickWav()
    if (filePath == null)
      return
    const track = trackOf(trackId)
    if (track == null) {
      await command('importTrack', { trackId, path: filePath })
      return
    }
    const start = snapPlace(position)
    await command('importClip', { trackId, path: filePath, timelineStart: start })
  }

  async function importTakeWav(trackId: string): Promise<void> {
    const filePath = await window.studio.pickWav()
    if (filePath == null)
      return
    const start = snapPlace(position)
    await command('importTake', { trackId, path: filePath, timelineStart: start })
    await command('setTakesExpanded', { trackId, expanded: true })
  }

  async function applyDevices(): Promise<void> {
    const next = await commandState('configure', {
      outputDevice,
      inputDevice,
      sampleRate: Number(sampleRate),
      bufferSize: Number(bufferSize)
    })
    if (next != null) {
      peakCache.current.clear()
      setPeakVersion((value) => value + 1)
      if (typeof next.inputDevice === 'string')
        setInputDevice(next.inputDevice)
      if (typeof next.outputDevice === 'string' && next.outputDevice.length > 0)
        setOutputDevice(next.outputDevice)
      if (typeof next.sampleRate === 'number' && next.sampleRate > 0) {
        setSampleRate(String(next.sampleRate))
        setExportRate(String(next.sampleRate))
      }
      if (typeof next.bufferSize === 'number' && next.bufferSize > 0)
        setBufferSize(String(next.bufferSize))
      setMixStep('levels')
      await refresh()
    }
  }

  function exportReadiness(): { ready: boolean, reason: string } {
    if (!engineConnected || state == null)
      return { ready: false, reason: 'Audio engine is disconnected. Export is unavailable.' }
    if (state.deviceOpen !== true)
      return { ready: false, reason: 'Audio stream is closed. Apply devices before export.' }
    const previews = state.vocalWorkflow?.previews
    if (previews?.pitch || previews?.breath || previews?.preset)
      return { ready: false, reason: 'Cancel or Apply active vocal previews before export. Export uses committed audio only.' }
    const hasAudio = (state.tracks ?? []).some((track) => track.clips.length > 0 || (track.takes?.length ?? 0) > 0 || track.path.length > 0)
    if (!hasAudio)
      return { ready: false, reason: 'Nothing to export yet. Record or import audio first.' }
    return { ready: true, reason: 'Ready — Export WAV uses the existing mixer render path.' }
  }

  async function startLoudnessAnalysis(path: string): Promise<void> {
    setLoudnessAnalyzing(true)
    setLoudnessProgress(0)
    setError(null)
    let response: { ok: boolean, error?: string, result?: unknown }
    try {
      response = await window.studio.request('analyzeLoudness', { path }, 15000)
    } catch (error) {
      setLoudnessAnalyzing(false)
      const message = error instanceof Error ? error.message : String(error)
      setError(isEngineDisconnectMessage(message) ? message : `Loudness analysis failed to start: ${message}`)
      return
    }
    if (!response.ok) {
      setLoudnessAnalyzing(false)
      setError(response.error ?? 'Loudness analysis failed to start.')
      return
    }
    setNotice('Analyzing exported mix loudness…')
    setMixStep('export')
    window.setTimeout(() => scrollPanel('[data-panel="loudness-285"]'), 80)
  }

  async function exportWav(): Promise<void> {
    const gate = exportReadiness()
    if (!gate.ready) {
      setError(gate.reason)
      setMixStep('export')
      return
    }
    const filePath = await window.studio.pickExportWav()
    if (filePath == null)
      return
    const ok = await command('exportWav', { path: filePath, sampleRate: Number(exportRate) }, 120000)
    if (ok) {
      setLastExportPath(filePath)
      setNotice('Export finished. Starting loudness analysis of the rendered WAV.')
      setMixStep('export')
      await startLoudnessAnalysis(filePath)
    }
  }

  async function analyzeLastExport(): Promise<void> {
    if (lastExportPath == null) {
      setError('Export a mix first, then analyze loudness.')
      return
    }
    await startLoudnessAnalysis(lastExportPath)
  }

  async function analyzePickedWav(): Promise<void> {
    const filePath = await window.studio.pickWav()
    if (filePath == null)
      return
    setLastExportPath(filePath)
    await startLoudnessAnalysis(filePath)
  }

  async function cancelLoudness(): Promise<void> {
    await window.studio.request('cancelLoudnessAnalysis', {}).catch(() => undefined)
  }

  function openVocalStage(stage: VocalWorkflowStage): void {
    setVocalStage(stage)
    if (stage === 'mix') {
      setMixStep('mix')
      setView('mixer')
      return
    }
    setView('editor')
    if (stage === 'record') {
      setMixStep('record')
      window.setTimeout(() => scrollPanel('[data-panel="recording-workflow-271"]'), 50)
    } else if (stage === 'comp') {
      setMixStep('edit')
      const trackId = selected?.trackId ?? selectedTrack?.id ?? state?.tracks.find((t) => (t.takes?.length ?? 0) > 0)?.id
      if (trackId != null)
        void command('setTakesExpanded', { trackId, expanded: true })
      window.setTimeout(() => scrollPanel('[data-panel="vocal-comp"]'), 80)
    } else if (stage === 'timing') {
      setMixStep('edit')
    } else if (stage === 'breath') {
      setMixStep('edit')
      window.setTimeout(() => scrollPanel('[data-panel="breath-edit"]'), 80)
    } else if (stage === 'pitch') {
      setMixStep('edit')
      window.setTimeout(() => scrollPanel('[data-panel="pitch-correction"]'), 80)
    } else if (stage === 'presets') {
      setMixStep('edit')
      window.setTimeout(() => scrollPanel('[data-panel="vocal-presets"]'), 80)
    }
  }

  function openMixWorkflowStep(step: RecordingMixStep): void {
    setMixStep(step)
    if (step === 'mix') {
      setVocalStage('mix')
      setView('mixer')
      return
    }
    if (step === 'export') {
      setVocalStage('mix')
      setView('editor')
      window.setTimeout(() => scrollPanel('[data-devices-panel]'), 50)
      const gate = exportReadiness()
      if (!gate.ready)
        setError(gate.reason)
      else
        setNotice(gate.reason)
      return
    }
    setView('editor')
    if (step === 'prepare') {
      window.setTimeout(() => scrollPanel('[data-devices-panel]'), 50)
    } else if (step === 'levels' || step === 'monitor' || step === 'record' || step === 'review' || step === 'arm') {
      setVocalStage('record')
      window.setTimeout(() => scrollPanel('[data-panel="recording-workflow-271"]'), 50)
    } else if (step === 'edit') {
      setVocalStage('comp')
      const trackId = selected?.trackId ?? state?.tracks.find((t) => (t.takes?.length ?? 0) > 0)?.id
      if (trackId != null)
        void command('setTakesExpanded', { trackId, expanded: true })
      window.setTimeout(() => scrollPanel('[data-panel="vocal-comp"], [data-panel="vocal-workflow"]'), 80)
    }
  }

  async function openKaraokeVocalInStudio(): Promise<void> {
    // Prefer a fresh getState so tracks created outside the last React refresh are visible.
    const fresh = await commandState('getState')
    const tracks = fresh?.tracks ?? state?.tracks ?? []
    const track = tracks.find((item) => item.name === 'Karaoke Vocal')
    if (track == null) {
      setError('No Karaoke Vocal track yet. Record a take in Karaoke first.')
      return
    }
    setView('editor')
    const clip = track.clips.at(-1) ?? track.clips[0]
    if (clip != null)
      selectClip({ trackId: track.id, clipId: clip.id })
    void command('setTakesExpanded', { trackId: track.id, expanded: true })
    const stage = track.clips.length > 0 || (track.takes?.length ?? 0) > 0 ? 'comp' : 'record'
    setVocalStage(stage)
    setMixStep(stage === 'comp' ? 'edit' : 'record')
    setTimingEdit(false)
    setBreathEdit(false)
    setNotice('Opened Karaoke Vocal in the Editor. Original takes, comps, timing, breath, pitch, and presets stay on this track.')
    setError(null)
  }

  async function splitSelected(): Promise<void> {
    const targets = selectedSet
    for (const target of targets)
      await command('splitClip', { trackId: target.trackId, clipId: target.clipId, position })
  }

  async function deleteSelected(): Promise<void> {
    const targets = selectedSet
    if (targets.length === 0)
      return
    clearClipSelection()
    for (const target of targets)
      await command('deleteClip', { trackId: target.trackId, clipId: target.clipId })
  }

  function copySelected(): void {
    if (selected != null)
      clipboard.current = selected
  }

  async function pasteClip(): Promise<void> {
    const copied = clipboard.current
    if (copied == null)
      return
    const start = snapPlace(position)
    await command('duplicateClip', { trackId: copied.trackId, clipId: copied.clipId, timelineStart: start })
  }

  async function duplicateSelectedInPlace(): Promise<void> {
    const targets = selectedSet
    for (const target of targets) {
      const track = trackOf(target.trackId)
      const clip = clipsOf(track).find((item) => item.id === target.clipId)
      if (clip == null)
        continue
      await command('duplicateClip', {
        trackId: target.trackId,
        clipId: target.clipId,
        timelineStart: snapPlace(clip.timelineStart + clip.duration, target.clipId)
      })
    }
  }

  async function cutSelected(): Promise<void> {
    copySelected()
    await deleteSelected()
  }

  function selectAllClips(): void {
    const items: Selection[] = []
    for (const track of state?.tracks ?? []) {
      for (const clip of clipsOf(track))
        items.push({ trackId: track.id, clipId: clip.id })
    }
    applyClipSelection(items)
  }

  async function nudgeSelected(deltaSeconds: number): Promise<void> {
    const targets = selectedSet
    if (targets.length === 0)
      return
    for (const target of targets) {
      const track = trackOf(target.trackId)
      const clip = clipsOf(track).find((item) => item.id === target.clipId)
      if (clip == null)
        continue
      const nextStart = snapPlace(Math.max(0, clip.timelineStart + deltaSeconds), target.clipId)
      await command('moveClip', {
        trackId: target.trackId,
        clipId: target.clipId,
        timelineStart: nextStart
      })
    }
  }

  function navigateClip(direction: -1 | 1): void {
    const flat: Selection[] = []
    for (const track of state?.tracks ?? []) {
      for (const clip of clipsOf(track))
        flat.push({ trackId: track.id, clipId: clip.id })
    }
    if (flat.length === 0)
      return
    const currentKey = selected != null ? selectionKey(selected.trackId, selected.clipId) : null
    let index = flat.findIndex((item) => selectionKey(item.trackId, item.clipId) === currentKey)
    if (index < 0)
      index = direction > 0 ? -1 : 0
    const next = flat[(index + direction + flat.length) % flat.length]
    if (next != null)
      selectClip(next)
  }

  function seekBy(deltaSeconds: number): void {
    const next = Math.max(0, position + deltaSeconds)
    setPosition(next)
    void command('transport', { action: 'seek', position: next })
  }

  function returnToStart(): void {
    setPosition(0)
    void command('transport', { action: 'seek', position: 0 })
  }

  async function runShortcutCommand(id: ShortcutCommandId): Promise<void> {
    if (shortcutBusy.current)
      return
    shortcutBusy.current = true
    try {
      switch (id) {
        case 'project.new':
          await newProject()
          break
        case 'project.open':
          await loadProject()
          break
        case 'project.save':
          await saveProject()
          break
        case 'project.saveAs':
          await saveProjectAs()
          break
        case 'edit.undo':
          await command('undo')
          break
        case 'edit.redo':
          await command('redo')
          break
        case 'edit.cut':
          await cutSelected()
          break
        case 'edit.copy':
          copySelected()
          break
        case 'edit.paste':
          await pasteClip()
          break
        case 'edit.duplicate':
          await duplicateSelectedInPlace()
          break
        case 'edit.delete': {
          const row = autoSelected == null ? undefined : rows.find((item): item is AutoRow => item.kind === 'auto' && item.key === autoSelected.key)
          if (row != null && autoSelected != null && row.param?.param === autoSelected.param)
            await deleteAutomationPoint(row, autoSelected.index)
          else
            await deleteSelected()
          break
        }
        case 'edit.selectAll':
          selectAllClips()
          break
        case 'edit.deselect':
          clearClipSelection()
          setSnapGuide(null)
          setContextMenu(null)
          break
        case 'timeline.zoomIn':
          zoomTimeline(pixelsPerSecond * 1.25)
          break
        case 'timeline.zoomOut':
          zoomTimeline(pixelsPerSecond / 1.25)
          break
        case 'timeline.fitProject':
          fitProjectToViewport()
          break
        case 'timeline.fitSelection':
          fitSelectionToViewport()
          break
        case 'timeline.centerPlayhead':
          centerPlayheadInView()
          break
        case 'timeline.split':
          await splitSelected()
          break
        case 'timeline.toggleSnap':
          setSnap((value) => !value)
          break
        case 'timeline.nudgeLeft':
          await nudgeSelected(-(snap ? gridSize(pixelsPerSecond) : 0.1))
          break
        case 'timeline.nudgeRight':
          await nudgeSelected(snap ? gridSize(pixelsPerSecond) : 0.1)
          break
        case 'timeline.nudgeLeftFine':
          await nudgeSelected(-1 / Math.max(1, rate))
          break
        case 'timeline.nudgeRightFine':
          await nudgeSelected(1 / Math.max(1, rate))
          break
        case 'timeline.prevClip':
          navigateClip(-1)
          break
        case 'timeline.nextClip':
          navigateClip(1)
          break
        case 'transport.playPause':
          await command('transport', { action: state?.transport === 'playing' ? 'pause' : 'play' })
          break
        case 'transport.stop':
          await command('transport', { action: 'stop' })
          break
        case 'transport.record':
          await toggleRecording()
          break
        case 'transport.returnToStart':
          returnToStart()
          break
        case 'transport.seekBack':
          seekBy(-1)
          break
        case 'transport.seekForward':
          seekBy(1)
          break
      }
    } finally {
      shortcutBusy.current = false
    }
  }

  async function persistShortcutOverride(id: ShortcutCommandId, binding: KeyBinding): Promise<string | null> {
    const next = { ...shortcutOverrides, [id]: binding }
    const probe = mergeShortcuts(next)
    const conflicts = findConflicts(probe).filter((item) => item.a === id || item.b === id)
    if (conflicts.length > 0) {
      const message = `Conflict: ${conflicts[0]!.label}`
      setShortcutConflict(message)
      return message
    }
    setShortcutConflict(null)
    setShortcutOverrides(next)
    await window.studio.setShortcutOverrides(next)
    return null
  }

  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (shortcutPanelOpen)
        return
      if (recoveryOffer != null || unsavedPrompt != null || missingDialogOpen || mediaPanelOpen)
        return
      const target = event.target as HTMLElement | null
      const typing = target != null && (
        target.tagName === 'INPUT'
        || target.tagName === 'SELECT'
        || target.tagName === 'TEXTAREA'
        || target.isContentEditable
      )
      const hit = matchShortcut(event, activeShortcuts, {
        view,
        typing,
        recording: state?.record?.state === 'recording'
      })
      if (hit == null)
        return
      event.preventDefault()
      event.stopPropagation()
      void runShortcutCommand(hit.id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const mediaAssets = useMemo(() => collectProjectMediaAssets(state, projectPath), [state, projectPath])
  const missingMediaCount = mediaAssets.filter((a) => a.availability === 'missing' || a.availability === 'invalid' || a.availability === 'offline').length
  const externalMediaCount = mediaAssets.filter((a) => a.external).length
  const missingNotes = (state?.tracks ?? [])
    .filter((track) => track.missing || (track.error != null && track.error.length > 0))
    .map((track) => track.error || `Missing audio file: ${track.path}`)
  const banner = [error, notice, ...missingNotes].filter((item) => item != null && item.length > 0).join(' ')
  const contentWidth = Math.max(400, (arrangementEnd + 2) * pixelsPerSecond)
  const recordElapsed = recording ? Math.max(0, position - (state?.record?.startSeconds ?? 0)) : 0
  const virtualInput = state?.record?.virtualInput?.enabled === true

  return (
    <main className="app" style={{ '--lane-height': `${laneHeight}px`, '--auto-height': `${autoHeight}px`, '--ruler-height': `${rulerHeight}px` } as CSSProperties}>
      <header>
        <div>
          <p className="eyebrow">Phase 2.3</p>
          <h1>Music Studio Pro</h1>
        </div>
        <div className="view-toggle" role="group" aria-label="View">
          <button aria-pressed={view === 'editor'} data-view="editor" onClick={() => setView('editor')}>Editor</button>
          <button aria-pressed={view === 'mixer'} data-view="mixer" onClick={() => setView('mixer')}>Mixer</button>
          <button aria-pressed={view === 'karaoke'} data-view="karaoke" onClick={() => setView('karaoke')}>Karaoke</button>
        </div>
        <div className="meters" aria-label="Master peak meter">
          <div>Master {gainText(state?.masterGain ?? 1)} · {state?.deviceOpen ? 'device open' : 'device closed'}</div>
          <div className="meter"><span className={meterClass(peaks.left)} style={{ width: `${Math.min(100, peaks.left * 100)}%` }} /></div>
          <div className="meter"><span className={meterClass(peaks.right)} style={{ width: `${Math.min(100, peaks.right * 100)}%` }} /></div>
        </div>
      </header>

      {banner.length > 0 ? <div className="banner" role="alert">{banner}</div> : null}

      <ProjectBar
        projectName={projectName}
        projectPath={projectPath}
        dirty={projectDirty}
        autosaveEnabled={autosaveEnabled}
        autosaveBusy={autosaveBusyUi}
        lastAutosaveAt={lastAutosaveAt}
        recent={recentProjects}
        onNew={() => void newProject()}
        onOpen={() => void loadProject()}
        onSave={() => void saveProject()}
        onSaveAs={() => void saveProjectAs()}
        onOpenRecent={(entry) => void openRecent(entry)}
        onRemoveRecent={(entry) => { void window.studio.removeRecentProject(entry.path).then(setRecentProjects) }}
        onToggleAutosave={(enabled) => {
          setAutosaveEnabled(enabled)
          void window.studio.setAutosaveSettings({ enabled })
        }}
      />
      <div className="shortcut-entry">
        <button data-shortcut-action="open-panel" title="Keyboard shortcuts" onClick={() => setShortcutPanelOpen(true)}>Shortcuts</button>
        <button
          data-media-action="open-panel"
          title="Project media assets"
          onClick={() => {
            setMediaPanelOpen(true)
            void refreshMediaEnrichment(collectProjectMediaAssets(stateRef.current, projectPathRef.current))
          }}
        >
          Media{missingMediaCount > 0 ? ` (${missingMediaCount})` : ''}
        </button>
        {missingMediaCount > 0 && (
          <button
            data-media-action="open-missing"
            className="media-missing-badge"
            title="Recover missing media"
            onClick={() => {
              if (recoveryOffer != null || unsavedPrompt != null || missingDialogGuard.current)
                return
              offerMissingMediaRecovery(stateRef.current)
            }}
          >
            Missing media
          </button>
        )}
      </div>

      {recoveryOffer != null ? (
        <RecoveryDialog
          offer={recoveryOffer}
          onRecover={() => void recoverSnapshot(recoveryOffer)}
          onDiscard={() => void discardSnapshot(recoveryOffer)}
          onLater={() => setRecoveryOffer(null)}
        />
      ) : null}

      {unsavedPrompt != null ? (
        <UnsavedDialog
          title={unsavedPrompt.title}
          onSave={() => {
            const resolve = unsavedPrompt.resolve
            setUnsavedPrompt(null)
            resolve('save')
          }}
          onDontSave={() => {
            const resolve = unsavedPrompt.resolve
            setUnsavedPrompt(null)
            resolve('dont-save')
          }}
          onCancel={() => {
            const resolve = unsavedPrompt.resolve
            setUnsavedPrompt(null)
            resolve('cancel')
          }}
        />
      ) : null}

      <section className="panel transport">
        <button className="primary" disabled={recording} data-action="transport-play" onClick={() => void command('transport', { action: 'play' })}>Play</button>
        <button disabled={recording} data-action="transport-pause" title={recording ? 'Use Stop rec to end the take' : undefined} onClick={() => void command('transport', { action: 'pause' })}>Pause</button>
        <button disabled={recording} data-action="transport-stop" title={recording ? 'Use Stop rec to end the take' : undefined} onClick={() => void command('transport', { action: 'stop' })}>Stop</button>
        <button
          className={`record-button${recording ? ' on' : ''}`}
          data-action="transport-record"
          aria-pressed={recording}
          aria-label={recording ? 'Stop recording' : 'Record'}
          disabled={!recording && (armedTracks.length === 0 || state == null || (!virtualInput && (state.inputChannels ?? 0) <= 0))}
          title={recording
            ? 'Stop recording and place the take on the timeline'
            : armedTracks.length === 0
              ? 'Arm a track (R) to record'
              : (!virtualInput && (state?.inputChannels ?? 0) <= 0)
                ? 'No microphone — choose input or virtual test signal'
                : `Record ${armedTracks.length} armed track${armedTracks.length === 1 ? '' : 's'} from the playhead (arrangement plays as backing)`}
          onClick={() => void toggleRecording()}
        >{recording ? 'Stop rec' : 'Record'}</button>
        {recording ? <span className="rec-status" role="status">● REC {formatTime(recordElapsed)}{(state?.record?.droppedFrames ?? 0) > 0 ? ` · ${state?.record?.droppedFrames} frames dropped` : ''}</span> : null}
        <span className="time">{formatTime(position)} / {formatTime(duration)}</span>
        <input
          className="seek"
          type="range"
          min={0}
          max={Math.max(duration, 0.01)}
          step={1 / rate}
          value={Math.min(position, Math.max(duration, 0.01))}
          disabled={recording}
          aria-label="Seek"
          onPointerDown={() => { draggingSeek.current = true }}
          onChange={(event) => setPosition(Number(event.target.value))}
          onPointerUp={(event) => {
            draggingSeek.current = false
            void command('transport', { action: 'seek', position: Number((event.target as HTMLInputElement).value) })
          }}
        />
        <button disabled={state?.canUndo === false} onClick={() => void command('undo')}>Undo</button>
        <button disabled={state?.canRedo === false} onClick={() => void command('redo')}>Redo</button>
        <button disabled={selected == null} onClick={() => void splitSelected()}>Split</button>
        <button disabled={selected == null} onClick={() => void deleteSelected()}>Delete</button>
        <button disabled={selected == null} onClick={copySelected}>Copy</button>
        <button onClick={() => void pasteClip()}>Paste</button>
        <button aria-pressed={snap} data-timeline-action="snap" onClick={() => setSnap((value) => !value)}>Snap {snap ? 'on' : 'off'}</button>
        <button data-timeline-action="fit-project" title="Fit entire project to the viewport (Ctrl+F)" onClick={() => fitProjectToViewport()}>Fit project</button>
        <button data-timeline-action="fit-selection" title="Fit selection to the viewport (Ctrl+Shift+F)" disabled={selectedSet.length === 0} onClick={() => fitSelectionToViewport()}>Fit selection</button>
        <button data-timeline-action="center-playhead" title="Center playhead (Ctrl+Home)" onClick={() => centerPlayheadInView()}>Center playhead</button>
        <label className="field timeline-bpm" title="Display-only tempo for bar/beat ruler (not stored in the project)">
          Ruler BPM
          <input
            data-timeline-bpm
            type="number"
            min={40}
            max={300}
            step={1}
            value={timelineBpm}
            onChange={(event) => setTimelineBpm(Math.max(40, Math.min(300, Number(event.target.value) || DEFAULT_TIMELINE_BPM)))}
          />
        </label>
        <button data-timeline-action="lane-taller" title="Taller tracks" onClick={() => setLaneHeight((value) => Math.min(laneHeightMax, value + 24))}>Tracks +</button>
        <button data-timeline-action="lane-shorter" title="Shorter tracks" onClick={() => setLaneHeight((value) => Math.max(laneHeightMin, value - 24))}>Tracks −</button>
        <button
          className={timingEdit ? 'timing-on' : undefined}
          aria-pressed={timingEdit}
          data-mode="timing-edit"
          title="Timing Edit: analyze onsets and drag markers without moving the whole clip"
          onClick={() => {
            setTimingEdit((value) => !value)
            setPendingTiming(null)
            if (!timingEdit)
              setBreathEdit(false)
          }}
        >Timing Edit {timingEdit ? 'on' : 'off'}</button>
        <button
          disabled={!timingEdit || selected == null}
          data-action="analyze-onsets"
          onClick={() => {
            if (selected == null)
              return
            void command('analyzeOnsets', { trackId: selected.trackId, clipId: selected.clipId })
          }}
        >Analyze Onsets</button>
        <button
          disabled={pendingTiming == null}
          data-action="apply-timing"
          onClick={() => {
            if (pendingTiming == null)
              return
            void command('applyTimingAlign', pendingTiming).then(() => setPendingTiming(null))
          }}
        >Apply timing</button>
        <button
          disabled={pendingTiming == null}
          data-action="revert-timing-preview"
          onClick={() => setPendingTiming(null)}
        >Cancel preview</button>
        <button
          disabled={!timingEdit || selected == null || !(selectedClip?.timingOriginalSourceFileId)}
          data-action="revert-timing"
          onClick={() => {
            if (selected == null)
              return
            void command('revertTimingAlign', { trackId: selected.trackId, clipId: selected.clipId })
          }}
        >Revert timing</button>
        <button
          className={breathEdit ? 'breath-on' : undefined}
          aria-pressed={breathEdit}
          data-mode="breath-edit"
          title="Breath/Silence Edit: analyze candidates and adjust region gains without moving the clip"
          onClick={() => {
            setBreathEdit((value) => !value)
            setSelectedBreath(null)
            if (!breathEdit)
              setTimingEdit(false)
          }}
        >Breath Edit {breathEdit ? 'on' : 'off'}</button>
        <button
          disabled={!breathEdit || selected == null}
          data-action="analyze-breath"
          onClick={() => {
            if (selected == null)
              return
            void command('analyzeBreath', { trackId: selected.trackId, clipId: selected.clipId })
          }}
        >Analyze Breath</button>
        <button
          disabled={!breathEdit || selected == null}
          data-action="preview-breath"
          onClick={() => {
            if (selected == null)
              return
            void command('previewBreath', { trackId: selected.trackId, clipId: selected.clipId })
          }}
        >Preview breath</button>
        <button
          disabled={!breathEdit || selected == null}
          data-action="apply-breath"
          onClick={() => {
            if (selected == null)
              return
            void command('applyBreath', { trackId: selected.trackId, clipId: selected.clipId })
          }}
        >Apply breath</button>
        <button
          disabled={!breathEdit}
          data-action="cancel-breath-preview"
          onClick={() => void command('cancelBreathPreview', {
            trackId: selected?.trackId ?? '',
            clipId: selected?.clipId ?? ''
          })}
        >Cancel breath preview</button>
        <button
          disabled={!breathEdit || selected == null || !(selectedClip?.breathOriginalSourceFileId)}
          data-action="revert-breath"
          onClick={() => {
            if (selected == null)
              return
            void command('revertBreath', { trackId: selected.trackId, clipId: selected.clipId })
          }}
        >Revert breath</button>
        <button onClick={() => void command('addTrack', { name: '' })}>Add track</button>
        <button aria-pressed={showBusLanes} title="Show automation lanes for the buses and the master" onClick={() => setShowBusLanes((value) => !value)}>Bus lanes</button>
        <label className="field compact" title={masterAuto ? 'Master volume follows its automation lane. Turn the lane off to set it by hand.' : undefined}>
          <span className={masterAuto ? 'automated' : undefined}>{masterAuto ? 'Master auto' : 'Master'}</span>
          <input
            type="range"
            min={0}
            max={2}
            step={0.01}
            value={state?.masterGain ?? 1}
            disabled={masterAuto}
            aria-label="Master gain"
            onChange={(event) => {
              const gain = Number(event.target.value)
              setState((current) => current == null ? current : { ...current, masterGain: gain })
            }}
            onPointerUp={(event) => void command('setMaster', { gain: Number((event.target as HTMLInputElement).value) })}
          />
        </label>
      </section>

      <section className="panel devices" data-devices-panel>
        <label className="field">
          Output
          <select value={outputDevice} onChange={(event) => setOutputDevice(event.target.value)}>
            {(devices?.outputs ?? []).map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
        <label className="field">
          Input
          <select value={inputDevice} onChange={(event) => setInputDevice(event.target.value)} data-action="device-input">
            <option value="">No input</option>
            {(devices?.inputs ?? []).map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
        <label className="field">
          Sample rate
          <select value={sampleRate} onChange={(event) => setSampleRate(event.target.value)}>
            {(devices?.sampleRates ?? [44100, 48000, 96000]).map((value) => <option key={value} value={value}>{value} Hz</option>)}
          </select>
        </label>
        <label className="field">
          Buffer
          <select value={bufferSize} onChange={(event) => setBufferSize(event.target.value)}>
            {(devices?.bufferSizes ?? [128, 256, 512, 1024]).map((size) => <option key={size} value={size}>{size} samples</option>)}
          </select>
        </label>
        <button data-action="apply-devices" onClick={() => void applyDevices()}>Apply devices</button>
        <label className="monitor">
          <input
            type="checkbox"
            data-action="mic-monitor"
            checked={state?.monitor ?? false}
            onChange={(event) => void command('setMonitor', { enabled: event.target.checked })}
          />
          Mic monitor
        </label>
        <label className="field">
          Export rate
          <select value={exportRate} onChange={(event) => setExportRate(event.target.value)}>
            {[44100, 48000, 96000].map((value) => <option key={value} value={value}>{value} Hz</option>)}
          </select>
        </label>
        <label className="field" title="Reverb and delay tails after the last clip, for playback and export. The tail stops when the master stays below the floor, or at the maximum length.">
          Effect tail
          <select
            aria-label="Effect tail"
            value={tail.enabled ? String(tail.maxSeconds) : 'off'}
            onChange={(event) => void command('setRenderTail', event.target.value === 'off' ? { enabled: false } : { enabled: true, maxSeconds: Number(event.target.value) })}
          >
            <option value="off">Off</option>
            {tailLengths.map((seconds) => <option key={seconds} value={String(seconds)}>Up to {seconds} s</option>)}
          </select>
        </label>
        <label className="field">
          Tail floor
          <select aria-label="Tail floor" value={String(tail.thresholdDb)} disabled={!tail.enabled} onChange={(event) => void command('setRenderTail', { thresholdDb: Number(event.target.value) })}>
            {tailFloors.map((db) => <option key={db} value={String(db)}>{db} dBFS</option>)}
          </select>
        </label>
        <button
          data-action="export-wav"
          data-export-ready={exportReadiness().ready ? 'true' : 'false'}
          title={exportReadiness().reason}
          onClick={() => void exportWav()}
        >Export WAV</button>
        <button data-project-action="save-legacy" onClick={() => void saveProject()}>Save project</button>
        <button data-project-action="open-legacy" onClick={() => void loadProject()}>Load project</button>
      </section>

      <LoudnessPanel
        report={loudnessReport}
        analyzing={loudnessAnalyzing}
        progress={loudnessProgress}
        lastExportPath={lastExportPath}
        targetId={loudnessTargetId}
        customTargetLufs={loudnessCustomLufs}
        onTargetId={setLoudnessTargetId}
        onCustomTarget={setLoudnessCustomLufs}
        onAnalyze={() => void analyzeLastExport()}
        onCancel={() => void cancelLoudness()}
        onPickAndAnalyze={() => void analyzePickedWav()}
      />

      {view === 'mixer' ? (
        <Mixer
          state={state}
          effectMeters={effectMeters}
          command={command}
          exportReady={exportReadiness().ready}
          onBackToEditor={() => { setView('editor'); setMixStep('edit'); setVocalStage('presets') }}
          onExport={() => void exportWav()}
        />
      ) : view === 'karaoke' ? (
        <KaraokePanel
          state={state}
          devices={devices}
          inputDevice={inputDevice}
          outputDevice={outputDevice}
          sampleRate={sampleRate}
          bufferSize={bufferSize}
          onInputDevice={setInputDevice}
          command={command}
          commandState={commandState}
          onApplyDevices={applyDevices}
          onChooseRecordFolder={chooseRecordFolder}
          onNotice={setNotice}
          onError={setError}
          onOpenVocalInStudio={openKaraokeVocalInStudio}
        />
      ) : (
      <section className="workspace">
        <div className="editor">
        <div className="lanes-scroll" ref={verticalRef}>
          <div className="lane-column">
            <div className="ruler-gap" style={{ height: rulerHeight }} />
            {rows.map((row) => row.kind === 'track' ? (
              <TrackHeader
                key={row.key}
                track={row.track}
                automationOpen={autoOpen[row.track.id] === true}
                height={laneHeight}
                selected={selectedSet.some((item) => item.trackId === row.track.id)}
                onImport={() => void importWav(row.track.id)}
                onImportTake={() => void importTakeWav(row.track.id)}
                onRename={(name) => void command('renameTrack', { trackId: row.track.id, name })}
                onDuplicate={() => void command('duplicateTrack', { trackId: row.track.id })}
                onRemove={() => {
                  if (selected?.trackId === row.track.id)
                    clearClipSelection()
                  void command('removeTrack', { trackId: row.track.id })
                }}
                onChange={(payload) => void command('setTrack', { trackId: row.track.id, ...payload })}
                onArm={() => void command('setTrackRecord', { trackId: row.track.id, armed: !row.track.armed })}
                onMonitor={() => void command('setTrackRecord', { trackId: row.track.id, monitor: !row.track.monitorInput })}
                onToggleAutomation={() => setAutoOpen((open) => ({ ...open, [row.track.id]: !(open[row.track.id] === true) }))}
                onToggleTakes={() => void command('setTakesExpanded', { trackId: row.track.id, expanded: !(row.track.takesExpanded === true) })}
              />
            ) : row.kind === 'take' ? (
              <TakeHeader
                key={row.key}
                track={row.track}
                take={row.take}
                onRename={(name) => void command('renameTake', { trackId: row.track.id, takeId: row.take.id, name })}
                onMute={() => void command('setTakeMuted', { trackId: row.track.id, takeId: row.take.id, muted: !row.take.muted })}
                onRemove={() => void command('removeTake', { trackId: row.track.id, takeId: row.take.id })}
              />
            ) : (
              <AutomationHeader
                key={row.key}
                row={row}
                interpolation={autoInterp}
                selectedIndex={autoSelected != null && autoSelected.key === row.key && autoSelected.param === row.param?.param ? autoSelected.index : -1}
                onChoose={(param) => {
                  setAutoChoice((choice) => ({ ...choice, [row.key]: param }))
                  setAutoSelected(null)
                }}
                onInterpolation={(value) => {
                  setAutoInterp(value)
                  const index = autoSelected != null && autoSelected.key === row.key && autoSelected.param === row.param?.param ? autoSelected.index : -1
                  const point = row.lane?.points[index]
                  if (point != null)
                    void moveAutomationPoint(row, index, point.time, point.value, value)
                }}
                onEnable={(enabled) => void command('setAutomation', { ...autoTarget(row), enabled })}
                onEditPoint={(index, time, value) => void moveAutomationPoint(row, index, placeTime(time, false, pixelsPerSecond, rate), value)}
                onClear={() => {
                  setAutoSelected(null)
                  void command('removeAutomation', autoTarget(row))
                }}
              />
            ))}
          </div>
          <Timeline
          rows={rows}
          autoSelected={autoSelected}
          onAutoSelect={setAutoSelected}
          onAutoAdd={(row, time, value) => void addAutomationPoint(row, snapPlace(time), value)}
          onAutoMove={(row, index, time, value) => void moveAutomationPoint(row, index, snapPlace(time), value)}
          onAutoDelete={(row, index) => void deleteAutomationPoint(row, index)}
          verticalRef={verticalRef}
          position={position}
          pixelsPerSecond={pixelsPerSecond}
          sampleRate={rate}
          snap={snap}
          selected={selected}
          selectedSet={selectedSet}
          laneHeight={laneHeight}
          bpm={timelineBpm}
          beatsPerBar={DEFAULT_BEATS_PER_BAR}
          snapGuide={snapGuide}
          contentWidth={contentWidth}
          scrollRef={scrollRef}
          scrollVersion={scrollVersion}
          peakVersion={peakVersion}
          choosePeaks={choosePeaks}
          onSelect={(next, additive) => selectClip(next, additive === true)}
          onSelectMany={applyClipSelection}
          onContextClip={(menu) => setContextMenu(menu)}
          onSnapGuide={setSnapGuide}
          onZoomAt={(next, anchorTime) => zoomTimeline(next, anchorTime)}
          onSeek={(time) => {
            setPosition(time)
            void command('transport', { action: 'seek', position: time })
          }}
          onCommit={(edit) => {
            const track = trackOf(edit.trackId)
            const clip = clipsOf(track).find((item) => item.id === edit.clipId)
            if (clip == null)
              return
            if (edit.mode === 'move') {
              const delta = edit.current - edit.origin
              const primaryStart = snapPlace(clip.timelineStart + delta, edit.clipId)
              const appliedDelta = primaryStart - clip.timelineStart
              const moving = selectedSet.some((item) => item.trackId === edit.trackId && item.clipId === edit.clipId)
                ? selectedSet
                : [{ trackId: edit.trackId, clipId: edit.clipId }]
              void (async () => {
                for (const item of moving) {
                  const itemTrack = trackOf(item.trackId)
                  const itemClip = clipsOf(itemTrack).find((c) => c.id === item.clipId)
                  if (itemClip == null)
                    continue
                  const start = item.clipId === edit.clipId
                    ? primaryStart
                    : snapPlace(itemClip.timelineStart + appliedDelta, item.clipId)
                  await command('moveClip', { trackId: item.trackId, clipId: item.clipId, timelineStart: start })
                }
              })()
            } else if (edit.mode === 'trim-left' || edit.mode === 'trim-right') {
              void command('trimClip', {
                trackId: edit.trackId,
                clipId: edit.clipId,
                edge: edit.mode === 'trim-left' ? 'left' : 'right',
                position: snapPlace(edit.current, edit.clipId)
              })
            } else if (edit.mode === 'fade-in') {
              const fadeIn = Math.min(clip.duration, Math.max(0, edit.current - clip.timelineStart))
              void command('setClipFades', { trackId: edit.trackId, clipId: edit.clipId, fadeIn, fadeOut: clip.fadeOut })
            } else {
              const fadeOut = Math.min(clip.duration, Math.max(0, clip.timelineStart + clip.duration - edit.current))
              void command('setClipFades', { trackId: edit.trackId, clipId: edit.clipId, fadeIn: clip.fadeIn, fadeOut })
            }
            setSnapGuide(null)
          }}
          onCompRegion={(trackId, takeId, timelineStart, timelineEnd) => {
            void command('setCompRegion', {
              trackId,
              takeId,
              timelineStart: snapPlace(timelineStart),
              timelineEnd: snapPlace(timelineEnd)
            })
          }}
          timingEdit={timingEdit}
          pendingTiming={pendingTiming}
          onTimingPreview={(trackId, clipId, markerId, timeline) => {
            setPendingTiming({
              trackId,
              clipId,
              markerId,
              timeline: snapPlace(timeline)
            })
          }}
          onAddTimingMarker={(trackId, clipId, timeline) => {
            void command('addTimingMarker', { trackId, clipId, timeline: snapPlace(timeline) })
          }}
          breathEdit={breathEdit}
          selectedBreath={selectedBreath}
          onSelectBreath={setSelectedBreath}
          onAddBreathRegion={(trackId, clipId, timelineStart, timelineEnd) => {
            void command('addBreathRegion', {
              trackId,
              clipId,
              timelineStart: snapPlace(timelineStart),
              timelineEnd: snapPlace(timelineEnd),
              gainDb: -6
            })
          }}
          onSetBreathRegion={(trackId, clipId, regionId, patch) => {
            void command('setBreathRegion', { trackId, clipId, regionId, ...patch })
          }}
          />
        </div>
        <div className="xscroll-row">
          <div className="timeline-scroll" ref={scrollRef} onScroll={() => setScrollVersion((value) => value + 1)}>
            <div style={{ width: contentWidth, height: 1 }} />
          </div>
        </div>
        </div>
        <aside className="panel inspector">
          <RecordingMixWorkflowPanel
            active={mixStep}
            recording={recording}
            armed={armedTracks.length > 0}
            deviceOpen={state?.deviceOpen === true}
            hasTake={state?.record?.lastTake != null || (state?.tracks ?? []).some((t) => (t.takes?.length ?? 0) > 0 || t.clips.length > 0)}
            exportReady={exportReadiness().ready}
            engineConnected={engineConnected}
            onStep={openMixWorkflowStep}
          />
          <VocalWorkflowPanel
            state={state}
            selectedTrackId={selected?.trackId ?? selectedTrack?.id ?? state?.tracks[0]?.id ?? null}
            selectedClipId={selected?.clipId ?? null}
            timingEdit={timingEdit}
            breathEdit={breathEdit}
            currentStage={vocalStage}
            onStage={openVocalStage}
            onTimingEdit={setTimingEdit}
            onBreathEdit={setBreathEdit}
          />
          {(() => {
            const vocalTrack = (selectedTrack != null && takesOf(selectedTrack).length > 0)
              ? selectedTrack
              : (state?.tracks ?? []).find((track) => track.takesExpanded === true && takesOf(track).length > 0)
            if (vocalTrack == null)
              return null
            return (
            <div className="comp-settings" data-panel="vocal-comp">
              <h2>Vocal Comp</h2>
              <p className="hint">{takesOf(vocalTrack).length} take{takesOf(vocalTrack).length === 1 ? '' : 's'} · drag a take lane to promote a region</p>
              <label className="field">
                Crossfade {(vocalTrack.compCrossfadeMs ?? 5).toFixed(1)} ms
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={0.5}
                  value={vocalTrack.compCrossfadeMs ?? 5}
                  aria-label="Comp crossfade milliseconds"
                  onChange={(event) => {
                    const ms = Number(event.target.value)
                    setState((current) => current == null ? current : {
                      ...current,
                      tracks: current.tracks.map((track) => track.id !== vocalTrack.id ? track : { ...track, compCrossfadeMs: ms })
                    })
                  }}
                  onPointerUp={(event) => void command('setCompCrossfade', { trackId: vocalTrack.id, ms: Number(event.currentTarget.value) })}
                />
              </label>
            </div>
            )
          })()}
          <h2>Clip</h2>
          {selectedClip == null || selected == null ? <p className="hint">Select a clip on the timeline.</p> : (
            <>
              <p className="path">{fileName(selectedTrack?.path ?? '')}</p>
              <p className="hint">Start {selectedClip.timelineStart.toFixed(3)} s · length {selectedClip.duration.toFixed(3)} s · offset {selectedClip.sourceOffset.toFixed(3)} s</p>
              <label className="field">
                Clip gain {gainText(selectedClip.gain)}
                <input
                  type="range"
                  min={0}
                  max={2}
                  step={0.01}
                  value={selectedClip.gain}
                  aria-label="Clip gain"
                  onChange={(event) => {
                    const gain = Number(event.target.value)
                    setState((current) => current == null ? current : {
                      ...current,
                      tracks: current.tracks.map((track) => track.id !== selected.trackId ? track : {
                        ...track,
                        clips: clipsOf(track).map((clip) => clip.id === selected.clipId ? { ...clip, gain } : clip)
                      })
                    })
                  }}
                  onPointerUp={(event) => void command('setClipGain', { trackId: selected.trackId, clipId: selected.clipId, gain: Number((event.target as HTMLInputElement).value) })}
                />
              </label>
              <label className="field">
                Fade in seconds
                <input
                  type="number"
                  min={0}
                  max={selectedClip.duration}
                  step={0.01}
                  value={selectedClip.fadeIn}
                  aria-label="Fade in"
                  onChange={(event) => void command('setClipFades', {
                    trackId: selected.trackId,
                    clipId: selected.clipId,
                    fadeIn: Number(event.target.value),
                    fadeOut: selectedClip.fadeOut
                  })}
                />
              </label>
              <label className="field">
                Fade out seconds
                <input
                  type="number"
                  min={0}
                  max={selectedClip.duration}
                  step={0.01}
                  value={selectedClip.fadeOut}
                  aria-label="Fade out"
                  onChange={(event) => void command('setClipFades', {
                    trackId: selected.trackId,
                    clipId: selected.clipId,
                    fadeIn: selectedClip.fadeIn,
                    fadeOut: Number(event.target.value)
                  })}
                />
              </label>
              {breathEdit && (
                <div className="breath-settings" data-panel="breath-edit">
                  <h3>Breath / Silence</h3>
                  <p className="hint">Candidates are suggestions. Ignore false positives before Apply.</p>
                  {(() => {
                    const region = (selectedClip.breathRegions ?? []).find((item) => item.id === selectedBreath?.regionId)
                    if (region == null)
                      return <p className="hint">Select a highlighted region, or double-click the clip to add one.</p>
                    return (
                      <>
                        <p className="hint">{region.kind} · confidence {(region.confidence * 100).toFixed(0)}%{region.ignored ? ' · ignored' : ''}</p>
                        <label className="field">
                          Region gain {region.gainDb.toFixed(1)} dB
                          <input
                            type="range"
                            min={-60}
                            max={12}
                            step={0.5}
                            value={region.gainDb}
                            aria-label="Breath region gain"
                            onChange={(event) => {
                              const gainDb = Number(event.target.value)
                              setState((current) => current == null ? current : {
                                ...current,
                                tracks: current.tracks.map((track) => track.id !== selected.trackId ? track : {
                                  ...track,
                                  clips: clipsOf(track).map((clip) => clip.id !== selected.clipId ? clip : {
                                    ...clip,
                                    breathRegions: (clip.breathRegions ?? []).map((item) => item.id === region.id ? { ...item, gainDb } : item)
                                  })
                                })
                              })
                            }}
                            onPointerUp={(event) => void command('setBreathRegion', {
                              trackId: selected.trackId,
                              clipId: selected.clipId,
                              regionId: region.id,
                              gainDb: Number((event.target as HTMLInputElement).value)
                            })}
                          />
                        </label>
                        <label className="field">
                          Fade in (s)
                          <input
                            type="number"
                            min={0}
                            step={0.001}
                            value={region.fadeIn}
                            aria-label="Breath fade in"
                            onChange={(event) => void command('setBreathRegion', {
                              trackId: selected.trackId,
                              clipId: selected.clipId,
                              regionId: region.id,
                              fadeIn: Number(event.target.value)
                            })}
                          />
                        </label>
                        <label className="field">
                          Fade out (s)
                          <input
                            type="number"
                            min={0}
                            step={0.001}
                            value={region.fadeOut}
                            aria-label="Breath fade out"
                            onChange={(event) => void command('setBreathRegion', {
                              trackId: selected.trackId,
                              clipId: selected.clipId,
                              regionId: region.id,
                              fadeOut: Number(event.target.value)
                            })}
                          />
                        </label>
                        <button
                          data-action="ignore-breath"
                          onClick={() => void command('ignoreBreathRegion', {
                            trackId: selected.trackId,
                            clipId: selected.clipId,
                            regionId: region.id,
                            ignored: !region.ignored
                          })}
                        >{region.ignored ? 'Unignore' : 'Ignore'} region</button>
                        <button
                          data-action="remove-breath"
                          onClick={() => {
                            void command('removeBreathRegion', {
                              trackId: selected.trackId,
                              clipId: selected.clipId,
                              regionId: region.id
                            })
                            setSelectedBreath(null)
                          }}
                        >Delete region</button>
                      </>
                    )
                  })()}
                </div>
              )}
            </>
          )}
          <ClipStretchPanel
            state={state}
            trackId={selected?.trackId ?? selectedTrack?.id ?? null}
            clip={selectedClip ?? null}
            command={command}
            onNotice={setNotice}
            onError={setError}
          />
          <CrossfadePanel
            state={state}
            trackId={selected?.trackId ?? selectedTrack?.id ?? null}
            clip={selectedClip ?? null}
            command={command}
            onNotice={setNotice}
            onError={setError}
          />
          <VocalPresetsPanel
            tracks={state?.tracks ?? []}
            selectedTrackId={selected?.trackId ?? selectedTrack?.id ?? null}
            presets={state?.vocalPresets ?? []}
            onState={(next) => setState(next)}
            command={command}
          />
          <PitchPanel
            tracks={state?.tracks ?? []}
            selected={selected == null ? null : { trackId: selected.trackId, clipId: selected.clipId }}
            pitch={state?.pitch ?? null}
            onState={(next) => setState(next)}
            onProjectMutation={(op) => markDirtyFromExternalOp(op)}
          />
          <LivePitchPanel
            mapping={state?.pitch?.mapping}
            onState={(next) => setState(next)}
            onProjectMutation={(op) => markDirtyFromExternalOp(op)}
          />
          <RecordingWorkflowPanel
            state={state}
            inputDevice={inputDevice}
            armedTracks={armedTracks}
            recording={recording}
            recordElapsed={recordElapsed}
            virtualInput={virtualInput}
            inputMeter={inputMeter}
            busy={recording}
            engineConnected={engineConnected}
            command={command}
            onRecord={toggleRecording}
            onReview={async () => { setMixStep('review'); await reviewLastTake() }}
            onRetake={retakeFromLastStart}
            onChooseFolder={chooseRecordFolder}
          />
          <LiveAutoTunePanel />
          <section className="record-panel" aria-label="Recording settings">
            <h2>Recording settings</h2>
            <label className="field">
              Record from
              <select
                aria-label="Record from"
                data-action="recording-source"
                value={virtualInput ? 'virtual' : 'device'}
                disabled={recording}
                onChange={(event) => void command('setVirtualInput', { enabled: event.target.value === 'virtual' })}
              >
                <option value="device">Audio device input{state?.inputChannels ? ` (${state.inputChannels} ch)` : ' (none open)'}</option>
                <option value="virtual">Test signal (virtual)</option>
              </select>
            </label>
            {armedTracks.length === 0 ? <p className="hint">Arm a track with its R button to set input channel and dry/processed mode.</p> : armedTracks.map((track) => {
              const label = track.name || track.id
              return (
                <div className="record-track" key={track.id} aria-label={`${label} recording settings`}>
                  <span className="record-name">● {label}</span>
                  <label className="field">
                    Input
                    <select aria-label={`${label} record input`} value={track.recordInput} disabled={recording}
                      onChange={(event) => void command('setTrackRecord', { trackId: track.id, input: event.target.value as RecordInputName })}>
                      <option value="1">Input 1 (mono)</option>
                      <option value="2">Input 2 (mono)</option>
                      <option value="1+2">Inputs 1+2 (stereo)</option>
                    </select>
                  </label>
                  <label className="field">
                    Record
                    <select aria-label={`${label} record mode`} value={track.recordMode} disabled={recording}
                      onChange={(event) => void command('setTrackRecord', { trackId: track.id, mode: event.target.value as RecordModeName })}>
                      <option value="dry">Dry input</option>
                      <option value="processed">Through track effects</option>
                      <option value="both">Dry and processed</option>
                    </select>
                  </label>
                </div>
              )
            })}
            {state?.record?.lastTake != null && !recording ? <p className="hint">{takeSummary(state.record.lastTake)}</p> : null}
          </section>
        </aside>
      </section>
      )}

      <footer className="status">
        <span>{state?.outputDevice || 'No output'} · {rate} Hz · buffer {state?.bufferSize ?? 0} · latency {state?.reportedLatencyMs?.toFixed(1) ?? '0.0'} ms reported</span>
        <span className="zoom">
          <button data-timeline-action="zoom-out" onClick={() => zoomTimeline(pixelsPerSecond / 1.25)}>Zoom out</button>
          <span data-timeline-pps>{pixelsPerSecond} px/s</span>
          <button data-timeline-action="zoom-in" onClick={() => zoomTimeline(pixelsPerSecond * 1.25)}>Zoom in</button>
        </span>
        <span data-shortcut-hint>
          {state?.tracks.length ?? 0} tracks · {labelForCommand(activeShortcuts, 'transport.playPause', shortcutPlatform) || 'Space'} play ·
          {' '}{labelForCommand(activeShortcuts, 'timeline.split', shortcutPlatform) || 'S'} split ·
          {' '}{labelForCommand(activeShortcuts, 'edit.delete', shortcutPlatform) || 'Del'} ·
          {' '}{labelForCommand(activeShortcuts, 'edit.undo', shortcutPlatform) || 'Ctrl+Z'} undo · Shortcuts panel
        </span>
      </footer>

      {contextMenu != null ? (
        <div
          className="timeline-context-menu"
          data-timeline-context="true"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          role="menu"
        >
          <button role="menuitem" data-context-action="split" onClick={() => { selectClip({ trackId: contextMenu.trackId, clipId: contextMenu.clipId }); void splitSelected(); setContextMenu(null) }}>
            Split at playhead{labelForCommand(activeShortcuts, 'timeline.split', shortcutPlatform) ? ` (${labelForCommand(activeShortcuts, 'timeline.split', shortcutPlatform)})` : ''}
          </button>
          <button role="menuitem" data-context-action="duplicate" onClick={() => { selectClip({ trackId: contextMenu.trackId, clipId: contextMenu.clipId }); void duplicateSelectedInPlace(); setContextMenu(null) }}>
            Duplicate{labelForCommand(activeShortcuts, 'edit.duplicate', shortcutPlatform) ? ` (${labelForCommand(activeShortcuts, 'edit.duplicate', shortcutPlatform)})` : ''}
          </button>
          <button role="menuitem" data-context-action="delete" onClick={() => { selectClip({ trackId: contextMenu.trackId, clipId: contextMenu.clipId }); void deleteSelected(); setContextMenu(null) }}>
            Delete{labelForCommand(activeShortcuts, 'edit.delete', shortcutPlatform) ? ` (${labelForCommand(activeShortcuts, 'edit.delete', shortcutPlatform)})` : ''}
          </button>
          <button role="menuitem" data-context-action="clear" onClick={() => clearClipSelection()}>
            Clear selection{labelForCommand(activeShortcuts, 'edit.deselect', shortcutPlatform) ? ` (${labelForCommand(activeShortcuts, 'edit.deselect', shortcutPlatform)})` : ''}
          </button>
        </div>
      ) : null}

      {shortcutPanelOpen ? (
        <ShortcutPanel
          overrides={shortcutOverrides}
          capturing={shortcutCapturing}
          conflictNote={shortcutConflict}
          onCapture={setShortcutCapturing}
          onChange={(id, binding) => { void persistShortcutOverride(id, binding) }}
          onReset={() => {
            void (async () => {
              const empty = await window.studio.resetShortcutOverrides()
              setShortcutOverrides(empty as ShortcutOverrides)
              setShortcutConflict(null)
              setShortcutCapturing(null)
            })()
          }}
          onClose={() => {
            setShortcutPanelOpen(false)
            setShortcutCapturing(null)
          }}
        />
      ) : null}

      <MediaAssetsPanel
        open={mediaPanelOpen}
        projectName={projectName}
        projectPath={projectPath}
        assets={mediaAssets}
        enriched={mediaEnriched}
        externalCount={externalMediaCount}
        missingCount={missingMediaCount}
        busyKey={mediaBusyKey}
        onClose={() => setMediaPanelOpen(false)}
        onRelink={(asset) => { void locateAndRelink(asset) }}
        onRevealMissing={() => {
          setMediaPanelOpen(false)
          offerMissingMediaRecovery(stateRef.current)
        }}
        onRefresh={() => { void refreshMediaEnrichment(mediaAssets) }}
      />

      <MissingMediaDialog
        open={missingDialogOpen}
        projectName={projectName}
        items={missingItems}
        activeKey={missingActiveKey}
        searching={mediaSearchBusy}
        searchScanned={mediaSearchScanned}
        searchFolder={mediaSearchFolder}
        candidates={mediaCandidates}
        candidateError={mediaCandidateError}
        busy={mediaBusyKey != null}
        onSelectItem={(key) => {
          setMissingActiveKey(key)
          setMediaCandidates([])
          setMediaCandidateError(null)
        }}
        onLocateFile={() => {
          const active = missingItems.find((item) => item.key === missingActiveKey) ?? missingItems[0]
          if (active != null)
            void locateAndRelink(active)
        }}
        onSearchFolder={() => { void searchFolderForActiveMissing() }}
        onRelink={(path) => { void relinkFromCandidate(path) }}
        onRelinkAll={() => { void relinkAllMissingByName() }}
        onSkip={() => {
          setMissingItems((items) => items.map((item) => item.key === missingActiveKey ? { ...item, status: 'skipped' } : item))
          const next = missingItems.find((item) => item.key !== missingActiveKey && item.status === 'pending')
          if (next != null)
            setMissingActiveKey(next.key)
        }}
        onDecideLater={() => {
          setMissingItems((items) => items.map((item) => item.status === 'pending' ? { ...item, status: 'later' } : item))
          missingDialogGuard.current = false
          setMissingDialogOpen(false)
          setMediaCandidates([])
        }}
        onCancelSearch={() => { void window.studio.cancelMediaSearch() }}
        onClose={() => {
          missingDialogGuard.current = false
          setMissingDialogOpen(false)
          setMediaCandidates([])
        }}
      />
    </main>
  )
}

function AutomationHeader(props: {
  row: AutoRow
  interpolation: AutomationInterpolation
  selectedIndex: number
  onChoose: (param: string) => void
  onInterpolation: (value: AutomationInterpolation) => void
  onEnable: (enabled: boolean) => void
  onEditPoint: (index: number, time: number, value: number) => void
  onClear: () => void
}) {
  const { row } = props
  const lane = row.lane
  const point = lane?.points[props.selectedIndex]
  const label = `${row.owner} automation`
  const state = lane == null ? 'no lane' : !lane.enabled ? 'off' : lane.points.length === 0 ? 'no points' : 'active'
  return (
    <article className={`auto-header${lane?.active === true ? ' active' : ''}`} style={{ height: autoHeight }} aria-label={label}>
      <div className="auto-head">
        <span className="auto-title" title={`${label}: click the lane to add a point, drag to move, double-click or Delete to remove`}>A · {row.owner}</span>
        <button aria-label={`${label} clear lane`} disabled={lane == null} title="Delete this lane and all its points" onClick={props.onClear}>Clear</button>
      </div>
      <select aria-label={`${label} parameter`} value={row.param?.param ?? ''} disabled={row.params.length === 0} onChange={(event) => props.onChoose(event.target.value)}>
        {row.params.length === 0 ? <option value="">No automatable parameters</option> : null}
        {row.params.map((param) => {
          const existing = laneFor(row.lanes, param.param)
          const mark = existing?.active === true ? '● ' : existing != null ? '○ ' : ''
          return <option key={param.param} value={param.param}>{mark}{param.label}</option>
        })}
      </select>
      <div className="auto-controls">
        <button aria-pressed={lane?.enabled === true} aria-label={`${label} enabled`} disabled={lane == null}
          title={lane?.enabled === false ? 'Off: the manual value plays. Click to follow the lane.' : 'On: the lane overrides the manual value.'}
          onClick={() => props.onEnable(!(lane?.enabled ?? false))}>{lane?.enabled === false ? 'Off' : 'On'}</button>
        <select aria-label={`${label} interpolation`} value={point?.interpolation ?? props.interpolation} title="Shape after a point: ramp to the next point, or hold until it"
          onChange={(event) => props.onInterpolation(event.target.value as AutomationInterpolation)}>
          <option value="linear">Linear</option>
          <option value="step">Step</option>
        </select>
        {point != null && row.param != null ? (
          <PointFields label={label} param={row.param} time={point.time} value={point.value} onCommit={(time, value) => props.onEditPoint(props.selectedIndex, time, value)} />
        ) : (
          <span className="auto-state" title={state}>{`${lane?.points.length ?? 0} pts · ${state}`}</span>
        )}
      </div>
    </article>
  )
}

// Time and value of the selected point as text fields. Typing commits on Enter or blur; Escape reverts.
function PointFields(props: { label: string, param: AutoParam, time: number, value: number, onCommit: (time: number, value: number) => void }) {
  const { param } = props
  const [time, setTime] = useState(props.time.toFixed(3))
  const [value, setValue] = useState(String(param.toInput(props.value)))
  useEffect(() => {
    setTime(props.time.toFixed(3))
    setValue(String(param.toInput(props.value)))
    // `param` is rebuilt with every engine state update; resyncing on that would wipe text being typed.
  }, [props.time, props.value, param.param])
  const revert = (): void => {
    setTime(props.time.toFixed(3))
    setValue(String(param.toInput(props.value)))
  }
  const commit = (): void => {
    const nextTime = Number(time)
    const typed = Number(value)
    if (time.trim() === '' || value.trim() === '' || !Number.isFinite(nextTime) || !Number.isFinite(typed)) {
      revert()
      return
    }
    const nextValue = param.fromInput(typed)
    const clampedTime = Math.max(0, nextTime)
    if (Math.abs(clampedTime - props.time) < 1e-9 && Math.abs(nextValue - props.value) < 1e-9) {
      revert()
      return
    }
    props.onCommit(clampedTime, nextValue)
  }
  const keys = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.currentTarget.blur()
    } else if (event.key === 'Escape') {
      revert()
      event.currentTarget.blur()
    }
  }
  return (
    <span className="auto-point" title={`${param.label}: ${props.time.toFixed(3)} s, ${param.format(props.value)}. Type a value and press Enter.`}>
      <input type="number" min={0} step={0.01} aria-label={`${props.label} point time`} value={time}
        onChange={(event) => setTime(event.target.value)} onBlur={commit} onKeyDown={keys} />
      <span>s</span>
      <input type="number" step="any" aria-label={`${props.label} point value`} value={value}
        onChange={(event) => setValue(event.target.value)} onBlur={commit} onKeyDown={keys} />
      <span>{param.unit}</span>
    </span>
  )
}

function TrackHeader(props: {
  track: TrackState
  automationOpen: boolean
  height: number
  selected: boolean
  onImport: () => void
  onImportTake: () => void
  onRename: (name: string) => void
  onDuplicate: () => void
  onRemove: () => void
  onChange: (payload: { gain?: number, pan?: number, mute?: boolean, solo?: boolean }) => void
  onArm: () => void
  onMonitor?: () => void
  onToggleAutomation: () => void
  onToggleTakes: () => void
}) {
  const [gain, setGain] = useState(props.track.gain ?? 1)
  const [pan, setPan] = useState(props.track.pan ?? 0)
  const [name, setName] = useState(props.track.name || props.track.id)
  useEffect(() => {
    setGain(props.track.gain ?? 1)
    setPan(props.track.pan ?? 0)
    setName(props.track.name || props.track.id)
  }, [props.track.gain, props.track.pan, props.track.path, props.track.name, props.track.id])
  const label = props.track.name || props.track.id
  const clipCount = clipsOf(props.track).length
  const takeCount = takesOf(props.track).length
  const gainAuto = isAutomated(props.track.automation, 'volume')
  const panAuto = isAutomated(props.track.automation, 'pan')
  const anyAuto = (props.track.automation ?? []).some((lane) => lane.active)
  const takesOpen = props.track.takesExpanded === true
  return (
    <article className={`lane-header${props.selected ? ' selected' : ''}`} style={{ height: props.height }} data-lane="comp" data-track-id={props.track.id} data-track-selected={props.selected ? 'true' : 'false'}>
      <div className="strip-head">
        <input
          className="track-name"
          aria-label={`${label} name`}
          value={name}
          onChange={(event) => setName(event.target.value)}
          onBlur={() => {
            const next = name.trim()
            if (next.length > 0 && next !== (props.track.name || props.track.id))
              props.onRename(next)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter')
              event.currentTarget.blur()
          }}
        />
        <button onClick={props.onImport}>{props.track.path || clipCount > 0 ? 'Add clip' : 'Import WAV'}</button>
        <button onClick={props.onImportTake} title="Import a WAV as a vocal take lane (does not place on the comp)">Add take</button>
        <button className={`arm-button${props.track.armed ? ' armed' : ''}`} aria-pressed={props.track.armed} aria-label={`${label} record arm`}
          data-action="track-arm" data-track-id={props.track.id}
          title={props.track.armed ? 'Armed: Record captures input onto this track. Click to disarm.' : 'Arm this track for recording'} onClick={props.onArm}>R</button>
        {props.track.armed && props.onMonitor != null && (
          <button
            className={`monitor-lane-button${props.track.monitorInput ? ' on' : ''}`}
            aria-pressed={props.track.monitorInput}
            aria-label={`${label} input monitor`}
            data-action="track-monitor"
            data-track-id={props.track.id}
            title={props.track.monitorInput ? 'Input monitor ON — use headphones to avoid feedback' : 'Input monitor OFF — click to hear input while transport plays'}
            onClick={props.onMonitor}
          >Mon</button>
        )}
        <button className={`takes-button${takeCount > 0 ? ' has-takes' : ''}`} aria-pressed={takesOpen} aria-label={`${label} take lanes`}
          title={takeCount === 0 ? 'No takes yet — record or Add take' : `${takesOpen ? 'Hide' : 'Show'} ${takeCount} take lane${takeCount === 1 ? '' : 's'}`}
          disabled={takeCount === 0} onClick={props.onToggleTakes}>T</button>
        <button className={`auto-button${anyAuto ? ' automated' : ''}`} aria-pressed={props.automationOpen} aria-label={`${label} automation lane`}
          title={`${props.automationOpen ? 'Hide' : 'Show'} the automation lane${anyAuto ? ' (this track has active automation)' : ''}`} onClick={props.onToggleAutomation}>A</button>
      </div>
      <p className="path">{takeCount > 0 ? `Comp · ${clipCount} region${clipCount === 1 ? '' : 's'} · ${takeCount} take${takeCount === 1 ? '' : 's'}` : props.track.missing ? 'Missing media' : props.track.path ? `${fileName(props.track.path)} · ${props.track.channels === 1 ? 'mono' : 'stereo'}` : clipCount > 0 ? `${clipCount} clip${clipCount === 1 ? '' : 's'}` : 'Empty track'}</p>
      <label className="field inline" title={gainAuto ? 'Volume follows its automation lane. Turn the lane off to set it by hand.' : undefined}>
        <span className={gainAuto ? 'automated' : undefined}>{gainAuto ? 'Gain auto' : `Gain ${gainText(gain)}`}</span>
        <input type="range" min={0} max={2} step={0.01} value={gain} disabled={gainAuto} aria-label={`${label} gain`} onChange={(event) => setGain(Number(event.target.value))} onPointerUp={(event) => props.onChange({ gain: Number(event.currentTarget.value) })} />
      </label>
      <label className="field inline" title={panAuto ? 'Pan follows its automation lane. Turn the lane off to set it by hand.' : undefined}>
        <span className={panAuto ? 'automated' : undefined}>{panAuto ? 'Pan auto' : `Pan ${pan.toFixed(2)}`}</span>
        <input type="range" min={-1} max={1} step={0.01} value={pan} disabled={panAuto} aria-label={`${label} pan`} onChange={(event) => setPan(Number(event.target.value))} onPointerUp={(event) => props.onChange({ pan: Number(event.currentTarget.value) })} />
      </label>
      <div className="toggles">
        <button aria-pressed={props.track.mute} onClick={() => props.onChange({ mute: !props.track.mute })}>M</button>
        <button aria-pressed={props.track.solo} onClick={() => props.onChange({ solo: !props.track.solo })}>S</button>
        <button onClick={props.onDuplicate}>Duplicate</button>
        <button onClick={props.onRemove}>Remove</button>
      </div>
    </article>
  )
}

function TakeHeader(props: {
  track: TrackState
  take: TakeState
  onRename: (name: string) => void
  onMute: () => void
  onRemove: () => void
}) {
  const [name, setName] = useState(props.take.name)
  useEffect(() => { setName(props.take.name) }, [props.take.name, props.take.id])
  return (
    <article className={`lane-header take-header${props.take.muted ? ' muted' : ''}`} style={{ height: takeLaneHeight }} data-lane="take" data-take-id={props.take.id} data-track-id={props.track.id}>
      <div className="strip-head">
        <span className="take-badge">Take</span>
        <input
          className="track-name"
          aria-label={`${props.take.name} take name`}
          value={name}
          onChange={(event) => setName(event.target.value)}
          onBlur={() => {
            const next = name.trim()
            if (next.length > 0 && next !== props.take.name)
              props.onRename(next)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter')
              event.currentTarget.blur()
          }}
        />
        <button aria-pressed={props.take.muted} title="Mute take lane display (does not silence the comp)" onClick={props.onMute}>M</button>
        <button title="Remove take lane (blocked while its audio is used in the comp)" onClick={props.onRemove}>×</button>
      </div>
      <p className="path">{props.take.duration.toFixed(2)} s · drag on the lane to promote a region to the comp</p>
    </article>
  )
}

interface AutoDrag {
  key: string
  param: string
  index: number
  time: number
  value: number
  moved: boolean
}

// Points of an automation row as drawn, with a point being dragged shown at its new place.
function displayedPoints(row: AutoRow, active: AutoDrag | null): AutomationPointState[] {
  const points = row.lane?.points ?? []
  if (active == null || active.key !== row.key || active.param !== row.param?.param || points[active.index] == null)
    return points
  const moved = points.map((point, index) => index === active.index ? { ...point, time: active.time, value: active.value } : point)
  return moved.sort((a, b) => a.time - b.time)
}

function Timeline(props: {
  rows: Row[]
  autoSelected: AutoSelection | null
  onAutoSelect: (selection: AutoSelection | null) => void
  onAutoAdd: (row: AutoRow, time: number, value: number) => void
  onAutoMove: (row: AutoRow, index: number, time: number, value: number) => void
  onAutoDelete: (row: AutoRow, index: number) => void
  position: number
  pixelsPerSecond: number
  sampleRate: number
  snap: boolean
  selected: Selection | null
  selectedSet: Selection[]
  laneHeight: number
  bpm: number
  beatsPerBar: number
  snapGuide: number | null
  contentWidth: number
  scrollRef: RefObject<HTMLDivElement | null>
  scrollVersion: number
  verticalRef: RefObject<HTMLDivElement | null>
  peakVersion: number
  choosePeaks: (trackId: string, sourceId: string, start: number, end: number) => PeakSet | undefined
  onSelect: (selection: Selection | null, additive?: boolean) => void
  onSelectMany: (selection: Selection[]) => void
  onContextClip: (menu: { x: number, y: number, trackId: string, clipId: string } | null) => void
  onSnapGuide: (time: number | null) => void
  onZoomAt: (pixelsPerSecond: number, anchorTime: number) => void
  onSeek: (time: number) => void
  onCommit: (edit: DragState) => void
  onCompRegion: (trackId: string, takeId: string, timelineStart: number, timelineEnd: number) => void
  timingEdit: boolean
  pendingTiming: { trackId: string, clipId: string, markerId: string, timeline: number } | null
  onTimingPreview: (trackId: string, clipId: string, markerId: string, timeline: number) => void
  onAddTimingMarker: (trackId: string, clipId: string, timeline: number) => void
  breathEdit: boolean
  selectedBreath: { trackId: string, clipId: string, regionId: string } | null
  onSelectBreath: (selection: { trackId: string, clipId: string, regionId: string } | null) => void
  onAddBreathRegion: (trackId: string, clipId: string, timelineStart: number, timelineEnd: number) => void
  onSetBreathRegion: (trackId: string, clipId: string, regionId: string, patch: Record<string, number | boolean>) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rulerRef = useRef<HTMLCanvasElement>(null)
  const columnRef = useRef<HTMLDivElement>(null)
  const drag = useRef<DragState | null>(null)
  const marquee = useRef<{ originX: number, originY: number, currentX: number, currentY: number, additive: boolean } | null>(null)
  const markerDrag = useRef<{ trackId: string, clipId: string, markerId: string, current: number } | null>(null)
  const breathDrag = useRef<{ trackId: string, clipId: string, regionId: string, edge: 'start' | 'end' | 'create', origin: number, current: number } | null>(null)
  const takeDrag = useRef<{ trackId: string, takeId: string, origin: number, current: number } | null>(null)
  const autoDrag = useRef<AutoDrag | null>(null)
  const lastAdd = useRef({ at: 0, x: 0, y: 0 })
  const [dragVersion, setDragVersion] = useState(0)
  const [layoutTick, setLayoutTick] = useState(0)
  const last = props.rows[props.rows.length - 1]
  const laneHeight = props.laneHeight
  const lanesHeight = last == null ? laneHeight : last.top + last.height
  const selectedKeys = new Set(props.selectedSet.map((item) => selectionKey(item.trackId, item.clipId)))

  function rowAt(y: number): Row | undefined {
    return props.rows.find((row) => y >= row.top && y < row.top + row.height)
  }

  function autoY(row: AutoRow, fraction: number): number {
    return row.top + autoPad + (1 - fraction) * (row.height - 2 * autoPad)
  }

  function autoFraction(row: AutoRow, y: number): number {
    return 1 - (y - row.top - autoPad) / (row.height - 2 * autoPad)
  }

  // Index of the point of `row` under (x, y) in canvas pixels, or -1.
  function autoPointAt(row: AutoRow, x: number, y: number): number {
    if (row.param == null)
      return -1
    const points = row.lane?.points ?? []
    let best = -1
    let bestDistance = 7
    points.forEach((point, index) => {
      const px = (point.time - scrollSeconds()) * props.pixelsPerSecond
      const py = autoY(row, row.param?.toFraction(point.value) ?? 0)
      const distance = Math.hypot(px - x, py - y)
      if (distance <= bestDistance) {
        best = index
        bestDistance = distance
      }
    })
    return best
  }

  function scrollSeconds(): number {
    return (props.scrollRef.current?.scrollLeft ?? 0) / props.pixelsPerSecond
  }

  function timeAt(clientX: number, rect: DOMRect | undefined): number {
    if (rect == null)
      return 0
    return scrollSeconds() + (clientX - rect.left) / props.pixelsPerSecond
  }

  // Vertical wheel scrolling is left to the browser: the timeline sits inside the vertical lanes scroller.
  function scrollByWheel(event: { ctrlKey: boolean, metaKey: boolean, shiftKey: boolean, deltaX: number, deltaY: number, clientX: number, currentTarget: EventTarget, preventDefault: () => void }): void {
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault()
      const rect = (event.currentTarget as HTMLElement | null)?.getBoundingClientRect()
      const anchor = Math.max(0, timeAt(event.clientX, rect))
      const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12
      props.onZoomAt(props.pixelsPerSecond * factor, anchor)
      return
    }
    const horizontal = event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)
    if (horizontal && props.scrollRef.current != null) {
      event.preventDefault()
      props.scrollRef.current.scrollLeft += event.deltaX || event.deltaY
    }
  }

  function displayed(track: TrackState, clip: ClipState): ClipState {
    const active = drag.current
    if (active == null || active.clipId !== clip.id || active.trackId !== track.id)
      return clip
    if (active.mode === 'move') {
      const delta = active.current - active.origin
      return { ...clip, timelineStart: Math.max(0, clip.timelineStart + delta) }
    }
    if (active.mode === 'trim-left') {
      const edge = Math.min(clip.timelineStart + clip.duration - 1 / props.sampleRate, Math.max(0, active.current))
      const delta = edge - clip.timelineStart
      const duration = Math.max(1 / props.sampleRate, clip.duration - delta)
      return { ...clip, timelineStart: edge, sourceOffset: clip.sourceOffset + delta, duration, fadeIn: Math.min(clip.fadeIn, duration), fadeOut: Math.min(clip.fadeOut, duration) }
    }
    if (active.mode === 'trim-right') {
      const edge = Math.max(clip.timelineStart + 1 / props.sampleRate, active.current)
      const duration = edge - clip.timelineStart
      return { ...clip, duration, fadeIn: Math.min(clip.fadeIn, duration), fadeOut: Math.min(clip.fadeOut, duration) }
    }
    if (active.mode === 'fade-in') {
      const fadeIn = Math.min(clip.duration, Math.max(0, active.current - clip.timelineStart))
      return { ...clip, fadeIn }
    }
    const fadeOut = Math.min(clip.duration, Math.max(0, clip.timelineStart + clip.duration - active.current))
    return { ...clip, fadeOut }
  }

  useEffect(() => {
    const column = columnRef.current
    if (column == null)
      return
    const observer = new ResizeObserver(() => setLayoutTick((value) => value + 1))
    observer.observe(column)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    const ruler = rulerRef.current
    const column = columnRef.current
    if (canvas == null || ruler == null || column == null)
      return
    const width = column.clientWidth
    const ratio = window.devicePixelRatio || 1
    const origin = scrollSeconds()
    const labelStep = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300].find((step) => step * props.pixelsPerSecond >= 72) ?? 600
    const tickStep = labelStep / 5
    const firstTick = Math.floor(origin / tickStep)
    const lastTick = Math.ceil((origin + width / props.pixelsPerSecond) / tickStep)
    const playX = (props.position - origin) * props.pixelsPerSecond

    function prepare(target: HTMLCanvasElement, height: number): CanvasRenderingContext2D | null {
      target.width = Math.max(1, Math.floor(width * ratio))
      target.height = Math.max(1, Math.floor(height * ratio))
      target.style.width = '100%'
      target.style.height = `${height}px`
      const ctx = target.getContext('2d')
      if (ctx == null)
        return null
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
      ctx.clearRect(0, 0, width, height)
      return ctx
    }

    const beatSec = beatDuration(props.bpm)
    const barSec = barDuration(props.bpm, props.beatsPerBar)
    const showBeats = beatSec * props.pixelsPerSecond >= 10
    const showBars = barSec * props.pixelsPerSecond >= 28
    const firstBar = Math.floor(origin / barSec)
    const lastBar = Math.ceil((origin + width / props.pixelsPerSecond) / barSec)

    const rulerCtx = prepare(ruler, rulerHeight)
    if (rulerCtx != null) {
      rulerCtx.fillStyle = '#10141b'
      rulerCtx.fillRect(0, 0, width, rulerHeight)
      if (showBeats) {
        rulerCtx.strokeStyle = '#1d2430'
        rulerCtx.beginPath()
        const firstBeat = Math.floor(origin / beatSec)
        const lastBeat = Math.ceil((origin + width / props.pixelsPerSecond) / beatSec)
        for (let beat = firstBeat; beat <= lastBeat; beat++) {
          const time = beat * beatSec
          const x = (time - origin) * props.pixelsPerSecond
          const isBar = Math.abs((time / barSec) - Math.round(time / barSec)) < 1e-6
          if (isBar)
            continue
          rulerCtx.moveTo(x, 18)
          rulerCtx.lineTo(x, rulerHeight)
        }
        rulerCtx.stroke()
      }
      rulerCtx.strokeStyle = '#2a3140'
      rulerCtx.fillStyle = '#8b97a8'
      rulerCtx.font = '11px Segoe UI'
      rulerCtx.beginPath()
      for (let tick = firstTick; tick <= lastTick; tick++) {
        const time = tick * tickStep
        const x = (time - origin) * props.pixelsPerSecond
        const major = tick % 5 === 0
        rulerCtx.moveTo(x, major ? 4 : 20)
        rulerCtx.lineTo(x, rulerHeight)
        if (major && x >= 0 && x < width - 36)
          rulerCtx.fillText(formatTime(time), x + 4, 13)
      }
      rulerCtx.stroke()
      if (showBars) {
        rulerCtx.fillStyle = '#c9b48f'
        for (let bar = firstBar; bar <= lastBar; bar++) {
          const time = bar * barSec
          const x = (time - origin) * props.pixelsPerSecond
          if (x < -8 || x > width)
            continue
          rulerCtx.fillText(`${bar + 1}`, x + 3, 24)
        }
      }
      rulerCtx.strokeStyle = '#f4f7fb'
      rulerCtx.beginPath()
      rulerCtx.moveTo(playX, 0)
      rulerCtx.lineTo(playX, rulerHeight)
      rulerCtx.stroke()
    }

    const height = lanesHeight
    const ctx = prepare(canvas, height)
    if (ctx == null)
      return
    ctx.fillStyle = '#10141b'
    ctx.fillRect(0, 0, width, height)
    ctx.strokeStyle = '#2a3140'
    ctx.beginPath()
    for (let tick = firstTick; tick <= lastTick; tick++) {
      const x = (tick * tickStep - origin) * props.pixelsPerSecond
      ctx.moveTo(x, 0)
      ctx.lineTo(x, height)
    }
    ctx.stroke()
    if (showBars) {
      ctx.strokeStyle = '#3a4558'
      ctx.beginPath()
      for (let bar = firstBar; bar <= lastBar; bar++) {
        const x = (bar * barSec - origin) * props.pixelsPerSecond
        ctx.moveTo(x, 0)
        ctx.lineTo(x, height)
      }
      ctx.stroke()
    }

    if (props.rows.length === 0) {
      ctx.fillStyle = '#8b97a8'
      ctx.font = '13px Segoe UI'
      ctx.fillText('Add a track to start a timeline.', 12, 32)
    }
    const drawAutomation = (row: AutoRow): void => {
      const top = row.top
      ctx.fillStyle = '#0f131a'
      ctx.fillRect(0, top, width, row.height)
      ctx.strokeStyle = '#2a3140'
      ctx.beginPath()
      ctx.moveTo(0, top + row.height - 0.5)
      ctx.lineTo(width, top + row.height - 0.5)
      ctx.stroke()
      const param = row.param
      if (param == null) {
        ctx.fillStyle = '#8b97a8'
        ctx.font = '12px Segoe UI'
        ctx.fillText('Add an effect to automate its parameters.', 8, top + 24)
        return
      }
      const lane = row.lane
      const active = lane?.enabled !== false
      // The manual value, which plays whenever the lane is off or empty.
      ctx.setLineDash([4, 4])
      ctx.strokeStyle = '#4b5567'
      const manualY = autoY(row, param.toFraction(param.manual))
      ctx.beginPath()
      ctx.moveTo(0, manualY)
      ctx.lineTo(width, manualY)
      ctx.stroke()
      ctx.setLineDash([])
      const points = displayedPoints(row, autoDrag.current)
      ctx.font = '11px Segoe UI'
      ctx.fillStyle = '#8b97a8'
      ctx.fillText(points.length === 0 ? `${param.label}: click to add a point` : `${param.label}${active ? '' : ' (off: manual value plays)'}`, 8, top + 14)
      if (points.length === 0)
        return
      const xOf = (time: number): number => (time - origin) * props.pixelsPerSecond
      const yOf = (value: number): number => autoY(row, param.toFraction(value))
      ctx.strokeStyle = active ? '#f2c27e' : '#6d7c92'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(0, yOf(points[0].value))
      ctx.lineTo(xOf(points[0].time), yOf(points[0].value))
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1]
        const b = points[i]
        if (a.interpolation === 'step')
          ctx.lineTo(xOf(b.time), yOf(a.value))
        ctx.lineTo(xOf(b.time), yOf(b.value))
      }
      ctx.lineTo(width, yOf(points[points.length - 1].value))
      ctx.stroke()
      ctx.lineWidth = 1
      const selectedIndex = props.autoSelected != null && props.autoSelected.key === row.key && props.autoSelected.param === param.param ? props.autoSelected.index : -1
      const dragging = autoDrag.current != null && autoDrag.current.key === row.key ? autoDrag.current : null
      ;(row.lane?.points ?? []).forEach((raw, index) => {
        const point = dragging != null && dragging.index === index ? { ...raw, time: dragging.time, value: dragging.value } : raw
        const x = xOf(point.time)
        if (x < -6 || x > width + 6)
          return
        ctx.fillStyle = index === selectedIndex ? '#ffffff' : active ? '#e0a24a' : '#8b97a8'
        ctx.beginPath()
        if (point.interpolation === 'step')
          ctx.rect(x - 4, yOf(point.value) - 4, 8, 8)
        else
          ctx.arc(x, yOf(point.value), 4.5, 0, Math.PI * 2)
        ctx.fill()
      })
    }
    let trackIndex = 0
    props.rows.forEach((row) => {
      if (row.kind === 'auto') {
        drawAutomation(row)
        return
      }
      if (row.kind === 'take') {
        const track = row.track
        const take = row.take
        const top = row.top
        const h = row.height
        ctx.fillStyle = take.muted ? '#10131a' : '#121820'
        ctx.fillRect(0, top, width, h)
        ctx.strokeStyle = '#2a3140'
        ctx.beginPath()
        ctx.moveTo(0, top + h - 0.5)
        ctx.lineTo(width, top + h - 0.5)
        ctx.stroke()
        const x = (take.timelineStart - origin) * props.pixelsPerSecond
        const w = Math.max(2, take.duration * props.pixelsPerSecond)
        ctx.fillStyle = take.muted ? '#1a2230' : '#1c2838'
        ctx.fillRect(x, top + 6, w, h - 12)
        ctx.strokeStyle = take.muted ? '#3a4558' : '#5a6f8c'
        ctx.strokeRect(x + 0.5, top + 6.5, Math.max(0, w - 1), h - 13)
        const peaks = props.choosePeaks(track.id, take.sourceFileId, 0, take.duration)
        if (peaks != null && peaks.max.length > 0 && !take.muted) {
          const span = Math.max(1.0e-6, peaks.end - peaks.start)
          const first = Math.max(0, Math.floor((0 - peaks.start) / span * peaks.max.length))
          const last = Math.min(peaks.max.length, Math.ceil((take.duration - peaks.start) / span * peaks.max.length))
          const count = Math.max(1, last - first)
          const mid = top + h / 2
          ctx.strokeStyle = '#6d9ecf'
          ctx.beginPath()
          for (let bucket = 0; bucket < count; bucket++) {
            const indexBucket = Math.min(peaks.max.length - 1, first + bucket)
            const px = x + (bucket / count) * w
            const half = (h - 18) / 2
            ctx.moveTo(px, mid - peaks.max[indexBucket] * half)
            ctx.lineTo(px, mid - peaks.min[indexBucket] * half)
          }
          ctx.stroke()
        }
        // Active comp regions sourced from this take.
        for (const clip of clipsOf(track)) {
          if (clip.sourceFileId !== take.sourceFileId)
            continue
          const cx = (clip.timelineStart - origin) * props.pixelsPerSecond
          const cw = Math.max(2, clip.duration * props.pixelsPerSecond)
          ctx.fillStyle = 'rgba(224, 162, 74, 0.35)'
          ctx.fillRect(cx, top + 6, cw, h - 12)
          ctx.strokeStyle = '#e0a24a'
          ctx.strokeRect(cx + 0.5, top + 6.5, Math.max(0, cw - 1), h - 13)
        }
        const selecting = takeDrag.current
        if (selecting != null && selecting.takeId === take.id && selecting.trackId === track.id) {
          const a = Math.min(selecting.origin, selecting.current)
          const b = Math.max(selecting.origin, selecting.current)
          const sx = (a - origin) * props.pixelsPerSecond
          const sw = Math.max(2, (b - a) * props.pixelsPerSecond)
          ctx.fillStyle = 'rgba(126, 182, 255, 0.28)'
          ctx.fillRect(sx, top + 6, sw, h - 12)
        }
        return
      }
      const track = row.track
      const index = trackIndex++
      const top = row.top
      ctx.fillStyle = index % 2 === 0 ? '#171c25' : '#141922'
      ctx.fillRect(0, top, width, laneHeight)
      if (track.missing) {
        ctx.fillStyle = '#6a3036'
        ctx.fillRect(0, top, width, laneHeight)
        ctx.fillStyle = '#ffd7db'
        ctx.fillText('Missing media — clip positions are kept', 8, top + 24)
      }
      if (takesOf(track).length > 0) {
        ctx.fillStyle = '#8b97a8'
        ctx.font = '11px Segoe UI'
        ctx.fillText('Comp', 8, top + 14)
      }
      for (const raw of clipsOf(track)) {
        const clip = displayed(track, raw)
        const x = (clip.timelineStart - origin) * props.pixelsPerSecond
        const w = Math.max(2, clip.duration * props.pixelsPerSecond)
        if (x + w < 0 || x > width)
          continue
        const selected = selectedKeys.has(selectionKey(track.id, raw.id))
        ctx.fillStyle = selected ? '#3d3424' : '#243044'
        ctx.fillRect(x, top + 8, w, laneHeight - 20)
        ctx.strokeStyle = selected ? '#e0a24a' : '#6d7c92'
        ctx.strokeRect(x + 0.5, top + 8.5, Math.max(0, w - 1), laneHeight - 21)
        const peaks = props.choosePeaks(track.id, clip.sourceFileId, clip.sourceOffset, clip.sourceOffset + clip.duration)
        if (peaks != null && peaks.max.length > 0) {
          const span = Math.max(1.0e-6, peaks.end - peaks.start)
          const first = Math.max(0, Math.floor(((clip.sourceOffset - peaks.start) / span) * peaks.max.length))
          const last = Math.min(peaks.max.length, Math.ceil(((clip.sourceOffset + clip.duration - peaks.start) / span) * peaks.max.length))
          const count = Math.max(1, last - first)
          const mid = top + 8 + (laneHeight - 20) / 2
          ctx.strokeStyle = selected ? '#f0c27a' : '#7eb6ff'
          ctx.beginPath()
          for (let bucket = 0; bucket < count; bucket++) {
            const indexBucket = Math.min(peaks.max.length - 1, first + bucket)
            const px = x + (bucket / count) * w
            const half = (laneHeight - 28) / 2
            ctx.moveTo(px, mid - peaks.max[indexBucket] * half)
            ctx.lineTo(px, mid - peaks.min[indexBucket] * half)
          }
          ctx.stroke()
        }
        ctx.fillStyle = 'rgba(224, 162, 74, 0.28)'
        if (clip.fadeIn > 0)
          ctx.fillRect(x, top + 8, Math.min(w, clip.fadeIn * props.pixelsPerSecond), 8)
        if (clip.fadeOut > 0)
          ctx.fillRect(x + w - Math.min(w, clip.fadeOut * props.pixelsPerSecond), top + 8, Math.min(w, clip.fadeOut * props.pixelsPerSecond), 8)
        // Phase 2.8.2 — highlight linked crossfade region more clearly.
        if (raw.crossfadePartnerId && clip.fadeOut > 0) {
          ctx.fillStyle = 'rgba(120, 200, 180, 0.35)'
          ctx.fillRect(x + w - Math.min(w, clip.fadeOut * props.pixelsPerSecond), top + 4,
            Math.min(w, clip.fadeOut * props.pixelsPerSecond), laneHeight - 10)
        } else if (raw.crossfadePartnerId && clip.fadeIn > 0) {
          ctx.fillStyle = 'rgba(120, 200, 180, 0.35)'
          ctx.fillRect(x, top + 4, Math.min(w, clip.fadeIn * props.pixelsPerSecond), laneHeight - 10)
        }
        const fadeInX = x + clip.fadeIn * props.pixelsPerSecond
        const fadeOutX = x + w - clip.fadeOut * props.pixelsPerSecond
        ctx.fillStyle = '#e0a24a'
        ctx.beginPath()
        ctx.arc(fadeInX, top + 12, 4, 0, Math.PI * 2)
        ctx.arc(fadeOutX, top + 12, 4, 0, Math.PI * 2)
        ctx.fill()
        const markers = (raw.timingMarkers ?? []) as TimingMarker[]
        for (const marker of markers) {
          let time = marker.timeline
          if (props.pendingTiming != null && props.pendingTiming.markerId === marker.id
            && props.pendingTiming.trackId === track.id && props.pendingTiming.clipId === raw.id)
            time = props.pendingTiming.timeline
          else if (markerDrag.current != null && markerDrag.current.markerId === marker.id)
            time = markerDrag.current.current
          const mx = (time - origin) * props.pixelsPerSecond
          ctx.strokeStyle = marker.manual ? '#f0c27a' : '#7eb6ff'
          ctx.fillStyle = marker.manual ? '#f0c27a' : '#7eb6ff'
          ctx.beginPath()
          ctx.moveTo(mx, top + 4)
          ctx.lineTo(mx, top + laneHeight - 6)
          ctx.stroke()
          ctx.beginPath()
          ctx.moveTo(mx, top + 4)
          ctx.lineTo(mx - 5, top + 14)
          ctx.lineTo(mx + 5, top + 14)
          ctx.closePath()
          ctx.fill()
        }
        const regions = (raw.breathRegions ?? []) as BreathRegion[]
        for (const region of regions) {
          let start = region.timelineStart
          let end = region.timelineEnd
          if (breathDrag.current != null && breathDrag.current.regionId === region.id
            && breathDrag.current.trackId === track.id && breathDrag.current.clipId === raw.id) {
            if (breathDrag.current.edge === 'start')
              start = Math.min(breathDrag.current.current, end - 0.01)
            else if (breathDrag.current.edge === 'end')
              end = Math.max(breathDrag.current.current, start + 0.01)
          }
          const rx = (start - origin) * props.pixelsPerSecond
          const rw = Math.max(2, (end - start) * props.pixelsPerSecond)
          const selectedRegion = props.selectedBreath?.regionId === region.id
            && props.selectedBreath.trackId === track.id && props.selectedBreath.clipId === raw.id
          const fill = region.kind === 'silence'
            ? (region.ignored ? 'rgba(120,130,150,0.18)' : 'rgba(90,120,160,0.35)')
            : region.kind === 'breath'
              ? (region.ignored ? 'rgba(180,140,90,0.15)' : 'rgba(210,150,70,0.38)')
              : (region.ignored ? 'rgba(140,160,120,0.15)' : 'rgba(120,180,110,0.35)')
          ctx.fillStyle = fill
          ctx.fillRect(rx, top + 18, rw, laneHeight - 28)
          ctx.strokeStyle = selectedRegion ? '#f4f7fb' : (region.kind === 'breath' ? '#e0a24a' : '#7eb6ff')
          ctx.lineWidth = selectedRegion ? 2 : 1
          ctx.strokeRect(rx, top + 18, rw, laneHeight - 28)
          ctx.lineWidth = 1
          ctx.fillStyle = '#d7dee8'
          ctx.font = '10px sans-serif'
          ctx.fillText(region.kind[0]!.toUpperCase() + (region.ignored ? '·ign' : ''), rx + 3, top + 30)
        }
        if (breathDrag.current != null && breathDrag.current.edge === 'create'
          && breathDrag.current.trackId === track.id && breathDrag.current.clipId === raw.id) {
          const a = Math.min(breathDrag.current.origin, breathDrag.current.current)
          const b = Math.max(breathDrag.current.origin, breathDrag.current.current)
          const rx = (a - origin) * props.pixelsPerSecond
          const rw = Math.max(2, (b - a) * props.pixelsPerSecond)
          ctx.fillStyle = 'rgba(120,180,110,0.25)'
          ctx.fillRect(rx, top + 18, rw, laneHeight - 28)
        }
      }
    })

    if (props.snapGuide != null) {
      const guideX = (props.snapGuide - origin) * props.pixelsPerSecond
      ctx.strokeStyle = '#e0a24a'
      ctx.setLineDash([4, 4])
      ctx.beginPath()
      ctx.moveTo(guideX, 0)
      ctx.lineTo(guideX, height)
      ctx.stroke()
      ctx.setLineDash([])
    }

    const box = marquee.current
    if (box != null) {
      const x = Math.min(box.originX, box.currentX)
      const y = Math.min(box.originY, box.currentY)
      const w = Math.abs(box.currentX - box.originX)
      const h = Math.abs(box.currentY - box.originY)
      ctx.fillStyle = 'rgba(126, 182, 255, 0.18)'
      ctx.fillRect(x, y, w, h)
      ctx.strokeStyle = '#7eb6ff'
      ctx.strokeRect(x + 0.5, y + 0.5, Math.max(0, w - 1), Math.max(0, h - 1))
    }

    ctx.strokeStyle = '#f4f7fb'
    ctx.beginPath()
    ctx.moveTo(playX, 0)
    ctx.lineTo(playX, height)
    ctx.stroke()
  }, [props.rows, props.position, props.pixelsPerSecond, props.selected, props.selectedSet, props.peakVersion, props.contentWidth, dragVersion, props.snap, props.snapGuide, props.scrollVersion, layoutTick, lanesHeight, props.autoSelected, props.timingEdit, props.pendingTiming, props.breathEdit, props.selectedBreath, props.bpm, props.beatsPerBar, laneHeight])

  function hit(clientX: number, clientY: number): { trackId: string, clip: ClipState, mode: DragMode } | null {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (rect == null)
      return null
    const y = clientY - rect.top
    const row = rowAt(y)
    if (row == null || row.kind !== 'track')
      return null
    const track = row.track
    const trackId = track.id
    const time = timeAt(clientX, rect)
    const matches = clipsOf(track).filter((clip) => time >= clip.timelineStart && time <= clip.timelineStart + clip.duration)
    const clip = matches[matches.length - 1]
    if (clip == null)
      return null
    const x = (time - scrollSeconds()) * props.pixelsPerSecond
    const left = (clip.timelineStart - scrollSeconds()) * props.pixelsPerSecond
    const right = left + clip.duration * props.pixelsPerSecond
    const fadeInX = left + clip.fadeIn * props.pixelsPerSecond
    const fadeOutX = right - clip.fadeOut * props.pixelsPerSecond
    const nearTop = y - row.top < 20
    let mode: DragMode = 'move'
    if (nearTop && Math.abs(x - fadeInX) < 8 && Math.abs(x - fadeInX) <= Math.abs(x - fadeOutX))
      mode = 'fade-in'
    else if (nearTop && Math.abs(x - fadeOutX) < 8)
      mode = 'fade-out'
    else if (Math.abs(x - left) < 7)
      mode = 'trim-left'
    else if (Math.abs(x - right) < 7)
      mode = 'trim-right'
    return { trackId, clip, mode }
  }

  return (
    <div className="timeline-column" ref={columnRef}>
      <canvas
        ref={rulerRef}
        className="timeline-ruler"
        style={{ height: rulerHeight }}
        onWheel={scrollByWheel}
        onPointerDown={(event) => {
          const rect = rulerRef.current?.getBoundingClientRect()
          props.onSeek(Math.max(0, timeAt(event.clientX, rect)))
        }}
      />
      <div className="timeline-pane" style={{ height: lanesHeight }}>
      <canvas
        ref={canvasRef}
        className="timeline-canvas"
        style={{ height: lanesHeight }}
        onWheel={scrollByWheel}
        onPointerDown={(event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          const row = rowAt(event.clientY - rect.top)
          if (row?.kind === 'auto') {
            props.onSelect(null)
            if (row.param == null)
              return
            const x = event.clientX - rect.left
            const y = event.clientY - rect.top
            const index = autoPointAt(row, x, y)
            if (index >= 0) {
              const point = row.lane?.points[index]
              props.onAutoSelect({ key: row.key, param: row.param.param, index })
              if (point != null) {
                autoDrag.current = { key: row.key, param: row.param.param, index, time: point.time, value: point.value, moved: false }
                event.currentTarget.setPointerCapture(event.pointerId)
              }
              return
            }
            // A double-click on empty lane space must not add two points.
            const now = performance.now()
            if (now - lastAdd.current.at < 450 && Math.abs(x - lastAdd.current.x) < 8 && Math.abs(y - lastAdd.current.y) < 8)
              return
            lastAdd.current = { at: now, x, y }
            props.onAutoAdd(row, Math.max(0, timeAt(event.clientX, rect)), row.param.fromFraction(autoFraction(row, y)))
            return
          }
          props.onAutoSelect(null)
          if (row?.kind === 'take') {
            props.onSelect(null)
            if (row.take.muted)
              return
            const point = timeAt(event.clientX, rect)
            const clamped = Math.min(row.take.timelineStart + row.take.duration, Math.max(row.take.timelineStart, point))
            takeDrag.current = { trackId: row.track.id, takeId: row.take.id, origin: clamped, current: clamped }
            event.currentTarget.setPointerCapture(event.pointerId)
            setDragVersion((n) => n + 1)
            return
          }
          if (props.breathEdit && row?.kind === 'track') {
            const time = timeAt(event.clientX, rect)
            const track = row.track
            let hitRegion: { clip: ClipState, region: BreathRegion, edge: 'start' | 'end' | 'body' } | null = null
            for (const clip of clipsOf(track)) {
              for (const region of clip.breathRegions ?? []) {
                const x0 = (region.timelineStart - scrollSeconds()) * props.pixelsPerSecond
                const x1 = (region.timelineEnd - scrollSeconds()) * props.pixelsPerSecond
                const px = event.clientX - rect.left
                if (Math.abs(px - x0) < 6)
                  hitRegion = { clip, region, edge: 'start' }
                else if (Math.abs(px - x1) < 6)
                  hitRegion = { clip, region, edge: 'end' }
                else if (px >= x0 && px <= x1)
                  hitRegion = { clip, region, edge: 'body' }
                if (hitRegion != null)
                  break
              }
              if (hitRegion != null)
                break
            }
            if (hitRegion != null) {
              props.onSelect({ trackId: track.id, clipId: hitRegion.clip.id })
              props.onSelectBreath({ trackId: track.id, clipId: hitRegion.clip.id, regionId: hitRegion.region.id })
              if (hitRegion.edge !== 'body') {
                breathDrag.current = {
                  trackId: track.id,
                  clipId: hitRegion.clip.id,
                  regionId: hitRegion.region.id,
                  edge: hitRegion.edge,
                  origin: time,
                  current: time
                }
                event.currentTarget.setPointerCapture(event.pointerId)
                setDragVersion((n) => n + 1)
              }
              return
            }
            const foundClip = clipsOf(track).find((clip) => time >= clip.timelineStart && time <= clip.timelineStart + clip.duration)
            if (foundClip != null && event.detail === 2) {
              props.onSelect({ trackId: track.id, clipId: foundClip.id })
              breathDrag.current = {
                trackId: track.id,
                clipId: foundClip.id,
                regionId: '',
                edge: 'create',
                origin: time,
                current: time
              }
              event.currentTarget.setPointerCapture(event.pointerId)
              setDragVersion((n) => n + 1)
              return
            }
            if (foundClip != null) {
              props.onSelect({ trackId: track.id, clipId: foundClip.id })
              props.onSelectBreath(null)
            } else {
              props.onSelect(null)
              props.onSelectBreath(null)
            }
            return
          }
          if (props.timingEdit && row?.kind === 'track') {
            const time = timeAt(event.clientX, rect)
            const track = row.track
            let hitMarker: { clip: ClipState, marker: TimingMarker } | null = null
            for (const clip of clipsOf(track)) {
              for (const marker of clip.timingMarkers ?? []) {
                const mt = marker.timeline
                if (Math.abs((mt - scrollSeconds()) * props.pixelsPerSecond - (event.clientX - rect.left)) < 8) {
                  hitMarker = { clip, marker }
                  break
                }
              }
              if (hitMarker != null)
                break
            }
            if (hitMarker != null) {
              props.onSelect({ trackId: track.id, clipId: hitMarker.clip.id })
              markerDrag.current = { trackId: track.id, clipId: hitMarker.clip.id, markerId: hitMarker.marker.id, current: time }
              event.currentTarget.setPointerCapture(event.pointerId)
              setDragVersion((n) => n + 1)
              return
            }
            const foundClip = clipsOf(track).find((clip) => time >= clip.timelineStart && time <= clip.timelineStart + clip.duration)
            if (foundClip != null && event.detail === 2) {
              props.onSelect({ trackId: track.id, clipId: foundClip.id })
              props.onAddTimingMarker(track.id, foundClip.id, time)
              return
            }
            if (foundClip != null)
              props.onSelect({ trackId: track.id, clipId: foundClip.id })
            else
              props.onSelect(null)
            return
          }
          const found = hit(event.clientX, event.clientY)
          if (found == null) {
            const x = event.clientX - rect.left
            const y = event.clientY - rect.top
            marquee.current = { originX: x, originY: y, currentX: x, currentY: y, additive: event.shiftKey || event.ctrlKey || event.metaKey }
            if (!(event.shiftKey || event.ctrlKey || event.metaKey))
              props.onSelect(null)
            props.onContextClip(null)
            event.currentTarget.setPointerCapture(event.pointerId)
            setDragVersion((n) => n + 1)
            return
          }
          props.onSelect({ trackId: found.trackId, clipId: found.clip.id }, event.shiftKey || event.ctrlKey || event.metaKey)
          props.onContextClip(null)
          const point = timeAt(event.clientX, rect)
          drag.current = { mode: found.mode, trackId: found.trackId, clipId: found.clip.id, origin: point, current: point }
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onContextMenu={(event) => {
          event.preventDefault()
          const found = hit(event.clientX, event.clientY)
          if (found == null) {
            props.onContextClip(null)
            return
          }
          props.onSelect({ trackId: found.trackId, clipId: found.clip.id }, event.shiftKey)
          props.onContextClip({ x: event.clientX, y: event.clientY, trackId: found.trackId, clipId: found.clip.id })
        }}
        onPointerMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          if (marquee.current != null) {
            marquee.current = {
              ...marquee.current,
              currentX: event.clientX - rect.left,
              currentY: event.clientY - rect.top
            }
            setDragVersion((n) => n + 1)
            return
          }
          const active = autoDrag.current
          if (active != null) {
            const row = props.rows.find((item): item is AutoRow => item.kind === 'auto' && item.key === active.key)
            if (row?.param == null)
              return
            const time = Math.max(0, timeAt(event.clientX, rect))
            const value = row.param.fromFraction(autoFraction(row, event.clientY - rect.top))
            autoDrag.current = { ...active, time, value, moved: active.moved || Math.abs(time - active.time) > 0.0005 || value !== active.value }
            setDragVersion((n) => n + 1)
            return
          }
          if (markerDrag.current != null) {
            markerDrag.current = { ...markerDrag.current, current: Math.max(0, timeAt(event.clientX, rect)) }
            setDragVersion((n) => n + 1)
            return
          }
          if (breathDrag.current != null) {
            breathDrag.current = { ...breathDrag.current, current: Math.max(0, timeAt(event.clientX, rect)) }
            setDragVersion((n) => n + 1)
            return
          }
          if (takeDrag.current != null) {
            const row = props.rows.find((item): item is TakeRow =>
              item.kind === 'take' && item.track.id === takeDrag.current?.trackId && item.take.id === takeDrag.current.takeId)
            const point = timeAt(event.clientX, rect)
            const clamped = row == null
              ? Math.max(0, point)
              : Math.min(row.take.timelineStart + row.take.duration, Math.max(row.take.timelineStart, point))
            takeDrag.current = { ...takeDrag.current, current: clamped }
            setDragVersion((n) => n + 1)
            return
          }
          if (drag.current == null)
            return
          const nextTime = timeAt(event.clientX, rect)
          drag.current = { ...drag.current, current: nextTime }
          if (props.snap && (drag.current.mode === 'move' || drag.current.mode === 'trim-left' || drag.current.mode === 'trim-right'))
            props.onSnapGuide(nextTime)
          setDragVersion((value) => value + 1)
        }}
        onPointerUp={(event) => {
          const box = marquee.current
          if (box != null) {
            marquee.current = null
            setDragVersion((n) => n + 1)
            const left = Math.min(box.originX, box.currentX)
            const right = Math.max(box.originX, box.currentX)
            const top = Math.min(box.originY, box.currentY)
            const bottom = Math.max(box.originY, box.currentY)
            if (right - left < 3 && bottom - top < 3) {
              const rect = canvasRef.current?.getBoundingClientRect()
              props.onSeek(Math.max(0, timeAt(left + (rect?.left ?? 0), rect)))
              return
            }
            const origin = scrollSeconds()
            const t0 = origin + left / props.pixelsPerSecond
            const t1 = origin + right / props.pixelsPerSecond
            const hits: Selection[] = []
            for (const row of props.rows) {
              if (row.kind !== 'track')
                continue
              if (row.top > bottom || row.top + row.height < top)
                continue
              for (const clip of clipsOf(row.track)) {
                const c0 = clip.timelineStart
                const c1 = clip.timelineStart + clip.duration
                if (c1 >= t0 && c0 <= t1)
                  hits.push({ trackId: row.track.id, clipId: clip.id })
              }
            }
            if (box.additive) {
              const map = new Map(props.selectedSet.map((item) => [selectionKey(item.trackId, item.clipId), item]))
              for (const hitItem of hits)
                map.set(selectionKey(hitItem.trackId, hitItem.clipId), hitItem)
              props.onSelectMany([...map.values()])
            } else {
              props.onSelectMany(hits)
            }
            return
          }
          props.onSnapGuide(null)
          const moved = autoDrag.current
          if (moved != null) {
            autoDrag.current = null
            setDragVersion((n) => n + 1)
            const row = props.rows.find((item): item is AutoRow => item.kind === 'auto' && item.key === moved.key)
            if (moved.moved && row != null)
              props.onAutoMove(row, moved.index, moved.time, moved.value)
            return
          }
          const region = takeDrag.current
          if (region != null) {
            takeDrag.current = null
            setDragVersion((n) => n + 1)
            const start = Math.min(region.origin, region.current)
            const end = Math.max(region.origin, region.current)
            if (end - start >= 1 / Math.max(1, props.sampleRate))
              props.onCompRegion(region.trackId, region.takeId, start, end)
            return
          }
          const marker = markerDrag.current
          if (marker != null) {
            markerDrag.current = null
            setDragVersion((n) => n + 1)
            props.onTimingPreview(marker.trackId, marker.clipId, marker.markerId, marker.current)
            return
          }
          const breath = breathDrag.current
          if (breath != null) {
            breathDrag.current = null
            setDragVersion((n) => n + 1)
            if (breath.edge === 'create') {
              const start = Math.min(breath.origin, breath.current)
              const end = Math.max(breath.origin, breath.current)
              if (end - start >= 0.02)
                props.onAddBreathRegion(breath.trackId, breath.clipId, start, end)
              return
            }
            const track = props.rows.find((row): row is Extract<Row, { kind: 'track' }> =>
              row.kind === 'track' && row.track.id === breath.trackId)?.track
            const region = clipsOf(track).find((clip) => clip.id === breath.clipId)
              ?.breathRegions?.find((item) => item.id === breath.regionId)
            if (region != null) {
              const patch: Record<string, number | boolean> = breath.edge === 'start'
                ? { timelineStart: Math.min(breath.current, region.timelineEnd - 0.01) }
                : { timelineEnd: Math.max(breath.current, region.timelineStart + 0.01) }
              props.onSetBreathRegion(breath.trackId, breath.clipId, breath.regionId, patch)
            }
            return
          }
          const active = drag.current
          drag.current = null
          setDragVersion((value) => value + 1)
          if (active != null && Math.abs(active.current - active.origin) > 0.001)
            props.onCommit({ ...active, current: timeAt(event.clientX, canvasRef.current?.getBoundingClientRect()) })
        }}
        onDoubleClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          const row = rowAt(event.clientY - rect.top)
          if (row?.kind !== 'auto')
            return
          const x = event.clientX - rect.left
          const y = event.clientY - rect.top
          if (performance.now() - lastAdd.current.at < 600 && Math.abs(x - lastAdd.current.x) < 8 && Math.abs(y - lastAdd.current.y) < 8)
            return
          const index = autoPointAt(row, x, y)
          if (index >= 0)
            props.onAutoDelete(row, index)
        }}
      />
      </div>
    </div>
  )
}
