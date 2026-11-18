import type { ClipState, EngineState, TrackState, VocalWorkflowState } from '../../../../packages/shared/src/protocol'

export type VocalWorkflowStage =
  | 'record'
  | 'comp'
  | 'timing'
  | 'breath'
  | 'pitch'
  | 'presets'
  | 'mix'

const STAGE_LABELS: Record<VocalWorkflowStage, string> = {
  record: '1. Record / Import',
  comp: '2. Comp',
  timing: '3. Timing',
  breath: '4. Breath & Silence',
  pitch: '5. Pitch Correction',
  presets: '6. Vocal Presets',
  mix: '7. Mix & Export'
}

type StageStatus = 'ready' | 'active' | 'pending' | 'blocked' | 'preview'

function clipOf(tracks: TrackState[], trackId: string | null, clipId: string | null): ClipState | undefined {
  if (trackId == null)
    return undefined
  const track = tracks.find((item) => item.id === trackId)
  if (track == null)
    return undefined
  if (clipId != null)
    return track.clips.find((clip) => clip.id === clipId) ?? track.clips[0]
  return track.clips[0]
}

function stageStatus(args: {
  stage: VocalWorkflowStage
  track: TrackState | undefined
  clip: ClipState | undefined
  workflow: VocalWorkflowState | undefined
  timingEdit: boolean
  breathEdit: boolean
  current: VocalWorkflowStage
}): { status: StageStatus, detail: string } {
  const { stage, track, clip, workflow, timingEdit, breathEdit, current } = args
  const preview = workflow?.previews
  const hasAudio = track != null && (!track.missing) && (track.clips.length > 0 || (track.takes?.length ?? 0) > 0 || track.path.length > 0)
  const hasComp = (track?.clips.length ?? 0) > 0
  const hasTakes = (track?.takes?.length ?? 0) > 0

  if (stage === 'record') {
    if (!hasAudio)
      return { status: 'pending', detail: 'Use Recording workflow below, or Import WAV / transport Record.' }
    return { status: current === stage ? 'active' : 'ready', detail: track?.missing ? 'Source missing' : 'Source available — Review / Retake in Recording workflow' }
  }
  if (stage === 'comp') {
    if (!hasAudio)
      return { status: 'blocked', detail: 'Needs source audio first.' }
    if (!hasTakes && !hasComp)
      return { status: 'pending', detail: 'Add takes or place a clip.' }
    if (hasTakes && hasComp)
      return { status: current === stage ? 'active' : 'ready', detail: `${track!.takes!.length} take(s) · ${track!.clips.length} comp clip(s)` }
    if (hasComp)
      return { status: current === stage ? 'active' : 'ready', detail: `${track!.clips.length} clip(s) on the track` }
    return { status: 'pending', detail: 'Promote take regions onto the comp.' }
  }
  if (stage === 'timing') {
    if (!hasComp)
      return { status: 'blocked', detail: 'Select or build a comp clip first.' }
    if (clip?.originalSourceFileId)
      return { status: 'blocked', detail: 'Revert offline pitch before changing timing.' }
    if (clip?.breathOriginalSourceFileId)
      return { status: 'blocked', detail: 'Revert breath before changing timing.' }
    if (clip?.timingOriginalSourceFileId)
      return { status: timingEdit || current === stage ? 'active' : 'ready', detail: `Applied${clip.timingLabel ? `: ${clip.timingLabel}` : ''}` }
    if ((clip?.timingMarkers?.length ?? 0) > 0)
      return { status: timingEdit || current === stage ? 'active' : 'pending', detail: `${clip!.timingMarkers!.length} marker(s) — analyze/apply` }
    return { status: timingEdit || current === stage ? 'active' : 'pending', detail: 'Analyze onsets, then Apply timing.' }
  }
  if (stage === 'breath') {
    if (!hasComp)
      return { status: 'blocked', detail: 'Select or build a comp clip first.' }
    if (clip?.originalSourceFileId)
      return { status: 'blocked', detail: 'Revert offline pitch before editing breath.' }
    if (preview?.breath)
      return { status: 'preview', detail: 'Breath preview active — Apply or Cancel before export.' }
    if (clip?.breathOriginalSourceFileId)
      return { status: breathEdit || current === stage ? 'active' : 'ready', detail: `Applied${clip.breathLabel ? `: ${clip.breathLabel}` : ''}` }
    if ((clip?.breathRegions?.length ?? 0) > 0)
      return { status: breathEdit || current === stage ? 'active' : 'pending', detail: `${clip!.breathRegions!.length} region(s) — Preview/Apply` }
    return { status: breathEdit || current === stage ? 'active' : 'pending', detail: 'Analyze Breath, then Preview/Apply.' }
  }
  if (stage === 'pitch') {
    if (!hasComp)
      return { status: 'blocked', detail: 'Select a comp clip first.' }
    if (preview?.pitch)
      return { status: 'preview', detail: 'Pitch preview active — Apply or Cancel before export.' }
    if (clip?.originalSourceFileId)
      return { status: current === stage ? 'active' : 'ready', detail: `Applied${clip.pitchLabel ? `: ${clip.pitchLabel}` : ''}` }
    return { status: current === stage ? 'active' : 'pending', detail: 'Offline pitch only — Live Auto-Tune is not exported.' }
  }
  if (stage === 'presets') {
    if (track == null)
      return { status: 'blocked', detail: 'Select a vocal track.' }
    if (preview?.preset)
      return { status: 'preview', detail: 'Preset preview active — Apply or Cancel before export.' }
    if (track.vocalPresetId)
      return {
        status: current === stage ? 'active' : 'ready',
        detail: track.vocalPresetBypassed ? 'Preset bypassed' : 'Preset applied (track FX)'
      }
    return { status: current === stage ? 'active' : 'pending', detail: 'Optional starting FX chain.' }
  }
  // mix
  if (!hasComp)
    return { status: 'blocked', detail: 'Nothing to export yet.' }
  if (preview?.pitch || preview?.breath || preview?.preset)
    return { status: 'preview', detail: 'Cancel or Apply previews before export.' }
  return {
    status: current === stage ? 'active' : 'ready',
    detail: 'Open Mixer for levels/FX, then Export WAV in the devices bar (committed processing only).'
  }
}

export function VocalWorkflowPanel(props: {
  state: EngineState | null
  selectedTrackId: string | null
  selectedClipId: string | null
  timingEdit: boolean
  breathEdit: boolean
  currentStage: VocalWorkflowStage
  onStage: (stage: VocalWorkflowStage) => void
  onTimingEdit: (on: boolean) => void
  onBreathEdit: (on: boolean) => void
}) {
  const tracks = props.state?.tracks ?? []
  const track = tracks.find((item) => item.id === props.selectedTrackId) ?? tracks[0]
  const clip = clipOf(tracks, track?.id ?? null, props.selectedClipId)
  const workflow = props.state?.vocalWorkflow
  const stages = (workflow?.order ?? ['record', 'comp', 'timing', 'breath', 'pitch', 'presets', 'mix']) as VocalWorkflowStage[]

  const banner = (() => {
    if (track == null)
      return 'Add or select a track to begin the vocal workflow.'
    if (track.missing)
      return 'Source audio is missing — re-link or re-import before processing.'
    if (workflow?.previews.pitch || workflow?.previews.breath || workflow?.previews.preset)
      return 'A temporary preview is active. Export uses committed audio only; Apply or Cancel the preview first.'
    if (props.state?.canUndo)
      return 'Unsaved edit history is available (Undo). Save the project to persist.'
    return null
  })()

  function openStage(stage: VocalWorkflowStage): void {
    props.onStage(stage)
    if (stage === 'timing') {
      props.onBreathEdit(false)
      props.onTimingEdit(true)
    } else if (stage === 'breath') {
      props.onTimingEdit(false)
      props.onBreathEdit(true)
    } else {
      props.onTimingEdit(false)
      props.onBreathEdit(false)
    }
  }

  return (
    <section className="vocal-workflow" data-panel="vocal-workflow">
      <h2>Vocal Workflow</h2>
      <p className="hint">
        Non-destructive pipeline. Live Auto-Tune is monitor/record only and is not exported.
      </p>
      {banner != null && <p className="workflow-banner" data-status="banner">{banner}</p>}
      <ol className="workflow-stages" aria-label="Vocal workflow stages">
        {stages.map((stage) => {
          const info = stageStatus({
            stage,
            track,
            clip,
            workflow,
            timingEdit: props.timingEdit,
            breathEdit: props.breathEdit,
            current: props.currentStage
          })
          const selected = props.currentStage === stage
          return (
            <li key={stage} data-stage={stage} data-status={info.status} className={selected ? 'selected' : undefined}>
              <button
                type="button"
                data-action={`workflow-stage-${stage}`}
                aria-pressed={selected}
                title={info.detail}
                onClick={() => openStage(stage)}
              >
                <span className="stage-name">{STAGE_LABELS[stage] ?? stage}</span>
                <span className="stage-status">{info.status}</span>
              </button>
              {(selected || info.status === 'preview' || info.status === 'blocked') && (
                <p className="hint stage-detail">{info.detail}</p>
              )}
            </li>
          )
        })}
      </ol>
      <p className="hint workflow-order" data-workflow-note>
        {workflow?.note ?? 'Order: source → comp → timing → breath → offline pitch → presets → mix/export.'}
      </p>
    </section>
  )
}
