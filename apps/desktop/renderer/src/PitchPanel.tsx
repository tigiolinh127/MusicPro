import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import {
  defaultPitchParams,
  formantShiftMax,
  keyRoots,
  retuneMaxMs,
  scaleOptions,
  type VocalQualityMode,
  type VocalQualitySettings,
  type EngineState,
  type NoteSegmentMapping,
  type PitchCorrectResultEvent,
  type PitchCorrectStart,
  type PitchMappingResult,
  type PitchParams,
  type PitchProcessResultEvent,
  type PitchProcessStart,
  type PitchResultEvent,
  type PitchStart,
  type PitchState,
  type TrackState
} from '../../../../packages/shared/src/protocol'

interface Job {
  jobId: number
  label: string
  done: number
  total: number
}

interface ProcessJob {
  jobId: number
  trackId: string
  clipId: string
  fraction: number
}

function shiftText(semitones: number, cents: number): string {
  return `${semitones >= 0 ? '+' : ''}${semitones} st${cents !== 0 ? ` ${cents > 0 ? '+' : ''}${cents} c` : ''}`
}

function centsText(total: number): string {
  const semitones = Math.trunc(total / 100)
  return shiftText(semitones, Math.round((total - semitones * 100) * 10) / 10)
}

const fields: Array<{ key: keyof PitchParams, label: string, step: number }> = [
  { key: 'minHz', label: 'Min Hz', step: 1 },
  { key: 'maxHz', label: 'Max Hz', step: 1 },
  { key: 'windowSize', label: 'Window', step: 256 },
  { key: 'hopSize', label: 'Hop', step: 64 },
  { key: 'confidenceThreshold', label: 'Confidence', step: 0.01 }
]

const noSegments: NoteSegmentMapping[] = []

function clipKey(trackId: string, clipId: string): string {
  return `${trackId}\n${clipId}`
}

function signed(value: number, digits: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`
}

// Offline pitch analysis and correction of one clip. The engine works on a copy of the clip's
// source audio on its own thread; processed audio goes to a new file and reaches the clip only
// through Apply (undoable). The source file is never modified.
export function PitchPanel(props: {
  tracks: TrackState[]
  selected: { trackId: string, clipId: string } | null
  pitch: PitchState | null
  onState: (state: EngineState) => void
  /** Phase 2.9.5 — mark project dirty for mutating pitch ops that bypass App.command. */
  onProjectMutation?: (op: string) => void
}) {
  const clips = props.tracks.flatMap((track) => (track.clips ?? []).map((clip, index) => ({
    key: clipKey(track.id, clip.id),
    trackId: track.id,
    clipId: clip.id,
    label: `${track.name || track.id} · clip ${index + 1} (${clip.timelineStart.toFixed(2)} s)`
  })))
  const [choice, setChoice] = useState('')
  const [values, setValues] = useState<Record<keyof PitchParams, string>>(() => ({
    minHz: String(defaultPitchParams.minHz),
    maxHz: String(defaultPitchParams.maxHz),
    windowSize: String(defaultPitchParams.windowSize),
    hopSize: String(defaultPitchParams.hopSize),
    confidenceThreshold: String(defaultPitchParams.confidenceThreshold),
    silenceDb: String(defaultPitchParams.silenceDb)
  }))
  const [job, setJob] = useState<Job | null>(null)
  const [result, setResult] = useState<{ event: PitchResultEvent, label: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [hover, setHover] = useState<number | null>(null)
  const jobRef = useRef<Job | null>(null)
  const early = useRef(new Map<number, PitchResultEvent>())
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [semitones, setSemitones] = useState('0')
  const [cents, setCents] = useState('0')
  const [processJob, setProcessJob] = useState<ProcessJob | null>(null)
  const [processed, setProcessed] = useState<{ event: PitchProcessResultEvent, applied: boolean } | null>(null)
  const [processError, setProcessError] = useState<string | null>(null)
  const processRef = useRef<ProcessJob | null>(null)
  const earlyProcess = useRef(new Map<number, PitchProcessResultEvent>())
  const [mapped, setMapped] = useState<PitchMappingResult | null>(null)
  const [mappingError, setMappingError] = useState<string | null>(null)
  const mappingRequest = useRef(0)
  const [autoEnabled, setAutoEnabled] = useState(false)
  const [retune, setRetune] = useState('20')
  const [strength, setStrength] = useState('100')
  const [autoJob, setAutoJob] = useState<ProcessJob | null>(null)
  const [autoResult, setAutoResult] = useState<{ event: PitchCorrectResultEvent, applied: boolean } | null>(null)
  const [autoError, setAutoError] = useState<string | null>(null)
  const autoRef = useRef<ProcessJob | null>(null)
  const earlyAuto = useRef(new Map<number, PitchCorrectResultEvent>())
  const [preserveFormants, setPreserveFormants] = useState(true)
  const [formantShift, setFormantShift] = useState('0')
  const [qualityMode, setQualityMode] = useState<VocalQualityMode>('standard')

  // Vocal quality settings shared by automatic correction and the manual shift (null when invalid).
  function vocalSettings(report: (message: string | null) => void): VocalQualitySettings | null {
    const shift = Number(formantShift)
    if (formantShift.trim() === '' || !Number.isFinite(shift) || Math.abs(shift) > formantShiftMax) {
      report(`Formant shift must be a number from -${formantShiftMax} to +${formantShiftMax} semitones.`)
      return null
    }
    return { preserveFormants, formantShift: preserveFormants ? shift : 0, quality: qualityMode, protectTransients: true }
  }

  useEffect(() => {
    if (props.selected != null)
      setChoice(clipKey(props.selected.trackId, props.selected.clipId))
  }, [props.selected?.trackId, props.selected?.clipId])

  const chosen = clips.find((clip) => clip.key === choice) ?? clips[0]

  function finish(event: PitchResultEvent): void {
    const current = jobRef.current
    jobRef.current = null
    setJob(null)
    if (event.status === 'error') {
      setError(event.error || 'The pitch analysis failed.')
      return
    }
    setError(null)
    setHover(null)
    setResult({ event, label: current?.label ?? '' })
  }

  function finishProcess(event: PitchProcessResultEvent): void {
    processRef.current = null
    setProcessJob(null)
    if (event.status === 'error') {
      setProcessError(event.error || 'Pitch processing failed.')
      return
    }
    if (event.status === 'cancelled') {
      setProcessError(null)
      setProcessed(null)
      return
    }
    setProcessError(null)
    setProcessed({ event, applied: false })
  }

  function finishAuto(event: PitchCorrectResultEvent): void {
    autoRef.current = null
    setAutoJob(null)
    if (event.status === 'error') {
      setAutoError(event.error || 'Automatic correction failed.')
      return
    }
    setAutoError(null)
    setAutoResult(event.status === 'cancelled' ? null : { event, applied: false })
  }

  useEffect(() => window.studio.onEvent((event) => {
    if (event.event === 'pitchProgress') {
      if (jobRef.current?.jobId === event.jobId) {
        jobRef.current = { ...jobRef.current, done: event.done, total: event.total }
        setJob(jobRef.current)
      }
    } else if (event.event === 'pitchResult') {
      if (jobRef.current?.jobId === event.jobId)
        finish(event)
      else
        early.current.set(event.jobId, event)
    } else if (event.event === 'pitchProcessProgress') {
      if (processRef.current?.jobId === event.jobId) {
        processRef.current = { ...processRef.current, fraction: event.fraction }
        setProcessJob(processRef.current)
      }
    } else if (event.event === 'pitchProcessResult') {
      if (processRef.current?.jobId === event.jobId)
        finishProcess(event)
      else
        earlyProcess.current.set(event.jobId, event)
    } else if (event.event === 'pitchCorrectProgress') {
      if (autoRef.current?.jobId === event.jobId) {
        autoRef.current = { ...autoRef.current, fraction: event.fraction }
        setAutoJob(autoRef.current)
      }
    } else if (event.event === 'pitchCorrectResult') {
      if (autoRef.current?.jobId === event.jobId)
        finishAuto(event)
      else
        earlyAuto.current.set(event.jobId, event)
    }
  }), [])

  // Corrects the analysed clip towards the targets shown in the note list. The engine refuses
  // when the clip, the key/scale or the targets changed since they were shown.
  async function processAuto(): Promise<void> {
    if (mapped == null || autoRef.current != null || processRef.current != null || jobRef.current != null)
      return
    const retuneMs = Number(retune)
    const percent = Number(strength)
    if (retune.trim() === '' || !Number.isFinite(retuneMs) || retuneMs < 0 || retuneMs > retuneMaxMs) {
      setAutoError(`Retune speed must be a number from 0 to ${retuneMaxMs} ms.`)
      return
    }
    if (strength.trim() === '' || !Number.isFinite(percent) || percent < 0 || percent > 100) {
      setAutoError('Correction strength must be a number from 0 to 100%.')
      return
    }
    const vocal = vocalSettings(setAutoError)
    if (vocal == null)
      return
    setAutoError(null)
    const response = await window.studio.request('processAutoCorrection', {
      jobId: mapped.jobId,
      retuneMs,
      strength: percent,
      root: mapped.mapping.root,
      scale: mapped.mapping.scale,
      targets: mapped.segments.map((segment) => segment.targetMidi),
      ...vocal
    })
    if (!response.ok || response.result == null) {
      setAutoError(response.error ?? 'Automatic correction could not start.')
      return
    }
    const started = response.result as PitchCorrectStart
    autoRef.current = { jobId: started.jobId, trackId: started.trackId, clipId: started.clipId, fraction: 0 }
    setAutoJob(autoRef.current)
    setAutoResult(null)
    const arrived = earlyAuto.current.get(started.jobId)
    earlyAuto.current.clear()
    if (arrived != null)
      finishAuto(arrived)
  }

  async function previewAuto(correctedOn: boolean): Promise<void> {
    if (autoResult == null)
      return
    await pitchCommand('previewPitch', { resultId: autoResult.event.resultId, enabled: correctedOn }, setAutoError)
  }

  async function applyAuto(): Promise<void> {
    if (autoResult == null)
      return
    if (await pitchCommand('applyPitch', { resultId: autoResult.event.resultId }, setAutoError))
      setAutoResult({ ...autoResult, applied: true })
  }

  async function processPitch(): Promise<void> {
    if (chosen == null || processRef.current != null || jobRef.current != null)
      return
    const st = Number(semitones)
    const c = Number(cents)
    if (semitones.trim() === '' || !Number.isInteger(st) || st < -12 || st > 12) {
      setProcessError('Semitones must be a whole number from -12 to +12.')
      return
    }
    if (cents.trim() === '' || !Number.isFinite(c) || c < -100 || c > 100) {
      setProcessError('Cents must be a number from -100 to +100.')
      return
    }
    const vocal = vocalSettings(setProcessError)
    if (vocal == null)
      return
    setProcessError(null)
    const response = await window.studio.request('processPitch', { trackId: chosen.trackId, clipId: chosen.clipId, semitones: st, cents: c, ...vocal })
    if (!response.ok || response.result == null) {
      setProcessError(response.error ?? 'Pitch processing could not start.')
      return
    }
    const started = response.result as PitchProcessStart
    processRef.current = { jobId: started.jobId, trackId: chosen.trackId, clipId: chosen.clipId, fraction: 0 }
    setProcessJob(processRef.current)
    setProcessed(null)
    const arrived = earlyProcess.current.get(started.jobId)
    earlyProcess.current.clear()
    if (arrived != null)
      finishProcess(arrived)
  }

  async function cancelProcess(): Promise<void> {
    const response = await window.studio.request('cancelPitchProcess')
    if (!response.ok)
      setProcessError(response.error ?? 'Processing could not be cancelled.')
  }

  // Runs a command that answers with the engine state and hands that state to the app.
  async function pitchCommand(op: string, payload: Record<string, unknown>,
    report: (message: string | null) => void = setProcessError): Promise<boolean> {
    const response = await window.studio.request(op, payload)
    if (!response.ok || response.result == null) {
      report(response.error ?? 'The audio engine rejected the command.')
      const current = await window.studio.request('getState')
      if (current.ok && current.result != null)
        props.onState(current.result as EngineState)
      return false
    }
    report(null)
    props.onProjectMutation?.(op)
    props.onState(response.result as EngineState)
    return true
  }

  async function setMapping(change: Record<string, unknown>): Promise<void> {
    await pitchCommand('setPitchMapping', change, setMappingError)
  }

  async function chooseTarget(segment: NoteSegmentMapping, value: string): Promise<void> {
    if (mapped == null)
      return
    if (value === '')
      await pitchCommand('resetNoteTarget', { jobId: mapped.jobId, segment: segment.index }, setMappingError)
    else
      await pitchCommand('setNoteTarget', { jobId: mapped.jobId, segment: segment.index, targetMidi: Number(value) }, setMappingError)
  }

  async function clearTargets(): Promise<void> {
    if (mapped == null)
      return
    await pitchCommand('clearNoteTargets', { trackId: mapped.trackId, clipId: mapped.clipId }, setMappingError)
  }

  async function preview(processedOn: boolean): Promise<void> {
    if (processed == null)
      return
    await pitchCommand('previewPitch', { resultId: processed.event.resultId, enabled: processedOn })
  }

  async function apply(): Promise<void> {
    if (processed == null)
      return
    if (await pitchCommand('applyPitch', { resultId: processed.event.resultId }))
      setProcessed({ ...processed, applied: true })
  }

  async function revert(report: (message: string | null) => void = setProcessError): Promise<void> {
    if (chosen == null)
      return
    await pitchCommand('revertPitch', { trackId: chosen.trackId, clipId: chosen.clipId }, report)
  }

  async function cancelAuto(): Promise<void> {
    const response = await window.studio.request('cancelPitchProcess')
    if (!response.ok)
      setAutoError(response.error ?? 'Automatic correction could not be cancelled.')
  }

  async function analyze(): Promise<void> {
    if (chosen == null || jobRef.current != null)
      return
    const params: Record<string, number> = {}
    for (const field of fields) {
      const value = Number(values[field.key])
      if (values[field.key].trim() === '' || !Number.isFinite(value)) {
        setError(`${field.label} must be a number.`)
        return
      }
      params[field.key] = value
    }
    setError(null)
    const response = await window.studio.request('analyzePitch', { trackId: chosen.trackId, clipId: chosen.clipId, ...params })
    if (!response.ok || response.result == null) {
      setError(response.error ?? 'The pitch analysis could not start.')
      return
    }
    const started = response.result as PitchStart
    jobRef.current = { jobId: started.jobId, label: chosen.label, done: 0, total: started.frames }
    setJob(jobRef.current)
    const arrived = early.current.get(started.jobId)
    early.current.clear()
    if (arrived != null)
      finish(arrived)
  }

  async function cancel(): Promise<void> {
    const response = await window.studio.request('cancelPitchAnalysis')
    if (!response.ok)
      setError(response.error ?? 'The analysis could not be cancelled.')
  }

  const event = result?.event
  const frames = event?.frames
  const mappingSettings = props.pitch?.mapping
  const analysedClip = event == null ? undefined
    : props.tracks.find((track) => track.id === event.trackId)?.clips?.find((clip) => clip.id === event.clipId)
  // Settings, overrides (after edits, undo and redo) and clip edits all change the mapping.
  const mappingKey = JSON.stringify([mappingSettings ?? null, analysedClip ?? null])

  useEffect(() => {
    if (event == null || event.status !== 'done') {
      setMapped(null)
      return
    }
    const request = ++mappingRequest.current
    void window.studio.request('getPitchMapping', { jobId: event.jobId }).then((response) => {
      if (request !== mappingRequest.current)
        return
      if (!response.ok || response.result == null) {
        setMapped(null)
        setMappingError(response.error ?? 'The note targets could not be read.')
        return
      }
      setMapped(response.result as PitchMappingResult)
    })
  }, [event?.jobId, mappingKey])

  const segments = mapped != null && mapped.jobId === event?.jobId ? mapped.segments : noSegments
  const voicedMidi = frames == null ? [] : frames.midi.filter((_midi, index) => frames.voiced[index])
  const targetMidi = segments.filter((segment) => segment.targetMidi >= 0).map((segment) => segment.targetMidi)
  const plotted = [...voicedMidi, ...targetMidi]
  const low = plotted.length > 0 ? Math.min(...plotted) - 2 : 57
  const high = plotted.length > 0 ? Math.max(...plotted) + 2 : 69

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas == null || event == null || frames == null)
      return
    const width = canvas.clientWidth
    const height = canvas.clientHeight
    const scale = window.devicePixelRatio || 1
    canvas.width = Math.round(width * scale)
    canvas.height = Math.round(height * scale)
    const context = canvas.getContext('2d')
    if (context == null)
      return
    context.setTransform(scale, 0, 0, scale, 0, 0)
    context.clearRect(0, 0, width, height)
    const span = Math.max(event.duration, 1e-6)
    const x = (time: number): number => time / span * width
    const y = (midi: number): number => height - (midi - low) / Math.max(1, high - low) * height
    // Unvoiced windows: shaded columns.
    context.fillStyle = 'rgba(255, 255, 255, 0.06)'
    const half = event.hopSeconds / 2
    for (let i = 0; i < frames.time.length; i++) {
      if (!frames.voiced[i])
        context.fillRect(x(frames.time[i] - half), 0, Math.max(1, x(2 * half)), height)
    }
    context.strokeStyle = 'rgba(255, 255, 255, 0.12)'
    context.fillStyle = '#7f8ba0'
    context.font = '10px system-ui, sans-serif'
    for (let midi = Math.ceil(low); midi <= high; midi++) {
      if (midi % 12 !== 0 && high - low > 12)
        continue
      context.beginPath()
      context.moveTo(0, y(midi) + 0.5)
      context.lineTo(width, y(midi) + 0.5)
      context.stroke()
      if (midi % 12 === 0 || high - low <= 12)
        context.fillText(noteLabel(midi), 2, y(midi) - 2)
    }
    for (let i = 0; i < frames.time.length; i++) {
      if (!frames.voiced[i])
        continue
      const exact = 69 + 12 * Math.log2(frames.frequency[i] / 440)
      context.fillStyle = `rgba(242, 177, 52, ${0.35 + 0.65 * frames.confidence[i]})`
      context.fillRect(x(frames.time[i]) - 1.5, y(exact) - 1.5, 3, 3)
    }
    // Note segments: the original median (thin) and the target note (bar; purple when manual).
    for (const segment of segments) {
      const left = x(segment.start)
      const right = Math.max(left + 2, x(segment.end))
      context.fillStyle = 'rgba(255, 255, 255, 0.55)'
      context.fillRect(left, y(segment.originalMidi) - 0.5, right - left, 1)
      if (segment.targetMidi < 0)
        continue
      context.fillStyle = segment.targetSource === 'manual' ? 'rgba(180, 140, 255, 0.85)' : 'rgba(76, 175, 122, 0.85)'
      context.fillRect(left, y(segment.targetMidi) - 2, right - left, 4)
    }
    if (hover != null && hover < frames.time.length) {
      context.fillStyle = 'rgba(255, 255, 255, 0.5)'
      context.fillRect(x(frames.time[hover]), 0, 1, height)
    }
  }, [event, frames, low, high, hover, segments])

  function pointAt(pointer: ReactPointerEvent<HTMLCanvasElement>): void {
    if (event == null || frames == null || frames.time.length === 0)
      return
    const box = pointer.currentTarget.getBoundingClientRect()
    const time = (pointer.clientX - box.left) / Math.max(1, box.width) * event.duration
    const index = Math.round((time - frames.time[0]) / event.hopSeconds)
    setHover(Math.max(0, Math.min(frames.time.length - 1, index)))
  }

  const running = job != null
  const processing = processJob != null
  const autoProcessing = autoJob != null
  const busy = running || processing || autoProcessing
  const percent = job == null || job.total <= 0 ? 0 : Math.round(job.done / job.total * 100)
  const summary = event?.summary
  const chosenClip = chosen == null ? undefined
    : props.tracks.find((track) => track.id === chosen.trackId)?.clips?.find((clip) => clip.id === chosen.clipId)
  const shown = processed != null && chosen != null && processed.event.trackId === chosen.trackId && processed.event.clipId === chosen.clipId
    ? processed : null
  const previewing = shown != null && props.pitch?.preview?.resultId === shown.event.resultId
  const done = shown?.event
  // After an undo the clip no longer plays the processed audio and can be applied again.
  const applied = shown?.applied === true && chosenClip?.originalSourceFileId != null
  const autoShown = autoResult != null && chosen != null && autoResult.event.trackId === chosen.trackId && autoResult.event.clipId === chosen.clipId
    ? autoResult : null
  const autoPreviewing = autoShown != null && props.pitch?.preview?.resultId === autoShown.event.resultId
  const autoApplied = autoShown?.applied === true && chosenClip?.originalSourceFileId != null
  const autoMapping = mapped != null && mapped.jobId === event?.jobId && chosen != null && mapped.trackId === chosen.trackId
    && mapped.clipId === chosen.clipId ? mapped : null
  const autoTargets = autoMapping?.segments.filter((segment) => segment.targetMidi >= 0).length ?? 0
  const autoBlocked = autoMapping == null ? 'Analyse this clip first; the correction uses its detected notes and targets.'
    : autoMapping.clipChanged ? 'The clip changed after the analysis. Analyse it again before correcting.'
      : autoTargets === 0 ? 'No note has a target. Turn on Suggest targets or choose manual targets.' : null
  return (
    <section className="pitch-panel" aria-label="Pitch analysis" data-panel="pitch-correction">
      <h2>Pitch analysis</h2>
      {clips.length === 0 ? <p className="hint">Import a WAV file to analyse its pitch.</p> : (
        <>
          <label className="field">
            Clip
            <select aria-label="Pitch clip" value={chosen?.key ?? ''} disabled={busy} onChange={(change) => setChoice(change.target.value)}>
              {clips.map((clip) => <option key={clip.key} value={clip.key}>{clip.label}</option>)}
            </select>
          </label>
          <details className="pitch-settings">
            <summary>Detection settings</summary>
            <div className="pitch-fields">
              {fields.map((field) => (
                <label key={field.key}>
                  {field.label}
                  <input
                    type="number"
                    step={field.step}
                    value={values[field.key]}
                    disabled={running}
                    aria-label={`Pitch ${field.label}`}
                    onChange={(change) => setValues((current) => ({ ...current, [field.key]: change.target.value }))}
                  />
                </label>
              ))}
            </div>
          </details>
          <div className="pitch-actions">
            <button disabled={busy || chosen == null} onClick={() => void analyze()}>Analyze</button>
            <button disabled={!running} onClick={() => void cancel()}>Cancel</button>
            {running && <progress aria-label="Pitch progress" value={job.done} max={Math.max(1, job.total)} />}
            {running && <span className="hint">{percent}%</span>}
          </div>
          <div className="pitch-mapping" aria-label="Target note mapping">
            <h3>Key and target notes</h3>
            <div className="pitch-key-fields">
              <label>
                Key
                <select aria-label="Pitch key" value={mappingSettings?.root ?? 'C'} disabled={mappingSettings == null}
                  onChange={(change) => void setMapping({ root: change.target.value })}>
                  {keyRoots.map((root) => <option key={root.value} value={root.value}>{root.label}</option>)}
                </select>
              </label>
              <label>
                Scale
                <select aria-label="Pitch scale" value={mappingSettings?.scale ?? 'major'} disabled={mappingSettings == null}
                  onChange={(change) => void setMapping({ scale: change.target.value })}>
                  {scaleOptions.map((scale) => <option key={scale.value} value={scale.value}>{scale.label}</option>)}
                </select>
              </label>
              <label className="pitch-mapping-toggle">
                <input type="checkbox" aria-label="Pitch target mapping" checked={mappingSettings?.enabled === true}
                  disabled={mappingSettings == null} onChange={(change) => void setMapping({ enabled: change.target.checked })} />
                Suggest targets
              </label>
            </div>
            <p className="hint">
              {mappingSettings == null ? 'Key and scale are not available from the engine.'
                : `${keyRoots.find((root) => root.value === mappingSettings.root)?.label ?? mappingSettings.root} ${mappingSettings.scaleLabel}: `
                  + mappingSettings.pitchClasses.map((pc) => noteLabel(pc + 60).replace(/-?\d+$/, '')).join(' ')
                  + '. Targets are a preview only; no audio is changed.'}
            </p>
            {mapped != null && mapped.jobId === event?.jobId && (
              <>
                {mapped.clipChanged && (
                  <p className="hint pitch-mapping-stale">The clip changed after this analysis. Analyse it again to edit target notes.</p>
                )}
                {mapped.unmatchedOverrides > 0 && (
                  <p className="hint pitch-mapping-unmatched">
                    {mapped.unmatchedOverrides} manual target{mapped.unmatchedOverrides === 1 ? '' : 's'} on this clip
                    {mapped.unmatchedOverrides === 1 ? ' does' : ' do'} not match a detected note and {mapped.unmatchedOverrides === 1 ? 'is' : 'are'} not used.
                  </p>
                )}
                {segments.length === 0 ? <p className="hint">No steady notes were found for target mapping.</p> : (
                  <ol className="pitch-segments" aria-label="Note targets">
                    {segments.slice(0, 300).map((segment) => (
                      <SegmentRow key={segment.index} segment={segment} pitchClasses={mappingSettings?.pitchClasses ?? []}
                        disabled={busy || mapped.clipChanged} onChoose={(value) => void chooseTarget(segment, value)} />
                    ))}
                  </ol>
                )}
                {segments.length > 300 && <p className="hint">Showing the first 300 of {segments.length} notes.</p>}
                <div className="pitch-actions">
                  <button disabled={busy || mapped.overrideCount === 0} onClick={() => void clearTargets()}>Clear manual targets</button>
                </div>
              </>
            )}
            {mappingError != null && <p className="pitch-error" role="alert">{mappingError}</p>}
          </div>
          <div className="pitch-vocal" aria-label="Vocal quality">
            <h3>Vocal quality</h3>
            <div className="pitch-vocal-fields">
              <label className="pitch-mapping-toggle">
                <input type="checkbox" aria-label="Preserve formants" checked={preserveFormants} disabled={busy}
                  onChange={(change) => setPreserveFormants(change.target.checked)} />
                Preserve formants
              </label>
              <label>
                Formant shift (st)
                <input type="number" min={-formantShiftMax} max={formantShiftMax} step={1} value={formantShift}
                  disabled={busy || !preserveFormants} aria-label="Formant shift" onChange={(change) => setFormantShift(change.target.value)} />
              </label>
              <label>
                Quality
                <select aria-label="Vocal quality mode" value={qualityMode} disabled={busy}
                  onChange={(change) => setQualityMode(change.target.value as VocalQualityMode)}>
                  <option value="standard">Standard</option>
                  <option value="high">High (slower)</option>
                </select>
              </label>
            </div>
            <p className="hint pitch-vocal-hint">
              {preserveFormants
                ? 'For a single voice: keeps the vocal timbre (formants) in place when the pitch changes. Applies to automatic correction and the manual shift.'
                : 'Formants move with the pitch (the plain shift). Applies to automatic correction and the manual shift.'}
            </p>
          </div>
          <div className="pitch-autocorrect" aria-label="Automatic pitch correction">
            <h3>Automatic correction</h3>
            {chosenClip?.originalSourceFileId != null && (
              <p className="hint pitch-auto-state">
                This clip plays processed audio ({chosenClip.pitchLabel ?? centsText(chosenClip.pitchShiftCents ?? 0)}).
              </p>
            )}
            <label className="pitch-mapping-toggle">
              <input type="checkbox" aria-label="Auto correct" checked={autoEnabled} disabled={busy}
                onChange={(change) => setAutoEnabled(change.target.checked)} />
              Auto correct
            </label>
            <div className="pitch-shift-fields">
              <label>
                Retune speed (ms)
                <input type="number" min={0} max={retuneMaxMs} step={1} value={retune} disabled={busy || !autoEnabled}
                  aria-label="Retune speed" onChange={(change) => setRetune(change.target.value)} />
              </label>
              <label>
                Strength (%)
                <input type="number" min={0} max={100} step={1} value={strength} disabled={busy || !autoEnabled}
                  aria-label="Correction strength" onChange={(change) => setStrength(change.target.value)} />
              </label>
            </div>
            <p className="hint pitch-auto-hint">
              {!autoEnabled ? 'Turn on Auto correct to move each analysed note towards its target note.'
                : autoBlocked ?? `${autoTargets} of ${autoMapping?.segments.length ?? 0} notes have a target. Retune 0 ms snaps at once, 200 ms glides slowly; strength 0% leaves the audio unchanged.`}
            </p>
            <div className="pitch-actions">
              <button disabled={busy || !autoEnabled || autoBlocked != null} onClick={() => void processAuto()}>Process auto correction</button>
              <button disabled={!autoProcessing} aria-label="Cancel auto correction" onClick={() => void cancelAuto()}>Cancel</button>
              {autoProcessing && <progress aria-label="Auto correction progress" value={autoJob.fraction} max={1} />}
              {autoProcessing && <span className="hint">{Math.round(autoJob.fraction * 100)}%</span>}
            </div>
            {autoShown != null && (
              <>
                <p className="hint pitch-auto-summary">{autoSummary(autoShown.event)}</p>
                {(autoShown.event.notes ?? []).length > 0 && (
                  <ol className="pitch-auto-notes" aria-label="Corrected notes">
                    {(autoShown.event.notes ?? []).slice(0, 300).map((note) => (
                      <li key={note.index}>
                        <span>{note.start.toFixed(2)}–{note.end.toFixed(2)} s</span>
                        <strong>{note.targetName}</strong>
                        <span>{note.originalCents != null && note.correctedCents != null
                          ? `${signed(note.originalCents, 1)} → ${signed(note.correctedCents, 1)} c` : 'too short to measure'}</span>
                        <span>{note.glide === true ? 'glide, kept' : `${note.transitionMs.toFixed(0)} ms`}</span>
                      </li>
                    ))}
                  </ol>
                )}
                {!autoApplied && (
                  <>
                    <div className="pitch-auto-ab" role="group" aria-label="Auto correction preview">
                      <button aria-pressed={!autoPreviewing} onClick={() => void previewAuto(false)}>Original</button>
                      <button aria-pressed={autoPreviewing} onClick={() => void previewAuto(true)}>Corrected</button>
                    </div>
                    <p className="hint">The preview changes playback only. Press Play to listen; the clip is unchanged until you apply.</p>
                  </>
                )}
                {autoApplied && <p className="hint">Applied to the clip. Undo or Revert to original restores it.</p>}
              </>
            )}
            <div className="pitch-actions">
              <button disabled={busy || autoShown == null || autoApplied} onClick={() => void applyAuto()}>Apply to clip</button>
              <button disabled={busy || chosenClip?.originalSourceFileId == null} onClick={() => void revert(setAutoError)}>Revert to original</button>
            </div>
            {autoError != null && <p className="pitch-error" role="alert">{autoError}</p>}
          </div>
          <div className="pitch-correction" aria-label="Pitch correction">
            <h3>Manual pitch shift</h3>
            {chosenClip?.originalSourceFileId != null && (
              <p className="hint pitch-clip-state">
                This clip plays pitch-processed audio ({chosenClip.pitchLabel ?? centsText(chosenClip.pitchShiftCents ?? 0)}).
              </p>
            )}
            <div className="pitch-shift-fields">
              <label>
                Semitones
                <input type="number" min={-12} max={12} step={1} value={semitones} disabled={busy}
                  aria-label="Pitch shift semitones" onChange={(change) => setSemitones(change.target.value)} />
              </label>
              <label>
                Cents
                <input type="number" min={-100} max={100} step={1} value={cents} disabled={busy}
                  aria-label="Pitch shift cents" onChange={(change) => setCents(change.target.value)} />
              </label>
            </div>
            <div className="pitch-actions">
              <button disabled={busy || chosen == null} onClick={() => void processPitch()}>Process</button>
              <button disabled={!processing} aria-label="Cancel pitch processing" onClick={() => void cancelProcess()}>Cancel</button>
              {processing && <progress aria-label="Pitch correction progress" value={processJob.fraction} max={1} />}
              {processing && <span className="hint">{Math.round(processJob.fraction * 100)}%</span>}
            </div>
            {done != null && shown != null && (
              <>
                <p className="hint pitch-process-summary">
                  {done.label ?? shiftText(done.semitones, done.cents)}
                  {done.identity === true ? ' · no shift, audio copied unchanged' : ''}
                  {done.originalHz != null && done.originalHz > 0 && done.processedHz != null && done.processedHz > 0
                    ? ` · ${done.originalHz.toFixed(1)} → ${done.processedHz.toFixed(1)} Hz (expected ${done.expectedHz?.toFixed(1)}, ${signed(done.deviationCents ?? 0, 1)} c)`
                    : ' · no steady pitch to measure'}
                  {` · ${done.duration.toFixed(2)} s in ${(done.elapsedSeconds * 1000).toFixed(0)} ms`}
                  {done.gainReductionDb != null && done.gainReductionDb > 0 ? ` · lowered ${done.gainReductionDb.toFixed(1)} dB to avoid clipping` : ''}
                </p>
                {!applied && (
                  <>
                    <div className="pitch-ab" role="group" aria-label="Preview">
                      <button aria-pressed={!previewing} onClick={() => void preview(false)}>Original</button>
                      <button aria-pressed={previewing} onClick={() => void preview(true)}>Processed</button>
                    </div>
                    <p className="hint">The preview changes playback only. Press Play to listen; the clip is unchanged until you apply.</p>
                  </>
                )}
                {applied && <p className="hint">Applied to the clip. Undo or Revert to original restores it.</p>}
              </>
            )}
            <div className="pitch-actions">
              <button disabled={busy || shown == null || applied} onClick={() => void apply()}>Apply to clip</button>
              <button disabled={busy || chosenClip?.originalSourceFileId == null} onClick={() => void revert()}>Revert to original</button>
            </div>
            {processError != null && <p className="pitch-error" role="alert">{processError}</p>}
          </div>
        </>
      )}
      {error != null && <p className="pitch-error" role="alert">{error}</p>}
      {event != null && frames != null && summary != null && (
        <div className="pitch-result">
          <p className="hint pitch-summary">
            {event.status === 'cancelled' ? `Cancelled after ${summary.frames} windows. ` : ''}
            {result?.label}: {summary.medianNote != null ? `median ${summary.medianNote} (${summary.medianFrequency?.toFixed(1)} Hz)` : 'no voiced pitch'}
            {` · voiced ${Math.round(summary.voicedRatio * 100)}% · ${summary.frames} windows · ${(event.elapsedSeconds * 1000).toFixed(0)} ms`}
          </p>
          <canvas
            ref={canvasRef}
            className="pitch-plot"
            aria-label="Pitch over time"
            onPointerMove={pointAt}
            onPointerLeave={() => setHover(null)}
          />
          <p className="pitch-readout" aria-label="Pitch at pointer">
            {hover == null ? 'Point at the plot for frequency and confidence.' : frames.voiced[hover]
              ? `${frames.time[hover].toFixed(3)} s · ${frames.note[hover]} ${frames.frequency[hover].toFixed(2)} Hz · ${signed(frames.cents[hover], 1)} c · confidence ${frames.confidence[hover].toFixed(2)}`
              : `${frames.time[hover].toFixed(3)} s · unvoiced · confidence ${frames.confidence[hover].toFixed(2)}`}
          </p>
          <ol className="pitch-notes" aria-label="Detected notes">
            {event.notes.slice(0, 300).map((note, index) => (
              <li key={index}>
                <span>{note.start.toFixed(2)}–{note.end.toFixed(2)} s</span>
                <strong>{note.name}</strong>
                <span>{note.frequency.toFixed(1)} Hz</span>
                <span>{signed(note.cents, 0)} c</span>
                <span>{Math.round(note.confidence * 100)}%</span>
              </li>
            ))}
          </ol>
          {event.notes.length > 300 && <p className="hint">Showing the first 300 of {event.notes.length} notes.</p>}
        </div>
      )}
    </section>
  )
}

function SegmentRow(props: {
  segment: NoteSegmentMapping
  pitchClasses: number[]
  disabled: boolean
  onChoose: (value: string) => void
}) {
  const { segment } = props
  const manual = segment.targetSource === 'manual'
  const number = segment.index + 1
  const choices: number[] = []
  for (let midi = Math.max(0, segment.nearestMidi - 12); midi <= Math.min(127, segment.nearestMidi + 12); midi++)
    choices.push(midi)
  if (manual && !choices.includes(segment.overrideMidi))
    choices.push(segment.overrideMidi)
  const inKey = (midi: number): boolean => props.pitchClasses.includes(((midi % 12) + 12) % 12)
  return (
    <li className={manual ? 'overridden' : undefined} data-segment={segment.index}>
      <div className="pitch-segment-info">
        <span className="pitch-segment-time">{segment.timelineStart.toFixed(2)}–{segment.timelineEnd.toFixed(2)} s</span>
        <span className="pitch-segment-original" title={`${segment.originalFrequency.toFixed(1)} Hz`}>
          {segment.nearestName} {signed(segment.nearestCents, 0)} c
        </span>
        <span className="pitch-segment-suggested">
          {segment.suggestedMidi >= 0 ? `→ ${segment.suggestedName} (${signed(segment.suggestedCents, 0)} c)` : '→ no suggestion'}
        </span>
        {manual && <span className="pitch-manual">manual</span>}
      </div>
      <select aria-label={`Target note ${number}`} value={manual ? String(segment.overrideMidi) : ''} disabled={props.disabled}
        onChange={(change) => props.onChoose(change.target.value)}>
        <option value="">{segment.suggestedMidi >= 0 ? `Auto (${segment.suggestedName})` : 'Auto (none)'}</option>
        {choices.map((midi) => (
          <option key={midi} value={String(midi)}>{noteLabel(midi)}{inKey(midi) ? '' : ' · out of key'}</option>
        ))}
      </select>
      <span className="pitch-segment-target" aria-label={`Correction ${number}`}>
        {segment.targetMidi >= 0 ? `${segment.targetName} ${signed(segment.targetCents, 0)} c` : '—'}
      </span>
      <button aria-label={`Reset target ${number}`} disabled={props.disabled || !manual} onClick={() => props.onChoose('')}>Reset</button>
    </li>
  )
}

function autoSummary(done: PitchCorrectResultEvent): string {
  const parts = [done.label]
  if (done.identity === true)
    parts.push('nothing changed, audio copied unchanged')
  else if (done.worstRemainingCents != null)
    parts.push(`worst remaining error ${done.worstRemainingCents.toFixed(1)} c`)
  parts.push(`${done.duration.toFixed(2)} s in ${((done.correctionSeconds ?? done.elapsedSeconds) * 1000).toFixed(0)} ms`
    + (done.realtimeFactor != null && done.realtimeFactor > 0 ? ` (${done.realtimeFactor.toFixed(0)}× real time)` : ''))
  if (done.glideNotes != null && done.glideNotes > 0)
    parts.push(`${done.glideNotes} glide${done.glideNotes === 1 ? '' : 's'} left uncorrected`)
  if (done.gainReductionDb != null && done.gainReductionDb > 0)
    parts.push(`lowered ${done.gainReductionDb.toFixed(1)} dB to avoid clipping`)
  return parts.join(' · ')
}

function noteLabel(midi: number): string {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
  return `${names[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`
}
