/**
 * Phase 2.8.3 — frequency-response helpers matching native EqDsp (JUCE RBJ IIR).
 * Graph values use the same coefficient design as `msp::eqBandMagnitude`.
 */

export type EqBandTypeId = 0 | 1 | 2 // lowShelf | bell | highShelf

export interface EqBandState {
  type: EqBandTypeId
  freq: number
  gain: number
  q: number
  enabled: boolean
}

export interface EqState {
  bands: EqBandState[]
  outputGain: number
}

interface Biquad {
  b0: number
  b1: number
  b2: number
  a1: number
  a2: number
}

function dbToGain(db: number): number {
  return Math.pow(10, db / 20)
}

/** RBJ cookbook coefficients (matches juce::dsp::IIR::ArrayCoefficients). */
export function designBand(type: EqBandTypeId, sampleRate: number, centre: number, gainDb: number, q: number): Biquad {
  const nyquistSafe = sampleRate * 0.49
  const f = Math.min(nyquistSafe, Math.max(10, centre))
  const Q = Math.max(0.05, q)
  const A = dbToGain(gainDb)
  const w0 = 2 * Math.PI * f / sampleRate
  const cos = Math.cos(w0)
  const sin = Math.sin(w0)
  const alpha = sin / (2 * Q)
  let b0 = 1, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0
  if (type === 1) {
    // Peak / bell
    b0 = 1 + alpha * A
    b1 = -2 * cos
    b2 = 1 - alpha * A
    a0 = 1 + alpha / A
    a1 = -2 * cos
    a2 = 1 - alpha / A
  } else if (type === 0) {
    // Low shelf
    const twoSqrtAAlpha = 2 * Math.sqrt(A) * alpha
    b0 = A * ((A + 1) - (A - 1) * cos + twoSqrtAAlpha)
    b1 = 2 * A * ((A - 1) - (A + 1) * cos)
    b2 = A * ((A + 1) - (A - 1) * cos - twoSqrtAAlpha)
    a0 = (A + 1) + (A - 1) * cos + twoSqrtAAlpha
    a1 = -2 * ((A - 1) + (A + 1) * cos)
    a2 = (A + 1) + (A - 1) * cos - twoSqrtAAlpha
  } else {
    // High shelf
    const twoSqrtAAlpha = 2 * Math.sqrt(A) * alpha
    b0 = A * ((A + 1) + (A - 1) * cos + twoSqrtAAlpha)
    b1 = -2 * A * ((A - 1) + (A + 1) * cos)
    b2 = A * ((A + 1) + (A - 1) * cos - twoSqrtAAlpha)
    a0 = (A + 1) - (A - 1) * cos + twoSqrtAAlpha
    a1 = 2 * ((A - 1) - (A + 1) * cos)
    a2 = (A + 1) - (A - 1) * cos - twoSqrtAAlpha
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 }
}

export function bandMagnitude(type: EqBandTypeId, sampleRate: number, centre: number, gainDb: number, q: number, frequency: number): number {
  const k = designBand(type, sampleRate, centre, gainDb, q)
  const w = 2 * Math.PI * frequency / sampleRate
  const cos1 = Math.cos(w), sin1 = Math.sin(w), cos2 = Math.cos(2 * w), sin2 = Math.sin(2 * w)
  const numRe = k.b0 + k.b1 * cos1 + k.b2 * cos2
  const numIm = -(k.b1 * sin1 + k.b2 * sin2)
  const denRe = 1 + k.a1 * cos1 + k.a2 * cos2
  const denIm = -(k.a1 * sin1 + k.a2 * sin2)
  return Math.sqrt((numRe * numRe + numIm * numIm) / (denRe * denRe + denIm * denIm))
}

export function compositeDb(eq: EqState, sampleRate: number, frequency: number): number {
  let mag = 1
  for (const band of eq.bands) {
    if (!band.enabled || Math.abs(band.gain) < 1e-9)
      continue
    mag *= bandMagnitude(band.type, sampleRate, band.freq, band.gain, band.q, frequency)
  }
  mag *= dbToGain(eq.outputGain)
  if (mag <= 1e-12)
    return -120
  return 20 * Math.log10(mag)
}

export function responseCurve(eq: EqState, sampleRate: number, points = 128): { hz: number[], db: number[] } {
  const hz: number[] = []
  const db: number[] = []
  const fMin = 20
  const fMax = Math.min(20000, sampleRate * 0.49)
  for (let i = 0; i < points; ++i) {
    const t = i / (points - 1)
    const f = fMin * Math.pow(fMax / fMin, t)
    hz.push(f)
    db.push(compositeDb(eq, sampleRate, f))
  }
  return { hz, db }
}

export function eqFromParams(params: Record<string, number>): EqState {
  const bands: EqBandState[] = []
  for (let i = 1; i <= 4; ++i) {
    bands.push({
      type: Math.round(params[`band${i}Type`] ?? (i === 1 ? 0 : i === 4 ? 2 : 1)) as EqBandTypeId,
      freq: params[`band${i}Freq`] ?? (i === 1 ? 100 : i === 2 ? 400 : i === 3 ? 2000 : 8000),
      gain: params[`band${i}Gain`] ?? 0,
      q: params[`band${i}Q`] ?? (i === 1 || i === 4 ? 0.71 : 1),
      enabled: (params[`band${i}Enabled`] ?? 1) >= 0.5
    })
  }
  return { bands, outputGain: params.outputGain ?? 0 }
}

export function defaultEqParams(): Record<string, number> {
  return {
    band1Type: 0, band1Freq: 100, band1Gain: 0, band1Q: 0.71, band1Enabled: 1,
    band2Type: 1, band2Freq: 400, band2Gain: 0, band2Q: 1, band2Enabled: 1,
    band3Type: 1, band3Freq: 2000, band3Gain: 0, band3Q: 1, band3Enabled: 1,
    band4Type: 2, band4Freq: 8000, band4Gain: 0, band4Q: 0.71, band4Enabled: 1,
    outputGain: 0
  }
}

export function freqToX(hz: number, width: number, fMin = 20, fMax = 20000): number {
  const t = Math.log(Math.min(fMax, Math.max(fMin, hz)) / fMin) / Math.log(fMax / fMin)
  return t * width
}

export function xToFreq(x: number, width: number, fMin = 20, fMax = 20000): number {
  const t = Math.min(1, Math.max(0, x / Math.max(1, width)))
  return fMin * Math.pow(fMax / fMin, t)
}

export function dbToY(db: number, height: number, minDb = -24, maxDb = 24): number {
  const t = (db - maxDb) / (minDb - maxDb)
  return Math.min(1, Math.max(0, t)) * height
}

export function yToDb(y: number, height: number, minDb = -24, maxDb = 24): number {
  const t = Math.min(1, Math.max(0, y / Math.max(1, height)))
  return maxDb + t * (minDb - maxDb)
}
