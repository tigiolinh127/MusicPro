import type { EngineState, MediaSourceState, TrackState } from '../../../../packages/shared/src/protocol'

export type MediaAvailability = 'available' | 'missing' | 'offline' | 'invalid' | 'unverified'
export type MediaOrigin = 'original' | 'recorded' | 'generated' | 'unknown'

export interface ProjectMediaAsset {
  key: string
  trackId: string
  trackName: string
  sourceFileId: string
  kind: string
  fileName: string
  path: string
  format: string
  durationSeconds: number
  sampleRate: number
  channels: number
  fileBytes: number
  availability: MediaAvailability
  origin: MediaOrigin
  unused: boolean
  duplicate: boolean
  external: boolean
  clipCount: number
  takeCount: number
  affectedTrackNames: string[]
  error?: string
}

export interface MissingMediaItem {
  key: string
  trackId: string
  trackName: string
  sourceFileId: string
  fileName: string
  originalPath: string
  clipCount: number
  takeCount: number
  affectedTracks: string[]
  availability: MediaAvailability
  error?: string
  durationSeconds: number
  sampleRate: number
  channels: number
  status: 'pending' | 'relinked' | 'skipped' | 'later'
}

function fileNameOf(filePath: string): string {
  if (!filePath)
    return '(no path)'
  const parts = filePath.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] || filePath
}

function inferOrigin(filePath: string, kind: string): MediaOrigin {
  const base = fileNameOf(filePath).toLowerCase()
  if (/take[-_]?\d|rec[-_]?\d|record|dry-|processed-/.test(base))
    return 'recorded'
  if (/stretch|pitch|breath|preview|bake|render/.test(base))
    return 'generated'
  if (kind === 'extra' && /gen|bake/.test(base))
    return 'generated'
  if (filePath.length > 0)
    return 'original'
  return 'unknown'
}

function isExternal(filePath: string, projectPath: string | null): boolean {
  if (!filePath || projectPath == null)
    return Boolean(filePath)
  const norm = (p: string) => p.replace(/\//g, '\\').toLowerCase()
  const root = norm(projectPath).replace(/\\[^\\]+$/, '\\')
  const abs = norm(filePath)
  return !abs.startsWith(root)
}

function sourcesForTrack(track: TrackState): MediaSourceState[] {
  if (track.sources != null && track.sources.length > 0)
    return track.sources
  return [{
    id: `${track.id}-src`,
    path: track.path,
    kind: 'primary',
    missing: track.missing,
    error: track.error,
    sampleRate: track.sourceSampleRate,
    channels: track.channels,
    duration: track.duration
  }]
}

export function collectProjectMediaAssets(state: EngineState | null, projectPath: string | null): ProjectMediaAsset[] {
  if (state == null)
    return []
  const rows: ProjectMediaAsset[] = []
  const pathCounts = new Map<string, number>()

  for (const track of state.tracks) {
    for (const source of sourcesForTrack(track)) {
      const pathKey = (source.path ?? '').replace(/\//g, '\\').toLowerCase()
      if (pathKey)
        pathCounts.set(pathKey, (pathCounts.get(pathKey) ?? 0) + 1)
    }
  }

  for (const track of state.tracks) {
    for (const source of sourcesForTrack(track)) {
      const clipCount = track.clips.filter((c) => c.sourceFileId === source.id).length
      const takeCount = (track.takes ?? []).filter((t) => t.sourceFileId === source.id).length
      const pathKey = (source.path ?? '').replace(/\//g, '\\').toLowerCase()
      let availability: MediaAvailability = 'available'
      if (!source.path)
        availability = 'missing'
      else if (source.missing)
        availability = 'missing'
      else if (source.error != null && source.error.length > 0)
        availability = 'invalid'
      rows.push({
        key: `${track.id}::${source.id}`,
        trackId: track.id,
        trackName: track.name,
        sourceFileId: source.id,
        kind: source.kind,
        fileName: fileNameOf(source.path),
        path: source.path,
        format: source.path ? (fileNameOf(source.path).split('.').pop() ?? 'wav').toLowerCase() : '',
        durationSeconds: source.duration ?? 0,
        sampleRate: source.sampleRate ?? 0,
        channels: source.channels ?? 0,
        fileBytes: 0,
        availability,
        origin: inferOrigin(source.path, source.kind),
        unused: clipCount === 0 && takeCount === 0,
        duplicate: pathKey.length > 0 && (pathCounts.get(pathKey) ?? 0) > 1,
        external: isExternal(source.path, projectPath),
        clipCount,
        takeCount,
        affectedTrackNames: [track.name],
        error: source.error || undefined
      })
    }
  }

  for (const row of rows) {
    if (!row.path)
      continue
    const key = row.path.replace(/\//g, '\\').toLowerCase()
    row.affectedTrackNames = [...new Set(
      rows.filter((r) => r.path.replace(/\//g, '\\').toLowerCase() === key).map((r) => r.trackName)
    )]
  }

  return rows
}

export function collectMissingMedia(state: EngineState | null): MissingMediaItem[] {
  const assets = collectProjectMediaAssets(state, null)
  return assets
    .filter((a) => a.availability === 'missing' || a.availability === 'invalid' || a.availability === 'offline')
    .map((a) => ({
      key: a.key,
      trackId: a.trackId,
      trackName: a.trackName,
      sourceFileId: a.sourceFileId,
      fileName: a.fileName,
      originalPath: a.path,
      clipCount: a.clipCount,
      takeCount: a.takeCount,
      affectedTracks: a.affectedTrackNames,
      availability: a.availability,
      error: a.error,
      durationSeconds: a.durationSeconds,
      sampleRate: a.sampleRate,
      channels: a.channels,
      status: 'pending' as const
    }))
}

export function formatBytes(bytes: number): string {
  if (!(bytes > 0))
    return '—'
  if (bytes < 1024)
    return `${bytes} B`
  if (bytes < 1024 * 1024)
    return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

export function formatDuration(seconds: number): string {
  if (!(seconds > 0))
    return '—'
  const m = Math.floor(seconds / 60)
  const s = seconds - m * 60
  return `${m}:${s.toFixed(2).padStart(5, '0')}`
}
