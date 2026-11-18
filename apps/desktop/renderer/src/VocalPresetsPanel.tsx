import { useMemo, useState } from 'react'
import type { EngineState, TrackState, VocalPresetSummary } from '../../../../packages/shared/src/protocol'
import { effectSpec } from './effects'

type Command = (op: string, payload?: Record<string, unknown>, timeoutMs?: number) => Promise<boolean>

export function VocalPresetsPanel(props: {
  tracks: TrackState[]
  selectedTrackId: string | null
  presets: VocalPresetSummary[]
  onState: (state: EngineState) => void
  command: Command
}) {
  void props.onState
  const track = props.tracks.find((item) => item.id === props.selectedTrackId) ?? props.tracks[0]
  const [selectedId, setSelectedId] = useState(track?.vocalPresetId ?? props.presets[0]?.id ?? '')
  const [customName, setCustomName] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const selected = useMemo(
    () => props.presets.find((preset) => preset.id === selectedId) ?? props.presets[0],
    [props.presets, selectedId]
  )

  const activeId = track?.vocalPresetId ?? ''
  const dirty = selected != null && selected.id !== activeId

  async function run(op: string, payload: Record<string, unknown>): Promise<void> {
    setBusy(true)
    setNotice(null)
    const ok = await props.command(op, payload)
    setBusy(false)
    if (!ok)
      setNotice('The engine rejected that preset action.')
  }

  if (track == null) {
    return (
      <section className="vocal-presets" data-panel="vocal-presets">
        <h2>Vocal Presets</h2>
        <p className="hint">Select a track to apply a vocal processing preset.</p>
      </section>
    )
  }

  return (
    <section className="vocal-presets" data-panel="vocal-presets">
      <h2>Vocal Presets</h2>
      <p className="hint">Non-destructive effect chains. Starting points only — not automatic mastering.</p>
      <label className="field">
        Preset
        <select
          aria-label="Vocal preset"
          data-action="vocal-preset-select"
          value={selected?.id ?? ''}
          disabled={busy}
          onChange={(event) => setSelectedId(event.target.value)}
        >
          {props.presets.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.name}{preset.factory ? '' : ' (custom)'}
            </option>
          ))}
        </select>
      </label>
      {selected != null && (
        <ul className="preset-chain" aria-label="Preset effect chain">
          {selected.effects.map((effect, index) => (
            <li key={`${selected.id}-${index}`}>{effectSpec(effect.type).label}{effect.enabled ? '' : ' (off)'}</li>
          ))}
        </ul>
      )}
      {dirty && <p className="hint unsaved">Unsaved selection — Preview or Apply to hear changes.</p>}
      {activeId && (
        <p className="hint">Active: {props.presets.find((p) => p.id === activeId)?.name ?? activeId}
          {track.vocalPresetBypassed ? ' (bypassed)' : ''}
        </p>
      )}
      <div className="preset-actions">
        <button
          data-action="vocal-preset-preview"
          disabled={busy || selected == null}
          onClick={() => void run('previewVocalPreset', { trackId: track.id, presetId: selected!.id })}
        >Preview</button>
        <button
          data-action="vocal-preset-cancel-preview"
          disabled={busy}
          onClick={() => void run('cancelVocalPresetPreview', {})}
        >Cancel preview</button>
        <button
          data-action="vocal-preset-apply"
          disabled={busy || selected == null}
          onClick={() => void run('applyVocalPreset', { trackId: track.id, presetId: selected!.id })}
        >Apply</button>
        <button
          data-action="vocal-preset-bypass"
          disabled={busy || !activeId}
          onClick={() => void run('bypassVocalPreset', { trackId: track.id, bypassed: !track.vocalPresetBypassed })}
        >{track.vocalPresetBypassed ? 'Unbypass' : 'Bypass'}</button>
        <button
          data-action="vocal-preset-revert"
          disabled={busy || !activeId}
          onClick={() => void run('revertVocalPreset', { trackId: track.id })}
        >Revert</button>
      </div>
      <label className="field">
        Custom name
        <input
          type="text"
          value={customName}
          maxLength={80}
          aria-label="Custom vocal preset name"
          onChange={(event) => setCustomName(event.target.value)}
        />
      </label>
      <div className="preset-actions">
        <button
          data-action="vocal-preset-save"
          disabled={busy || customName.trim().length === 0}
          onClick={() => void run('saveCustomVocalPreset', { trackId: track.id, name: customName.trim() })}
        >Save Custom Preset</button>
        <button
          data-action="vocal-preset-delete"
          disabled={busy || selected == null || selected.factory}
          onClick={() => void run('deleteCustomVocalPreset', { presetId: selected!.id })}
        >Delete custom</button>
        <button
          data-action="vocal-preset-restore-factory"
          disabled={busy}
          onClick={() => void run('restoreFactoryVocalPresets', {})}
        >Restore factory</button>
      </div>
      {notice != null && <p className="hint">{notice}</p>}
    </section>
  )
}
