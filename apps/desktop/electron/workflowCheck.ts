import type { BrowserWindow } from 'electron'
import fs from 'fs'
import path from 'path'
import type { EngineHost } from './engineHost'
import type { EngineEvent } from './protocol'

interface Clip {
  id: string
  sourceFileId: string
  timelineStart: number
  sourceOffset: number
  duration: number
  fadeIn: number
  fadeOut: number
  gain: number
  timelineStartSamples: number
  sourceOffsetSamples: number
  durationSamples: number
  fadeInSamples: number
  fadeOutSamples: number
}

interface Track {
  id: string
  name: string
  path: string
  gain: number
  pan: number
  mute: boolean
  solo: boolean
  clips: Clip[]
}

interface State {
  tracks: Track[]
  sampleRate: number
  masterGain: number
  canUndo: boolean
  canRedo: boolean
  position: number
  transport: string
  deviceOpen: boolean
}

interface Geometry {
  left: number
  top: number
  width: number
  rulerTop: number
  rulerHeight: number
  scrollLeft: number
  pps: number
  lane: number
}

interface Check {
  scenario: string
  result: 'PASS' | 'FAIL' | 'NOT RUN'
  detail: string
}

export interface WorkflowOptions {
  outDir: string
  fixtureDir: string
  phase: 'edit' | 'reload'
  answer: (filePath: string) => void
}

const rampRate = 48000
const rampFrames = 4 * rampRate

function rampLeft(index: number): number {
  return 0.1 + 0.8 * index / rampFrames
}

function rampRight(index: number): number {
  return 0.5 * rampLeft(index)
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function writeWav24(file: string, rate: number, frames: number, left: (i: number) => number, right: (i: number) => number): void {
  const dataBytes = frames * 6
  const buffer = Buffer.alloc(44 + dataBytes)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataBytes, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(2, 22)
  buffer.writeUInt32LE(rate, 24)
  buffer.writeUInt32LE(rate * 6, 28)
  buffer.writeUInt16LE(6, 32)
  buffer.writeUInt16LE(24, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataBytes, 40)
  let offset = 44
  for (let i = 0; i < frames; i++) {
    for (const value of [left(i), right(i)]) {
      buffer.writeIntLE(Math.round(Math.max(-1, Math.min(1, value)) * 8388607), offset, 3)
      offset += 3
    }
  }
  fs.writeFileSync(file, buffer)
}

export function readWav(file: string): { rate: number, left: Float32Array, right: Float32Array } {
  const data = fs.readFileSync(file)
  if (data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WAVE')
    throw new Error(`${file} is not a WAV file`)
  let offset = 12
  let format = 0
  let channels = 0
  let rate = 0
  let bits = 0
  let samples: Buffer | null = null
  while (offset + 8 <= data.length) {
    const id = data.toString('ascii', offset, offset + 4)
    const size = data.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ') {
      format = data.readUInt16LE(body)
      channels = data.readUInt16LE(body + 2)
      rate = data.readUInt32LE(body + 4)
      bits = data.readUInt16LE(body + 14)
      if (format === 0xfffe)
        format = data.readUInt16LE(body + 24)
    } else if (id === 'data') {
      samples = data.subarray(body, body + size)
    }
    offset = body + size + (size % 2)
  }
  if (samples == null || channels < 1)
    throw new Error(`${file} has no audio data`)
  const bytes = bits / 8
  const frames = Math.floor(samples.length / (bytes * channels))
  const left = new Float32Array(frames)
  const right = new Float32Array(frames)
  const read = (at: number): number => {
    if (format === 3 && bits === 32)
      return samples!.readFloatLE(at)
    if (bits === 16)
      return samples!.readInt16LE(at) / 32768
    if (bits === 24)
      return samples!.readIntLE(at, 3) / 8388608
    if (bits === 32)
      return samples!.readInt32LE(at) / 2147483648
    throw new Error(`unsupported WAV format ${format}/${bits}`)
  }
  for (let i = 0; i < frames; i++) {
    const base = i * bytes * channels
    left[i] = read(base)
    right[i] = channels > 1 ? read(base + bytes) : left[i]
  }
  return { rate, left, right }
}

function fadeEnvelope(index: number, duration: number, fadeIn: number, fadeOut: number): number {
  if (index < 0 || index >= duration)
    return 0
  let gain = 1
  if (fadeIn > 0 && index < fadeIn)
    gain *= index / fadeIn
  if (fadeOut > 0 && index >= duration - fadeOut)
    gain *= Math.max(0, duration - index) / fadeOut
  return Math.max(0, Math.min(1, gain))
}

function expectedRampMix(track: Track, master: number, frames: number): { left: Float64Array, right: Float64Array } {
  const left = new Float64Array(frames)
  const right = new Float64Array(frames)
  const angle = (Math.max(-1, Math.min(1, track.pan)) + 1) * Math.PI / 4
  const panL = Math.cos(angle) * track.gain * master
  const panR = Math.sin(angle) * track.gain * master
  for (const clip of track.clips) {
    for (let i = 0; i < clip.durationSamples; i++) {
      const destination = clip.timelineStartSamples + i
      const source = clip.sourceOffsetSamples + i
      if (destination >= frames || source >= rampFrames)
        continue
      const gain = clip.gain * fadeEnvelope(i, clip.durationSamples, clip.fadeInSamples, clip.fadeOutSamples)
      left[destination] += rampLeft(source) * gain * panL
      right[destination] += rampRight(source) * gain * panR
    }
  }
  return { left, right }
}

function worstDifference(a: { left: ArrayLike<number>, right: ArrayLike<number> }, b: { left: ArrayLike<number>, right: ArrayLike<number> }): { worst: number, at: number } {
  if (a.left.length !== b.left.length)
    return { worst: Number.POSITIVE_INFINITY, at: -1 }
  let worst = 0
  let at = 0
  for (let i = 0; i < a.left.length; i++) {
    const diff = Math.max(Math.abs(a.left[i] - b.left[i]), Math.abs(a.right[i] - b.right[i]))
    if (diff > worst) {
      worst = diff
      at = i
    }
  }
  return { worst, at }
}

function snapTime(seconds: number): number {
  return Math.max(0, Math.round(seconds / 0.05) * 0.05)
}

export async function runWorkflowCheck(win: BrowserWindow, engine: EngineHost, options: WorkflowOptions): Promise<number> {
  const { outDir, fixtureDir, phase, answer } = options
  fs.mkdirSync(outDir, { recursive: true })
  const web = win.webContents
  const checks: Check[] = []
  const musicPath = path.join(fixtureDir, 'test_music_440hz.wav')
  const rampPath = path.join(outDir, 'ramp-4s.wav')
  const projectPath = path.join(outDir, 'edited.msp.json')
  const exportPath = path.join(outDir, `${phase}-export.wav`)
  const firstExportPath = path.join(outDir, 'edit-export.wav')
  const playbackPath = path.join(outDir, `${phase}-playback.wav`)
  const savedStatePath = path.join(outDir, 'edit-state.json')
  const meterLog: Array<{ position: number, peak: number }> = []
  const previousHandler = engine.onEvent
  engine.onEvent = (event: EngineEvent) => {
    if (event.event === 'meter' && typeof event.position === 'number')
      meterLog.push({ position: event.position, peak: Math.max(event.peakL ?? 0, event.peakR ?? 0) })
    previousHandler(event)
  }

  function record(scenario: string, ok: boolean | null, detail: string): void {
    checks.push({ scenario, result: ok == null ? 'NOT RUN' : ok ? 'PASS' : 'FAIL', detail })
    console.log(`${ok == null ? 'NOT RUN' : ok ? 'PASS' : 'FAIL'} ${scenario} — ${detail}`)
  }

  async function js<T>(code: string): Promise<T> {
    return await web.executeJavaScript(code, true) as T
  }

  async function state(): Promise<State> {
    const response = await engine.request('getState')
    return response.result as State
  }

  async function until(predicate: (current: State) => boolean, timeoutMs = 6000): Promise<State> {
    const started = Date.now()
    let current = await state()
    while (!predicate(current) && Date.now() - started < timeoutMs) {
      await wait(100)
      current = await state()
    }
    await wait(250)
    return current
  }

  async function geometry(): Promise<Geometry> {
    return await js<Geometry>(`(() => {
      const canvas = document.querySelector('.timeline-canvas').getBoundingClientRect()
      const ruler = document.querySelector('.timeline-ruler').getBoundingClientRect()
      const scroll = document.querySelector('.timeline-scroll')
      const pps = parseFloat(document.querySelector('.zoom span').textContent)
      const lane = parseFloat(getComputedStyle(document.querySelector('.app')).getPropertyValue('--lane-height'))
      return { left: canvas.left, top: canvas.top, width: canvas.width, rulerTop: ruler.top, rulerHeight: ruler.height, scrollLeft: scroll.scrollLeft, pps, lane }
    })()`)
  }

  function xAt(g: Geometry, seconds: number): number {
    return Math.round(g.left + (seconds - g.scrollLeft / g.pps) * g.pps)
  }

  function timeAtX(g: Geometry, x: number): number {
    return g.scrollLeft / g.pps + (x - g.left) / g.pps
  }

  function laneY(g: Geometry, lane: number, offset: number): number {
    return Math.round(g.top + lane * g.lane + offset)
  }

  function mouse(type: 'mouseDown' | 'mouseUp' | 'mouseMove', x: number, y: number): void {
    web.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
  }

  async function click(x: number, y: number): Promise<void> {
    mouse('mouseMove', x, y)
    await wait(30)
    mouse('mouseDown', x, y)
    await wait(40)
    mouse('mouseUp', x, y)
    await wait(300)
  }

  async function drag(x0: number, y0: number, x1: number, y1: number): Promise<void> {
    mouse('mouseMove', x0, y0)
    await wait(30)
    mouse('mouseDown', x0, y0)
    await wait(60)
    for (let step = 1; step <= 8; step++) {
      mouse('mouseMove', x0 + (x1 - x0) * step / 8, y0 + (y1 - y0) * step / 8)
      await wait(20)
    }
    mouse('mouseUp', x1, y1)
    await wait(400)
  }

  async function key(keyCode: string, modifiers: Array<'control' | 'shift'> = []): Promise<void> {
    web.focus()
    web.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    await wait(20)
    web.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    await wait(400)
  }

  async function pressButton(text: string, scope = 'body', index = 0): Promise<boolean> {
    const point = await js<{ x: number, y: number, disabled: boolean } | null>(`(() => {
      const button = Array.from(document.querySelectorAll(${JSON.stringify(`${scope} button`)})).filter((item) => item.textContent.trim() === ${JSON.stringify(text)})[${index}]
      if (button == null)
        return null
      button.scrollIntoView({ block: 'nearest' })
      const rect = button.getBoundingClientRect()
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, disabled: button.disabled }
    })()`)
    if (point == null || point.disabled)
      return false
    await click(point.x, point.y)
    return true
  }

  async function shot(name: string): Promise<void> {
    const image = await web.capturePage()
    fs.writeFileSync(path.join(outDir, `${phase}-${name}.png`), image.toPNG())
  }

  async function waitForFile(file: string, timeoutMs = 15000): Promise<boolean> {
    const started = Date.now()
    let last = -1
    while (Date.now() - started < timeoutMs) {
      if (fs.existsSync(file)) {
        const size = fs.statSync(file).size
        if (size > 44 && size === last)
          return true
        last = size
      }
      await wait(200)
    }
    return false
  }

  async function waveformCoverage(lane: number, startSeconds: number, endSeconds: number): Promise<{ columns: number, covered: number, firstHeight: number, lastHeight: number, maxHeight: number }> {
    const g = await geometry()
    const x0 = Math.max(0, (startSeconds - g.scrollLeft / g.pps) * g.pps + 4)
    const x1 = Math.min(g.width - 1, (endSeconds - g.scrollLeft / g.pps) * g.pps - 4)
    return await js(`(() => {
      const canvas = document.querySelector('.timeline-canvas')
      const ratio = canvas.width / canvas.clientWidth
      const ctx = canvas.getContext('2d')
      const top = ${lane} * ${g.lane} + 20
      const height = ${g.lane} - 40
      const x0 = Math.floor(${x0} * ratio)
      const x1 = Math.floor(${x1} * ratio)
      const image = ctx.getImageData(x0, Math.floor(top * ratio), Math.max(1, x1 - x0), Math.floor(height * ratio))
      let covered = 0
      const heights = []
      for (let x = 0; x < image.width; x++) {
        let low = -1
        let high = -1
        for (let y = 0; y < image.height; y++) {
          const at = (y * image.width + x) * 4
          const r = image.data[at], gg = image.data[at + 1], b = image.data[at + 2]
          const wave = (b >= 110 && b - r >= 60) || (r >= 170 && r - b >= 60 && gg >= 130)
          if (wave) {
            if (low < 0)
              low = y
            high = y
          }
        }
        if (low >= 0)
          covered++
        heights.push(low >= 0 ? (high - low + 1) / ratio : 0)
      }
      const edge = Math.max(1, Math.floor(heights.length / 10))
      const avg = (values) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)
      return { columns: image.width, covered, firstHeight: avg(heights.slice(0, edge)), lastHeight: avg(heights.slice(-edge)), maxHeight: Math.max(...heights) }
    })()`)
  }

  function rampTrack(current: State): Track | undefined {
    return current.tracks[1]
  }

  function clipsByStart(track: Track | undefined): Clip[] {
    return [...(track?.clips ?? [])].sort((a, b) => a.timelineStart - b.timelineStart)
  }

  const near = (a: number, b: number, tolerance = 1.5 / rampRate): boolean => Math.abs(a - b) <= tolerance

  async function validateExport(label: string, file: string, current: State): Promise<{ left: Float32Array, right: Float32Array } | null> {
    const ramp = rampTrack(current)
    if (ramp == null) {
      record(`${label} export samples`, false, 'ramp track not found')
      return null
    }
    try {
      const wav = readWav(file)
      const end = Math.max(...current.tracks.flatMap((track) => track.clips.map((clip) => clip.timelineStartSamples + clip.durationSamples)))
      const expected = expectedRampMix(ramp, current.masterGain, wav.left.length)
      const { worst, at } = worstDifference(wav, expected)
      record(`${label} export samples match clip positions, trims and fades`, wav.rate === rampRate && wav.left.length === end && worst < 1.0e-4,
        `rate ${wav.rate}, ${wav.left.length} frames (timeline ${end}), worst sample error ${worst.toExponential(2)} at frame ${at}`)
      return wav
    } catch (error) {
      record(`${label} export samples`, false, error instanceof Error ? error.message : String(error))
      return null
    }
  }

  async function comparePlayback(label: string, exported: { left: Float32Array, right: Float32Array } | null): Promise<void> {
    const response = await engine.request('renderPlayback', { path: playbackPath }, 20000)
    if (!response.ok) {
      record(`${label} playback mix equals export`, null, `engine does not support renderPlayback: ${response.error ?? ''}`)
      return
    }
    if (exported == null) {
      record(`${label} playback mix equals export`, false, 'no export to compare')
      return
    }
    const played = readWav(playbackPath)
    const { worst, at } = worstDifference(played, exported)
    record(`${label} playback mix equals export`, worst < 1.0e-4, `realtime mix rendered offline through mixRoute: worst ${worst.toExponential(2)} at frame ${at}`)
  }

  try {
    win.setMaximizable(false)
    if (win.isMaximized())
      win.unmaximize()
    win.setSize(1180, 860)
    win.show()
    win.focus()
    await wait(800)
    const initial = await state()
    for (const track of initial.tracks)
      await engine.request('removeTrack', { trackId: track.id })
    web.reload()
    await new Promise<void>((resolve) => web.once('did-finish-load', () => resolve()))
    await wait(1200)

    if (phase === 'edit') {
      writeWav24(rampPath, rampRate, rampFrames, rampLeft, rampRight)

      await pressButton('Add track')
      await pressButton('Add track')
      let current = await until((s) => s.tracks.length === 2)
      record('add two tracks with the Add track button', current.tracks.length === 2, current.tracks.map((t) => t.name).join(', '))

      answer(musicPath)
      await pressButton('Import WAV', '.lane-column article:nth-of-type(1)')
      current = await until((s) => (s.tracks[0]?.clips.length ?? 0) === 1)
      const music = current.tracks[0]
      const musicClip = music?.clips[0]
      record('import WAV through the header button and file dialog', musicClip != null && musicClip.duration > 1, musicClip == null ? 'no clip' : `clip ${musicClip.duration.toFixed(3)} s from ${path.basename(musicPath)}`)

      answer(rampPath)
      await pressButton('Import WAV', '.lane-column article:nth-of-type(2)')
      current = await until((s) => (s.tracks[1]?.clips.length ?? 0) === 1)
      const rampClip = current.tracks[1]?.clips[0]
      record('import second WAV (ramp test signal)', rampClip != null && rampClip.durationSamples === rampFrames, rampClip == null ? 'no clip' : `${rampClip.durationSamples} frames`)
      await wait(1500)

      const headerText = await js<string[]>(`Array.from(document.querySelectorAll('.lane-header')).map((h) => h.querySelector('.path')?.textContent ?? '')`)
      record('header shows the imported file name', headerText[0]?.includes('test_music_440hz.wav') === true && headerText[1]?.includes('ramp-4s.wav') === true, headerText.join(' | '))

      if (musicClip != null && music != null) {
        const peaks = await engine.request('waveform', { trackId: music.id, sourceFileId: musicClip.sourceFileId, start: 0, end: musicClip.duration, buckets: 64 })
        const peakMax = Math.max(...(((peaks.result as { max?: number[] } | undefined)?.max) ?? [0]))
        const coverage = await waveformCoverage(0, musicClip.timelineStart, musicClip.timelineStart + musicClip.duration)
        const g = await geometry()
        const expectedHeight = Math.min(g.lane - 40, 2 * peakMax * (g.lane - 28) / 2)
        record('real waveform drawn for imported music', coverage.covered > coverage.columns * 0.9 && Math.abs(coverage.maxHeight - expectedHeight) < 8,
          `${coverage.covered}/${coverage.columns} columns drawn, drawn height ${coverage.maxHeight.toFixed(1)} px, height from file peaks ${expectedHeight.toFixed(1)} px`)
      }
      if (rampClip != null) {
        const coverage = await waveformCoverage(1, 0, rampClip.duration)
        record('real waveform follows the ramp signal', coverage.covered > coverage.columns * 0.9 && coverage.lastHeight > coverage.firstHeight * 2,
          `height at start ${coverage.firstHeight.toFixed(1)} px, at end ${coverage.lastHeight.toFixed(1)} px`)
      }
      await shot('imported')

      const before = (await state()).tracks.map((t) => t.name)
      await engine.request('importTrack', { trackId: 'wf-direct-import', path: musicPath }, 20000)
      await pressButton('Add track')
      current = await until((s) => s.tracks.length === 4)
      const names = current.tracks.map((t) => t.name)
      const unique = new Set(names.map((n) => n.toLowerCase())).size === names.length
      record('track names stay unique after imports and Add track', unique && names[0] === before[0] && names[1] === before[1], names.join(', '))
      await pressButton('Remove', '.lane-column article:nth-of-type(4)')
      await until((s) => s.tracks.length === 3)
      await pressButton('Remove', '.lane-column article:nth-of-type(3)')
      current = await until((s) => s.tracks.length === 2)
      record('remove the extra tracks with Remove buttons', current.tracks.length === 2, current.tracks.map((t) => t.name).join(', '))

      let g = await geometry()
      const splitX = xAt(g, 1.0)
      await click(splitX, g.rulerTop + g.rulerHeight / 2)
      const splitTime = timeAtX(g, splitX)
      await click(xAt(g, 0.5), laneY(g, 1, 90))
      const selectedText = await js<string>(`document.querySelector('.inspector')?.textContent ?? ''`)
      record('click selects a clip', selectedText.includes('Start 0.000'), selectedText.replace(/\s+/g, ' ').slice(0, 120))
      await pressButton('Split')
      current = await until((s) => (rampTrack(s)?.clips.length ?? 0) === 2)
      let clips = clipsByStart(rampTrack(current))
      record('split clip at playhead', clips.length === 2 && near(clips[0].duration, splitTime, 1.5 / rampRate) && near(clips[1].sourceOffset, clips[0].duration) && clips[0].durationSamples + clips[1].durationSamples === rampFrames,
        clips.map((c) => `${c.timelineStart.toFixed(4)}+${c.duration.toFixed(4)}@${c.sourceOffset.toFixed(4)}`).join(' | ') + ` (playhead ${splitTime.toFixed(4)})`)

      await pressButton('Undo')
      current = await until((s) => (rampTrack(s)?.clips.length ?? 0) === 1)
      const undoCount = rampTrack(current)?.clips.length ?? 0
      await pressButton('Redo')
      current = await until((s) => (rampTrack(s)?.clips.length ?? 0) === 2)
      record('Undo and Redo buttons revert and reapply the split', undoCount === 1 && (rampTrack(current)?.clips.length ?? 0) === 2, `after undo ${undoCount} clip(s), after redo ${rampTrack(current)?.clips.length ?? 0}`)

      g = await geometry()
      clips = clipsByStart(rampTrack(current))
      let target = xAt(g, 1.5)
      await drag(xAt(g, clips[1].timelineStart) + 3, laneY(g, 1, 100), target, laneY(g, 1, 100))
      const trimLeftExpected = snapTime(timeAtX(g, target))
      current = await until((s) => near(clipsByStart(rampTrack(s))[1]?.timelineStart ?? -1, trimLeftExpected))
      clips = clipsByStart(rampTrack(current))
      record('trim left edge by dragging', near(clips[1].timelineStart, trimLeftExpected) && near(clips[1].sourceOffset, trimLeftExpected) && near(clips[1].duration, 4 - trimLeftExpected),
        `start ${clips[1].timelineStart.toFixed(4)} offset ${clips[1].sourceOffset.toFixed(4)} length ${clips[1].duration.toFixed(4)} (expected start ${trimLeftExpected})`)

      target = xAt(g, 0.75)
      await drag(xAt(g, clips[0].timelineStart + clips[0].duration) - 2, laneY(g, 1, 100), target, laneY(g, 1, 100))
      const trimRightExpected = snapTime(timeAtX(g, target))
      current = await until((s) => near(clipsByStart(rampTrack(s))[0]?.duration ?? -1, trimRightExpected))
      clips = clipsByStart(rampTrack(current))
      record('trim right edge by dragging', near(clips[0].duration, trimRightExpected) && clips[0].timelineStart === 0, `length ${clips[0].duration.toFixed(4)} (expected ${trimRightExpected})`)

      const moveFrom = xAt(g, 2.5)
      const moveTo = moveFrom + Math.round(0.5 * g.pps)
      const moveExpected = snapTime(clips[1].timelineStart + (moveTo - moveFrom) / g.pps)
      const movedOffset = clips[1].sourceOffset
      await drag(moveFrom, laneY(g, 1, 100), moveTo, laneY(g, 1, 100))
      current = await until((s) => near(clipsByStart(rampTrack(s))[1]?.timelineStart ?? -1, moveExpected))
      clips = clipsByStart(rampTrack(current))
      record('move clip by dragging', near(clips[1].timelineStart, moveExpected) && near(clips[1].sourceOffset, movedOffset), `start ${clips[1].timelineStart.toFixed(4)} offset ${clips[1].sourceOffset.toFixed(4)} (expected start ${moveExpected})`)

      g = await geometry()
      const fadeStart = clips[1].timelineStart
      const fadeInFrom = xAt(g, fadeStart) + 2
      const fadeInTo = xAt(g, fadeStart + 0.5)
      await drag(fadeInFrom, laneY(g, 1, 12), fadeInTo, laneY(g, 1, 12))
      const fadeInExpected = timeAtX(g, fadeInTo) - fadeStart
      current = await until((s) => (clipsByStart(rampTrack(s))[1]?.fadeIn ?? 0) > 0, 2500)
      clips = clipsByStart(rampTrack(current))
      const fadeInOk = near(clips[1].fadeIn, fadeInExpected, 2 / rampRate) && near(clips[1].timelineStart, fadeStart)
      record('fade in by dragging the clip handle', fadeInOk, `fade in ${clips[1].fadeIn.toFixed(4)} s (expected ${fadeInExpected.toFixed(4)}), clip start ${clips[1].timelineStart.toFixed(4)} (was ${fadeStart.toFixed(4)})`)
      if (!near(clips[1].timelineStart, fadeStart)) {
        await key('Z', ['control'])
        current = await until((s) => near(clipsByStart(rampTrack(s))[1]?.timelineStart ?? -1, fadeStart))
        clips = clipsByStart(rampTrack(current))
      }

      const fadeEnd = clips[0].timelineStart + clips[0].duration
      const fadeOutTo = xAt(g, fadeEnd - 0.25)
      const previousLength = clips[0].duration
      await drag(xAt(g, fadeEnd) - 2, laneY(g, 1, 12), fadeOutTo, laneY(g, 1, 12))
      const fadeOutExpected = fadeEnd - timeAtX(g, fadeOutTo)
      current = await until((s) => (clipsByStart(rampTrack(s))[0]?.fadeOut ?? 0) > 0, 2500)
      clips = clipsByStart(rampTrack(current))
      const fadeOutOk = near(clips[0].fadeOut, fadeOutExpected, 2 / rampRate) && near(clips[0].duration, previousLength)
      record('fade out by dragging the clip handle', fadeOutOk, `fade out ${clips[0].fadeOut.toFixed(4)} s (expected ${fadeOutExpected.toFixed(4)}), clip length ${clips[0].duration.toFixed(4)} (was ${previousLength.toFixed(4)})`)
      if (!near(clips[0].duration, previousLength)) {
        await key('Z', ['control'])
        current = await until((s) => near(clipsByStart(rampTrack(s))[0]?.duration ?? -1, previousLength))
        clips = clipsByStart(rampTrack(current))
      }
      if (!fadeInOk || !fadeOutOk) {
        await click(xAt(g, clips[1].timelineStart + 1.0), laneY(g, 1, 90))
        await js(`(() => { const input = document.querySelector('input[aria-label="Fade in"]'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(input, '0.5'); input.dispatchEvent(new Event('input', { bubbles: true })) })()`)
        await wait(400)
        await click(xAt(g, 0.3), laneY(g, 1, 90))
        await js(`(() => { const input = document.querySelector('input[aria-label="Fade out"]'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(input, '0.25'); input.dispatchEvent(new Event('input', { bubbles: true })) })()`)
        current = await until((s) => (clipsByStart(rampTrack(s))[0]?.fadeOut ?? 0) > 0 && (clipsByStart(rampTrack(s))[1]?.fadeIn ?? 0) > 0)
        clips = clipsByStart(rampTrack(current))
        record('fades set from the inspector fields instead', near(clips[1].fadeIn, 0.5) && near(clips[0].fadeOut, 0.25), `fade in ${clips[1].fadeIn}, fade out ${clips[0].fadeOut}`)
      }
      await shot('edited')

      g = await geometry()
      await click(xAt(g, clips[0].timelineStart + clips[0].duration / 2), laneY(g, 1, 90))
      await key('C', ['control'])
      const pasteX = xAt(g, 5.0)
      await click(pasteX, g.rulerTop + g.rulerHeight / 2)
      await key('V', ['control'])
      const pasteExpected = snapTime(timeAtX(g, pasteX))
      current = await until((s) => (rampTrack(s)?.clips.length ?? 0) === 3)
      clips = clipsByStart(rampTrack(current))
      const pasted = clips[2]
      record('copy and paste with Ctrl+C and Ctrl+V', clips.length === 3 && near(pasted.timelineStart, pasteExpected) && pasted.sourceOffsetSamples === clips[0].sourceOffsetSamples && pasted.durationSamples === clips[0].durationSamples && pasted.fadeOutSamples === clips[0].fadeOutSamples,
        clips.length === 3 ? `pasted at ${pasted.timelineStart.toFixed(4)} length ${pasted.duration.toFixed(4)} fade out ${pasted.fadeOut.toFixed(4)}` : `${clips.length} clips`)

      await click(xAt(g, pasted.timelineStart + pasted.duration / 2), laneY(g, 1, 90))
      await key('Delete')
      current = await until((s) => (rampTrack(s)?.clips.length ?? 0) === 2)
      const afterDelete = rampTrack(current)?.clips.length ?? 0
      await key('Z', ['control'])
      current = await until((s) => (rampTrack(s)?.clips.length ?? 0) === 3)
      const afterUndo = rampTrack(current)?.clips.length ?? 0
      await key('Y', ['control'])
      current = await until((s) => (rampTrack(s)?.clips.length ?? 0) === 2)
      const afterRedo = rampTrack(current)?.clips.length ?? 0
      await key('Z', ['control'])
      current = await until((s) => (rampTrack(s)?.clips.length ?? 0) === 3)
      record('Delete key, then Ctrl+Z and Ctrl+Y', afterDelete === 2 && afterUndo === 3 && afterRedo === 2 && (rampTrack(current)?.clips.length ?? 0) === 3, `delete ${afterDelete}, undo ${afterUndo}, redo ${afterRedo}, undo ${rampTrack(current)?.clips.length ?? 0}`)

      clips = clipsByStart(rampTrack(current))
      await click(xAt(g, clips[1].timelineStart + 1), laneY(g, 1, 90))
      const copied = await pressButton('Copy')
      await click(xAt(g, 6.5), g.rulerTop + g.rulerHeight / 2)
      const pastedByButton = await pressButton('Paste')
      current = await until((s) => (rampTrack(s)?.clips.length ?? 0) === 4)
      const buttonPaste = rampTrack(current)?.clips.length ?? 0
      clips = clipsByStart(rampTrack(current))
      const extra = clips.find((c) => near(c.timelineStart, 6.5, 0.03))
      if (extra != null)
        await click(xAt(g, extra.timelineStart + 0.2), laneY(g, 1, 90))
      const deletedByButton = await pressButton('Delete')
      current = await until((s) => (rampTrack(s)?.clips.length ?? 0) === 3)
      record('Copy, Paste and Delete buttons', copied && pastedByButton && deletedByButton && buttonPaste === 4 && extra != null && (rampTrack(current)?.clips.length ?? 0) === 3,
        `after paste ${buttonPaste} clips, after delete ${rampTrack(current)?.clips.length ?? 0}`)

      await pressButton('M', '.lane-column article:nth-of-type(1)')
      current = await until((s) => s.tracks[0]?.mute === true)
      record('mute the music track with its M button', current.tracks[0]?.mute === true, `mute=${current.tracks[0]?.mute}`)
      await shot('final-arrangement')

      answer(exportPath)
      await pressButton('Export WAV')
      const exportedOk = await waitForFile(exportPath)
      record('export through the Export WAV button', exportedOk, exportPath)
      current = await state()
      const exported = exportedOk ? await validateExport('edited', exportPath, current) : null
      await comparePlayback('edited', exported)

      if (current.deviceOpen) {
        await pressButton('Stop')
        await engine.request('transport', { action: 'seek', position: 0 })
        meterLog.length = 0
        await pressButton('Play')
        await wait(6400)
        await pressButton('Stop')
        const ramp = rampTrack(current)!
        const spans = ramp.clips.map((c) => [c.timelineStart, c.timelineStart + c.duration] as const)
        const inside = (a: number, b: number): boolean => spans.some(([s, e]) => a >= s + 0.1 && b <= e - 0.3)
        const outside = (a: number, b: number): boolean => spans.every(([s, e]) => b <= s - 0.03 || a >= e + 0.03)
        let loudInClips = 0
        let clipWindows = 0
        let quietInGaps = 0
        let gapWindows = 0
        for (let i = 1; i < meterLog.length; i++) {
          const a = meterLog[i - 1].position
          const b = meterLog[i].position
          if (b <= a)
            continue
          if (inside(a, b)) {
            clipWindows++
            if (meterLog[i].peak > 0.01)
              loudInClips++
          } else if (outside(a, b) && b < 6.2) {
            gapWindows++
            if (meterLog[i].peak < 1.0e-3)
              quietInGaps++
          }
        }
        record('device playback is audible inside clips and silent in gaps', clipWindows > 10 && gapWindows > 5 && loudInClips === clipWindows && quietInGaps === gapWindows,
          `${loudInClips}/${clipWindows} meter windows loud inside clips, ${quietInGaps}/${gapWindows} silent in gaps (meter peaks from the audio callback, not a loopback recording)`)
      } else {
        record('device playback is audible inside clips and silent in gaps', null, 'no output device open')
      }

      answer(projectPath)
      await pressButton('Save project')
      const savedOk = await waitForFile(projectPath)
      current = await state()
      fs.writeFileSync(savedStatePath, JSON.stringify(current.tracks, null, 2))
      record('save project through the Save project button', savedOk, projectPath)

      const panelHeights = async (): Promise<{ devices: number, workspace: number, banner: boolean }> => await js(`(() => ({
        devices: document.querySelector('.panel.devices').getBoundingClientRect().height,
        workspace: document.querySelector('.workspace').getBoundingClientRect().height,
        banner: document.querySelector('.banner') != null
      }))()`)
      const calm = await panelHeights()
      answer(path.join(outDir, 'does-not-exist.msp.json'))
      await pressButton('Load project')
      await wait(800)
      const alarmed = await panelHeights()
      const tracksKept = (await state()).tracks.length === 2
      record('error banner does not stretch the device panel or collapse the editor', alarmed.banner && Math.abs(alarmed.devices - calm.devices) < 1 && alarmed.workspace > calm.workspace - 80 && tracksKept,
        `device panel ${calm.devices.toFixed(0)} -> ${alarmed.devices.toFixed(0)} px, editor ${calm.workspace.toFixed(0)} -> ${alarmed.workspace.toFixed(0)} px, banner shown ${alarmed.banner}, tracks kept ${tracksKept}`)
      await shot('error-banner')

      for (let i = 0; i < 12; i++)
        await engine.request('addTrack', { name: '' })
      web.reload()
      await new Promise<void>((resolve) => web.once('did-finish-load', () => resolve()))
      await wait(1500)
      const scroller = '.lanes-scroll'
      const readScroll = async (): Promise<{ top: number, aligned: boolean, left: number }> => await js(`(() => {
        const s = document.querySelector('${scroller}')
        const canvas = document.querySelector('.timeline-canvas').getBoundingClientRect()
        const headers = Array.from(document.querySelectorAll('.lane-header'))
        const lane = ${g.lane}
        const aligned = headers.every((h, i) => Math.abs(h.getBoundingClientRect().top - canvas.top - i * lane) < 0.5)
        return { top: s.scrollTop, aligned, left: document.querySelector('.timeline-scroll').scrollLeft }
      })()`)
      const wheel = async (x: number, y: number, deltaY: number, deltaX = 0, modifiers: Array<'shift'> = []): Promise<void> => {
        mouse('mouseMove', x, y)
        await wait(50)
        web.sendInputEvent({ type: 'mouseWheel', x, y, deltaX, deltaY, wheelTicksX: deltaX / 120, wheelTicksY: deltaY / 120, canScroll: true, modifiers })
        await wait(500)
      }
      await js(`document.querySelector('${scroller}').scrollTop = 600`)
      await wait(300)
      g = await geometry()
      const headerPoint = await js<{ x: number, y: number }>(`(() => { const r = document.querySelector('.lane-column').getBoundingClientRect(); const s = document.querySelector('${scroller}').getBoundingClientRect(); return { x: r.left + 120, y: s.top + 200 } })()`)
      const s0 = await readScroll()
      await wheel(headerPoint.x, headerPoint.y, -120)
      const s1 = await readScroll()
      await wheel(xAt(g, 2), headerPoint.y, -120)
      const s2 = await readScroll()
      const headerDelta = s1.top - s0.top
      const laneDelta = s2.top - s1.top
      record('mouse wheel over track headers scrolls vertically', headerDelta !== 0 && s1.aligned, `scrollTop ${s0.top} -> ${s1.top}`)
      record('mouse wheel over the timeline scrolls the same distance', laneDelta !== 0 && Math.abs(laneDelta - headerDelta) < 1 && s2.aligned, `header notch ${headerDelta}px, timeline notch ${laneDelta}px`)
      await wheel(xAt(g, 2), headerPoint.y, -120, 0, ['shift'])
      const s3 = await readScroll()
      record('shift + mouse wheel over the timeline scrolls horizontally', s3.left !== s2.left && Math.abs(s3.top - s2.top) < 1, `scrollLeft ${s2.left} -> ${s3.left}, scrollTop ${s2.top} -> ${s3.top}`)

      await js(`document.querySelector('${scroller}').scrollTop = 0; document.querySelector('.timeline-scroll').scrollLeft = 0`)
      await wait(300)
      const bar = await js<{ x: number, y: number, thickness: number, length: number, thumb: number }>(`(() => {
        const s = document.querySelector('${scroller}')
        const r = s.getBoundingClientRect()
        const thickness = s.offsetWidth - s.clientWidth
        const track = s.clientHeight - 2 * thickness
        const thumb = Math.max(20, track * s.clientHeight / s.scrollHeight)
        return { x: r.right - thickness / 2, y: r.top + thickness + Math.min(thumb / 2, 12), thickness, length: track, thumb }
      })()`)
      if (bar.thickness > 0) {
        await drag(bar.x, bar.y, bar.x, bar.y + 120)
        const s4 = await readScroll()
        record('drag the vertical scrollbar thumb', s4.top > 100 && s4.aligned, `scrollTop 0 -> ${s4.top}, headers aligned ${s4.aligned}`)
      } else {
        record('drag the vertical scrollbar thumb', null, 'no classic scrollbar to grab')
      }
      const hbar = await js<{ x: number, y: number, thickness: number }>(`(() => {
        const s = document.querySelector('.timeline-scroll')
        const r = s.getBoundingClientRect()
        const thickness = Math.max(0, s.offsetHeight - s.clientHeight)
        return { x: r.left + Math.max(thickness, 14) + 12, y: r.top + r.height / 2, thickness }
      })()`)
      const rulerBefore = await js<number>(`(() => { const c = document.querySelector('.timeline-ruler'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let h = 0; for (let i = 0; i < d.length; i += 4) h = (h * 31 + d[i]) % 1000000007; return h })()`)
      await drag(hbar.x, hbar.y, hbar.x + 120, hbar.y)
      const s5 = await readScroll()
      await wait(300)
      const rulerAfter = await js<number>(`(() => { const c = document.querySelector('.timeline-ruler'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let h = 0; for (let i = 0; i < d.length; i += 4) h = (h * 31 + d[i]) % 1000000007; return h })()`)
      record('drag the horizontal scrollbar thumb', s5.left > 50 && rulerAfter !== rulerBefore, `scrollLeft 0 -> ${s5.left}, ruler redrawn ${rulerAfter !== rulerBefore}`)
      await shot('scrolled')
    } else {
      if (!fs.existsSync(projectPath) || !fs.existsSync(savedStatePath)) {
        record('reopen and load saved project', false, 'run the edit phase first')
      } else {
        const saved = JSON.parse(fs.readFileSync(savedStatePath, 'utf8')) as Track[]
        answer(projectPath)
        await pressButton('Load project')
        const current = await until((s) => s.tracks.length === saved.length && s.tracks.every((t) => t.clips.length > 0), 15000)
        const describe = (tracks: Track[]): string => tracks.map((t) => `${t.name}[${t.mute ? 'muted ' : ''}${[...t.clips].sort((a, b) => a.timelineStartSamples - b.timelineStartSamples).map((c) => `${c.timelineStartSamples}+${c.durationSamples}@${c.sourceOffsetSamples} f${c.fadeInSamples}/${c.fadeOutSamples}`).join(',')}]`).join(' ')
        const same = describe(current.tracks) === describe(saved)
        record('reopen app and load the saved project: clips, fades, names and mute restored', same, same ? describe(current.tracks) : `saved ${describe(saved)} | loaded ${describe(current.tracks)}`)
        await wait(1500)
        const ramp = rampTrack(current)
        if (ramp != null) {
          const coverage = await waveformCoverage(current.tracks.indexOf(ramp), ramp.clips[0].timelineStart, ramp.clips[0].timelineStart + ramp.clips[0].duration)
          record('waveforms redrawn after loading', coverage.covered > coverage.columns * 0.9, `${coverage.covered}/${coverage.columns} columns drawn`)
        }
        await shot('loaded')
        answer(exportPath)
        await pressButton('Export WAV')
        const exportedOk = await waitForFile(exportPath)
        const exported = exportedOk ? await validateExport('reloaded', exportPath, current) : null
        if (exported != null && fs.existsSync(firstExportPath)) {
          const first = readWav(firstExportPath)
          const { worst } = worstDifference(first, exported)
          record('export after reload is identical to export before closing', worst < 1.0e-6, `worst ${worst.toExponential(2)}`)
        }
        await comparePlayback('reloaded', exported)
      }
    }
  } catch (error) {
    record('workflow check run', false, error instanceof Error ? error.stack ?? error.message : String(error))
  }

  engine.onEvent = previousHandler
  fs.writeFileSync(path.join(outDir, `${phase}-results.json`), JSON.stringify(checks, null, 2))
  return checks.every((check) => check.result !== 'FAIL') ? 0 : 1
}
