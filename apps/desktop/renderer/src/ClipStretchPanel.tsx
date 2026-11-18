import { useEffect, useState } from 'react'
import type { ClipState, EngineState } from '../../../../packages/shared/src/protocol'

type Command = (op: string, payload?: Record<string, unknown>, timeoutMs?: number) => Promise<boolean>
type StretchMode = 'timeStretch' | 'speed'

function formatSec(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0)
    return '—'
  return `${seconds.toFixed(3)} s`
}

/**
 * Phase 2.8.1 — Clip Inspector time stretch / speed controls.
 * Offline Preview / Apply / Revert; no realtime DSP path.
 */
export function ClipStretchPanel(props: {
  state: EngineState | null
  trackId: string | null
  clip: ClipState | null
  busy?: boolean
  command: Command
  onNotice?: (message: string) => void
  onError?: (message: string) => void
}) {
  const [mode, setMode] = useState<StretchMode>('timeStretch')
  const [ratio, setRatio] = useState(1)
  const [status, setStatus] = useState('')
  const clip = props.clip
  const engineOk = props.state != null
  const originalDuration = clip?.stretchOriginalDuration ?? clip?.duration ?? 0
  const currentDuration = clip?.duration ?? 0
  const applied = (clip?.stretchOriginalSourceFileId ?? '').length > 0
  const resultDuration = mode === 'speed'
    ? originalDuration / Math.max(ratio, 1e-9)
    : originalDuration * ratio

  useEffect(() => {
    if (clip?.stretchMode === 'speed' || clip?.stretchMode === 'timeStretch')
      setMode(clip.stretchMode)
    if (typeof clip?.stretchRatio === 'number' && Number.isFinite(clip.stretchRatio) && clip.stretchRatio > 0)
      setRatio(clip.stretchRatio)
  }, [clip?.id, clip?.stretchMode, clip?.stretchRatio])

  async function run(op: 'previewClipStretch' | 'applyClipStretch' | 'revertClipStretch' | 'cancelClipStretchPreview'): Promise<void> {
    if (props.trackId == null || clip == null) {
      props.onError?.('Select a clip on the timeline.')
      return
    }
    if (!engineOk) {
      props.onError?.('Audio engine is disconnected. Stretch/speed is unavailable.')
      return
    }
    setStatus(op === 'previewClipStretch' ? 'Processing preview…' : op === 'applyClipStretch' ? 'Applying…' : 'Working…')
    const payload = op === 'cancelClipStretchPreview' || op === 'revertClipStretch'
      ? { trackId: props.trackId, clipId: clip.id }
      : { trackId: props.trackId, clipId: clip.id, mode, ratio }
    const ok = await props.command(op, payload, 120000)
    setStatus('')
    if (!ok)
      return
    if (op === 'previewClipStretch')
      props.onNotice?.(`Preview ${mode === 'speed' ? 'speed' : 'time stretch'} ${ratio.toFixed(3)}x — Apply to keep, or Cancel.`)
    else if (op === 'applyClipStretch')
      props.onNotice?.(`Applied ${mode === 'speed' ? 'speed' : 'time stretch'} ${ratio.toFixed(3)}x. Undo restores the previous clip.`)
    else if (op === 'revertClipStretch')
      props.onNotice?.('Reverted stretch/speed to the original clip audio.')
    else
      props.onNotice?.('Stretch/speed preview cancelled.')
  }

  const canEdit = clip != null && props.trackId != null && engineOk && !props.busy

  return (
    <section className="clip-stretch" data-panel="clip-stretch-281" aria-label="Clip stretch and speed">
      <h3>Time Stretch / Speed</h3>
      <p className="hint">
        Duration ratio = output ÷ original (0.5× = half length). Speed 2.0× = twice as fast, half duration.
        Time stretch reuses the offline phase vocoder (multi-pass outside 0.75–1.25). Speed uses resampling.
        Original files are never overwritten.
      </p>
      {clip == null && <p className="hint">Select a clip on the timeline to process.</p>}
      {!engineOk && <p className="workflow-banner" role="alert">Engine disconnected — processing unavailable.</p>}
      <div className="clip-stretch-mode" role="group" aria-label="Processing mode">
        <label>
          <input
            type="radio"
            name="clip-stretch-mode"
            data-action="stretch-mode-timeStretch"
            checked={mode === 'timeStretch'}
            disabled={!canEdit}
            onChange={() => setMode('timeStretch')}
          />
          Time Stretch (pitch preserved)
        </label>
        <label>
          <input
            type="radio"
            name="clip-stretch-mode"
            data-action="stretch-mode-speed"
            checked={mode === 'speed'}
            disabled={!canEdit}
            onChange={() => setMode('speed')}
          />
          Speed (pitch changes)
        </label>
      </div>
      <label className="field">
        {mode === 'speed' ? 'Speed' : 'Duration ratio'} ({ratio.toFixed(3)}x)
        <input
          type="number"
          min={0.5}
          max={2}
          step={0.01}
          value={ratio}
          data-action="stretch-ratio"
          aria-label={mode === 'speed' ? 'Speed multiplier' : 'Duration ratio'}
          disabled={!canEdit}
          onChange={(event) => setRatio(Number(event.target.value))}
        />
      </label>
      <ul className="recording-status-list" data-stretch-status>
        <li data-stretch-mode>Mode: {mode === 'speed' ? 'Speed' : 'Time Stretch'}</li>
        <li data-stretch-ratio>Ratio / speed: {ratio.toFixed(3)}x</li>
        <li data-stretch-original>Original duration: {formatSec(originalDuration)}</li>
        <li data-stretch-result>Resulting duration: {formatSec(resultDuration)}</li>
        <li data-stretch-current>Timeline clip length: {formatSec(currentDuration)}</li>
        <li data-stretch-applied>{applied ? `Applied: ${clip?.stretchLabel ?? clip?.stretchMode ?? 'yes'}` : 'Applied: none'}</li>
        <li data-stretch-processing>{status || (props.busy ? 'Busy…' : 'Idle')}</li>
      </ul>
      <div className="clip-stretch-actions">
        <button type="button" data-action="stretch-preview" disabled={!canEdit} onClick={() => void run('previewClipStretch')}>Preview</button>
        <button type="button" data-action="stretch-apply" disabled={!canEdit} onClick={() => void run('applyClipStretch')}>Apply</button>
        <button type="button" data-action="stretch-cancel" disabled={!canEdit} onClick={() => void run('cancelClipStretchPreview')}>Cancel preview</button>
        <button type="button" data-action="stretch-revert" disabled={!canEdit || !applied} onClick={() => void run('revertClipStretch')}>Revert</button>
      </div>
    </section>
  )
}
