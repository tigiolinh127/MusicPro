import path from 'path'
import { probeWavFile, type MediaAvailability, type WavProbeResult } from './mediaProbe'
import { isExternalToProject, normalizeMediaPath, sameMediaPath } from './mediaPaths'

export type MediaOrigin = 'original' | 'recorded' | 'generated' | 'unknown'

export interface MediaAssetRow {
  key: string
  trackId: string
  trackName: string
  sourceFileId: string
  kind: 'primary' | 'extra' | string
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
  duplicateOf: string | null
  external: boolean
  clipCount: number
  takeCount: number
  trackNames: string[]
  error?: string
  fingerprint?: string
  probe?: WavProbeResult
}

export interface InventorySourceInput {
  trackId: string
  trackName: string
  sourceFileId: string
  kind: string
  path: string
  missing?: boolean
  error?: string
  sampleRate?: number
  channels?: number
  duration?: number
  clipCount: number
  takeCount: number
}

function inferOrigin(filePath: string, kind: string): MediaOrigin {
  const base = path.basename(filePath).toLowerCase()
  if (/take[-_]?\d|rec[-_]?\d|record|dry-|processed-/.test(base))
    return 'recorded'
  if (/stretch|pitch|breath|preview|bake|render/.test(base) || kind === 'extra' && /gen|bake/.test(base))
    return 'generated'
  if (filePath.length > 0)
    return 'original'
  return 'unknown'
}

export function buildMediaInventory(
  sources: InventorySourceInput[],
  projectFilePath: string | null,
  options?: { probe?: boolean }
): MediaAssetRow[] {
  const shouldProbe = options?.probe !== false
  const rows: MediaAssetRow[] = []
  const byPath = new Map<string, string>()

  for (const source of sources) {
    const resolved = source.path ? normalizeMediaPath(source.path) : ''
    const probe = shouldProbe && resolved.length > 0
      ? probeWavFile(resolved)
      : null

    let availability: MediaAvailability = 'unverified'
    if (!resolved) {
      availability = 'missing'
    } else if (source.missing) {
      availability = probe?.availability === 'available' ? 'available' : (probe?.availability ?? 'missing')
    } else if (probe != null) {
      availability = probe.availability
    } else {
      availability = 'unverified'
    }

    const pathKey = resolved.toLowerCase()
    const duplicateOf = pathKey.length > 0 && byPath.has(pathKey) ? (byPath.get(pathKey) ?? null) : null
    if (pathKey.length > 0 && !byPath.has(pathKey))
      byPath.set(pathKey, `${source.trackId}:${source.sourceFileId}`)

    const key = `${source.trackId}::${source.sourceFileId}`
    rows.push({
      key,
      trackId: source.trackId,
      trackName: source.trackName,
      sourceFileId: source.sourceFileId,
      kind: source.kind,
      fileName: resolved ? path.basename(resolved) : '(no path)',
      path: resolved || source.path,
      format: probe?.format ?? (resolved ? path.extname(resolved).replace(/^\./, '').toLowerCase() || 'wav' : ''),
      durationSeconds: probe?.ok ? probe.durationSeconds : (source.duration ?? 0),
      sampleRate: probe?.ok ? probe.sampleRate : (source.sampleRate ?? 0),
      channels: probe?.ok ? probe.channels : (source.channels ?? 0),
      fileBytes: probe?.fileBytes ?? 0,
      availability,
      origin: inferOrigin(resolved, source.kind),
      unused: source.clipCount === 0 && source.takeCount === 0,
      duplicateOf,
      external: isExternalToProject(resolved, projectFilePath),
      clipCount: source.clipCount,
      takeCount: source.takeCount,
      trackNames: [source.trackName],
      error: probe?.error ?? source.error,
      fingerprint: probe?.fingerprint,
      probe: probe ?? undefined
    })
  }

  // Merge duplicate path track names for display.
  for (const row of rows) {
    if (!row.path)
      continue
    const peers = rows.filter((r) => r.path && sameMediaPath(r.path, row.path))
    row.trackNames = [...new Set(peers.map((p) => p.trackName))]
  }

  return rows
}

export function missingFromInventory(rows: MediaAssetRow[]): MediaAssetRow[] {
  return rows.filter((r) => r.availability === 'missing' || r.availability === 'offline' || r.availability === 'invalid')
}
