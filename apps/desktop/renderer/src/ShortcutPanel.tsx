import {
  DEFAULT_SHORTCUTS,
  findConflicts,
  formatBinding,
  mergeShortcuts,
  parseBindingFromEvent,
  uniqueShortcutRows,
  type KeyBinding,
  type ShortcutCommandId,
  type ShortcutOverrides
} from './shortcuts'

export function ShortcutPanel(props: {
  overrides: ShortcutOverrides
  capturing: ShortcutCommandId | null
  conflictNote: string | null
  onCapture: (id: ShortcutCommandId | null) => void
  onChange: (id: ShortcutCommandId, binding: KeyBinding) => void
  onReset: () => void
  onClose: () => void
}) {
  const platform = navigator.platform.toLowerCase().includes('mac') ? 'mac' : 'win'
  const merged = mergeShortcuts(props.overrides)
  const rows = uniqueShortcutRows(merged)
  const conflicts = findConflicts(merged)

  return (
    <div className="modal-backdrop" data-shortcut-panel="true" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
      <div className="modal-card shortcut-panel-card">
        <div className="shortcut-panel-head">
          <h2>Keyboard shortcuts</h2>
          <button data-shortcut-action="close" onClick={props.onClose}>Close</button>
        </div>
        <p className="hint">Shortcuts call the same commands as the toolbar. Changes persist in app settings (not the project file).</p>
        {props.conflictNote != null ? <p className="banner" role="status" data-shortcut-conflict>{props.conflictNote}</p> : null}
        {conflicts.length > 0 ? (
          <p className="hint" data-shortcut-conflicts>
            Conflicts: {conflicts.map((item) => item.label).join(' · ')}
          </p>
        ) : null}
        <div className="shortcut-table" role="table">
          {(['Project', 'Edit', 'Timeline', 'Transport'] as const).map((category) => (
            <div key={category} className="shortcut-group">
              <h3>{category}</h3>
              {rows.filter((row) => row.category === category).map((row) => {
                const binding = props.overrides[row.id] ?? DEFAULT_SHORTCUTS.find((item) => item.id === row.id)?.binding ?? row.binding
                const capturing = props.capturing === row.id
                return (
                  <div key={row.id} className="shortcut-row" role="row" data-shortcut-id={row.id}>
                    <span>{row.name}</span>
                    <button
                      data-shortcut-bind={row.id}
                      className={capturing ? 'capturing' : undefined}
                      onClick={() => props.onCapture(capturing ? null : row.id)}
                      onKeyDown={(event) => {
                        if (!capturing)
                          return
                        event.preventDefault()
                        event.stopPropagation()
                        if (event.code === 'Escape') {
                          props.onCapture(null)
                          return
                        }
                        const next = parseBindingFromEvent(event.nativeEvent)
                        if (next == null)
                          return
                        props.onChange(row.id, next)
                        props.onCapture(null)
                      }}
                    >
                      {capturing ? 'Press keys…' : formatBinding(binding, platform)}
                    </button>
                  </div>
                )
              })}
            </div>
          ))}
        </div>
        <div className="modal-actions">
          <button data-shortcut-action="reset" onClick={props.onReset}>Reset to defaults</button>
          <button data-shortcut-action="done" className="primary" onClick={props.onClose}>Done</button>
        </div>
        <p className="hint">Loop / Metronome shortcuts are unavailable — not supported by the current engine.</p>
      </div>
    </div>
  )
}
