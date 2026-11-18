/** Steady-state dynamics transfer curves matching native CompressorDsp / LimiterDsp. */

export interface CompParams {
  threshold: number
  ratio: number
  makeup: number
  knee: number
}

export interface LimParams {
  ceiling: number
}

export function defaultCompParams(): CompParams {
  return { threshold: -18, ratio: 4, makeup: 0, knee: 0 }
}

export function defaultLimParams(): LimParams {
  return { ceiling: -0.3 }
}

export function compFromParams(params: Record<string, number>): CompParams {
  return {
    threshold: params.threshold ?? -18,
    ratio: Math.max(1, params.ratio ?? 4),
    makeup: params.makeup ?? 0,
    knee: Math.max(0, params.knee ?? 0)
  }
}

export function limFromParams(params: Record<string, number>): LimParams {
  return { ceiling: Math.min(0, params.ceiling ?? -0.3) }
}

/** Soft-knee gain reduction in dB (knee 0 = hard knee / legacy). */
export function compressorGainReductionDb(p: CompParams, inputDb: number): number {
  if (!Number.isFinite(inputDb))
    return 0
  const slope = 1 - 1 / Math.max(1, p.ratio)
  const over = inputDb - p.threshold
  const width = Math.max(0, p.knee)
  if (width <= 1e-9)
    return over > 0 ? over * slope : 0
  const half = width * 0.5
  if (over <= -half)
    return 0
  if (over >= half)
    return over * slope
  const x = over + half
  return slope * x * x / (2 * width)
}

export function compressorTransferDb(p: CompParams, inputDb: number): number {
  if (!Number.isFinite(inputDb))
    return -120
  return inputDb - compressorGainReductionDb(p, inputDb) + p.makeup
}

export function limiterGainReductionDb(p: LimParams, inputDb: number): number {
  if (!Number.isFinite(inputDb))
    return 0
  return inputDb > p.ceiling ? inputDb - p.ceiling : 0
}

export function limiterTransferDb(p: LimParams, inputDb: number): number {
  if (!Number.isFinite(inputDb))
    return -120
  return inputDb - limiterGainReductionDb(p, inputDb)
}

export function transferCurve(
  kind: 'compressor' | 'limiter',
  params: Record<string, number>,
  points = 65
): { inDb: number[], outDb: number[] } {
  const inDb: number[] = []
  const outDb: number[] = []
  const comp = compFromParams(params)
  const lim = limFromParams(params)
  for (let i = 0; i < points; ++i) {
    const t = i / (points - 1)
    const input = -60 + t * 60
    inDb.push(input)
    outDb.push(kind === 'limiter' ? limiterTransferDb(lim, input) : compressorTransferDb(comp, input))
  }
  return { inDb, outDb }
}

export function dbToAxis(db: number, size: number, minDb = -60, maxDb = 0): number {
  const t = (db - minDb) / (maxDb - minDb)
  return (1 - Math.min(1, Math.max(0, t))) * size
}

export function axisToDb(pos: number, size: number, minDb = -60, maxDb = 0): number {
  const t = 1 - Math.min(1, Math.max(0, pos / Math.max(1, size)))
  return minDb + t * (maxDb - minDb)
}
