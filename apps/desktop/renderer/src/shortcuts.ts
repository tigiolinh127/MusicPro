/** Phase 2.9.3 — centralized keyboard shortcut registry (renderer). */

export type ShortcutCommandId =
  | 'project.new'
  | 'project.open'
  | 'project.save'
  | 'project.saveAs'
  | 'edit.undo'
  | 'edit.redo'
  | 'edit.cut'
  | 'edit.copy'
  | 'edit.paste'
  | 'edit.duplicate'
  | 'edit.delete'
  | 'edit.selectAll'
  | 'edit.deselect'
  | 'timeline.zoomIn'
  | 'timeline.zoomOut'
  | 'timeline.fitProject'
  | 'timeline.fitSelection'
  | 'timeline.centerPlayhead'
  | 'timeline.split'
  | 'timeline.toggleSnap'
  | 'timeline.nudgeLeft'
  | 'timeline.nudgeRight'
  | 'timeline.nudgeLeftFine'
  | 'timeline.nudgeRightFine'
  | 'timeline.prevClip'
  | 'timeline.nextClip'
  | 'transport.playPause'
  | 'transport.stop'
  | 'transport.record'
  | 'transport.returnToStart'
  | 'transport.seekBack'
  | 'transport.seekForward'

export interface KeyBinding {
  /** KeyboardEvent.code when practical (Space, ArrowLeft, Digit0…). */
  code?: string
  /** Lowercase KeyboardEvent.key for letter shortcuts. */
  key?: string
  ctrlOrMeta?: boolean
  shift?: boolean
  alt?: boolean
}

export interface ShortcutDefinition {
  id: ShortcutCommandId
  name: string
  category: 'Project' | 'Edit' | 'Timeline' | 'Transport'
  binding: KeyBinding
  /** When true, allow key-repeat (nudge/seek). */
  allowRepeat?: boolean
  /** When true, still fire while an INPUT/TEXTAREA/SELECT is focused (rare). */
  allowWhileTyping?: boolean
  /** Editor-only (skipped in mixer/karaoke except transport.playPause). */
  editorOnly?: boolean
}

export const DEFAULT_SHORTCUTS: ShortcutDefinition[] = [
  { id: 'project.new', name: 'New Project', category: 'Project', binding: { key: 'n', ctrlOrMeta: true } },
  { id: 'project.open', name: 'Open Project', category: 'Project', binding: { key: 'o', ctrlOrMeta: true } },
  { id: 'project.save', name: 'Save Project', category: 'Project', binding: { key: 's', ctrlOrMeta: true } },
  { id: 'project.saveAs', name: 'Save As', category: 'Project', binding: { key: 's', ctrlOrMeta: true, shift: true } },
  { id: 'edit.undo', name: 'Undo', category: 'Edit', binding: { key: 'z', ctrlOrMeta: true } },
  { id: 'edit.redo', name: 'Redo', category: 'Edit', binding: { key: 'z', ctrlOrMeta: true, shift: true } },
  { id: 'edit.redo', name: 'Redo (alternate)', category: 'Edit', binding: { key: 'y', ctrlOrMeta: true } },
  { id: 'edit.cut', name: 'Cut', category: 'Edit', binding: { key: 'x', ctrlOrMeta: true }, editorOnly: true },
  { id: 'edit.copy', name: 'Copy', category: 'Edit', binding: { key: 'c', ctrlOrMeta: true }, editorOnly: true },
  { id: 'edit.paste', name: 'Paste', category: 'Edit', binding: { key: 'v', ctrlOrMeta: true }, editorOnly: true },
  { id: 'edit.duplicate', name: 'Duplicate', category: 'Edit', binding: { key: 'd', ctrlOrMeta: true }, editorOnly: true },
  { id: 'edit.delete', name: 'Delete', category: 'Edit', binding: { code: 'Delete' }, editorOnly: true },
  { id: 'edit.delete', name: 'Delete (Backspace)', category: 'Edit', binding: { code: 'Backspace' }, editorOnly: true },
  { id: 'edit.selectAll', name: 'Select All', category: 'Edit', binding: { key: 'a', ctrlOrMeta: true }, editorOnly: true },
  { id: 'edit.deselect', name: 'Deselect All', category: 'Edit', binding: { code: 'Escape' }, editorOnly: true },
  { id: 'timeline.zoomIn', name: 'Zoom In', category: 'Timeline', binding: { key: '=', ctrlOrMeta: true }, editorOnly: true },
  { id: 'timeline.zoomIn', name: 'Zoom In (+)', category: 'Timeline', binding: { key: '+', ctrlOrMeta: true }, editorOnly: true },
  { id: 'timeline.zoomOut', name: 'Zoom Out', category: 'Timeline', binding: { key: '-', ctrlOrMeta: true }, editorOnly: true },
  { id: 'timeline.fitProject', name: 'Fit Project', category: 'Timeline', binding: { key: 'f', ctrlOrMeta: true }, editorOnly: true },
  { id: 'timeline.fitSelection', name: 'Fit Selection', category: 'Timeline', binding: { key: 'f', ctrlOrMeta: true, shift: true }, editorOnly: true },
  { id: 'timeline.centerPlayhead', name: 'Center Playhead', category: 'Timeline', binding: { code: 'Home', ctrlOrMeta: true }, editorOnly: true },
  { id: 'timeline.split', name: 'Split at Playhead', category: 'Timeline', binding: { key: 's' }, editorOnly: true },
  { id: 'timeline.toggleSnap', name: 'Toggle Snap', category: 'Timeline', binding: { key: 'n' }, editorOnly: true },
  { id: 'timeline.nudgeLeft', name: 'Nudge Left', category: 'Timeline', binding: { code: 'ArrowLeft' }, allowRepeat: true, editorOnly: true },
  { id: 'timeline.nudgeRight', name: 'Nudge Right', category: 'Timeline', binding: { code: 'ArrowRight' }, allowRepeat: true, editorOnly: true },
  { id: 'timeline.nudgeLeftFine', name: 'Nudge Left (fine)', category: 'Timeline', binding: { code: 'ArrowLeft', shift: true }, allowRepeat: true, editorOnly: true },
  { id: 'timeline.nudgeRightFine', name: 'Nudge Right (fine)', category: 'Timeline', binding: { code: 'ArrowRight', shift: true }, allowRepeat: true, editorOnly: true },
  { id: 'timeline.prevClip', name: 'Previous Clip', category: 'Timeline', binding: { code: 'ArrowLeft', alt: true }, editorOnly: true },
  { id: 'timeline.nextClip', name: 'Next Clip', category: 'Timeline', binding: { code: 'ArrowRight', alt: true }, editorOnly: true },
  { id: 'transport.playPause', name: 'Play / Pause', category: 'Transport', binding: { code: 'Space' } },
  { id: 'transport.stop', name: 'Stop', category: 'Transport', binding: { code: 'Digit0' } },
  { id: 'transport.record', name: 'Record', category: 'Transport', binding: { key: 'r', ctrlOrMeta: true } },
  { id: 'transport.returnToStart', name: 'Return to Start', category: 'Transport', binding: { code: 'Home' } },
  { id: 'transport.seekBack', name: 'Seek Backward', category: 'Transport', binding: { code: 'ArrowLeft', ctrlOrMeta: true }, allowRepeat: true },
  { id: 'transport.seekForward', name: 'Seek Forward', category: 'Transport', binding: { code: 'ArrowRight', ctrlOrMeta: true }, allowRepeat: true }
]

export type ShortcutOverrides = Partial<Record<ShortcutCommandId, KeyBinding>>

export function mergeShortcuts(overrides: ShortcutOverrides = {}): ShortcutDefinition[] {
  return DEFAULT_SHORTCUTS.map((item) => {
    const override = overrides[item.id]
    if (override == null)
      return item
    return { ...item, binding: { ...override } }
  })
}

export function bindingEquals(a: KeyBinding, b: KeyBinding): boolean {
  return (a.code ?? '') === (b.code ?? '')
    && (a.key ?? '').toLowerCase() === (b.key ?? '').toLowerCase()
    && (a.ctrlOrMeta === true) === (b.ctrlOrMeta === true)
    && (a.shift === true) === (b.shift === true)
    && (a.alt === true) === (b.alt === true)
}

export function formatBinding(binding: KeyBinding, platform: 'win' | 'mac' = 'win'): string {
  const parts: string[] = []
  if (binding.ctrlOrMeta)
    parts.push(platform === 'mac' ? '⌘' : 'Ctrl')
  if (binding.alt)
    parts.push(platform === 'mac' ? '⌥' : 'Alt')
  if (binding.shift)
    parts.push(platform === 'mac' ? '⇧' : 'Shift')
  if (binding.code === 'Space')
    parts.push('Space')
  else if (binding.code === 'Escape')
    parts.push('Esc')
  else if (binding.code === 'Delete')
    parts.push('Del')
  else if (binding.code === 'Backspace')
    parts.push('Backspace')
  else if (binding.code === 'Home')
    parts.push('Home')
  else if (binding.code === 'ArrowLeft')
    parts.push('←')
  else if (binding.code === 'ArrowRight')
    parts.push('→')
  else if (binding.code === 'Digit0')
    parts.push('0')
  else if (binding.key === '=')
    parts.push('=')
  else if (binding.key === '+')
    parts.push('+')
  else if (binding.key === '-')
    parts.push('-')
  else if (binding.key != null && binding.key.length > 0)
    parts.push(binding.key.toUpperCase())
  else if (binding.code != null)
    parts.push(binding.code)
  return parts.join('+')
}

export function eventMatchesBinding(event: KeyboardEvent, binding: KeyBinding): boolean {
  const wantsMod = binding.ctrlOrMeta === true
  const hasMod = event.ctrlKey || event.metaKey
  if (wantsMod !== hasMod)
    return false
  if ((binding.shift === true) !== event.shiftKey)
    return false
  if ((binding.alt === true) !== event.altKey)
    return false
  if (binding.code != null && event.code === binding.code)
    return true
  if (binding.key != null && event.key.toLowerCase() === binding.key.toLowerCase())
    return true
  // Numpad / layout: Digits for '=' via key
  if (binding.key === '=' && (event.key === '=' || event.code === 'Equal'))
    return true
  if (binding.key === '+' && (event.key === '+' || event.key === '='))
    return wantsMod // already checked
  return false
}

function specificity(binding: KeyBinding): number {
  return (binding.ctrlOrMeta ? 4 : 0) + (binding.shift ? 2 : 0) + (binding.alt ? 1 : 0) + (binding.code != null ? 0.5 : 0)
}

export function matchShortcut(
  event: KeyboardEvent,
  shortcuts: ShortcutDefinition[],
  options: { view: 'editor' | 'mixer' | 'karaoke', typing: boolean, recording: boolean }
): ShortcutDefinition | null {
  const candidates = shortcuts
    .filter((item) => eventMatchesBinding(event, item.binding))
    .filter((item) => item.allowWhileTyping === true || !options.typing)
    .filter((item) => item.allowRepeat === true || !event.repeat)
    .filter((item) => {
      if (options.view === 'editor')
        return true
      // Mixer/karaoke: allow transport + project/edit global, skip editor-only timeline
      if (item.editorOnly === true)
        return false
      return true
    })
    .sort((a, b) => specificity(b.binding) - specificity(a.binding))

  const hit = candidates[0] ?? null
  if (hit == null)
    return null

  // Recording safety: block seek/play/new/open that would disturb the take; allow record toggle + stop via record.
  if (options.recording) {
    const blocked: ShortcutCommandId[] = [
      'transport.playPause',
      'transport.stop',
      'transport.returnToStart',
      'transport.seekBack',
      'transport.seekForward',
      'project.new',
      'project.open',
      'timeline.split',
      'timeline.nudgeLeft',
      'timeline.nudgeRight',
      'timeline.nudgeLeftFine',
      'timeline.nudgeRightFine',
      'edit.cut',
      'edit.delete',
      'edit.paste',
      'edit.duplicate'
    ]
    if (blocked.includes(hit.id) && hit.id !== 'transport.record')
      return null
  }
  return hit
}

export function findConflicts(shortcuts: ShortcutDefinition[]): Array<{ a: ShortcutCommandId, b: ShortcutCommandId, label: string }> {
  const out: Array<{ a: ShortcutCommandId, b: ShortcutCommandId, label: string }> = []
  for (let i = 0; i < shortcuts.length; i++) {
    for (let j = i + 1; j < shortcuts.length; j++) {
      const a = shortcuts[i]!
      const b = shortcuts[j]!
      if (a.id === b.id)
        continue
      if (!bindingEquals(a.binding, b.binding))
        continue
      out.push({ a: a.id, b: b.id, label: `${formatBinding(a.binding)} → ${a.name} & ${b.name}` })
    }
  }
  return out
}

export function parseBindingFromEvent(event: KeyboardEvent): KeyBinding | null {
  if (event.code === 'Tab' || event.code === 'Escape' || event.code === 'ShiftLeft' || event.code === 'ControlLeft' || event.code === 'MetaLeft' || event.code === 'AltLeft')
    return null
  const binding: KeyBinding = {}
  if (event.ctrlKey || event.metaKey)
    binding.ctrlOrMeta = true
  if (event.shiftKey)
    binding.shift = true
  if (event.altKey)
    binding.alt = true
  if (event.code === 'Space' || event.code === 'Delete' || event.code === 'Backspace' || event.code === 'Home'
    || event.code === 'ArrowLeft' || event.code === 'ArrowRight' || event.code === 'Escape' || event.code === 'Digit0') {
    binding.code = event.code
  } else if (event.key.length === 1) {
    binding.key = event.key.toLowerCase()
  } else {
    binding.code = event.code
  }
  return binding
}

/** Unique command rows for the settings UI (first definition per id). */
export function uniqueShortcutRows(shortcuts: ShortcutDefinition[]): ShortcutDefinition[] {
  const seen = new Set<ShortcutCommandId>()
  const rows: ShortcutDefinition[] = []
  for (const item of shortcuts) {
    if (seen.has(item.id))
      continue
    seen.add(item.id)
    rows.push(item)
  }
  return rows
}

export function bindingForCommand(shortcuts: ShortcutDefinition[], id: ShortcutCommandId): KeyBinding | null {
  return shortcuts.find((item) => item.id === id)?.binding ?? null
}

export function labelForCommand(shortcuts: ShortcutDefinition[], id: ShortcutCommandId, platform: 'win' | 'mac' = 'win'): string {
  const binding = bindingForCommand(shortcuts, id)
  return binding == null ? '' : formatBinding(binding, platform)
}
