import { useEffect, useMemo, useState } from 'react'
import type { ClipState, EngineState, TrackState } from '../../../../packages/shared/src/protocol'

type Command = (op: string, payload?: Record<string, unknown>, timeoutMs?: number) => Promise<boolean>
type FadeCurveName = 'linear' | 'equalPower' | 'sCurve'

const CURVES: Array<{ id: FadeCurveName, label: string }> = [
  { id: 'linear', label: 'Linear' },
  { id: 'equalPower', label: 'Equal Power' },
  { id: 'sCurve', label: 'S-Curve' }
]

function asCurve(value: string | undefined): FadeCurveName {
  if (value === 'equalPower' || value === 'sCurve')
    return value
  return 'linear'
}

function neighborPair(track: TrackState | null, clipId: string | null): { left: ClipState, right: ClipState } | null {
  if (track == null || clipId == null)
    return null
  const clips = [...track.clips].sort((a, b) => a.timelineStart - b.timelineStart || a.id.localeCompare(b.id))
  const index = clips.findIndex((c) => c.id === clipId)
  if (index < 0)
    return null
  const selected = clips[index]
  // Prefer an existing linked partner.
  if (selected.crossfadePartnerId) {
    const partner = clips.find((c) => c.id === selected.crossfadePartnerId)
    if (partner != null) {
      return selected.timelineStart <= partner.timelineStart
        ? { left: selected, right: partner }
        : { left: partner, right: selected }
    }
  }
  // Otherwise pick the nearest touching/overlapping neighbor.
  const left = index > 0 ? clips[index - 1] : null
  const right = index + 1 < clips.length ? clips[index + 1] : null
  const leftTouches = left != null && left.timelineStart + left.duration >= selected.timelineStart
  const rightTouches = right != null && selected.timelineStart + selected.duration >= right.timelineStart
  if (rightTouches && right != null)
    return { left: selected, right }
  if (leftTouches && left != null)
    return { left, right: selected }
  return null
}

/**
 * Phase 2.8.2 — Clip Inspector crossfade editor + track auto-crossfade.
 * Uses complementary fade envelopes (no second gain path).
 */
export function CrossfadePanel(props: {
  state: EngineState | null
  trackId: string | null
  clip: ClipState | null
  busy?: boolean
  command: Command
  onNotice?: (message: string) => void
  onError?: (message: string) => void
}) {
  const track = props.state?.tracks.find((t) => t.id === props.trackId) ?? null
  const pair = useMemo(() => neighborPair(track, props.clip?.id ?? null), [track, props.clip?.id])
  const linked = Boolean(props.clip?.crossfadePartnerId)
  const defaultMs = track?.autoCrossfadeMs ?? 20
  const [durationMs, setDurationMs] = useState(20)
  const [curve, setCurve] = useState<FadeCurveName>('equalPower')
  const [autoEnabled, setAutoEnabled] = useState(false)
  const [autoMs, setAutoMs] = useState(20)
  const [autoCurve, setAutoCurve] = useState<FadeCurveName>('equalPower')
  const [status, setStatus] = useState('')
  const engineOk = props.state != null
  const canEdit = engineOk && !props.busy && pair != null

  useEffect(() => {
    if (props.clip?.crossfadeDuration != null && props.clip.crossfadeDuration > 0)
      setDurationMs(Math.round(props.clip.crossfadeDuration * 1000))
    else if (pair != null) {
      const overlap = Math.max(0, Math.min(pair.left.timelineStart + pair.left.duration, pair.right.timelineStart + pair.right.duration)
        - pair.right.timelineStart)
      setDurationMs(Math.max(1, Math.round((overlap > 0 ? Math.min(overlap, 0.02) : 0.02) * 1000)))
    }
    setCurve(asCurve(props.clip?.crossfadeCurve ?? pair?.left.fadeOutCurve ?? 'equalPower'))
  }, [props.clip?.id, props.clip?.crossfadeDuration, props.clip?.crossfadeCurve, pair?.left.id, pair?.right.id])

  useEffect(() => {
    setAutoEnabled(Boolean(track?.autoCrossfadeEnabled))
    setAutoMs(track?.autoCrossfadeMs ?? defaultMs)
    setAutoCurve(asCurve(track?.autoCrossfadeCurve))
  }, [track?.id, track?.autoCrossfadeEnabled, track?.autoCrossfadeMs, track?.autoCrossfadeCurve, defaultMs])

  async function run(op: 'previewCrossfade' | 'applyCrossfade' | 'revertCrossfade' | 'cancelCrossfadePreview' | 'reset'): Promise<void> {
    if (!engineOk) {
      props.onError?.('Audio engine is disconnected. Crossfade is unavailable.')
      return
    }
    if (props.trackId == null || pair == null) {
      props.onError?.('Select a clip that touches or overlaps another clip on the same track.')
      return
    }
    setStatus(op === 'previewCrossfade' ? 'Previewing…' : op === 'applyCrossfade' ? 'Applying…' : 'Working…')
    if (op === 'cancelCrossfadePreview') {
      const ok = await props.command('cancelCrossfadePreview', {})
      setStatus(ok ? 'Preview cancelled.' : 'Cancel failed.')
      if (ok) props.onNotice?.('Crossfade preview cancelled.')
      return
    }
    if (op === 'reset') {
      const ok = await props.command('applyCrossfade', {
        trackId: props.trackId,
        leftClipId: pair.left.id,
        rightClipId: pair.right.id,
        duration: 0.02,
        curve: 'equalPower'
      })
      setDurationMs(20)
      setCurve('equalPower')
      setStatus(ok ? 'Reset to 20 ms equal-power.' : 'Reset failed.')
      if (ok) props.onNotice?.('Crossfade reset to default (20 ms equal-power).')
      return
    }
    if (op === 'revertCrossfade') {
      const ok = await props.command('revertCrossfade', {
        trackId: props.trackId,
        leftClipId: pair.left.id,
        rightClipId: pair.right.id
      })
      setStatus(ok ? 'Reverted.' : 'Revert failed.')
      if (ok) props.onNotice?.('Crossfade cleared.')
      return
    }
    const duration = Math.max(0, durationMs) / 1000
    const ok = await props.command(op, {
      trackId: props.trackId,
      leftClipId: pair.left.id,
      rightClipId: pair.right.id,
      duration,
      curve
    })
    setStatus(ok ? (op === 'previewCrossfade' ? 'Preview active.' : 'Applied.') : 'Request failed.')
    if (ok)
      props.onNotice?.(op === 'previewCrossfade' ? 'Crossfade preview active.' : 'Crossfade applied.')
  }

  async function saveAuto(): Promise<void> {
    if (props.trackId == null || !engineOk) {
      props.onError?.('Select a track before changing auto-crossfade.')
      return
    }
    const ok = await props.command('setAutoCrossfade', {
      trackId: props.trackId,
      enabled: autoEnabled,
      durationMs: autoMs,
      curve: autoCurve
    })
    if (ok)
      props.onNotice?.(autoEnabled ? `Auto-crossfade on (${autoMs} ms, ${autoCurve}).` : 'Auto-crossfade off.')
  }

  return (
    <section className="crossfade-panel" data-panel="crossfade-282" aria-label="Crossfade">
      <h3>Crossfade</h3>
      <p className="hint">
        Editable complementary fades between overlapping or abutting clips. Envelopes are sample-accurate and match playback/export.
        Equal Power keeps constant power for uncorrelated signals; correlated overlaps can still sum louder than either solo.
      </p>
      <ul className="hint">
        <li data-crossfade-pair>{pair != null ? `Pair: ${pair.left.id} ↔ ${pair.right.id}` : 'No touching neighbor for the selected clip.'}</li>
        <li data-crossfade-linked>{linked ? 'Linked crossfade' : 'No linked crossfade'}</li>
      </ul>
      <label className="field">
        Duration (ms)
        <input
          type="number"
          min={0}
          max={5000}
          step={1}
          value={durationMs}
          data-action="crossfade-duration"
          aria-label="Crossfade duration milliseconds"
          disabled={!canEdit}
          onChange={(event) => setDurationMs(Number(event.target.value))}
        />
      </label>
      <div className="crossfade-curves" role="group" aria-label="Crossfade curve">
        {CURVES.map((item) => (
          <label key={item.id}>
            <input
              type="radio"
              name="crossfade-curve"
              data-action={`crossfade-curve-${item.id}`}
              checked={curve === item.id}
              disabled={!canEdit}
              onChange={() => setCurve(item.id)}
            />
            {item.label}
          </label>
        ))}
      </div>
      <div className="crossfade-actions">
        <button type="button" data-action="crossfade-preview" disabled={!canEdit} onClick={() => void run('previewCrossfade')}>Preview</button>
        <button type="button" data-action="crossfade-apply" disabled={!canEdit} onClick={() => void run('applyCrossfade')}>Apply</button>
        <button type="button" data-action="crossfade-cancel" disabled={!canEdit} onClick={() => void run('cancelCrossfadePreview')}>Cancel preview</button>
        <button type="button" data-action="crossfade-revert" disabled={!canEdit || !linked} onClick={() => void run('revertCrossfade')}>Revert</button>
        <button type="button" data-action="crossfade-reset" disabled={!canEdit} onClick={() => void run('reset')}>Reset to default</button>
      </div>
      {status ? <p className="hint" data-crossfade-status>{status}</p> : null}

      <h4>Auto crossfade</h4>
      <p className="hint">When enabled, moving or trimming a clip that overlaps a neighbor applies the default duration. Off by default.</p>
      <label className="field">
        <input
          type="checkbox"
          data-action="auto-crossfade-enabled"
          checked={autoEnabled}
          disabled={!engineOk || props.trackId == null || props.busy}
          onChange={(event) => setAutoEnabled(event.target.checked)}
        />
        {' '}Enable auto-crossfade on this track
      </label>
      <label className="field">
        Default duration (ms)
        <input
          type="number"
          min={0}
          max={5000}
          step={1}
          value={autoMs}
          data-action="auto-crossfade-ms"
          disabled={!engineOk || props.trackId == null || props.busy}
          onChange={(event) => setAutoMs(Number(event.target.value))}
        />
      </label>
      <div className="crossfade-curves" role="group" aria-label="Auto crossfade curve">
        {CURVES.map((item) => (
          <label key={`auto-${item.id}`}>
            <input
              type="radio"
              name="auto-crossfade-curve"
              data-action={`auto-crossfade-curve-${item.id}`}
              checked={autoCurve === item.id}
              disabled={!engineOk || props.trackId == null || props.busy}
              onChange={() => setAutoCurve(item.id)}
            />
            {item.label}
          </label>
        ))}
      </div>
      <button type="button" data-action="auto-crossfade-save" disabled={!engineOk || props.trackId == null || props.busy} onClick={() => void saveAuto()}>
        Save auto-crossfade settings
      </button>
    </section>
  )
}
