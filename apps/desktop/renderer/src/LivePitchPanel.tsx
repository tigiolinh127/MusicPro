import { useEffect, useRef, useState } from 'react'
import {
  keyRoots,
  scaleOptions,
  type EngineState,
  type LivePitchInput,
  type LivePitchStatus,
  type PitchMappingSettings
} from '../../../../packages/shared/src/protocol'

const pollMs = 100   // 10 updates per second while detection is on
const staleMs = 500

const inputs: Array<{ value: LivePitchInput, label: string }> = [
  { value: 'input1', label: 'Input 1' },
  { value: 'input2', label: 'Input 2' },
  { value: 'mix', label: 'Inputs 1+2' }
]

function signed(value: number, digits: number): string {
  const shown = Number(value.toFixed(digits))   // -0.3 shows as +0, not -0
  return `${shown >= 0 ? '+' : ''}${shown.toFixed(digits)}`
}

// Live input pitch diagnostics. The engine analyses a copy of the live input (device or test
// signal) on its own worker thread; this panel only polls the latest result. No audio changes.
export function LivePitchPanel(props: {
  mapping: PitchMappingSettings | undefined
  onState: (state: EngineState) => void
  /** Phase 2.9.5 — mark dirty when key/scale mapping changes. */
  onProjectMutation?: (op: string) => void
}) {
  const [status, setStatus] = useState<LivePitchStatus | null>(null)
  const [correctionOn, setCorrectionOn] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busy = useRef(false)

  useEffect(() => {
    void window.studio.request('getLivePitch').then((response) => {
      if (response.ok && response.result != null)
        setStatus(response.result as LivePitchStatus)
    })
    void window.studio.request('getLiveCorrection').then((response) => {
      if (response.ok && response.result != null)
        setCorrectionOn((response.result as { enabled?: boolean }).enabled === true)
    })
  }, [])

  const enabled = status?.enabled === true
  useEffect(() => {
    if (!enabled)
      return
    const timer = window.setInterval(() => {
      if (busy.current)
        return
      busy.current = true
      void Promise.all([
        window.studio.request('getLivePitch', {}, 2000),
        window.studio.request('getLiveCorrection', {}, 2000)
      ]).then(([pitch, correction]) => {
        if (pitch.ok && pitch.result != null)
          setStatus(pitch.result as LivePitchStatus)
        if (correction.ok && correction.result != null)
          setCorrectionOn((correction.result as { enabled?: boolean }).enabled === true)
      }).finally(() => { busy.current = false })
    }, pollMs)
    return () => window.clearInterval(timer)
  }, [enabled])

  // When Detect is off, still refresh Auto-Tune status occasionally so the badge stays honest.
  useEffect(() => {
    if (enabled)
      return
    const timer = window.setInterval(() => {
      void window.studio.request('getLiveCorrection', {}, 2000).then((response) => {
        if (response.ok && response.result != null)
          setCorrectionOn((response.result as { enabled?: boolean }).enabled === true)
      })
    }, 1000)
    return () => window.clearInterval(timer)
  }, [enabled])

  async function configure(change: Record<string, unknown>): Promise<void> {
    const response = await window.studio.request('setLivePitch', change)
    if (!response.ok || response.result == null) {
      setError(response.error ?? 'The audio engine rejected the live pitch settings.')
      return
    }
    setError(null)
    setStatus(response.result as LivePitchStatus)
  }

  async function setKey(change: Record<string, unknown>): Promise<void> {
    const response = await window.studio.request('setPitchMapping', change)
    if (!response.ok || response.result == null) {
      setError(response.error ?? 'The audio engine rejected the key.')
      return
    }
    setError(null)
    props.onProjectMutation?.('setPitchMapping')
    props.onState(response.result as EngineState)
  }

  const latest = status?.latest
  const stats = status?.statistics
  const fresh = latest != null && latest.ageMs < staleMs
  const voiced = fresh && latest.voiced
  const hasTarget = voiced && latest.targetMidi >= 0
  const dash = '—'
  return (
    <section className="live-pitch-panel" aria-label="Live pitch">
      <h2>Live pitch</h2>
      <div className="live-pitch-fields">
        <label className="pitch-mapping-toggle">
          <input type="checkbox" aria-label="Live pitch detection" checked={enabled} disabled={status == null}
            onChange={(change) => void configure({ enabled: change.target.checked })} />
          Detect
        </label>
        <label>
          Input
          <select aria-label="Live pitch input" value={status?.input ?? 'mix'} disabled={status == null}
            onChange={(change) => void configure({ input: change.target.value })}>
            {inputs.map((input) => <option key={input.value} value={input.value}>{input.label}</option>)}
          </select>
        </label>
        <label>
          Key
          <select aria-label="Live pitch key" value={props.mapping?.root ?? 'C'} disabled={props.mapping == null}
            onChange={(change) => void setKey({ root: change.target.value })}>
            {keyRoots.map((root) => <option key={root.value} value={root.value}>{root.label}</option>)}
          </select>
        </label>
        <label>
          Scale
          <select aria-label="Live pitch scale" value={props.mapping?.scale ?? 'major'} disabled={props.mapping == null}
            onChange={(change) => void setKey({ scale: change.target.value })}>
            {scaleOptions.map((scale) => <option key={scale.value} value={scale.value}>{scale.label}</option>)}
          </select>
        </label>
      </div>
      {enabled && (
        <>
          <dl className="live-pitch-readout" aria-label="Live pitch readout">
            <div><dt>Note</dt><dd className="live-pitch-note">{voiced && latest.noteName !== '' ? latest.noteName : dash}</dd></div>
            <div><dt>Hz</dt><dd className="live-pitch-frequency">{voiced ? latest.frequency.toFixed(1) : dash}</dd></div>
            <div><dt>Cents</dt><dd className="live-pitch-cents">{voiced ? signed(latest.cents, 0) : dash}</dd></div>
            <div><dt>Conf.</dt><dd className="live-pitch-confidence">{fresh ? `${Math.round(latest.confidence * 100)}%` : dash}</dd></div>
            <div><dt>Target</dt><dd className="live-pitch-target">{hasTarget ? latest.targetName : dash}</dd></div>
            <div>
              <dt>Fix</dt>
              <dd className={`live-pitch-correction${hasTarget && latest.inTune ? ' in-tune' : ''}`}>
                {hasTarget ? `${signed(latest.correctionCents, 0)} c` : dash}
              </dd>
            </div>
            <div>
              <dt>Auto-Tune</dt>
              <dd className="live-pitch-correction-state" aria-label="Auto-Tune enabled status">
                {correctionOn ? 'On' : 'Off'}
              </dd>
            </div>
          </dl>
          <p className="hint live-pitch-latency">
            {latest == null || stats == null ? 'Waiting for live input…'
              : !fresh ? 'No live input is arriving (is the audio device open?).'
              : `Detection ${latest.availabilityMs.toFixed(1)} ms (window ${latest.windowDelayMs.toFixed(1)} + worker ${latest.schedulingMs.toFixed(1)}`
                + ` + compute ${latest.computeMs.toFixed(2)}); mean ${stats.meanAvailabilityMs.toFixed(1)} ms`
                + `${stats.droppedFrames > 0 ? `, ${stats.droppedFrames} frames dropped` : ''}. Device latency not included.`}
          </p>
        </>
      )}
      {!enabled && (
        <p className="hint live-pitch-correction-badge" aria-label="Auto-Tune enabled status">
          Auto-Tune: {correctionOn ? 'On' : 'Off'}
        </p>
      )}
      <p className="hint">
        {correctionOn
          ? 'Detection diagnostics; Auto-Tune is correcting live input separately (see Auto-Tune panel).'
          : 'Detection only; audio is not changed until Auto-Tune is enabled.'}
      </p>
      {error != null && <p className="pitch-error" role="alert">{error}</p>}
    </section>
  )
}
