/** Informational loudness targets (guidance only — never auto-normalize). */

export type LoudnessTargetId = 'streaming' | 'podcast' | 'custom'

export interface LoudnessTarget {
  id: LoudnessTargetId
  label: string
  integratedLufs: number
  truePeakDbTp: number
  note: string
}

export const loudnessTargets: LoudnessTarget[] = [
  {
    id: 'streaming',
    label: 'General streaming',
    integratedLufs: -14,
    truePeakDbTp: -1,
    note: 'Common streaming guidance (platform targets vary). Informational only.'
  },
  {
    id: 'podcast',
    label: 'Podcast / spoken voice',
    integratedLufs: -16,
    truePeakDbTp: -1,
    note: 'Typical spoken-word guidance. Informational only.'
  },
  {
    id: 'custom',
    label: 'Custom target',
    integratedLufs: -23,
    truePeakDbTp: -1,
    note: 'User-defined integrated LUFS target. Informational only.'
  }
]

export function formatLufs(value: number | null | undefined, valid: boolean): string {
  if (!valid || value == null || !Number.isFinite(value))
    return 'unavailable'
  return `${value.toFixed(1)} LUFS`
}

export function formatDb(value: number | null | undefined, valid: boolean, unit: string): string {
  if (!valid || value == null || !Number.isFinite(value))
    return 'unavailable'
  return `${value.toFixed(1)} ${unit}`
}

export function formatLu(value: number | null | undefined, valid: boolean): string {
  if (!valid || value == null || !Number.isFinite(value))
    return 'unavailable'
  return `${value.toFixed(1)} LU`
}
