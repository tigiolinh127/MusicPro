import {
  formatBytes,
  formatDuration,
  type ProjectMediaAsset
} from './mediaAssets'

export interface MediaAssetsPanelProps {
  open: boolean
  projectName: string
  projectPath: string | null
  assets: ProjectMediaAsset[]
  enriched: Record<string, { fileBytes?: number, availability?: string, error?: string, format?: string }>
  externalCount: number
  missingCount: number
  busyKey: string | null
  onClose: () => void
  onRelink: (asset: ProjectMediaAsset) => void
  onRevealMissing: () => void
  onRefresh: () => void
}

function statusLabel(asset: ProjectMediaAsset, enriched?: { availability?: string }): string {
  const value = enriched?.availability ?? asset.availability
  switch (value) {
    case 'available': return 'Available'
    case 'missing': return 'Missing'
    case 'offline': return 'Offline'
    case 'invalid': return 'Invalid'
    default: return 'Unverified'
  }
}

export function MediaAssetsPanel(props: MediaAssetsPanelProps) {
  if (!props.open)
    return null

  const { assets, enriched } = props

  return (
    <div className="modal-backdrop" data-media-assets-panel="true" role="dialog" aria-modal="true" aria-label="Project media">
      <div className="modal-card media-assets-card">
        <div className="media-assets-header">
          <div>
            <h2>Project Media</h2>
            <p className="hint">{props.projectName}{props.projectPath != null ? ` · ${props.projectPath}` : ''}</p>
          </div>
          <div className="modal-actions">
            <button data-media-action="refresh" onClick={props.onRefresh}>Refresh</button>
            {props.missingCount > 0 && (
              <button data-media-action="recover" className="primary" onClick={props.onRevealMissing}>
                Recover missing ({props.missingCount})
              </button>
            )}
            <button data-media-action="close" onClick={props.onClose}>Close</button>
          </div>
        </div>

        {props.externalCount > 0 && (
          <p className="media-external-warn" data-media-external-warn="true">
            This project references {props.externalCount} external audio file{props.externalCount === 1 ? '' : 's'}
            outside the project folder. Moving the project will require those files too.
            Collect/Consolidate Media is a future enhancement — files are never copied automatically.
          </p>
        )}

        <div className="media-assets-table-wrap">
          <table className="media-assets-table" data-media-assets-table>
            <thead>
              <tr>
                <th>File</th>
                <th>Location</th>
                <th>Format</th>
                <th>Duration</th>
                <th>Rate</th>
                <th>Ch</th>
                <th>Size</th>
                <th>Status</th>
                <th>Origin</th>
                <th>Use</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {assets.length === 0 && (
                <tr>
                  <td colSpan={11} className="hint">No audio assets in this project yet.</td>
                </tr>
              )}
              {assets.map((asset) => {
                const extra = enriched[asset.key]
                const bytes = extra?.fileBytes ?? asset.fileBytes
                const busy = props.busyKey === asset.key
                return (
                  <tr
                    key={asset.key}
                    data-media-row={asset.key}
                    data-media-status={extra?.availability ?? asset.availability}
                    data-media-unused={asset.unused ? 'true' : 'false'}
                    data-media-duplicate={asset.duplicate ? 'true' : 'false'}
                  >
                    <td>
                      <div className="media-file-name">{asset.fileName}</div>
                      <div className="hint">{asset.trackName} · {asset.sourceFileId}</div>
                    </td>
                    <td className="media-path-cell" title={asset.path}>{asset.path || '—'}</td>
                    <td>{((extra?.format ?? asset.format) || '—').toUpperCase()}</td>
                    <td>{formatDuration(asset.durationSeconds)}</td>
                    <td>{asset.sampleRate > 0 ? `${Math.round(asset.sampleRate)} Hz` : '—'}</td>
                    <td>{asset.channels > 0 ? asset.channels : '—'}</td>
                    <td>{formatBytes(bytes)}</td>
                    <td>
                      <span className={`media-status media-status-${extra?.availability ?? asset.availability}`}>
                        {statusLabel(asset, extra)}
                      </span>
                      {asset.duplicate && <span className="hint"> · duplicate ref</span>}
                      {(extra?.error ?? asset.error) != null && (
                        <div className="hint">{extra?.error ?? asset.error}</div>
                      )}
                    </td>
                    <td>{asset.origin}</td>
                    <td>
                      {asset.unused ? 'Unused' : `${asset.clipCount} clip${asset.clipCount === 1 ? '' : 's'}`}
                      {asset.takeCount > 0 ? ` · ${asset.takeCount} take${asset.takeCount === 1 ? '' : 's'}` : ''}
                    </td>
                    <td>
                      <button
                        data-media-relink={asset.key}
                        disabled={busy}
                        onClick={() => props.onRelink(asset)}
                      >
                        {busy ? '…' : 'Relink'}
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
