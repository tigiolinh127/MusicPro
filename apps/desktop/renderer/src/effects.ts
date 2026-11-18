import type { EffectType } from '../../../../packages/shared/src/protocol'

// Display metadata for the native effect parameters. Ranges match native/audio-engine/src/Effects.cpp;
// the engine validates every value again.
export type ParamUnit = 'hz' | 'db' | 'q' | 'ms' | 'ratio' | 'percent'

export interface ParamSpec {
  name: string
  label: string
  min: number
  max: number
  defaultValue: number
  unit: ParamUnit
  log?: boolean
  step?: number
  choices?: string[]
}

export interface EffectSpec {
  type: EffectType
  label: string
  params: ParamSpec[]
  reduction?: boolean
}

const bandTypes = ['Low shelf', 'Bell', 'High shelf']
const bandDefaults = [
  { type: 0, freq: 100, q: 0.71 },
  { type: 1, freq: 400, q: 1 },
  { type: 1, freq: 2000, q: 1 },
  { type: 2, freq: 8000, q: 0.71 }
]

export const eqBands = bandDefaults.length

export const effectSpecs: EffectSpec[] = [
  {
    type: 'eq',
    label: 'EQ',
    params: [
      ...bandDefaults.flatMap((band, index): ParamSpec[] => [
        { name: `band${index + 1}Type`, label: 'Type', min: 0, max: 2, defaultValue: band.type, unit: 'ratio', choices: bandTypes },
        { name: `band${index + 1}Freq`, label: 'Freq', min: 20, max: 20000, defaultValue: band.freq, unit: 'hz', log: true },
        { name: `band${index + 1}Gain`, label: 'Gain', min: -24, max: 24, defaultValue: 0, unit: 'db', step: 0.1 },
        { name: `band${index + 1}Q`, label: 'Q', min: 0.1, max: 18, defaultValue: band.q, unit: 'q', log: true }
      ]),
      { name: 'outputGain', label: 'Output', min: -24, max: 24, defaultValue: 0, unit: 'db', step: 0.1 },
      { name: 'band1Enabled', label: 'B1 On', min: 0, max: 1, defaultValue: 1, unit: 'ratio', choices: ['Off', 'On'] },
      { name: 'band2Enabled', label: 'B2 On', min: 0, max: 1, defaultValue: 1, unit: 'ratio', choices: ['Off', 'On'] },
      { name: 'band3Enabled', label: 'B3 On', min: 0, max: 1, defaultValue: 1, unit: 'ratio', choices: ['Off', 'On'] },
      { name: 'band4Enabled', label: 'B4 On', min: 0, max: 1, defaultValue: 1, unit: 'ratio', choices: ['Off', 'On'] }
    ]
  },
  {
    type: 'compressor',
    label: 'Compressor',
    reduction: true,
    params: [
      { name: 'threshold', label: 'Threshold', min: -60, max: 0, defaultValue: -18, unit: 'db', step: 0.5 },
      { name: 'ratio', label: 'Ratio', min: 1, max: 20, defaultValue: 4, unit: 'ratio', log: true },
      { name: 'attack', label: 'Attack', min: 0.1, max: 200, defaultValue: 10, unit: 'ms', log: true },
      { name: 'release', label: 'Release', min: 5, max: 2000, defaultValue: 100, unit: 'ms', log: true },
      { name: 'makeup', label: 'Makeup', min: 0, max: 24, defaultValue: 0, unit: 'db', step: 0.1 },
      // Phase 2.8.4 additive: 0 = hard knee (legacy)
      { name: 'knee', label: 'Knee', min: 0, max: 24, defaultValue: 0, unit: 'db', step: 0.5 }
    ]
  },
  {
    type: 'limiter',
    label: 'Limiter',
    reduction: true,
    params: [
      // Sample-peak stereo-linked brickwall (not true-peak / no lookahead)
      { name: 'ceiling', label: 'Ceiling', min: -24, max: 0, defaultValue: -0.3, unit: 'db', step: 0.1 },
      { name: 'release', label: 'Release', min: 1, max: 1000, defaultValue: 50, unit: 'ms', log: true },
      { name: 'attack', label: 'Attack', min: 0.01, max: 20, defaultValue: 0.1, unit: 'ms', log: true }
    ]
  },
  {
    type: 'gate',
    label: 'Noise gate',
    reduction: true,
    params: [
      { name: 'threshold', label: 'Threshold', min: -80, max: 0, defaultValue: -50, unit: 'db', step: 0.5 },
      { name: 'attack', label: 'Attack', min: 0.1, max: 100, defaultValue: 1, unit: 'ms', log: true },
      { name: 'hold', label: 'Hold', min: 0, max: 500, defaultValue: 20, unit: 'ms', step: 1 },
      { name: 'release', label: 'Release', min: 5, max: 2000, defaultValue: 100, unit: 'ms', log: true },
      { name: 'range', label: 'Range', min: -80, max: 0, defaultValue: -80, unit: 'db', step: 0.5 }
    ]
  },
  {
    type: 'reverb',
    label: 'Reverb',
    params: [
      { name: 'roomSize', label: 'Room size', min: 0, max: 1, defaultValue: 0.5, unit: 'percent', step: 0.01 },
      { name: 'damping', label: 'Damping', min: 0, max: 1, defaultValue: 0.5, unit: 'percent', step: 0.01 },
      { name: 'mix', label: 'Wet/dry', min: 0, max: 1, defaultValue: 0.3, unit: 'percent', step: 0.01 }
    ]
  },
  {
    type: 'delay',
    label: 'Delay',
    params: [
      { name: 'time', label: 'Time', min: 1, max: 2000, defaultValue: 250, unit: 'ms', log: true },
      { name: 'feedback', label: 'Feedback', min: 0, max: 0.95, defaultValue: 0.35, unit: 'percent', step: 0.01 },
      { name: 'mix', label: 'Wet/dry', min: 0, max: 1, defaultValue: 0.3, unit: 'percent', step: 0.01 }
    ]
  }
]

export function effectSpec(type: EffectType): EffectSpec {
  return effectSpecs.find((spec) => spec.type === type) ?? effectSpecs[0]
}

export const sliderSteps = 1000

export function toSlider(spec: ParamSpec, value: number): number {
  const clamped = Math.min(spec.max, Math.max(spec.min, value))
  const fraction = spec.log === true
    ? Math.log(clamped / spec.min) / Math.log(spec.max / spec.min)
    : (clamped - spec.min) / (spec.max - spec.min)
  return Math.round(fraction * sliderSteps)
}

// Rounds to a value the control can show and the engine accepts (never outside the range).
export function fromSlider(spec: ParamSpec, position: number): number {
  const fraction = Math.min(1, Math.max(0, position / sliderSteps))
  let value = spec.log === true
    ? spec.min * Math.pow(spec.max / spec.min, fraction)
    : spec.min + fraction * (spec.max - spec.min)
  if (spec.log === true) {
    const digits = Math.max(0, 2 - Math.floor(Math.log10(Math.abs(value))))
    value = Number(value.toFixed(digits))
  } else if (spec.step != null) {
    value = Math.round(value / spec.step) * spec.step
    value = Number(value.toFixed(4))
  }
  return Math.min(spec.max, Math.max(spec.min, value))
}

export function formatParam(spec: ParamSpec, value: number): string {
  switch (spec.unit) {
    case 'hz': return value >= 1000 ? `${(value / 1000).toFixed(value >= 10000 ? 1 : 2)} kHz` : `${Math.round(value)} Hz`
    case 'db': return `${value > 0 ? '+' : ''}${value.toFixed(1)} dB`
    case 'q': return value.toFixed(2)
    case 'ms': return value < 10 ? `${value.toFixed(1)} ms` : `${Math.round(value)} ms`
    case 'ratio': return `${value.toFixed(value < 10 ? 1 : 0)}:1`
    case 'percent': return `${Math.round(value * 100)}%`
  }
}
