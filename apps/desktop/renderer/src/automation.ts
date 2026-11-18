import type { AutomationLaneState, AutomationPointState, EffectState, EffectTarget } from '../../../../packages/shared/src/protocol'
import { effectSpec, formatParam } from './effects'

// One parameter that can carry an automation lane, with the mapping between its value and the
// vertical position in the lane (0 = bottom, 1 = top). Ranges match the engine's checks.
export interface AutoParam {
  param: string
  label: string
  manual: number
  toFraction: (value: number) => number
  fromFraction: (fraction: number) => number
  format: (value: number) => string
  // Typed point values use the unit shown to the user (dB for volume, -100..100 for pan, % for percentages).
  unit: string
  toInput: (value: number) => number
  fromInput: (typed: number) => number
}

const minDb = -60
const maxDb = 12
const maxGain = 4

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function volumeParam(manual: number): AutoParam {
  return {
    param: 'volume',
    label: 'Volume',
    manual,
    toFraction: (gain) => gain > 0 ? clamp01((20 * Math.log10(gain) - minDb) / (maxDb - minDb)) : 0,
    fromFraction: (fraction) => {
      if (fraction <= 0.002)
        return 0
      const db = minDb + clamp01(fraction) * (maxDb - minDb)
      return Math.min(maxGain, Number(Math.pow(10, db / 20).toFixed(4)))
    },
    format: (gain) => gain > 0.001 ? `${20 * Math.log10(gain) >= 0 ? '+' : ''}${(20 * Math.log10(gain)).toFixed(1)} dB` : '-inf dB',
    unit: 'dB',
    toInput: (gain) => gain > 0.001 ? Math.max(minDb, Number((20 * Math.log10(gain)).toFixed(1))) : minDb,
    fromInput: (db) => db <= minDb ? 0 : Math.min(maxGain, Number(Math.pow(10, Math.min(maxDb, db) / 20).toFixed(4)))
  }
}

function panParam(manual: number): AutoParam {
  return {
    param: 'pan',
    label: 'Pan',
    manual,
    toFraction: (pan) => clamp01((pan + 1) / 2),
    fromFraction: (fraction) => Number((clamp01(fraction) * 2 - 1).toFixed(3)),
    format: (pan) => Math.abs(pan) < 0.005 ? 'C' : pan < 0 ? `L${Math.round(-pan * 100)}` : `R${Math.round(pan * 100)}`,
    unit: 'L/R',
    toInput: (pan) => Math.round(pan * 100),
    fromInput: (typed) => Math.min(1, Math.max(-1, typed / 100))
  }
}

const inputUnits: Record<string, string> = { db: 'dB', hz: 'Hz', ms: 'ms', percent: '%' }

function effectParams(effects: EffectState[]): AutoParam[] {
  const list: AutoParam[] = []
  effects.forEach((effect, index) => {
    const spec = effectSpec(effect.type)
    for (const item of spec.params) {
      if (item.choices != null)
        continue
      const band = /^band(\d)/.exec(item.name)
      const log = item.log === true
      list.push({
        param: `fx:${effect.id}:${item.name}`,
        label: `${index + 1}. ${spec.label}${band != null ? ` band ${band[1]}` : ''} ${item.label}`,
        manual: effect.params[item.name] ?? item.defaultValue,
        toFraction: (value) => {
          const v = Math.min(item.max, Math.max(item.min, value))
          return log ? Math.log(v / item.min) / Math.log(item.max / item.min) : (v - item.min) / (item.max - item.min)
        },
        fromFraction: (fraction) => {
          const f = clamp01(fraction)
          const value = log ? item.min * Math.pow(item.max / item.min, f) : item.min + f * (item.max - item.min)
          return Math.min(item.max, Math.max(item.min, Number(value.toPrecision(4))))
        },
        format: (value) => formatParam(item, value),
        unit: inputUnits[item.unit] ?? '',
        toInput: (value) => Number((item.unit === 'percent' ? value * 100 : value).toPrecision(4)),
        fromInput: (typed) => Math.min(item.max, Math.max(item.min, item.unit === 'percent' ? typed / 100 : typed))
      })
    }
  })
  return list
}

// Tracks automate volume, pan and their effect parameters; buses and the master volume and effects.
export function automationParams(target: EffectTarget, owner: { gain?: number, pan?: number, effects?: EffectState[] }): AutoParam[] {
  const list: AutoParam[] = [volumeParam(owner.gain ?? 1)]
  if (target === 'track')
    list.push(panParam(owner.pan ?? 0))
  return [...list, ...effectParams(owner.effects ?? [])]
}

export function laneFor(lanes: AutomationLaneState[] | undefined, param: string): AutomationLaneState | undefined {
  return lanes?.find((lane) => lane.param === param)
}

export function isAutomated(lanes: AutomationLaneState[] | undefined, param: string): boolean {
  return laneFor(lanes, param)?.active === true
}

// The lane value at `time` (seconds), with the engine's rules: hold the first value before the
// first point and the last after the last; ramp linearly, or hold when the earlier point is a step.
export function laneValueAt(points: AutomationPointState[], time: number): number {
  if (points.length === 0)
    return 0
  let index = -1
  for (let i = 0; i < points.length && points[i].time <= time; i++)
    index = i
  if (index < 0)
    return points[0].value
  if (index >= points.length - 1)
    return points[points.length - 1].value
  const a = points[index]
  const b = points[index + 1]
  if (a.interpolation === 'step' || b.time <= a.time)
    return a.value
  return a.value + (b.value - a.value) * (time - a.time) / (b.time - a.time)
}
