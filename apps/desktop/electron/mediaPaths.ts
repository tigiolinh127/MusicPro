import path from 'path'
import fs from 'fs'

/** Normalize Windows/Unix separators and trim trailing separators (except roots). */
export function normalizeMediaPath(filePath: string): string {
  if (filePath == null || filePath.length === 0)
    return ''
  const resolved = path.resolve(filePath.replace(/\//g, path.sep))
  return resolved
}

export function sameMediaPath(a: string, b: string): boolean {
  if (!a || !b)
    return false
  return normalizeMediaPath(a).toLowerCase() === normalizeMediaPath(b).toLowerCase()
}

export function isAbsoluteMediaPath(filePath: string): boolean {
  return path.isAbsolute(filePath.replace(/\//g, path.sep))
}

/** Resolve a project-relative path against the project file directory. Absolute paths pass through. */
export function resolveAgainstProject(filePath: string, projectFilePath: string | null): string {
  if (!filePath)
    return ''
  const normalized = filePath.replace(/\//g, path.sep)
  if (path.isAbsolute(normalized))
    return path.resolve(normalized)
  if (projectFilePath == null || projectFilePath.length === 0)
    return path.resolve(normalized)
  return path.resolve(path.dirname(projectFilePath), normalized)
}

export function relativeToProject(filePath: string, projectFilePath: string | null): string | null {
  if (!filePath || projectFilePath == null)
    return null
  const abs = normalizeMediaPath(filePath)
  const root = path.dirname(normalizeMediaPath(projectFilePath))
  const rel = path.relative(root, abs)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel))
    return null
  return rel
}

export function isExternalToProject(filePath: string, projectFilePath: string | null): boolean {
  if (!filePath || projectFilePath == null)
    return true
  return relativeToProject(filePath, projectFilePath) == null
}

export function projectMediaDirs(projectFilePath: string | null): string[] {
  if (projectFilePath == null || projectFilePath.length === 0)
    return []
  const root = path.dirname(normalizeMediaPath(projectFilePath))
  const candidates = [
    root,
    path.join(root, 'media'),
    path.join(root, 'Media'),
    path.join(root, 'Audio'),
    path.join(root, 'audio'),
    path.join(root, 'Recordings'),
    path.join(root, 'recordings')
  ]
  return candidates.filter((dir) => {
    try {
      return fs.statSync(dir).isDirectory()
    } catch {
      return false
    }
  })
}

const recoveryDirsFile = (): string => {
  const root = process.env.MSP_PROJECT_DATA_ROOT
    ?? path.join(process.env.APPDATA ?? process.cwd(), 'MusicStudioPro')
  return path.join(root, 'media-recovery-dirs.json')
}

export function loadRecoveryDirectories(): string[] {
  try {
    const raw = fs.readFileSync(recoveryDirsFile(), 'utf8')
    const parsed = JSON.parse(raw) as { dirs?: string[] }
    if (!Array.isArray(parsed.dirs))
      return []
    return parsed.dirs.map(normalizeMediaPath).filter((d) => d.length > 0)
  } catch {
    return []
  }
}

export function rememberRecoveryDirectory(dir: string): string[] {
  const next = normalizeMediaPath(dir)
  if (!next)
    return loadRecoveryDirectories()
  const existing = loadRecoveryDirectories().filter((d) => !sameMediaPath(d, next))
  const dirs = [next, ...existing].slice(0, 12)
  try {
    const file = recoveryDirsFile()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ dirs }, null, 2), 'utf8')
  } catch {
    /* non-fatal */
  }
  return dirs
}
