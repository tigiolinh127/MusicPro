/** Phase 2.9.2 — timeline zoom / snap helpers (renderer-only). */

export const TIMELINE_PPS_MIN = 20
export const TIMELINE_PPS_MAX = 800
export const DEFAULT_TIMELINE_BPM = 120
export const DEFAULT_BEATS_PER_BAR = 4

export function gridSize(pixelsPerSecond: number): number {
  if (pixelsPerSecond >= 240)
    return 0.01
  if (pixelsPerSecond >= 80)
    return 0.05
  return 0.1
}

export function snapThresholdSeconds(pixelsPerSecond: number): number {
  return Math.max(0.01, 10 / Math.max(1, pixelsPerSecond))
}

export function quantizeSamples(seconds: number, sampleRate: number): number {
  const rate = sampleRate > 0 ? sampleRate : 48000
  return Math.round(Math.max(0, seconds) * rate) / rate
}

/** Snap to grid, then prefer the nearest playhead / clip-edge target within threshold. */
export function placeTime(
  seconds: number,
  snap: boolean,
  pixelsPerSecond: number,
  sampleRate: number,
  targets: number[] = []
): number {
  const quantized = quantizeSamples(seconds, sampleRate)
  if (!snap)
    return quantized
  const threshold = snapThresholdSeconds(pixelsPerSecond)
  // Prefer playhead / clip-edge targets when within threshold; otherwise use the zoom grid.
  let bestTarget: number | null = null
  let bestTargetDist = Number.POSITIVE_INFINITY
  for (const target of targets) {
    if (!Number.isFinite(target) || target < 0)
      continue
    const distance = Math.abs(quantized - target)
    if (distance <= threshold && distance < bestTargetDist) {
      bestTarget = target
      bestTargetDist = distance
    }
  }
  if (bestTarget != null)
    return quantizeSamples(bestTarget, sampleRate)
  const grid = gridSize(pixelsPerSecond)
  return quantizeSamples(Math.max(0, Math.round(quantized / grid) * grid), sampleRate)
}

export function collectSnapTargets(options: {
  playhead: number
  clips: Array<{ timelineStart: number, duration: number }>
  excludeClipId?: string
  clipIds?: Array<{ id: string, timelineStart: number, duration: number }>
}): number[] {
  const targets = [0, Math.max(0, options.playhead)]
  if (options.clipIds != null) {
    for (const clip of options.clipIds) {
      if (options.excludeClipId != null && clip.id === options.excludeClipId)
        continue
      targets.push(clip.timelineStart, clip.timelineStart + clip.duration)
    }
  } else {
    for (const clip of options.clips) {
      targets.push(clip.timelineStart, clip.timelineStart + clip.duration)
    }
  }
  return targets
}

export function clampPixelsPerSecond(value: number): number {
  return Math.min(TIMELINE_PPS_MAX, Math.max(TIMELINE_PPS_MIN, Math.round(value)))
}

/** Keep `anchorTime` under the same viewport X when changing zoom. */
export function scrollLeftForZoom(options: {
  anchorTime: number
  oldPixelsPerSecond: number
  newPixelsPerSecond: number
  oldScrollLeft: number
}): number {
  const viewX = options.anchorTime * options.oldPixelsPerSecond - options.oldScrollLeft
  return Math.max(0, options.anchorTime * options.newPixelsPerSecond - viewX)
}

export function fitPixelsPerSecond(contentSeconds: number, viewportWidth: number, paddingSeconds = 1): number {
  const span = Math.max(0.5, contentSeconds + paddingSeconds)
  const width = Math.max(120, viewportWidth)
  return clampPixelsPerSecond(width / span)
}

export function centerScrollLeft(time: number, pixelsPerSecond: number, viewportWidth: number): number {
  return Math.max(0, time * pixelsPerSecond - viewportWidth / 2)
}

export function beatDuration(bpm: number): number {
  const safe = Number.isFinite(bpm) && bpm > 0 ? bpm : DEFAULT_TIMELINE_BPM
  return 60 / safe
}

export function barDuration(bpm: number, beatsPerBar = DEFAULT_BEATS_PER_BAR): number {
  return beatDuration(bpm) * Math.max(1, beatsPerBar)
}

export function selectionKey(trackId: string, clipId: string): string {
  return `${trackId}\u0000${clipId}`
}

export function parseSelectionKey(key: string): { trackId: string, clipId: string } | null {
  const split = key.split('\u0000')
  if (split.length !== 2 || split[0]!.length === 0 || split[1]!.length === 0)
    return null
  return { trackId: split[0]!, clipId: split[1]! }
}
