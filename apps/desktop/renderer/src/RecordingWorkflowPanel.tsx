import { useEffect, useState } from 'react'
import type {
  EngineState,
  InputMeter,
  LiveCorrectionStatus,
  LiveMonitorMode,
  RecordingLatencyState,
  RecordTake,
  TrackState
} from '../../../../packages/shared/src/protocol'
import {
  INPUT_LEVEL_THRESHOLDS,
  formatDbFS,
  inputLevelGuidance,
  inputLevelLabel,
  meterBarFraction
} from './inputLevel'

type Command = (op: string, payload?: Record<string, unknown>, timeoutMs?: number) => Promise<boolean>

function formatTime(seconds: number): string {
  const s = Math.max(0, seconds)
  const m = Math.floor(s / 60)
  const r = s - m * 60
  return `${m}:${r.toFixed(1).padStart(4, '0')}`
}

function takeSummary(take: RecordTake | null | undefined): string {
  if (take == null)
    return ''
  const files = take.takes.map((item) => item.path.split(/[/\\]/).pop()).filter(Boolean)
  return [files.length > 0 ? `Last take: ${files.join(', ')} @ ${formatTime(take.startSeconds)}` : 'Nothing was recorded.', ...take.warnings].join(' ')
}

function InputLevelMeter(props: { meter: InputMeter | null }) {
  const guidance = inputLevelGuidance(props.meter)
  const available = props.meter?.available === true
  const channels = props.meter?.channels ?? 0
  const stereo = channels >= 2
  const peakDb = props.meter?.peakDbFS ?? -120
  const rmsDb = props.meter?.rmsDbFS ?? -120
  const clip = props.meter?.clip === true

  return (
    <div className="input-level-block" data-input-level-272>
      <h3 className="karaoke-subhead">Input level</h3>
      <p className="hint">
        Measured on captured samples after Input Gain (what recording sees). Software gain cannot repair hardware ADC clipping.
        Guidance thresholds are MSP defaults ({INPUT_LEVEL_THRESHOLDS.tooLowDbFS} / {INPUT_LEVEL_THRESHOLDS.nearClipDbFS} / {INPUT_LEVEL_THRESHOLDS.clipDbFS} dBFS), not universal standards.
      </p>
      {!available && (
        <p className="workflow-banner" data-input-level-unavailable role="status">Unavailable — no measurable input stream (open a mic, Apply devices, or enable virtual test signal).</p>
      )}
      <div className="input-level-readout" data-input-level-readout aria-live="polite">
        <span data-input-peak-db>{available ? `Peak ${formatDbFS(peakDb)}` : 'Peak —'}</span>
        <span data-input-rms-db>{available ? `RMS ${formatDbFS(rmsDb)}` : 'RMS —'}</span>
        <span
          className={`input-level-guidance guidance-${guidance}${clip ? ' clip' : ''}`}
          data-input-level-guidance={guidance}
        >{inputLevelLabel(guidance)}</span>
      </div>
      <div className="input-meter-bars" data-input-meter-bars aria-hidden={!available}>
        <div className="input-meter-channel" data-input-channel="L">
          <span className="input-meter-label">L</span>
          <div className={`meter-bar input-meter-bar${clip ? ' clipped' : ''}`}>
            <span
              className={guidance === 'clipping' ? 'clip' : guidance === 'near-clip' ? 'hot' : ''}
              style={{ height: `${available ? meterBarFraction(props.meter?.levelL ?? 0) * 100 : 0}%` }}
            />
            <i
              className="input-peak-hold"
              style={{ bottom: `${available ? meterBarFraction(props.meter?.peakHoldL ?? 0) * 100 : 0}%` }}
            />
          </div>
        </div>
        {stereo && (
          <div className="input-meter-channel" data-input-channel="R">
            <span className="input-meter-label">R</span>
            <div className={`meter-bar input-meter-bar${clip ? ' clipped' : ''}`}>
              <span
                className={guidance === 'clipping' ? 'clip' : guidance === 'near-clip' ? 'hot' : ''}
                style={{ height: `${available ? meterBarFraction(props.meter?.levelR ?? 0) * 100 : 0}%` }}
              />
              <i
                className="input-peak-hold"
                style={{ bottom: `${available ? meterBarFraction(props.meter?.peakHoldR ?? 0) * 100 : 0}%` }}
              />
            </div>
          </div>
        )}
        {!stereo && available && channels === 1 && (
          <span className="hint" data-input-mono>Mono input</span>
        )}
      </div>
    </div>
  )
}

/**
 * Editor recording status + monitoring summary (Phase 2.7.1) with input gain/level (2.7.2).
 * Reuses engine record / setTrackRecord / Live Auto-Tune — does not duplicate Karaoke Studio.
 */
export function RecordingWorkflowPanel(props: {
  state: EngineState | null
  inputDevice: string
  armedTracks: TrackState[]
  recording: boolean
  recordElapsed: number
  virtualInput: boolean
  inputMeter: InputMeter | null
  busy?: boolean
  /** When false, treat as disconnected even if a stale EngineState is still cached. */
  engineConnected?: boolean
  command: Command
  onRecord: () => Promise<void>
  onReview: () => Promise<void>
  onRetake: () => Promise<void>
  onChooseFolder: () => Promise<void>
}) {
  const [live, setLive] = useState<LiveCorrectionStatus | null>(null)
  const [gainDraft, setGainDraft] = useState(0)
  const [latency, setLatency] = useState<RecordingLatencyState | null>(null)
  const [offsetDraft, setOffsetDraft] = useState(0)
  const [latencyNotice, setLatencyNotice] = useState('')
  const engineDisconnected = props.engineConnected === false || props.state == null
  const deviceOpen = !engineDisconnected && props.state?.deviceOpen === true
  const inputChannels = props.state?.inputChannels ?? 0
  const noMic = !props.virtualInput && inputChannels <= 0
  const monitoringOn = props.armedTracks.some((track) => track.monitorInput)
  const lastTake = props.state?.record?.lastTake ?? null
  const canRecord = !engineDisconnected && deviceOpen && props.armedTracks.length > 0 && !noMic
  const canReview = !props.recording && !engineDisconnected && (lastTake != null || props.armedTracks.some((t) => (t.takes?.length ?? 0) > 0 || t.clips.length > 0))
  const inputGainDb = props.state?.inputGainDb ?? 0
  const latencyFromState = props.state?.record?.latency ?? null
  const effectiveInput = (props.state?.inputDevice && props.state.inputDevice.length > 0)
    ? props.state.inputDevice
    : props.inputDevice

  useEffect(() => {
    setGainDraft(inputGainDb)
  }, [inputGainDb])

  useEffect(() => {
    if (latencyFromState != null) {
      setLatency(latencyFromState)
      setOffsetDraft(latencyFromState.offsetMs)
      return
    }
    if (engineDisconnected) {
      setLatency(null)
      return
    }
    let cancelled = false
    void window.studio.request('getRecordingLatency').then((response) => {
      if (!cancelled && response.ok && response.result != null) {
        const next = response.result as RecordingLatencyState
        setLatency(next)
        setOffsetDraft(next.offsetMs)
      }
    })
    return () => { cancelled = true }
  }, [engineDisconnected, latencyFromState, props.state?.outputDevice, props.state?.inputDevice, props.state?.sampleRate, props.state?.bufferSize])

  useEffect(() => {
    let cancelled = false
    void window.studio.request('getLiveCorrection').then((response) => {
      if (!cancelled && response.ok && response.result != null)
        setLive(response.result as LiveCorrectionStatus)
    })
    return () => { cancelled = true }
  }, [props.recording, props.state?.transport])

  useEffect(() => {
    if (live?.enabled !== true)
      return
    const timer = window.setInterval(() => {
      void window.studio.request('getLiveCorrection', {}, 2000).then((response) => {
        if (response.ok && response.result != null)
          setLive(response.result as LiveCorrectionStatus)
      })
    }, 500)
    return () => window.clearInterval(timer)
  }, [live?.enabled])

  async function setMonitorMode(mode: LiveMonitorMode): Promise<void> {
    const response = await window.studio.request('setLiveCorrection', { monitorMode: mode })
    if (response.ok && response.result != null)
      setLive(response.result as LiveCorrectionStatus)
  }

  async function commitInputGain(db: number): Promise<void> {
    const clamped = Math.max(-24, Math.min(24, db))
    setGainDraft(clamped)
    await props.command('setInputGain', { gainDb: clamped })
  }

  async function commitOffset(ms: number): Promise<void> {
    const clamped = Math.max(-500, Math.min(500, ms))
    setOffsetDraft(clamped)
    const response = await window.studio.request('setRecordingOffset', { offsetMs: clamped })
    if (response.ok && response.result != null) {
      setLatency(response.result as RecordingLatencyState)
      setLatencyNotice('Manual offset saved for this device profile. Applies to new recordings only.')
    } else {
      setLatencyNotice(response.error ?? 'Could not set recording offset.')
    }
  }

  async function resetOffset(): Promise<void> {
    const response = await window.studio.request('resetRecordingOffset')
    if (response.ok && response.result != null) {
      const next = response.result as RecordingLatencyState
      setLatency(next)
      setOffsetDraft(next.offsetMs)
      setLatencyNotice('Recording offset reset to 0 ms for this device profile.')
    } else {
      setLatencyNotice(response.error ?? 'Could not reset recording offset.')
    }
  }

  const statusLines = [
    engineDisconnected ? 'Engine: disconnected' : (deviceOpen ? 'Engine: connected · device open' : 'Engine: connected · device closed'),
    props.virtualInput
      ? 'Input: virtual test signal'
      : (effectiveInput
        ? `Input: ${effectiveInput}${inputChannels ? ` (${inputChannels} ch)` : ' (none open)'}`
        : `Input: none selected${inputChannels ? ` · ${inputChannels} ch open` : ''}`),
    props.armedTracks.length === 0
      ? 'Armed track: none — press R on a track lane'
      : `Armed: ${props.armedTracks.map((t) => t.name || t.id).join(', ')}`,
    props.recording
      ? `Recording: active · ${formatTime(props.recordElapsed)}${(props.state?.record?.droppedFrames ?? 0) > 0 ? ` · ${props.state?.record?.droppedFrames} frames dropped` : ''}`
      : 'Recording: idle',
    `Track input monitor: ${monitoringOn ? 'ON (headphones recommended)' : 'OFF'}`,
    live?.enabled === true
      ? `Auto-Tune monitor: ${live.monitorMode === 'raw' ? 'RAW (aligned)' : 'CORRECTED'} · recording stays corrected`
      : 'Auto-Tune monitor: off (enable Auto-Tune below for RAW/CORRECTED)',
    lastTake != null && !props.recording ? takeSummary(lastTake) : null
  ].filter(Boolean) as string[]

  return (
    <section className="record-panel recording-workflow" data-panel="recording-workflow-271" aria-label="Recording workflow">
      <h2>Recording workflow</h2>
      <p className="hint">
        Arm a track (R), choose input, then Record. Recording starts transport from the playhead so other tracks play as backing.
        Earlier takes stay intact — retake adds another take (Phase 2.6.1 comps).
      </p>

      {engineDisconnected && (
        <p className="workflow-banner" data-recording-engine-error role="alert">Audio engine disconnected. Recording is unavailable.</p>
      )}
      {!engineDisconnected && noMic && (
        <p className="workflow-banner" data-recording-mic-error role="alert">
          No microphone input. Choose an input device and Apply devices, or use the virtual test signal.
        </p>
      )}
      {!engineDisconnected && !deviceOpen && (
        <p className="workflow-banner" data-recording-device-error role="alert">Audio device is closed. Apply devices to open output/input.</p>
      )}

      <ul className="recording-status-list" data-recording-status>
        {statusLines.map((line) => <li key={line}>{line}</li>)}
      </ul>

      <InputLevelMeter meter={engineDisconnected ? null : props.inputMeter} />

      <div className="input-gain-block" data-input-gain-272>
        <h3 className="karaoke-subhead">Input Gain</h3>
        <p className="hint">
          Software gain before Live DSP and recording (unity 0 dB). Distinct from Monitor Volume (armed track Gain) and Track Volume.
          Does not change master or Mic monitor level. Cannot undo hardware clipping.
        </p>
        <label className="field input-gain-field">
          Input Gain ({gainDraft >= 0 ? '+' : ''}{gainDraft.toFixed(1)} dB)
          <input
            type="range"
            min={-24}
            max={24}
            step={0.5}
            value={gainDraft}
            disabled={engineDisconnected || props.busy}
            aria-label="Input Gain dB"
            data-action="input-gain"
            onChange={(event) => setGainDraft(Number(event.target.value))}
            onMouseUp={() => void commitInputGain(gainDraft)}
            onTouchEnd={() => void commitInputGain(gainDraft)}
            onBlur={() => void commitInputGain(gainDraft)}
          />
        </label>
        <button
          type="button"
          data-action="input-gain-unity"
          disabled={engineDisconnected || props.busy}
          onClick={() => void commitInputGain(0)}
        >Reset to 0 dB (unity)</button>
      </div>

      <div className="recording-latency-block" data-recording-latency-274>
        <h3 className="karaoke-subhead">Recording latency calibration</h3>
        <p className="hint">
          Placement offset for <em>new</em> takes only (existing takes are never moved).
          Positive ms places the take later; negative places it earlier — if vocals sit late vs backing, use a negative offset.
          Reported device latency is output-only and is not treated as measured round-trip. Live Auto-Tune DSP delay is already in recorded samples and is not subtracted again here.
        </p>
        {engineDisconnected ? (
          <p className="workflow-banner" data-latency-unavailable role="status">Unavailable — engine disconnected.</p>
        ) : (
          <>
            <ul className="recording-status-list" data-latency-status>
              <li data-latency-offset>Current offset: {offsetDraft >= 0 ? '+' : ''}{offsetDraft.toFixed(1)} ms ({latency?.offsetSamples ?? 0} samples)</li>
              <li data-latency-method>Calibration method: {latency?.method ?? 'none'}</li>
              <li data-latency-devices>
                Devices: out {latency?.outputDevice || props.state?.outputDevice || '—'} · in {latency?.inputDevice || effectiveInput || 'none'} · {latency?.sampleRate ?? props.state?.sampleRate ?? '—'} Hz · buffer {latency?.bufferSize ?? props.state?.bufferSize ?? '—'}
              </li>
              <li data-latency-reported>
                Reported output latency: {typeof latency?.reportedOutputLatencyMs === 'number' ? `${latency.reportedOutputLatencyMs.toFixed(1)} ms` : '—'} (not round-trip)
              </li>
              <li data-latency-estimate>
                Last measured estimate:{' '}
                {latency?.lastEstimate != null
                  ? `${latency.lastEstimate.delayMs.toFixed(1)} ms delay · confidence ${(latency.lastEstimate.confidence * 100).toFixed(0)}% · ${latency.lastEstimate.reliable ? 'reliable' : 'not reliable'} — not auto-applied`
                  : 'none (physical loopback not run)'}
              </li>
            </ul>
            <label className="field">
              Recording placement offset ({offsetDraft >= 0 ? '+' : ''}{offsetDraft.toFixed(1)} ms)
              <input
                type="range"
                min={-500}
                max={500}
                step={1}
                value={offsetDraft}
                disabled={props.recording || props.busy}
                aria-label="Recording placement offset milliseconds"
                data-action="recording-offset"
                onChange={(event) => setOffsetDraft(Number(event.target.value))}
                onMouseUp={() => void commitOffset(offsetDraft)}
                onTouchEnd={() => void commitOffset(offsetDraft)}
                onBlur={() => void commitOffset(offsetDraft)}
              />
            </label>
            <div className="karaoke-actions">
              <button type="button" data-action="recording-offset-reset" disabled={props.recording || props.busy || engineDisconnected} onClick={() => void resetOffset()}>
                Reset offset to 0 ms
              </button>
            </div>
            <p className="hint" data-latency-loopback-help>
              Optional physical loopback: route the audio output into the mic/line input with a cable (authorized connection only),
              play a short click/pulse while recording that input, then use estimateRecordingLatency with the reference and recorded WAVs.
              Unreliable estimates are never applied automatically. Physical loopback: NOT RUN — NO HARDWARE in automated checks.
            </p>
            {latencyNotice !== '' && <p className="hint" data-latency-notice>{latencyNotice}</p>}
          </>
        )}
      </div>

      <div className="karaoke-actions recording-actions">
        <button
          type="button"
          className={`record-button${props.recording ? ' on' : ''}`}
          data-action="recording-start-stop"
          aria-pressed={props.recording}
          disabled={props.busy || (props.recording ? false : !canRecord)}
          title={props.recording
            ? 'Stop recording and place the take'
            : !canRecord
              ? 'Arm a track and open a mic (or virtual input) first'
              : 'Stops playback if needed, then records from the playhead while arrangement plays'}
          onClick={() => void props.onRecord()}
        >{props.recording ? 'Stop recording' : 'Start recording'}</button>
        <button
          type="button"
          data-action="recording-review"
          disabled={props.busy || props.recording || !canReview}
          onClick={() => void props.onReview()}
        >Review take</button>
        <button
          type="button"
          data-action="recording-retake"
          disabled={props.busy || props.recording || !canRecord}
          title="Seek to the last take start (or playhead) and record again — previous takes remain"
          onClick={() => void props.onRetake()}
        >Retake</button>
      </div>

      <div className="recording-monitor-block" data-recording-monitor>
        <h3 className="karaoke-subhead">Monitoring</h3>
        <p className="hint">
          Track Monitor hears input only while transport plays. Global Mic monitor (devices bar) is a separate raw undelayed path — prefer headphones to avoid feedback.
          Monitoring level follows the armed track’s Gain fader (Monitor Volume) — not Input Gain.
        </p>
        {props.armedTracks.map((track) => {
          const label = track.name || track.id
          return (
            <div className="record-track" key={track.id} data-recording-armed={track.id}>
              <span className="record-name">● {label}{track.armed ? ' (armed)' : ''}</span>
              <button
                type="button"
                data-action="recording-track-monitor"
                data-track-id={track.id}
                aria-pressed={track.monitorInput}
                title="Hear the input through this track while the transport runs"
                onClick={() => void props.command('setTrackRecord', { trackId: track.id, monitor: !track.monitorInput })}
              >Input monitor {track.monitorInput ? 'ON' : 'OFF'}</button>
            </div>
          )
        })}
        {props.armedTracks.length === 0 && (
          <p className="hint" data-recording-no-arm>Arm a track to enable per-track input monitoring.</p>
        )}
        <label className="field">
          Auto-Tune monitor (when Auto-Tune is on)
          <select
            aria-label="Recording Auto-Tune monitor mode"
            data-action="recording-monitor-mode"
            value={live?.monitorMode ?? 'corrected'}
            disabled={live == null || live.enabled !== true}
            onChange={(event) => void setMonitorMode(event.target.value as LiveMonitorMode)}
          >
            <option value="corrected">CORRECTED</option>
            <option value="raw">RAW (aligned)</option>
          </select>
        </label>
      </div>

      <button type="button" data-action="recording-choose-folder" disabled={props.recording || props.busy} onClick={() => void props.onChooseFolder()}>
        Choose record folder
      </button>
      <p className="path" data-recording-folder title={props.state?.record?.folder ?? ''}>Folder: {props.state?.record?.folder ?? ''}</p>
    </section>
  )
}
