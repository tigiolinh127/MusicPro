import fs from 'fs'
import path from 'path'
import { probeWavFile, type WavProbeResult } from './mediaProbe'
import {
  loadRecoveryDirectories,
  normalizeMediaPath,
  projectMediaDirs,
  rememberRecoveryDirectory,
  sameMediaPath
} from './mediaPaths'

export interface MediaHint {
  originalPath: string
  fileName: string
  /** Expected duration seconds when known (>0). */
  durationSeconds?: number
  /** Expected sample rate when known. */
  sampleRate?: number
  /** Expected channels when known. */
  channels?: number
  /** Expected file size when known. */
  fileBytes?: number
  /** Optional fingerprint from a previous probe. */
  fingerprint?: string
}

export interface MediaCandidate {
  path: string
  score: number
  rank: 'exact-meta' | 'name-duration' | 'size-meta' | 'fingerprint' | 'name-only'
  probe: WavProbeResult
  ambiguous: boolean
}

export interface SearchProgress {
  searching: boolean
  scanned: number
  folder: string | null
  cancelled: boolean
  error?: string
}

type ProgressFn = (progress: SearchProgress) => void

let activeToken = 0
let cancelRequested = false

export function cancelMediaSearch(): void {
  cancelRequested = true
}

export interface SearchOptions {
  projectFilePath?: string | null
  folders?: string[]
  rememberFolder?: boolean
  maxDepth?: number
  onProgress?: ProgressFn
}

function basenameLower(p: string): string {
  return path.basename(p).toLowerCase()
}

function durationClose(a: number, b: number): boolean {
  if (!(a > 0) || !(b > 0))
    return false
  return Math.abs(a - b) <= Math.max(0.05, Math.min(a, b) * 0.02)
}

function metaCompatible(hint: MediaHint, probe: WavProbeResult): boolean {
  if (hint.sampleRate != null && hint.sampleRate > 0 && probe.sampleRate > 0
      && Math.abs(hint.sampleRate - probe.sampleRate) > 0.5)
    return false
  if (hint.channels != null && hint.channels > 0 && probe.channels > 0
      && hint.channels !== probe.channels)
    return false
  return true
}

function scoreCandidate(hint: MediaHint, probe: WavProbeResult): MediaCandidate | null {
  if (!probe.ok)
    return null
  const nameMatch = basenameLower(probe.path) === basenameLower(hint.fileName || hint.originalPath)
  const sizeMatch = hint.fileBytes != null && hint.fileBytes > 0 && probe.fileBytes === hint.fileBytes
  const durMatch = hint.durationSeconds != null && durationClose(hint.durationSeconds, probe.durationSeconds)
  const fpMatch = hint.fingerprint != null && hint.fingerprint.length > 0
    && probe.fingerprint === hint.fingerprint
  const metaOk = metaCompatible(hint, probe)

  if (nameMatch && metaOk && (durMatch || hint.durationSeconds == null)) {
    return { path: probe.path, score: 100, rank: 'exact-meta', probe, ambiguous: false }
  }
  if (nameMatch && durMatch && metaOk) {
    return { path: probe.path, score: 90, rank: 'name-duration', probe, ambiguous: false }
  }
  if (fpMatch && metaOk) {
    return { path: probe.path, score: 85, rank: 'fingerprint', probe, ambiguous: false }
  }
  if (sizeMatch && metaOk && (durMatch || nameMatch)) {
    return { path: probe.path, score: 75, rank: 'size-meta', probe, ambiguous: false }
  }
  if (nameMatch) {
    // Filename alone is never auto-selected when other candidates exist.
    return { path: probe.path, score: 40, rank: 'name-only', probe, ambiguous: true }
  }
  return null
}

function collectWavFiles(root: string, maxDepth: number, token: number, onFile: (file: string) => void): void {
  const stack: Array<{ dir: string, depth: number }> = [{ dir: root, depth: 0 }]
  while (stack.length > 0) {
    if (cancelRequested || token !== activeToken)
      return
    const item = stack.pop()
    if (item == null)
      continue
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(item.dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (cancelRequested || token !== activeToken)
        return
      const full = path.join(item.dir, entry.name)
      if (entry.isDirectory()) {
        if (item.depth < maxDepth && !entry.name.startsWith('.'))
          stack.push({ dir: full, depth: item.depth + 1 })
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.wav')) {
        onFile(full)
      }
    }
  }
}

export async function searchMediaCandidates(hint: MediaHint, options: SearchOptions = {}): Promise<{
  candidates: MediaCandidate[]
  cancelled: boolean
  scanned: number
}> {
  const token = ++activeToken
  cancelRequested = false
  const maxDepth = options.maxDepth ?? 4
  const folders: string[] = []
  const pushFolder = (dir: string | null | undefined): void => {
    if (dir == null || dir.length === 0)
      return
    const normalized = normalizeMediaPath(dir)
    if (!normalized)
      return
    if (folders.some((f) => sameMediaPath(f, normalized)))
      return
    try {
      if (fs.statSync(normalized).isDirectory())
        folders.push(normalized)
    } catch { /* skip */ }
  }

  if (hint.originalPath) {
    pushFolder(path.dirname(normalizeMediaPath(hint.originalPath)))
  }
  for (const dir of projectMediaDirs(options.projectFilePath ?? null))
    pushFolder(dir)
  for (const dir of loadRecoveryDirectories())
    pushFolder(dir)
  for (const dir of options.folders ?? [])
    pushFolder(dir)

  if (options.rememberFolder && (options.folders?.length ?? 0) > 0) {
    for (const dir of options.folders ?? [])
      rememberRecoveryDirectory(dir)
  }

  const seen = new Set<string>()
  const scored: MediaCandidate[] = []
  let scanned = 0

  const report = (folder: string | null): void => {
    options.onProgress?.({
      searching: true,
      scanned,
      folder,
      cancelled: false
    })
  }

  // Yield to event loop between folders so cancellation stays responsive.
  for (const folder of folders) {
    if (cancelRequested || token !== activeToken)
      break
    report(folder)
    await new Promise<void>((resolve) => setImmediate(resolve))
    collectWavFiles(folder, maxDepth, token, (file) => {
      const key = normalizeMediaPath(file).toLowerCase()
      if (seen.has(key))
        return
      seen.add(key)
      scanned += 1
      const probe = probeWavFile(file)
      const candidate = scoreCandidate(hint, probe)
      if (candidate != null)
        scored.push(candidate)
      if (scanned % 25 === 0)
        report(folder)
    })
  }

  const cancelled = cancelRequested || token !== activeToken
  options.onProgress?.({
    searching: false,
    scanned,
    folder: null,
    cancelled
  })

  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))

  // Mark ambiguity: multiple top-tier matches, or name-only when others also match the name.
  const topScore = scored[0]?.score ?? 0
  const topTier = scored.filter((c) => c.score >= topScore - 5 && c.score >= 75)
  if (topTier.length > 1) {
    for (const c of scored) {
      if (c.score >= 75)
        c.ambiguous = true
    }
  }
  const nameOnly = scored.filter((c) => c.rank === 'name-only')
  if (nameOnly.length > 1 || (nameOnly.length === 1 && scored.some((c) => c.rank !== 'name-only'))) {
    for (const c of nameOnly)
      c.ambiguous = true
  }

  return { candidates: scored, cancelled, scanned }
}

/** Auto-pick only when a single non-ambiguous high-confidence candidate exists. */
export function autoSelectCandidate(candidates: MediaCandidate[]): MediaCandidate | null {
  // Require exact-meta / name-duration / fingerprint tier. Size-only matches are never auto-applied
  // when other files share compatible metadata.
  const strong = candidates.filter((c) => !c.ambiguous && c.score >= 85)
  if (strong.length === 1)
    return strong[0]
  return null
}
