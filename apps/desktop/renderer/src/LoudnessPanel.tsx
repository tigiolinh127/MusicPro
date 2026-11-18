import type { LoudnessResultEvent } from '../../../../packages/shared/src/protocol'
import { formatDb, formatLu, formatLufs, loudnessTargets, type LoudnessTargetId } from './loudnessTargets'

export function LoudnessPanel(props: {
  report: LoudnessResultEvent | null
  analyzing: boolean
  progress: number
  lastExportPath: string | null
  targetId: LoudnessTargetId
  customTargetLufs: number
  onTargetId: (id: LoudnessTargetId) => void
  onCustomTarget: (lufs: number) => void
  onAnalyze: () => void
  onCancel: () => void
  onPickAndAnalyze: () => void
}) {
  const report = props.report
  const target = loudnessTargets.find((t) => t.id === props.targetId) ?? loudnessTargets[0]
  const targetLufs = props.targetId === 'custom' ? props.customTargetLufs : target.integratedLufs
  const delta = report?.integratedValid && report.integratedLufs != null
    ? report.integratedLufs - targetLufs
    : null

  return (
    <aside className="loudness-panel" data-panel="loudness-285" aria-label="Mixdown loudness analysis">
      <div className="loudness-head">
        <h2>Mixdown loudness</h2>
        <p className="hint">
          Analyzes the exported WAV (same mix as Export). ITU-R BS.1770-4 / EBU R128. True peak uses {report?.truePeakOversample ?? 4}× oversampling (analysis only — the insert limiter remains sample-peak).
        </p>
      </div>

      <div className="loudness-actions">
        <button
          type="button"
          data-action="loudness-analyze-export"
          disabled={props.analyzing || props.lastExportPath == null}
          title={props.lastExportPath == null ? 'Export a mix first' : `Analyze ${props.lastExportPath}`}
          onClick={props.onAnalyze}
        >Analyze last export</button>
        <button
          type="button"
          data-action="loudness-analyze-pick"
          disabled={props.analyzing}
          onClick={props.onPickAndAnalyze}
        >Analyze WAV…</button>
        <button
          type="button"
          data-action="loudness-cancel"
          disabled={!props.analyzing}
          onClick={props.onCancel}
        >Cancel</button>
      </div>

      {props.analyzing ? (
        <p className="loudness-progress" data-loudness-progress="1">
          Analyzing… {Math.round(Math.min(1, Math.max(0, props.progress)) * 100)}%
        </p>
      ) : null}

      {props.lastExportPath != null ? (
        <p className="hint" data-loudness-path="1" title={props.lastExportPath}>Last export: {props.lastExportPath}</p>
      ) : (
        <p className="hint">No export in this session yet. Export Mix, then Analyze.</p>
      )}

      <label className="field">
        Guidance target
        <select
          data-action="loudness-target"
          value={props.targetId}
          onChange={(event) => props.onTargetId(event.target.value as LoudnessTargetId)}
        >
          {loudnessTargets.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
      </label>
      {props.targetId === 'custom' ? (
        <label className="field">
          Custom integrated (LUFS)
          <input
            type="number"
            min={-40}
            max={0}
            step={0.1}
            data-action="loudness-custom-target"
            value={props.customTargetLufs}
            onChange={(event) => props.onCustomTarget(Number(event.target.value))}
          />
        </label>
      ) : null}
      <p className="hint">{target.note} Target {targetLufs.toFixed(1)} LUFS / TP {target.truePeakDbTp.toFixed(1)} dBTP.</p>

      {report == null ? (
        <p className="hint">No loudness report yet.</p>
      ) : (
        <div className="loudness-report" data-loudness-report="1">
          {!report.ok ? (
            <p className="loudness-error" data-loudness-error="1">{report.cancelled ? 'Analysis cancelled.' : (report.error || 'Analysis failed.')}</p>
          ) : null}
          <dl className="loudness-metrics">
            <div><dt>Integrated</dt><dd data-metric="integrated">{formatLufs(report.integratedLufs, report.integratedValid)}</dd></div>
            <div><dt>Short-term (max)</dt><dd data-metric="short-term">{formatLufs(report.shortTermLufs, report.shortTermValid)}</dd></div>
            <div><dt>Momentary (max)</dt><dd data-metric="momentary">{formatLufs(report.momentaryLufs, report.momentaryValid)}</dd></div>
            <div><dt>LRA</dt><dd data-metric="lra">{formatLu(report.lraLu, report.lraValid)}</dd></div>
            <div><dt>Sample peak</dt><dd data-metric="sample-peak">{formatDb(report.samplePeakDbFs, report.samplePeakValid, 'dBFS')}</dd></div>
            <div><dt>True peak</dt><dd data-metric="true-peak">{formatDb(report.truePeakDbTp, report.truePeakValid, 'dBTP')}</dd></div>
            <div><dt>Duration</dt><dd data-metric="duration">{Number.isFinite(report.durationSeconds) ? `${report.durationSeconds.toFixed(2)} s` : 'unavailable'}</dd></div>
            <div><dt>Sample rate</dt><dd data-metric="rate">{report.sampleRate > 0 ? `${Math.round(report.sampleRate)} Hz` : 'unavailable'}</dd></div>
            <div><dt>Channels</dt><dd data-metric="channels">{report.channels > 0 ? String(report.channels) : 'unavailable'}</dd></div>
            <div>
              <dt>vs target</dt>
              <dd data-metric="delta">
                {delta == null || !Number.isFinite(delta) ? 'unavailable' : `${delta > 0 ? '+' : ''}${delta.toFixed(1)} LU`}
              </dd>
            </div>
          </dl>
          {(report.clippingSample || report.clippingTruePeak) ? (
            <p className="loudness-warn" data-loudness-clip="1">
              Clipping warning:
              {report.clippingSample ? ' sample peak ≥ 0 dBFS' : ''}
              {report.clippingSample && report.clippingTruePeak ? ';' : ''}
              {report.clippingTruePeak ? ' true peak ≥ 0 dBTP' : ''}
              . The Phase 2.8.4 limiter is sample-peak only.
            </p>
          ) : null}
          {!report.available && report.ok ? (
            <p className="hint" data-loudness-unavailable="1">Loudness metrics unavailable (silence or file too short for gated LUFS).</p>
          ) : null}
        </div>
      )}
    </aside>
  )
}
