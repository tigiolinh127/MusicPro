import type { RecentProjectEntry, RecoverySnapshot } from './projectTypes'

export interface ProjectBarProps {
  projectName: string
  projectPath: string | null
  dirty: boolean
  autosaveEnabled: boolean
  autosaveBusy: boolean
  lastAutosaveAt: string | null
  recent: RecentProjectEntry[]
  onNew: () => void
  onOpen: () => void
  onSave: () => void
  onSaveAs: () => void
  onOpenRecent: (entry: RecentProjectEntry) => void
  onRemoveRecent: (entry: RecentProjectEntry) => void
  onToggleAutosave: (enabled: boolean) => void
}

export interface RecoveryDialogProps {
  offer: RecoverySnapshot
  onRecover: () => void
  onDiscard: () => void
  onLater: () => void
}

export function RecoveryDialog(props: RecoveryDialogProps) {
  const { offer } = props
  return (
    <div className="modal-backdrop" data-recovery-dialog="true" role="dialog" aria-modal="true" aria-label="Recover project">
      <div className="modal-card">
        <h2>Recover unsaved work?</h2>
        <p className="hint">An autosave snapshot is available. Recovery opens a working copy and never overwrites the original project file.</p>
        <dl className="recovery-meta">
          <div><dt>Project</dt><dd data-recovery-name>{offer.projectName}</dd></div>
          <div><dt>Snapshot</dt><dd data-recovery-time>{new Date(offer.timestamp).toLocaleString()}</dd></div>
          <div><dt>Original</dt><dd data-recovery-path>{offer.originalPath ?? 'Unsaved project'}</dd></div>
          <div><dt>Status</dt><dd data-recovery-available>{offer.available ? 'Available' : (offer.error ?? 'Unavailable')}</dd></div>
        </dl>
        <div className="modal-actions">
          <button data-recovery-action="recover" className="primary" disabled={!offer.available} onClick={props.onRecover}>Recover</button>
          <button data-recovery-action="discard" onClick={props.onDiscard}>Discard</button>
          <button data-recovery-action="later" onClick={props.onLater}>Decide Later</button>
        </div>
      </div>
    </div>
  )
}

export interface UnsavedDialogProps {
  title: string
  onSave: () => void
  onDontSave: () => void
  onCancel: () => void
}

export function UnsavedDialog(props: UnsavedDialogProps) {
  return (
    <div className="modal-backdrop" data-unsaved-dialog="true" role="dialog" aria-modal="true" aria-label="Unsaved changes">
      <div className="modal-card">
        <h2>{props.title}</h2>
        <p className="hint">Save your changes before continuing?</p>
        <div className="modal-actions">
          <button data-unsaved-action="save" className="primary" onClick={props.onSave}>Save</button>
          <button data-unsaved-action="dont-save" onClick={props.onDontSave}>Don&apos;t Save</button>
          <button data-unsaved-action="cancel" onClick={props.onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  )
}

export function ProjectBar(props: ProjectBarProps) {
  const pathLabel = props.projectPath ?? 'Not saved yet'
  const autosaveLabel = !props.autosaveEnabled
    ? 'Autosave off'
    : props.autosaveBusy
      ? 'Autosaving…'
      : props.lastAutosaveAt != null
        ? `Autosaved ${new Date(props.lastAutosaveAt).toLocaleTimeString()}`
        : 'Autosave ready'

  return (
    <section className="panel project-bar" data-project-bar="true" aria-label="Project">
      <div className="project-identity">
        <span className="eyebrow">Project</span>
        <strong data-project-name={props.projectName}>
          {props.projectName}{props.dirty ? ' *' : ''}
        </strong>
        <span
          className={props.dirty ? 'dirty-pill on' : 'dirty-pill'}
          data-project-dirty={props.dirty ? 'true' : 'false'}
          title={props.dirty ? 'Unsaved changes' : 'All changes saved'}
        >
          {props.dirty ? 'Unsaved' : 'Saved'}
        </span>
        <span className="hint" data-project-path title={pathLabel}>{pathLabel}</span>
      </div>
      <div className="project-actions">
        <button data-project-action="new" onClick={props.onNew}>New</button>
        <button data-project-action="open" onClick={props.onOpen}>Open</button>
        <button data-project-action="save" onClick={props.onSave}>Save</button>
        <button data-project-action="save-as" onClick={props.onSaveAs}>Save As</button>
        <label className="field autosave-toggle">
          <input
            type="checkbox"
            data-autosave-enabled
            checked={props.autosaveEnabled}
            onChange={(event) => props.onToggleAutosave(event.target.checked)}
          />
          Autosave
        </label>
        <span className="hint" data-autosave-status>{autosaveLabel}</span>
        {props.recent.length > 0 ? (
          <label className="field">
            Recent
            <select
              data-recent-projects
              defaultValue=""
              onChange={(event) => {
                const value = event.target.value
                event.target.value = ''
                if (value === '')
                  return
                if (value.startsWith('remove:')) {
                  const target = props.recent.find((item) => item.path === value.slice('remove:'.length))
                  if (target != null)
                    props.onRemoveRecent(target)
                  return
                }
                const target = props.recent.find((item) => item.path === value)
                if (target != null)
                  props.onOpenRecent(target)
              }}
            >
              <option value="">Open recent…</option>
              {props.recent.map((entry) => (
                <option key={entry.path} value={entry.path} disabled={!entry.available}>
                  {entry.available ? entry.name : `${entry.name} (missing)`}
                </option>
              ))}
              {props.recent.some((entry) => !entry.available) ? (
                <optgroup label="Remove missing">
                  {props.recent.filter((entry) => !entry.available).map((entry) => (
                    <option key={`remove-${entry.path}`} value={`remove:${entry.path}`}>
                      Remove {entry.name}
                    </option>
                  ))}
                </optgroup>
              ) : null}
            </select>
          </label>
        ) : null}
      </div>
    </section>
  )
}
