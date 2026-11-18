/**
 * Phase 2.7.5 — navigational strip that ties existing Editor recording, vocal, Mixer, and export
 * controls into one workflow. Does not duplicate record/mix DSP or create a second recorder.
 */
export type RecordingMixStep =
  | 'prepare'
  | 'levels'
  | 'arm'
  | 'monitor'
  | 'record'
  | 'review'
  | 'edit'
  | 'mix'
  | 'export'

const STEPS: Array<{ id: RecordingMixStep, label: string, title: string }> = [
  { id: 'prepare', label: '1. Prepare Input', title: 'Focus devices: choose input/output and Apply devices' },
  { id: 'levels', label: '2. Check Levels', title: 'Open Recording workflow Input Level / Input Gain' },
  { id: 'arm', label: '3. Arm Track', title: 'Arm a track with R on the lane' },
  { id: 'monitor', label: '4. Monitoring', title: 'Configure track input monitor and Mic monitor' },
  { id: 'record', label: '5. Record', title: 'Start/Stop recording in the Recording workflow panel' },
  { id: 'review', label: '6. Review Take', title: 'Review or Retake the last recording' },
  { id: 'edit', label: '7. Edit Vocal', title: 'Comp, timing, breath, pitch, presets in the Editor' },
  { id: 'mix', label: '8. Mix', title: 'Open the Mixer view' },
  { id: 'export', label: '9. Export', title: 'Export WAV from the devices bar (existing mixer path)' }
]

export function RecordingMixWorkflowPanel(props: {
  active: RecordingMixStep
  recording: boolean
  armed: boolean
  deviceOpen: boolean
  hasTake: boolean
  exportReady: boolean
  engineConnected: boolean
  onStep: (step: RecordingMixStep) => void
}) {
  return (
    <section className="recording-mix-workflow" data-panel="recording-mix-workflow-275" aria-label="Recording and mixing workflow">
      <h2>Recording → Mix → Export</h2>
      <p className="hint">
        One workflow across existing panels — Devices, Recording workflow, Vocal Workflow, Mixer, and Export WAV.
        No second recorder; Karaoke Studio stays separate.
      </p>
      {!props.engineConnected && (
        <p className="workflow-banner" data-integration-engine-error role="alert">
          Audio engine disconnected. Reconnect or restart Music Studio Pro, then Apply devices.
        </p>
      )}
      {props.engineConnected && !props.deviceOpen && (
        <p className="workflow-banner" data-integration-device-error role="status">
          Audio stream closed. Use Prepare Input → Apply devices before recording or trusting meters.
        </p>
      )}
      <ol className="recording-mix-steps" data-recording-mix-steps>
        {STEPS.map((step) => {
          const selected = props.active === step.id
          let status = 'ready'
          if (step.id === 'arm' && !props.armed)
            status = 'pending'
          if (step.id === 'record' && props.recording)
            status = 'active'
          if (step.id === 'review' && !props.hasTake)
            status = 'pending'
          if (step.id === 'export' && !props.exportReady)
            status = 'pending'
          if (!props.engineConnected)
            status = 'blocked'
          return (
            <li key={step.id} data-step={step.id} data-status={status} className={selected ? 'selected' : undefined}>
              <button
                type="button"
                data-action={`mix-workflow-${step.id}`}
                aria-pressed={selected}
                title={step.title}
                onClick={() => props.onStep(step.id)}
              >
                <span className="step-name">{step.label}</span>
                <span className="step-status">{status}</span>
              </button>
            </li>
          )
        })}
      </ol>
      <p className="hint" data-integration-note>
        Signal path: Input Gain (capture) → record/placement offset (new takes only) → track/mixer FX once → Master → Export.
        Raw Mic monitor stays undelayed; track volume and Master stay independent.
      </p>
    </section>
  )
}
