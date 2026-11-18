export const protocolVersion = 1

export type TransportName = 'stopped' | 'playing' | 'paused'

export interface ClipState {
  id: string
  sourceFileId: string
  timelineStart: number
  sourceOffset: number
  duration: number
  fadeIn: number
  fadeOut: number
  timelineStartSamples: number
  sourceOffsetSamples: number
  durationSamples: number
  fadeInSamples: number
  fadeOutSamples: number
  /** Phase 2.8.2 — linear | equalPower | sCurve */
  fadeInCurve?: string
  fadeOutCurve?: string
  crossfadePartnerId?: string
  crossfadeCurve?: string
  crossfadeDuration?: number
  crossfadeDurationSamples?: number
  gain: number
  // Present while the clip plays pitch-processed audio (applyPitch); revertPitch restores it.
  originalSourceFileId?: string
  originalSourceOffset?: number
  pitchShiftCents?: number
  pitchLabel?: string               // what produced the processed audio
  noteTargets?: NoteTarget[]
  timingMarkers?: TimingMarker[]
  timingOriginalSourceFileId?: string
  timingOriginalSourceOffset?: number
  timingOriginalDuration?: number
  timingLabel?: string
  breathRegions?: BreathRegion[]
  breathOriginalSourceFileId?: string
  breathOriginalSourceOffset?: number
  breathOriginalDuration?: number
  breathLabel?: string
  /** Phase 2.8.1 — 'timeStretch' (pitch preserve) or 'speed' (pitch follows). */
  stretchMode?: 'timeStretch' | 'speed' | string
  /** Duration ratio (timeStretch) or speed multiplier (speed). */
  stretchRatio?: number
  stretchOriginalSourceFileId?: string
  stretchOriginalSourceOffset?: number
  stretchOriginalDuration?: number
  stretchLabel?: string
}

// Onset / manual timing marker on a comp clip (session-rate source samples + timeline seconds).
export interface TimingMarker {
  id: string
  sourceSample: number
  timeline: number
  manual: boolean
}

// Breath/silence region on a comp clip (Phase 2.6.3). Timeline fields are seconds.
export interface BreathRegion {
  id: string
  sourceStart: number
  sourceEnd: number
  timelineStart: number
  timelineEnd: number
  kind: 'silence' | 'breath' | 'manual'
  confidence: number
  gainDb: number
  fadeIn: number
  fadeOut: number
  ignored: boolean
  manual: boolean
}

// A manual target note for one detected note segment (source seconds; MIDI note numbers).
export interface NoteTarget {
  clipId: string
  sourceFileId: string
  sourceStart: number
  sourceEnd: number
  originalMidi: number
  targetMidi: number
}

// One vocal take lane (Phase 2.6.1). Display/selection only; the track's clips are the active comp.
export interface TakeState {
  id: string
  name: string
  sourceFileId: string
  timelineStart: number
  duration: number
  timelineStartSamples: number
  durationSamples: number
  muted: boolean
}

/** Phase 2.9.4 — registered media source on a track (primary or extra). */
export interface MediaSourceState {
  id: string
  path: string
  kind: 'primary' | 'extra' | string
  missing: boolean
  error: string
  sampleRate: number
  channels: number
  duration: number
}

export interface TrackState {
  id: string
  name: string
  path: string
  gain: number
  pan: number
  mute: boolean
  solo: boolean
  duration: number
  sourceSampleRate: number
  channels: number
  missing: boolean
  error: string
  clips: ClipState[]
  /** Phase 2.9.4 — primary + extras inventory (preview extras omitted). */
  sources?: MediaSourceState[]
  output: string
  sends: SendState[]
  effects: EffectState[]
  automation: AutomationLaneState[]
  armed: boolean
  recordInput: RecordInputName
  recordMode: RecordModeName
  // Input monitoring (off by default). Only heard while the transport plays.
  monitorInput: boolean
  takes?: TakeState[]
  takesExpanded?: boolean
  compCrossfadeMs?: number
  /** Phase 2.8.2 — optional auto-crossfade on move/trim (off by default). */
  autoCrossfadeEnabled?: boolean
  autoCrossfadeMs?: number
  autoCrossfadeCurve?: string
  vocalPresetId?: string
  vocalPresetBypassed?: boolean
}

export interface RecordTakeFile {
  trackId: string
  path: string
  kind: 'dry' | 'processed'
  channels: number
  frames: number
  seconds: number
  gapFrames: number
  error: string
  placed: boolean
  clipId?: string
  takeId?: string
}

export const masterBusId = 'master'

export type AutomationInterpolation = 'linear' | 'step'

// time is in seconds at the session rate; timeSamples is exact.
export interface AutomationPointState {
  time: number
  timeSamples: number
  value: number
  interpolation: AutomationInterpolation
}

// param is 'volume', 'pan', or 'fx:<effectId>:<parameterName>'. An active lane (enabled, with
// points) overrides the manual value, and the engine rejects manual changes to that parameter.
export interface AutomationLaneState {
  param: string
  enabled: boolean
  active: boolean
  points: AutomationPointState[]
}

export type RecordInputName = '1' | '2' | '1+2'
export type RecordModeName = 'dry' | 'processed' | 'both'

export interface RecordTake {
  startSeconds: number
  startSamples: number
  /** Playhead sample where capture began (before placement offset). */
  captureStartSamples?: number
  placementOffsetMs?: number
  placementOffsetSamples?: number
  takes: RecordTakeFile[]
  droppedFrames: number
  overflowEvents: number
  warnings: string[]
}

/** Phase 2.7.4 — recording placement latency calibration (engine). */
export interface RecordingLatencyState {
  offsetMs: number
  offsetSamples: number
  maxOffsetMs: number
  profileKey: string
  outputDevice: string
  inputDevice: string
  sampleRate: number
  bufferSize: number
  reportedOutputLatencyMs: number
  reportedOutputLatencySamples: number
  method: 'none' | 'manual' | 'loopback-estimate' | string
  signConvention: string
  notes: string
  lastEstimate: {
    delayMs: number
    delaySamples: number
    confidence: number
    peakCorrelation: number
    reliable: boolean
    message: string
  } | null
}

export interface RecordState {
  state: 'idle' | 'recording'
  folder: string
  startSeconds: number
  elapsedSeconds: number
  droppedFrames: number
  maxSeconds: number
  virtualInput: { enabled: boolean, frequency: number, level: number }
  lastTake: RecordTake | null
  latency?: RecordingLatencyState
}

export type EffectType = 'eq' | 'compressor' | 'gate' | 'reverb' | 'delay' | 'limiter'

export interface VocalPresetSummary {
  id: string
  name: string
  factory: boolean
  effects: Array<{ type: EffectType, enabled: boolean }>
}

// One insert effect. params holds every parameter of the type by name (see effectSpecs).
export interface EffectState {
  id: string
  type: EffectType
  enabled: boolean
  params: Record<string, number>
}

export type EffectTarget = 'track' | 'bus' | 'master'

export interface SendState {
  bus: string
  level: number
  preFader: boolean
}

export type BusKind = 'group' | 'return'

export interface BusState {
  id: string
  name: string
  kind: BusKind
  gain: number
  mute: boolean
  solo: boolean
  output: string
  effects: EffectState[]
  automation: AutomationLaneState[]
}

// How playback and export render reverb/delay tails after the last clip (saved with the project).
// The tail ends after a quiet stretch below thresholdDb on the master, or at maxSeconds.
export interface RenderTail {
  enabled: boolean
  maxSeconds: number
  thresholdDb: number
}

export interface ExportResult {
  path: string
  sampleRate: number
  channels: number
  bitsPerSample: number
  frames: number
  timelineFrames: number
  tailFrames: number
  tail: RenderTail
}

/** Phase 2.6.5 — derived vocal pipeline status (not persisted). */
export interface VocalWorkflowState {
  order: Array<'record' | 'comp' | 'timing' | 'breath' | 'pitch' | 'presets' | 'mix' | string>
  previews: {
    pitch: boolean
    breath: boolean
    preset: boolean
    pitchTrackId?: string
    pitchClipId?: string
    breathTrackId?: string
    breathClipId?: string
    presetTrackId?: string
  }
  liveAutoTuneInExport: boolean
  note: string
}

export interface EngineState {
  transport: TransportName
  // Parked at duration while an effect tail plays after the timeline (transport stays 'playing').
  position: number
  duration: number
  renderTail: RenderTail
  sampleRate: number
  bufferSize: number
  masterGain: number
  /** Software input gain in dB (unity 0). Independent of track/master/monitor. */
  inputGainDb?: number
  monitor: boolean
  deviceOpen: boolean
  outputDevice: string
  inputDevice: string
  inputChannels: number
  outputChannels: number
  reportedLatencyMs: number
  deviceError: string
  canUndo: boolean
  canRedo: boolean
  /** Stable project UUID for autosave / recovery (Phase 2.9.1). */
  projectId?: string
  /** Display name; defaults to Untitled. */
  projectName?: string
  tracks: TrackState[]
  buses: BusState[]
  masterEffects: EffectState[]
  masterAutomation: AutomationLaneState[]
  vocalPresets?: VocalPresetSummary[]
  vocalWorkflow?: VocalWorkflowState
  record: RecordState
  pitch?: PitchState
  createdBusId?: string
  createdEffectId?: string
  pointIndex?: number
  take?: RecordTake
}

export interface DeviceList {
  outputs: string[]
  inputs: string[]
  sampleRates: number[]
  bufferSizes: number[]
  current: EngineState
}

export interface EngineResponse<T = unknown> {
  v: number
  id?: string
  ok: boolean
  error?: string
  result?: T
}

export interface MeterEvent {
  v: number
  event: 'meter'
  position: number
  duration: number
  transport: TransportName
  peakL: number
  peakR: number
  monitor: boolean
  deviceOpen: boolean
  recording?: boolean
  master?: StripMeter
  tracks?: StripMeter[]
  buses?: StripMeter[]
  effects?: EffectMeter[]
  /** Post software-input-gain capture meter. available=false → UI shows Unavailable. */
  input?: InputMeter
  /** Phase 2.8.3 — FFT spectrum from post-insert / pre-fader tap (never fabricated). */
  spectrum?: SpectrumFrame
}

export interface SpectrumFrame {
  available: boolean
  fftSize: number
  target: string
  ownerId: string
  tap: string
  magnitudesDb: number[]
  frequenciesHz: number[]
}

/** Input capture meter (Phase 2.7.2). Measured on real post-gain samples — never fabricated. */
export interface InputMeter {
  available: boolean
  channels: number
  peakL: number
  peakR: number
  rmsL: number
  rmsR: number
  levelL: number
  levelR: number
  peakHoldL: number
  peakHoldR: number
  clip: boolean
  peakDbFS: number
  rmsDbFS: number
  gainDb: number
}

// Largest gain reduction in dB since the last event (compressor and gate; 0 for others).
export interface EffectMeter {
  id: string
  reduction: number
}

// Native meter values (Phase 2.7.3). peak* is the highest sample since the last event;
// rms* from sum-of-squares / sample count; level* is the decaying display level;
// peakHold* holds the recent peak; clip latches at 0 dBFS until resetClips.
// available=false when the audio device is closed / stream unavailable.
export interface StripMeter {
  id?: string
  available?: boolean
  peakL: number
  peakR: number
  rmsL?: number
  rmsR?: number
  levelL: number
  levelR: number
  peakHoldL?: number
  peakHoldR?: number
  clip: boolean
  peakDbFS?: number
  rmsDbFS?: number
}

export interface ErrorEvent {
  v: number
  event: 'error'
  message: string
}

export interface ReadyEvent {
  v: number
  event: 'ready'
  deviceOpen: boolean
  message: string
}

// The engine finalized a take on its own (the transport stopped or the device failed).
export interface RecordFinishedEvent {
  v: number
  event: 'recordFinished'
  reason: string
  take: RecordTake
}

// Pitch analysis settings (analyzePitch). windowSize and hopSize are in samples at the clip's
// source rate. Voiced when confidence >= confidenceThreshold.
export interface PitchParams {
  minHz: number
  maxHz: number
  windowSize: number
  hopSize: number
  confidenceThreshold: number
  silenceDb: number
}

export const defaultPitchParams: PitchParams = { minHz: 70, maxHz: 1000, windowSize: 2048, hopSize: 512, confidenceThreshold: 0.85, silenceDb: -60 }

// analyzePitch answers at once; the result arrives later as a pitchResult event.
export interface PitchStart {
  jobId: number
  trackId: string
  clipId: string
  sampleRate: number
  duration: number
  clipStart: number
  frames: number
  params: PitchParams
}

export interface PitchProgressEvent {
  v: number
  event: 'pitchProgress'
  jobId: number
  done: number
  total: number
}

// One analysis window per index. time is the window centre in seconds from the clip start.
// Unvoiced frames have frequency 0, midi -1, note '' and cents 0.
export interface PitchFrames {
  time: number[]
  frequency: number[]
  midi: number[]
  note: string[]
  cents: number[]
  confidence: number[]
  voiced: boolean[]
}

// Consecutive voiced frames on the same nearest note.
export interface PitchNote {
  start: number
  end: number
  midi: number
  name: string
  frequency: number
  cents: number
  confidence: number
  frames: number
}

export interface PitchResultEvent {
  v: number
  event: 'pitchResult'
  jobId: number
  status: 'done' | 'cancelled' | 'error'
  error: string
  trackId: string
  clipId: string
  sampleRate: number
  clipStart: number
  duration: number
  params: PitchParams
  hopSeconds: number
  windowSeconds: number
  elapsedSeconds: number
  frames: PitchFrames
  notes: PitchNote[]
  summary: { frames: number, voicedFrames: number, voicedRatio: number, medianMidi?: number, medianNote?: string, medianFrequency?: number }
}

// Offline pitch correction (processPitch). The processed audio is written to a new file; the
// clip changes only on applyPitch. A preview (previewPitch) affects playback only.
export interface PitchState {
  processedFolder: string
  preview: { resultId: number, trackId: string, clipId: string, sourceFileId: string } | null
  mapping?: PitchMappingSettings
}

export type ScaleName = 'major' | 'naturalMinor' | 'harmonicMinor' | 'melodicMinor' | 'majorPentatonic' | 'minorPentatonic' | 'chromatic'

export const scaleOptions: Array<{ value: ScaleName, label: string }> = [
  { value: 'major', label: 'Major' },
  { value: 'naturalMinor', label: 'Natural minor' },
  { value: 'harmonicMinor', label: 'Harmonic minor' },
  { value: 'melodicMinor', label: 'Melodic minor (ascending)' },
  { value: 'majorPentatonic', label: 'Major pentatonic' },
  { value: 'minorPentatonic', label: 'Minor pentatonic' },
  { value: 'chromatic', label: 'Chromatic' }
]

// Roots as the engine names them (sharps), with the flat spelling for display.
export const keyRoots: Array<{ value: string, label: string }> = [
  { value: 'C', label: 'C' }, { value: 'C#', label: 'C#/Db' }, { value: 'D', label: 'D' }, { value: 'D#', label: 'D#/Eb' },
  { value: 'E', label: 'E' }, { value: 'F', label: 'F' }, { value: 'F#', label: 'F#/Gb' }, { value: 'G', label: 'G' },
  { value: 'G#', label: 'G#/Ab' }, { value: 'A', label: 'A' }, { value: 'A#', label: 'A#/Bb' }, { value: 'B', label: 'B' }
]

export interface PitchMappingSettings {
  enabled: boolean
  root: string
  scale: ScaleName
  scaleLabel: string
  tieBreak: 'lower' | 'upper'
  toleranceCents: number
  pitchClasses: number[]
}

// Live input pitch detection (getLivePitch / setLivePitch). Read-only diagnostics: the engine
// analyses a copy of the live input on a worker thread; audio is not changed.
export type LivePitchInput = 'input1' | 'input2' | 'mix'

export interface LivePitchResult {
  sequence: number
  windowStart: number      // input sample index
  windowEnd: number
  inputTime: number        // window centre, seconds of live input since detection started
  ageMs: number            // time since the result was completed
  voiced: boolean
  invalid: boolean
  gap: boolean
  frequency: number
  midi: number
  nearestMidi: number
  nearestName: string
  cents: number
  confidence: number
  levelDb: number
  note: number             // tracked note, -1 when none
  noteName: string
  pitch: number
  onset: boolean
  held: boolean
  pending: boolean
  octaveCorrected: boolean
  targetMidi: number       // -1 when there is no target (unvoiced or no tracked note)
  targetName: string
  correctionCents: number
  inTune: boolean
  windowDelayMs: number
  schedulingMs: number
  computeMs: number
  availabilityMs: number
}

export interface LivePitchStatistics {
  inputFrames: number
  droppedFrames: number
  overflows: number
  windows: number
  voicedWindows: number
  invalidWindows: number
  gaps: number
  resets: number
  maxQueuedFrames: number
  queueSlots: number
  queueFrames: number
  queueMs: number
  bytes: number
  windowDelayMs: number
  meanSchedulingMs: number
  maxSchedulingMs: number
  meanComputeMs: number
  maxComputeMs: number
  meanAvailabilityMs: number
  maxAvailabilityMs: number
  p95AvailabilityMs: number
  workerLoad: number
}

export interface LivePitchStatus {
  enabled: boolean
  input: LivePitchInput
  minHz: number
  maxHz: number
  hopSize: number
  root: string
  scale: ScaleName
  scaleLabel: string
  toleranceCents: number
  sampleRate?: number
  windowSize?: number
  windowMs?: number
  hopMs?: number
  latest?: LivePitchResult
  statistics?: LivePitchStatistics
}

// Live input pitch correction (getLiveCorrection / setLiveCorrection). Uses the Phase 2.5.1 live
// input stage. Formant preservation is not implemented for live processing
// (formantPreservation is always false). Recording always receives the corrected input when
// correction is on. Track monitoring follows monitorMode (raw = latency-aligned dry; corrected =
// post-stage). Mic monitor stays raw and undelayed.
export type LiveAnalysisMode = 'inCallback' | 'worker'
export type LiveMonitorMode = 'raw' | 'corrected'

export interface LiveCorrectionLatency {
  windowSize: number
  hopSize: number
  detectionSamples: number
  detectionMs: number
  deliverySamples: number
  deliveryMs: number
  shifterSamples: number
  shifterMs: number
  bufferingSamples: number
  totalSamples: number
  totalMs: number
}

export interface LiveCorrectionStatistics {
  calls: number
  samples: number
  averageMs: number
  peakMs: number
  averageLoad: number
  peakLoad: number
  overBudgetCalls: number
  sanitizedSamples: number
  skippedBlocks: number
  windows: number
  voicedWindows: number
  meanWindowMs: number
  maxWindowMs: number
  resultsReceived: number
  lateResults: number
  staleResults: number
  resultsDropped: number
  analysisDroppedFrames: number
  analysisGaps: number
  missingSamples: number
  correctedSamples: number
  maxDeliveryLagSamples: number
  meanDeliveryLagSamples: number
  jumps: number
  recentres: number
  recoveries: number
  resets: number
}

export interface LiveMonitoringLatency {
  dspSamples: number
  dspMs: number
  deviceOutputSamples: number
  deviceOutputMs?: number
  endToEndMs: number | null     // null = unavailable (input device latency not measured)
  endToEndNote: string
  trackMonitoring: 'off' | 'corrected' | 'rawAligned'
}

export interface LiveCorrectionStatus {
  enabled: boolean
  bypassed: boolean
  analysis: LiveAnalysisMode
  input: LivePitchInput
  workerMarginMs: number
  root: string
  scale: ScaleName
  scaleLabel: string
  retuneMs: number
  strength: number            // 0..100 percent
  monitorMode: LiveMonitorMode
  formantPreservation: false
  formantNote: string
  routing: {
    trackInputMonitoring: LiveMonitorMode
    monitorMode: LiveMonitorMode
    micMonitor: 'raw'
    recording: 'corrected'
    note: string
  }
  warnings: string[]
  deviceOutputLatencySamples: number
  latencySamples: number
  latencyMs: number
  sampleRate?: number
  maxBlockSize?: number
  channels?: number
  fadeSamples?: number
  latency?: LiveCorrectionLatency
  monitoringLatency?: LiveMonitoringLatency
  bufferBytes?: number
  statistics?: LiveCorrectionStatistics
  current?: { inputMidi: number, targetMidi: number, targetName?: string, appliedCents: number, ratio?: number }
}

export interface NoteSegmentMapping {
  index: number
  start: number            // seconds from the clip start
  end: number
  timelineStart: number
  timelineEnd: number
  voicedFrames: number
  confidence: number
  originalMidi: number     // fractional median
  originalFrequency: number
  nearestMidi: number
  nearestName: string
  nearestCents: number
  status: 'off' | 'inTune' | 'needsCorrection' | 'unvoiced' | 'invalid'
  suggestedMidi: number    // -1 when mapping is off
  suggestedName: string
  suggestedCents: number
  overrideMidi: number     // -1 without a manual target
  overrideName: string
  targetSource: 'manual' | 'auto' | 'none'
  targetMidi: number       // the manual target, else the suggestion, else -1
  targetName: string
  targetCents: number
  targetInKey: boolean
}

export interface PitchMappingResult {
  jobId: number
  trackId: string
  clipId: string
  clipStart: number
  sourceStart: number
  hopSeconds: number
  clipChanged: boolean
  mapping: PitchMappingSettings
  overrideCount: number
  unmatchedOverrides: number
  segments: NoteSegmentMapping[]
}

// Optional vocal quality fields of processPitch and processAutoCorrection (offline only). Omitted
// fields keep the Phase 2.4.4 processing: formants follow the pitch, standard quality, attacks
// not protected. The UI sends preserveFormants true and protectTransients true by default.
export const formantShiftMax = 12
export type VocalQualityMode = 'standard' | 'high'

export interface VocalQualitySettings {
  preserveFormants: boolean
  formantShift: number        // semitones, -12..12
  quality: VocalQualityMode   // high: 8x vocoder overlap and true-envelope estimation, same frame size
  protectTransients: boolean
}

export interface PitchProcessStart extends VocalQualitySettings {
  jobId: number
  trackId: string
  clipId: string
  semitones: number
  cents: number
  ratio: number
  identity: boolean
  label: string
  sampleRate: number
  channels: number
  duration: number
  folder: string
}

export interface PitchProcessProgressEvent {
  v: number
  event: 'pitchProcessProgress'
  jobId: number
  fraction: number
}

export interface PitchProcessResultEvent {
  v: number
  event: 'pitchProcessResult'
  jobId: number
  resultId: number
  status: 'done' | 'cancelled' | 'error'
  error: string
  trackId: string
  clipId: string
  semitones: number
  cents: number
  ratio: number
  sampleRate: number
  channels: number
  frames: number
  duration: number
  elapsedSeconds: number
  // Present when status is 'done'.
  path?: string
  identity?: boolean
  gainReductionDb?: number
  repairedSamples?: number
  inputPeak?: number
  outputPeak?: number
  originalHz?: number
  processedHz?: number
  originalVoicedFrames?: number
  processedVoicedFrames?: number
  expectedHz?: number | null
  deviationCents?: number | null
  label?: string
  preserveFormants?: boolean
  formantShift?: number
  quality?: VocalQualityMode
  protectTransients?: boolean
  envelopeFrames?: number
  transients?: number
  processSeconds?: number
  realtimeFactor?: number
  workingMB?: number
  workingSetBeforeMB?: number
  workingSetAfterMB?: number
  peakWorkingSetMB?: number
}

export const retuneMaxMs = 200

export interface PitchCorrectStart extends VocalQualitySettings {
  jobId: number
  analysisJobId: number
  trackId: string
  clipId: string
  retuneMs: number
  strength: number
  notes: number
  sampleRate: number
  channels: number
  duration: number
  label: string
  folder: string
}

export interface PitchCorrectProgressEvent {
  v: number
  event: 'pitchCorrectProgress'
  jobId: number
  fraction: number
}

// Measured away from the note edges on the corrected audio (verification only).
export interface CorrectedNote {
  index: number
  start: number
  end: number
  targetMidi: number
  targetName: string
  measuredFrom: number
  measuredTo: number
  originalMidi?: number
  expectedMidi?: number
  correctedMidi?: number
  originalCents?: number
  correctedCents?: number
  remainingCents: number | null   // null: too short to measure away from its edges
  curveMiddleCents: number
  transitionMs: number    // settle time: 95% of the change from the note start to its middle
  responseMs: number      // curve within 5% of the wanted change at the same moment (the applied retune speed)
  goalSettleMs: number    // time the measured pitch took to settle near its middle value
  glide: boolean          // left uncorrected as a glide
}

export interface PitchCorrectResultEvent {
  v: number
  event: 'pitchCorrectResult'
  jobId: number
  resultId: number
  status: 'done' | 'cancelled' | 'error'
  error: string
  trackId: string
  clipId: string
  retuneMs: number
  strength: number
  label: string
  sampleRate: number
  channels: number
  frames: number
  duration: number
  elapsedSeconds: number
  // Present when status is 'done'.
  path?: string
  identity?: boolean
  notes?: CorrectedNote[]
  worstRemainingCents?: number
  maxCorrectionCents?: number
  gainReductionDb?: number
  repairedSamples?: number
  inputPeak?: number
  outputPeak?: number
  copiedSamples?: number
  vocoderFrames?: number
  skippedFrames?: number
  envelopeFrames?: number
  transients?: number
  glideNotes?: number
  octaveFrames?: number
  preserveFormants?: boolean
  formantShift?: number
  quality?: VocalQualityMode
  protectTransients?: boolean
  correctionSeconds?: number
  realtimeFactor?: number
  workingMB?: number
  workingSetBeforeMB?: number
  workingSetAfterMB?: number
  peakWorkingSetMB?: number
}

// Phase 2.8.5 — offline loudness of an exported mix WAV (BS.1770-4 / EBU R128).
export interface LoudnessStart {
  jobId: number
  path: string
  truePeakOversample: number
  standard: string
}

export interface LoudnessProgressEvent {
  v: number
  event: 'loudnessProgress'
  jobId: number
  done: number
  total: number
}

export interface LoudnessResultEvent {
  v: number
  event: 'loudnessResult'
  jobId: number
  path: string
  ok: boolean
  available: boolean
  cancelled: boolean
  error: string
  sampleRate: number
  channels: number
  frames: number
  durationSeconds: number
  elapsedSeconds: number
  truePeakOversample: number
  standard: string
  integratedValid: boolean
  integratedLufs: number | null
  momentaryValid: boolean
  momentaryLufs: number | null
  shortTermValid: boolean
  shortTermLufs: number | null
  lraValid: boolean
  lraLu: number | null
  samplePeakValid: boolean
  samplePeakDbFs: number | null
  truePeakValid: boolean
  truePeakDbTp: number | null
  clippingSample: boolean
  clippingTruePeak: boolean
}

export type EngineEvent = MeterEvent | ErrorEvent | ReadyEvent | RecordFinishedEvent | PitchProgressEvent | PitchResultEvent
  | LoudnessProgressEvent | LoudnessResultEvent
  | PitchProcessProgressEvent | PitchProcessResultEvent | PitchCorrectProgressEvent | PitchCorrectResultEvent
