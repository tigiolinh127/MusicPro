import type { StripMeter } from '../../../../packages/shared/src/protocol'

/**
 * Lightweight meter publish/subscribe (Phase 2.7.3).
 * Meter events update this store without forcing the whole Mixer tree to re-render;
 * only subscribed Meter components bump local state.
 */
type Listener = () => void

let stripMeters: Record<string, StripMeter> = {}
let masterMeter: StripMeter | undefined
const listeners = new Set<Listener>()

export function publishMeters(next: Record<string, StripMeter>, master: StripMeter | undefined): void {
  stripMeters = next
  masterMeter = master
  for (const listener of listeners)
    listener()
}

export function getStripMeter(key: string): StripMeter | undefined {
  return stripMeters[key]
}

export function getMasterMeter(): StripMeter | undefined {
  return masterMeter
}

export function subscribeMeters(listener: Listener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
