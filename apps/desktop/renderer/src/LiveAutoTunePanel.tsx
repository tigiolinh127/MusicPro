import { useEffect, useRef, useState } from 'react'
import {
  keyRoots,
  scaleOptions,
  type LiveCorrectionStatus,
  type LiveMonitorMode,
  type ScaleName
} from '../../../../packages/shared/src/protocol'

const pollMs = 200   // 5 Hz while Auto-Tune is on; Live pitch panel polls separately when Detect is on

function percent(value: number): string {
  return `${Math.round(value)}%`
}

// Live-input Auto-Tune controls (Phase 2.5.4). Drives getLiveCorrection / setLiveCorrection only;
// no second DSP engine. Applies to live input through the existing stage — not to clip playback.
export function LiveAutoTunePanel() {
  const [status, setStatus] = useState<LiveCorrectionStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const busy = useRef(false)

  useEffect(() => {
    void window.studio.request('getLiveCorrection').then((response) => {
      if (response.ok && response.result != null)
        setStatus(response.result as LiveCorrectionStatus)
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
      void window.studio.request('getLiveCorrection', {}, 2000).then((response) => {
        if (response.ok && response.result != null)
          setStatus(response.result as LiveCorrectionStatus)
      }).finally(() => { busy.current = false })
    }, pollMs)
    return () => window.clearInterval(timer)
  }, [enabled])

  async function configure(change: Record<string, unknown>): Promise<void> {
    const response = await window.studio.request('setLiveCorrection', change)
    if (!response.ok || response.result == null) {
      setError(response.error ?? 'The audio engine rejected the Auto-Tune settings.')
      // Refresh so controls match the engine after a rejection (e.g. while recording).
      const latest = await window.studio.request('getLiveCorrection')
      if (latest.ok && latest.result != null)
        setStatus(latest.result as LiveCorrectionStatus)
      return
    }
    setError(null)
    setStatus(response.result as LiveCorrectionStatus)
  }

  const stats = status?.statistics
  const mon = status?.monitoringLatency
  const cpu = stats != null ? Math.min(100, Math.round(stats.averageLoad * 1000) / 10) : null
  return (
    <section className="live-autotune-panel" aria-label="Live Auto-Tune">
      <h2>Auto-Tune <span className="hint">live input only</span></h2>
      <div className="live-autotune-fields">
        <label className="pitch-mapping-toggle">
          <input type="checkbox" aria-label="Enable Auto-Tune" checked={enabled} disabled={status == null}
            onChange={(change) => void configure({ enabled: change.target.checked })} />
          Enable
        </label>
        <label className="pitch-mapping-toggle">
          <input type="checkbox" aria-label="Bypass Auto-Tune" checked={status?.bypassed === true}
            disabled={status == null || !enabled}
            onChange={(change) => void configure({ bypassed: change.target.checked })} />
          Bypass
        </label>
        <label>
          Monitor
          <select aria-label="Auto-Tune monitor mode" value={status?.monitorMode ?? 'corrected'} disabled={status == null || !enabled}
            title="What armed-track input monitoring hears. Recording stays corrected when Auto-Tune is on. Does not turn monitoring on."
            onChange={(change) => void configure({ monitorMode: change.target.value as LiveMonitorMode })}>
            <option value="corrected">Corrected</option>
            <option value="raw">Raw (aligned)</option>
          </select>
        </label>
        <label>
          Root
          <select aria-label="Auto-Tune root" value={status?.root ?? 'C'} disabled={status == null}
            onChange={(change) => void configure({ root: change.target.value })}>
            {keyRoots.map((root) => <option key={root.value} value={root.value}>{root.label}</option>)}
          </select>
        </label>
        <label>
          Scale
          <select aria-label="Auto-Tune scale" value={status?.scale ?? 'major'} disabled={status == null}
            onChange={(change) => void configure({ scale: change.target.value as ScaleName })}>
            {scaleOptions.map((scale) => <option key={scale.value} value={scale.value}>{scale.label}</option>)}
          </select>
        </label>
        <label>
          Retune (ms)
          <input type="number" aria-label="Retune speed" min={0} max={200} step={1}
            value={status?.retuneMs ?? 20} disabled={status == null}
            onChange={(change) => void configure({ retuneMs: Number(change.target.value) })} />
        </label>
        <label className="live-autotune-strength">
          Strength
          <span className="live-autotune-strength-row">
            <input type="range" aria-label="Correction strength" min={0} max={100} step={1}
              value={status?.strength ?? 100} disabled={status == null}
              onChange={(change) => void configure({ strength: Number(change.target.value) })} />
            <span className="live-autotune-value" aria-live="polite">{percent(status?.strength ?? 100)}</span>
          </span>
        </label>
      </div>
      <dl className="live-autotune-readout" aria-label="Auto-Tune status">
        <div>
          <dt>State</dt>
          <dd className={enabled ? (status?.bypassed ? 'live-autotune-bypassed' : 'live-autotune-on') : undefined}>
            {!enabled ? 'Off' : status?.bypassed ? 'Bypassed' : 'On'}
          </dd>
        </div>
        <div>
          <dt>DSP latency</dt>
          <dd className="live-autotune-latency">
            {enabled ? `${(status?.latencyMs ?? 0).toFixed(2)} ms (${status?.latencySamples ?? 0} smp)` : '—'}
          </dd>
        </div>
        <div>
          <dt>Sample rate</dt>
          <dd>{enabled && status?.sampleRate != null ? `${Math.round(status.sampleRate)} Hz` : '—'}</dd>
        </div>
        <div>
          <dt>CPU</dt>
          <dd>{enabled && cpu != null ? `${cpu.toFixed(1)}%` : '—'}</dd>
        </div>
        <div>
          <dt>Device out</dt>
          <dd>{status != null ? `${status.deviceOutputLatencySamples} smp` : '—'}</dd>
        </div>
        <div>
          <dt>End-to-end</dt>
          <dd title={mon?.endToEndNote}>{mon?.endToEndMs == null ? 'Unavailable' : `${mon.endToEndMs.toFixed(1)} ms`}</dd>
        </div>
      </dl>
      <p className="hint">
        {enabled
          ? `Rec corrected · track monitor ${status?.monitorMode === 'raw' ? 'raw (aligned)' : 'corrected'} · mic raw · no delay compensation`
          : 'Enable corrects live input. Track Monitor hears it; this panel does not arm monitoring.'}
      </p>
      {status != null && status.warnings.length > 0 && (
        <p className="pitch-error" role="status">{status.warnings.join(' ')}</p>
      )}
      {error != null && <p className="pitch-error" role="alert">{error}</p>}
    </section>
  )
}
