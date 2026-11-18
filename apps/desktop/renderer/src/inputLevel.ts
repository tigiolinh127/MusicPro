import type { InputMeter } from '../../../../packages/shared/src/protocol'

/**
 * Illustrative MSP recording-level guidance thresholds (dBFS).
 * Not universal audio standards — documented defaults for this product.
 */
export const INPUT_LEVEL_THRESHOLDS = {
  /** Peak below this → "Signal too low". */
  tooLowDbFS: -40,
  /** Peak at or above this (and below nearClip) → "Healthy recording level". */
  healthyMinDbFS: -40,
  /** Peak at or above this (and below clip) → "Near clipping". */
  nearClipDbFS: -6,
  /** Peak at/above 0 dBFS or engine clip latch → "Clipping detected". */
  clipDbFS: 0
} as const

export type InputLevelGuidance =
  | 'unavailable'
  | 'too-low'
  | 'healthy'
  | 'near-clip'
  | 'clipping'

export function inputLevelGuidance(meter: InputMeter | null | undefined): InputLevelGuidance {
  if (meter == null || !meter.available)
    return 'unavailable'
  if (meter.clip || meter.peakDbFS >= INPUT_LEVEL_THRESHOLDS.clipDbFS)
    return 'clipping'
  if (meter.peakDbFS >= INPUT_LEVEL_THRESHOLDS.nearClipDbFS)
    return 'near-clip'
  if (meter.peakDbFS < INPUT_LEVEL_THRESHOLDS.tooLowDbFS)
    return 'too-low'
  return 'healthy'
}

export function inputLevelLabel(guidance: InputLevelGuidance): string {
  switch (guidance) {
    case 'unavailable':
      return 'Unavailable'
    case 'too-low':
      return 'Signal too low'
    case 'healthy':
      return 'Healthy recording level'
    case 'near-clip':
      return 'Near clipping'
    case 'clipping':
      return 'Clipping detected'
  }
}

export function formatDbFS(db: number): string {
  if (!(Number.isFinite(db)) || db <= -119.5)
    return '−∞ dBFS'
  const sign = db > 0 ? '+' : db < 0 ? '−' : ''
  return `${sign}${Math.abs(db).toFixed(1)} dBFS`
}

export function meterBarFraction(linear: number): number {
  if (!(linear > 0))
    return 0
  const db = 20 * Math.log10(linear)
  // Map −60…+6 dBFS into 0…1 for the bar (same style as mixer strip meters).
  return Math.max(0, Math.min(1, (db - -60) / (6 - -60)))
}
