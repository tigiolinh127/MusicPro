/**
 * Phase 2.8.3 — spectrum publish/subscribe (isolates analyzer updates from Mixer tree).
 */

export interface SpectrumFrame {
  available: boolean
  fftSize: number
  target: string
  ownerId: string
  tap: string
  magnitudesDb: number[]
  frequenciesHz: number[]
}

type Listener = () => void

let frame: SpectrumFrame = {
  available: false,
  fftSize: 2048,
  target: '',
  ownerId: '',
  tap: 'none',
  magnitudesDb: [],
  frequenciesHz: []
}
const listeners = new Set<Listener>()

export function publishSpectrum(next: SpectrumFrame | null | undefined): void {
  if (next == null) {
    frame = { ...frame, available: false, magnitudesDb: [], frequenciesHz: [] }
  } else {
    frame = next
  }
  for (const listener of listeners)
    listener()
}

export function getSpectrum(): SpectrumFrame {
  return frame
}

export function subscribeSpectrum(listener: Listener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
