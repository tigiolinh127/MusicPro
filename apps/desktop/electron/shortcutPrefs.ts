import fs from 'fs'
import path from 'path'
import { app } from 'electron'

export interface KeyBinding {
  code?: string
  key?: string
  ctrlOrMeta?: boolean
  shift?: boolean
  alt?: boolean
}

export type ShortcutOverrides = Record<string, KeyBinding>

const FILE = 'keyboard-shortcuts.json'

function userDataRoot(): string {
  const override = process.env.MSP_PROJECT_DATA_ROOT
  if (override != null && override.length > 0)
    return path.resolve(override)
  return app.getPath('userData')
}

function prefsPath(): string {
  return path.join(userDataRoot(), FILE)
}

function isBinding(value: unknown): value is KeyBinding {
  if (value == null || typeof value !== 'object')
    return false
  const obj = value as Record<string, unknown>
  if (obj.code != null && typeof obj.code !== 'string')
    return false
  if (obj.key != null && typeof obj.key !== 'string')
    return false
  return true
}

export function loadShortcutOverrides(): ShortcutOverrides {
  try {
    if (!fs.existsSync(prefsPath()))
      return {}
    const parsed = JSON.parse(fs.readFileSync(prefsPath(), 'utf8')) as { overrides?: ShortcutOverrides }
    if (parsed?.overrides == null || typeof parsed.overrides !== 'object')
      return {}
    const out: ShortcutOverrides = {}
    for (const [id, binding] of Object.entries(parsed.overrides)) {
      if (isBinding(binding))
        out[id] = binding
    }
    return out
  } catch {
    return {}
  }
}

export function saveShortcutOverrides(overrides: ShortcutOverrides): ShortcutOverrides {
  const dir = path.dirname(prefsPath())
  fs.mkdirSync(dir, { recursive: true })
  const cleaned: ShortcutOverrides = {}
  for (const [id, binding] of Object.entries(overrides)) {
    if (isBinding(binding))
      cleaned[id] = {
        code: binding.code,
        key: binding.key,
        ctrlOrMeta: binding.ctrlOrMeta === true ? true : undefined,
        shift: binding.shift === true ? true : undefined,
        alt: binding.alt === true ? true : undefined
      }
  }
  const tmp = `${prefsPath()}.tmp-${process.pid}`
  fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, overrides: cleaned }, null, 2)}\n`, 'utf8')
  try {
    fs.renameSync(tmp, prefsPath())
  } catch {
    fs.copyFileSync(tmp, prefsPath())
    fs.unlinkSync(tmp)
  }
  return cleaned
}

export function resetShortcutOverrides(): ShortcutOverrides {
  try {
    if (fs.existsSync(prefsPath()))
      fs.unlinkSync(prefsPath())
  } catch { /* ignore */ }
  return {}
}
