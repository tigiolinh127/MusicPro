import fs from 'fs'
import path from 'path'
import { app } from 'electron'

export interface RecentProjectEntry {
  path: string
  name: string
  projectId: string
  lastOpenedAt: string
  available: boolean
}

export interface RecoverySnapshot {
  projectId: string
  projectName: string
  originalPath: string | null
  snapshotPath: string
  timestamp: string
  available: boolean
  error?: string
}

export interface AutosaveMeta {
  projectId: string
  projectName: string
  originalPath: string | null
  savedAt: string
  schemaVersion: number
}

const MAX_RECENT = 12
const MAX_SNAPSHOTS = 10
const RECENT_FILE = 'recent-projects.json'

function userDataRoot(): string {
  const override = process.env.MSP_PROJECT_DATA_ROOT
  if (override != null && override.length > 0)
    return path.resolve(override)
  return app.getPath('userData')
}

export function autosaveRoot(): string {
  return path.join(userDataRoot(), 'autosave')
}

function recentPath(): string {
  return path.join(userDataRoot(), RECENT_FILE)
}

function projectAutosaveDir(projectId: string): string {
  const safe = projectId.replace(/[^a-zA-Z0-9._-]/g, '_')
  return path.join(autosaveRoot(), safe)
}

function atomicWriteText(filePath: string, text: string): void {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}`)
  fs.writeFileSync(tmp, text, 'utf8')
  try {
    fs.renameSync(tmp, filePath)
  } catch {
    fs.copyFileSync(tmp, filePath)
    fs.unlinkSync(tmp)
  }
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath))
      return null
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
  } catch {
    return null
  }
}

export function loadRecentProjects(): RecentProjectEntry[] {
  const raw = readJsonFile<RecentProjectEntry[]>(recentPath())
  if (!Array.isArray(raw))
    return []
  const seen = new Set<string>()
  const out: RecentProjectEntry[] = []
  for (const entry of raw) {
    if (entry == null || typeof entry.path !== 'string' || entry.path.length === 0)
      continue
    const key = path.normalize(entry.path).toLowerCase()
    if (seen.has(key))
      continue
    seen.add(key)
    out.push({
      path: entry.path,
      name: typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : path.basename(entry.path, path.extname(entry.path)),
      projectId: typeof entry.projectId === 'string' ? entry.projectId : '',
      lastOpenedAt: typeof entry.lastOpenedAt === 'string' ? entry.lastOpenedAt : new Date(0).toISOString(),
      available: fs.existsSync(entry.path)
    })
  }
  return out.slice(0, MAX_RECENT)
}

export function rememberRecentProject(entry: { path: string, name: string, projectId: string }): RecentProjectEntry[] {
  const normalized = path.resolve(entry.path)
  const now = new Date().toISOString()
  const existing = loadRecentProjects().filter((item) => path.normalize(item.path).toLowerCase() !== path.normalize(normalized).toLowerCase())
  const next: RecentProjectEntry[] = [{
    path: normalized,
    name: entry.name || path.basename(normalized, path.extname(normalized)),
    projectId: entry.projectId,
    lastOpenedAt: now,
    available: fs.existsSync(normalized)
  }, ...existing].slice(0, MAX_RECENT)
  atomicWriteText(recentPath(), `${JSON.stringify(next, null, 2)}\n`)
  return next
}

export function removeRecentProject(targetPath: string): RecentProjectEntry[] {
  const key = path.normalize(targetPath).toLowerCase()
  const next = loadRecentProjects().filter((item) => path.normalize(item.path).toLowerCase() !== key)
  atomicWriteText(recentPath(), `${JSON.stringify(next, null, 2)}\n`)
  return next
}

function listSnapshotFiles(projectId: string): string[] {
  const dir = projectAutosaveDir(projectId)
  if (!fs.existsSync(dir))
    return []
  return fs.readdirSync(dir)
    .filter((name) => name.startsWith('snapshot-') && name.endsWith('.msp.json'))
    .map((name) => path.join(dir, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
}

function validateProjectPayload(text: string): { ok: true, projectId: string, projectName: string, version: number } | { ok: false, error: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, error: 'Autosave payload is not valid JSON.' }
  }
  if (parsed == null || typeof parsed !== 'object')
    return { ok: false, error: 'Autosave payload is not a project object.' }
  const obj = parsed as Record<string, unknown>
  if (obj.format !== 'music-studio-pro-project')
    return { ok: false, error: 'Autosave payload is not a Music Studio Pro project.' }
  const version = typeof obj.version === 'number' ? obj.version : Number(obj.version)
  if (!Number.isFinite(version) || version < 1 || version > 6)
    return { ok: false, error: `Unsupported autosave schema version: ${String(obj.version)}` }
  if (!Array.isArray(obj.tracks))
    return { ok: false, error: 'Autosave payload is missing tracks.' }
  const projectId = typeof obj.projectId === 'string' ? obj.projectId : ''
  const projectName = typeof obj.projectName === 'string' && obj.projectName.length > 0 ? obj.projectName : 'Untitled'
  return { ok: true, projectId, projectName, version }
}

export function allocateAutosavePath(projectId: string): { dir: string, snapshotPath: string, savedAt: string } {
  const dir = projectAutosaveDir(projectId)
  fs.mkdirSync(dir, { recursive: true })
  const savedAt = new Date().toISOString()
  const stamp = savedAt.replace(/[:.]/g, '-')
  return { dir, snapshotPath: path.join(dir, `snapshot-${stamp}.msp.json`), savedAt }
}

export function commitAutosaveFile(options: {
  projectId: string
  projectName: string
  originalPath: string | null
  snapshotPath: string
  savedAt?: string
}): { ok: true, snapshotPath: string, savedAt: string } | { ok: false, error: string } {
  if (!fs.existsSync(options.snapshotPath))
    return { ok: false, error: 'Autosave snapshot file was not written.' }
  let text: string
  try {
    text = fs.readFileSync(options.snapshotPath, 'utf8')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `Could not read autosave snapshot: ${message}` }
  }
  const validated = validateProjectPayload(text)
  if (!validated.ok) {
    try { fs.unlinkSync(options.snapshotPath) } catch { /* leave for diagnosis */ }
    return { ok: false, error: validated.error }
  }
  const savedAt = options.savedAt ?? new Date().toISOString()
  const meta: AutosaveMeta = {
    projectId: options.projectId,
    projectName: options.projectName || validated.projectName,
    originalPath: options.originalPath,
    savedAt,
    schemaVersion: validated.version
  }
  try {
    atomicWriteText(path.join(projectAutosaveDir(options.projectId), 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`)
  } catch {
    // Snapshot remains valid without meta.
  }
  const files = listSnapshotFiles(options.projectId)
  for (const stale of files.slice(MAX_SNAPSHOTS)) {
    try { fs.unlinkSync(stale) } catch { /* keep latest */ }
  }
  return { ok: true, snapshotPath: options.snapshotPath, savedAt }
}

export function writeAutosaveSnapshot(options: {
  projectId: string
  projectName: string
  originalPath: string | null
  projectJson: string
}): { ok: true, snapshotPath: string, savedAt: string } | { ok: false, error: string } {
  const validated = validateProjectPayload(options.projectJson)
  if (!validated.ok)
    return { ok: false, error: validated.error }
  const projectId = options.projectId || validated.projectId
  if (projectId.length === 0)
    return { ok: false, error: 'Autosave requires a project identity.' }

  const dir = projectAutosaveDir(projectId)
  fs.mkdirSync(dir, { recursive: true })
  const savedAt = new Date().toISOString()
  const stamp = savedAt.replace(/[:.]/g, '-')
  const snapshotPath = path.join(dir, `snapshot-${stamp}.msp.json`)
  const metaPath = path.join(dir, 'meta.json')

  // Enrich JSON with identity fields without rewriting media paths.
  let enriched = options.projectJson
  try {
    const obj = JSON.parse(options.projectJson) as Record<string, unknown>
    obj.projectId = projectId
    obj.projectName = options.projectName || validated.projectName
    enriched = `${JSON.stringify(obj, null, 2)}\n`
  } catch {
    return { ok: false, error: 'Could not enrich autosave JSON.' }
  }

  try {
    atomicWriteText(snapshotPath, enriched)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `Autosave write failed: ${message}` }
  }

  const meta: AutosaveMeta = {
    projectId,
    projectName: options.projectName || validated.projectName,
    originalPath: options.originalPath,
    savedAt,
    schemaVersion: validated.version
  }
  try {
    atomicWriteText(metaPath, `${JSON.stringify(meta, null, 2)}\n`)
  } catch {
    // Snapshot is valid even if meta write fails.
  }

  // Retention: remove oldest only after a new valid snapshot exists.
  const files = listSnapshotFiles(projectId)
  for (const stale of files.slice(MAX_SNAPSHOTS)) {
    try { fs.unlinkSync(stale) } catch { /* keep latest intact */ }
  }

  return { ok: true, snapshotPath, savedAt }
}

export function listRecoverySnapshots(): RecoverySnapshot[] {
  const root = autosaveRoot()
  if (!fs.existsSync(root))
    return []
  const out: RecoverySnapshot[] = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory())
      continue
    const projectId = entry.name
    const dir = path.join(root, projectId)
    const meta = readJsonFile<AutosaveMeta>(path.join(dir, 'meta.json'))
    const latest = listSnapshotFiles(projectId)[0]
    if (latest == null)
      continue
    const text = fs.readFileSync(latest, 'utf8')
    const validated = validateProjectPayload(text)
    const stamp = meta?.savedAt ?? fs.statSync(latest).mtime.toISOString()
    const recoveredId = (meta?.projectId != null && meta.projectId.length > 0)
      ? meta.projectId
      : (validated.ok && validated.projectId.length > 0 ? validated.projectId : projectId)
    const recoveredName = (meta?.projectName != null && meta.projectName.length > 0)
      ? meta.projectName
      : (validated.ok ? validated.projectName : 'Untitled')
    out.push({
      projectId: recoveredId,
      projectName: recoveredName,
      originalPath: meta?.originalPath ?? null,
      snapshotPath: latest,
      timestamp: stamp,
      available: validated.ok,
      error: validated.ok ? undefined : validated.error
    })
  }
  out.sort((a, b) => b.timestamp.localeCompare(a.timestamp))
  return out
}

export function discardRecoverySnapshots(projectId: string): void {
  const dir = projectAutosaveDir(projectId)
  if (!fs.existsSync(dir))
    return
  for (const name of fs.readdirSync(dir)) {
    try { fs.unlinkSync(path.join(dir, name)) } catch { /* ignore */ }
  }
  try { fs.rmdirSync(dir) } catch { /* ignore */ }
}

export function copyRecoveryWorkingCopy(snapshotPath: string, destPath: string): { ok: true } | { ok: false, error: string } {
  try {
    const text = fs.readFileSync(snapshotPath, 'utf8')
    const validated = validateProjectPayload(text)
    if (!validated.ok)
      return { ok: false, error: validated.error }
    atomicWriteText(destPath, text.endsWith('\n') ? text : `${text}\n`)
    return { ok: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: message }
  }
}

export const projectPersistenceLimits = {
  maxRecent: MAX_RECENT,
  maxSnapshots: MAX_SNAPSHOTS
}
