import type { MissingMediaItem } from './mediaAssets'

export interface MediaSearchCandidate {
  path: string
  score: number
  rank: string
  ambiguous: boolean
  durationSeconds?: number
  sampleRate?: number
  channels?: number
  fileBytes?: number
}

export interface MissingMediaDialogProps {
  open: boolean
  projectName: string
  items: MissingMediaItem[]
  activeKey: string | null
  searching: boolean
  searchScanned: number
  searchFolder: string | null
  candidates: MediaSearchCandidate[]
  candidateError: string | null
  busy: boolean
  onSelectItem: (key: string) => void
  onLocateFile: () => void
  onSearchFolder: () => void
  onRelink: (path: string) => void
  onRelinkAll: () => void
  onSkip: () => void
  onDecideLater: () => void
  onCancelSearch: () => void
  onClose: () => void
}

export function MissingMediaDialog(props: MissingMediaDialogProps) {
  if (!props.open)
    return null

  const active = props.items.find((item) => item.key === props.activeKey) ?? props.items[0] ?? null
  const pending = props.items.filter((item) => item.status === 'pending')
  const unambiguous = props.candidates.filter((c) => !c.ambiguous && c.score >= 75)

  return (
    <div className="modal-backdrop" data-missing-media-dialog="true" role="dialog" aria-modal="true" aria-label="Missing media recovery">
      <div className="modal-card missing-media-card">
        <div className="media-assets-header">
          <div>
            <h2>Missing Media</h2>
            <p className="hint">Project: {props.projectName}</p>
          </div>
          <button data-missing-action="close" onClick={props.onClose} disabled={props.searching}>Close</button>
        </div>

        <div className="missing-media-layout">
          <aside className="missing-media-list" data-missing-list>
            {props.items.map((item) => (
              <button
                key={item.key}
                type="button"
                className={item.key === active?.key ? 'missing-item active' : 'missing-item'}
                data-missing-item={item.key}
                data-missing-status={item.status}
                onClick={() => props.onSelectItem(item.key)}
              >
                <strong>{item.fileName}</strong>
                <span className="hint">{item.status} · {item.clipCount} clip{item.clipCount === 1 ? '' : 's'}</span>
              </button>
            ))}
            {props.items.length === 0 && <p className="hint">No missing media.</p>}
          </aside>

          <div className="missing-media-detail">
            {active == null ? (
              <p className="hint">Select a missing asset.</p>
            ) : (
              <>
                <dl className="recovery-meta" data-missing-detail>
                  <div><dt>Filename</dt><dd data-missing-filename>{active.fileName}</dd></div>
                  <div><dt>Original path</dt><dd data-missing-path>{active.originalPath || '—'}</dd></div>
                  <div><dt>Affected clips</dt><dd data-missing-clips>{active.clipCount}</dd></div>
                  <div><dt>Affected tracks</dt><dd data-missing-tracks>{active.affectedTracks.join(', ') || active.trackName}</dd></div>
                  <div><dt>Status</dt><dd data-missing-recovery-status>{active.status} · {active.availability}</dd></div>
                  {active.error != null && active.error.length > 0 && (
                    <div><dt>Error</dt><dd>{active.error}</dd></div>
                  )}
                </dl>

                <div className="modal-actions">
                  <button data-missing-action="locate" className="primary" disabled={props.busy || props.searching} onClick={props.onLocateFile}>
                    Locate File
                  </button>
                  <button data-missing-action="search" disabled={props.busy || props.searching} onClick={props.onSearchFolder}>
                    Search Folder
                  </button>
                  <button data-missing-action="relink-all" disabled={props.busy || props.searching || pending.length === 0} onClick={props.onRelinkAll}>
                    Relink All
                  </button>
                  <button data-missing-action="skip" disabled={props.busy || props.searching || active.status !== 'pending'} onClick={props.onSkip}>
                    Skip
                  </button>
                  <button data-missing-action="later" disabled={props.busy || props.searching} onClick={props.onDecideLater}>
                    Decide Later
                  </button>
                </div>

                {props.searching && (
                  <div className="missing-search-progress" data-missing-search-progress>
                    <p className="hint">
                      Searching{props.searchFolder != null ? ` in ${props.searchFolder}` : ''}… scanned {props.searchScanned} file{props.searchScanned === 1 ? '' : 's'}
                    </p>
                    <button data-missing-action="cancel-search" onClick={props.onCancelSearch}>Cancel search</button>
                  </div>
                )}

                {props.candidateError != null && (
                  <p className="hint" data-missing-error>{props.candidateError}</p>
                )}

                {props.candidates.length > 0 && (
                  <div className="missing-candidates" data-missing-candidates>
                    <h3>Candidates</h3>
                    {unambiguous.length === 0 && props.candidates.some((c) => c.ambiguous) && (
                      <p className="hint">Multiple candidates match — confirm one manually. Ambiguous matches are never applied automatically.</p>
                    )}
                    <ul>
                      {props.candidates.map((candidate) => (
                        <li key={candidate.path} data-missing-candidate={candidate.path} data-ambiguous={candidate.ambiguous ? 'true' : 'false'}>
                          <div>
                            <div className="media-file-name">{candidate.path}</div>
                            <div className="hint">
                              {candidate.rank} · score {candidate.score}
                              {candidate.ambiguous ? ' · ambiguous' : ''}
                              {candidate.durationSeconds != null ? ` · ${candidate.durationSeconds.toFixed(2)}s` : ''}
                            </div>
                          </div>
                          <button
                            data-missing-relink-path={candidate.path}
                            disabled={props.busy}
                            onClick={() => props.onRelink(candidate.path)}
                          >
                            Relink
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
