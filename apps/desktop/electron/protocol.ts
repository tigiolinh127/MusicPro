export interface EngineResponse<T = unknown> {
  v: number
  id?: string
  ok: boolean
  error?: string
  result?: T
}

export interface EngineEvent {
  v: number
  event: string
  message?: string
  deviceOpen?: boolean
  position?: number
  duration?: number
  transport?: string
  peakL?: number
  peakR?: number
  monitor?: boolean
  tracks?: Array<{ id?: string, peakL: number, peakR: number, levelL: number, levelR: number, clip: boolean }>
  buses?: Array<{ id?: string, peakL: number, peakR: number, levelL: number, levelR: number, clip: boolean }>
  effects?: Array<{ id: string, reduction: number }>
  input?: {
    available: boolean
    channels: number
    peakL: number
    peakR: number
    rmsL: number
    rmsR: number
    levelL: number
    levelR: number
    peakHoldL: number
    peakHoldR: number
    clip: boolean
    peakDbFS: number
    rmsDbFS: number
    gainDb: number
  }
}
