import type { BrowserWindow } from 'electron'
import fs from 'fs'
import path from 'path'
import type { EngineHost } from './engineHost'
import { readWav, writeWav24 } from './workflowCheck'

interface Point { time: number, timeSamples: number, value: number, interpolation: 'linear' | 'step' }
interface Lane { param: string, enabled: boolean, active: boolean, points: Point[] }
interface Clip { id: string, timelineStart: number, duration: number, sourceFileId: string }
interface Effect { id: string, type: string }
interface Track {
  id: string, name: string, gain: number, pan: number, clips: Clip[], effects: Effect[], automation: Lane[]
  armed: boolean, recordInput: string, recordMode: string, monitorInput: boolean
}
interface Take { trackId: string, path: string, kind: string, channels: number, frames: number, gapFrames: number, placed: boolean }
interface RecordInfo { state: string, folder: string, droppedFrames: number, virtualInput: { enabled: boolean, frequency: number, level: number }, lastTake: { startSamples: number, takes: Take[], droppedFrames: number, warnings: string[] } | null }
interface State { tracks: Track[], buses: Array<{ id: string, automation: Lane[] }>, masterAutomation: Lane[], sampleRate: number, deviceOpen: boolean, transport: string, record: RecordInfo }
interface Check { scenario: string, result: 'PASS' | 'FAIL' | 'NOT RUN', detail: string }

export interface AutoCheckOptions {
  outDir: string
  phase: 'build' | 'reload'
  answer: (filePath: string) => void
}

const fixtureRate = 48000
const fixtureSeconds = 2
const dc = 0.5
const centre = Math.SQRT1_2
const autoPad = 10

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Same formula as msp::virtualInputSample (Recording.cpp).
function virtualSample(frequency: number, level: number, rate: number, frame: number, channel: number): number {
  if (channel === 0) {
    const cycles = frame * frequency / rate
    return Math.fround(level * Math.sin(2 * Math.PI * (cycles - Math.floor(cycles))))
  }
  const step = ((frame % 200) + 200) % 200
  return Math.fround(level * (step / 100 - 1))
}

function laneValue(points: Point[], time: number): number {
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

function volumeFraction(gain: number): number {
  return gain > 0 ? Math.min(1, Math.max(0, (20 * Math.log10(gain) + 60) / 72)) : 0
}

function lanesText(lanes: Lane[]): string {
  return lanes.map((lane) => `${lane.param}${lane.enabled ? '' : '(off)'}[${lane.points.map((p) => `${p.timeSamples}:${p.value.toFixed(4)}${p.interpolation === 'step' ? 's' : ''}`).join(' ')}]`).join(' ')
}

export async function runAutoCheck(win: BrowserWindow, engine: EngineHost, options: AutoCheckOptions): Promise<number> {
  const { outDir, phase, answer } = options
  fs.mkdirSync(outDir, { recursive: true })
  const web = win.webContents
  const checks: Check[] = []
  const fixture = path.join(outDir, 'auto-dc.wav')
  const projectPath = path.join(outDir, 'automation.msp.json')
  const savedStatePath = path.join(outDir, 'build-state.json')
  const exportBuild = path.join(outDir, 'export-build.wav')
  const recordFolder = path.join(outDir, 'recordings')

  function record(scenario: string, ok: boolean, detail: string): void {
    checks.push({ scenario, result: ok ? 'PASS' : 'FAIL', detail })
  }

  async function js<T>(code: string): Promise<T> {
    return await web.executeJavaScript(code, true) as T
  }

  async function state(): Promise<State> {
    const response = await engine.request('getState')
    return response.result as State
  }

  async function until(test: (s: State) => boolean, timeoutMs = 5000): Promise<State> {
    const started = Date.now()
    let current = await state()
    while (!test(current) && Date.now() - started < timeoutMs) {
      await wait(100)
      current = await state()
    }
    return current
  }

  // capturePage returns the last composited frame, which can predate the latest DOM change.
  async function shot(name: string): Promise<void> {
    web.invalidate()
    await js('new Promise((resolve) => { requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))); setTimeout(() => resolve(false), 500) })')
    await wait(150)
    const image = await web.capturePage()
    fs.writeFileSync(path.join(outDir, `${phase}-${name}.png`), image.toPNG())
  }

  function mouse(type: 'mouseDown' | 'mouseUp' | 'mouseMove', x: number, y: number, clickCount = 1): void {
    web.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount })
  }

  async function click(x: number, y: number): Promise<void> {
    mouse('mouseMove', x, y)
    await wait(30)
    mouse('mouseDown', x, y)
    await wait(40)
    mouse('mouseUp', x, y)
    await wait(350)
  }

  async function doubleClick(x: number, y: number): Promise<void> {
    mouse('mouseMove', x, y)
    await wait(30)
    mouse('mouseDown', x, y, 1)
    await wait(30)
    mouse('mouseUp', x, y, 1)
    await wait(60)
    mouse('mouseDown', x, y, 2)
    await wait(30)
    mouse('mouseUp', x, y, 2)
    await wait(450)
  }

  async function drag(x0: number, y0: number, x1: number, y1: number): Promise<void> {
    mouse('mouseMove', x0, y0)
    await wait(30)
    mouse('mouseDown', x0, y0)
    await wait(60)
    for (let step = 1; step <= 8; step++) {
      mouse('mouseMove', x0 + (x1 - x0) * step / 8, y0 + (y1 - y0) * step / 8)
      await wait(25)
    }
    mouse('mouseUp', x1, y1)
    await wait(450)
  }

  async function key(keyCode: string): Promise<void> {
    web.focus()
    web.sendInputEvent({ type: 'keyDown', keyCode })
    await wait(20)
    web.sendInputEvent({ type: 'keyUp', keyCode })
    await wait(450)
  }

  // Clicks a text field, selects its contents, types `text` and presses Enter.
  async function typeInto(selector: string, text: string): Promise<boolean> {
    if (!await press(selector))
      return false
    web.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] })
    web.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] })
    await wait(50)
    for (const ch of text) {
      web.sendInputEvent({ type: 'char', keyCode: ch })
      await wait(20)
    }
    await key('Enter')
    return true
  }

  // Clicks the element matching `selector` (optionally with exact text) with injected mouse events.
  async function press(selector: string, text?: string): Promise<boolean> {
    const point = await js<{ x: number, y: number, disabled: boolean } | null>(`(() => {
      const items = Array.from(document.querySelectorAll(${JSON.stringify(selector)}))
      const el = ${text == null ? 'items[0]' : `items.find((item) => item.textContent.trim() === ${JSON.stringify(text)})`}
      if (el == null)
        return null
      el.scrollIntoView({ block: 'nearest' })
      const r = el.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, disabled: el.disabled === true }
    })()`)
    if (point == null || point.disabled)
      return false
    await click(point.x, point.y)
    return true
  }

  async function choose(selector: string, value: string): Promise<boolean> {
    const done = await js<boolean>(`(() => {
      const select = document.querySelector(${JSON.stringify(selector)})
      if (select == null || select.disabled)
        return false
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
      setter.call(select, ${JSON.stringify(value)})
      select.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`)
    await wait(400)
    return done
  }

  async function reloadPage(): Promise<void> {
    web.reload()
    await new Promise<void>((resolve) => web.once('did-finish-load', () => resolve()))
    await wait(1200)
  }

  interface Lanes { left: number, top: number, pps: number, scrollLeft: number, autoTops: number[], autoHeight: number }
  async function geometry(): Promise<Lanes> {
    return await js<Lanes>(`(() => {
      const canvas = document.querySelector('.timeline-canvas').getBoundingClientRect()
      const app = getComputedStyle(document.querySelector('.app'))
      return {
        left: canvas.left,
        top: canvas.top,
        pps: parseFloat(document.querySelector('.zoom span').textContent),
        scrollLeft: document.querySelector('.timeline-scroll').scrollLeft,
        autoTops: Array.from(document.querySelectorAll('.auto-header')).map((h) => h.getBoundingClientRect().top),
        autoHeight: parseFloat(app.getPropertyValue('--auto-height'))
      }
    })()`)
  }

  const xAt = (g: Lanes, seconds: number): number => g.left + (seconds - g.scrollLeft / g.pps) * g.pps
  const yAt = (g: Lanes, row: number, fraction: number): number => g.autoTops[row] + autoPad + (1 - fraction) * (g.autoHeight - 2 * autoPad)

  // Every row header (track or automation) sits exactly on its canvas row.
  async function rowsAligned(): Promise<{ ok: boolean, detail: string }> {
    return await js<{ ok: boolean, detail: string }>(`(() => {
      const canvas = document.querySelector('.timeline-canvas').getBoundingClientRect()
      const rows = Array.from(document.querySelectorAll('.lane-column > article'))
      let top = 0
      const problems = []
      rows.forEach((row, index) => {
        const r = row.getBoundingClientRect()
        if (Math.abs(r.top - canvas.top - top) > 0.5)
          problems.push('row ' + index + ' off by ' + (r.top - canvas.top - top).toFixed(1))
        if (row.scrollWidth > row.clientWidth + 1 || row.scrollHeight > row.clientHeight + 1)
          problems.push('row ' + index + ' content overflows')
        row.querySelectorAll('button, input, select').forEach((control) => {
          const c = control.getBoundingClientRect()
          const label = (control.getAttribute('aria-label') || control.textContent || control.tagName).trim()
          if (c.width < 1 || c.height < 1 || c.left < r.left - 0.5 || c.right > r.right + 0.5 || c.top < r.top - 0.5 || c.bottom > r.bottom + 0.5)
            problems.push('row ' + index + ' ' + label + ' is outside its header')
          if (control.tagName === 'BUTTON' && control.scrollWidth > control.clientWidth + 1)
            problems.push('row ' + index + ' button ' + label + ' text is cut off')
        })
        top += r.height
      })
      if (Math.abs(canvas.height - Math.max(top, 1)) > 0.5)
        problems.push('canvas ' + canvas.height.toFixed(1) + ' != rows ' + top)
      return { ok: problems.length === 0, detail: rows.length + ' rows, ' + (problems.join('; ') || 'aligned') }
    })()`)
  }

  async function exportTo(file: string, rate: number): Promise<{ left: Float32Array, right: Float32Array, rate: number } | null> {
    if (fs.existsSync(file))
      fs.unlinkSync(file)
    const response = await engine.request('exportWav', { path: file, sampleRate: rate }, 60000)
    return response.ok && fs.existsSync(file) ? readWav(file) : null
  }

  function trackByName(s: State, name: string): Track | undefined {
    return s.tracks.find((track) => track.name === name)
  }

  try {
    if (phase === 'build') {
      writeWav24(fixture, fixtureRate, fixtureRate * fixtureSeconds, () => dc, () => dc)
      for (const track of (await state()).tracks)
        await engine.request('removeTrack', { trackId: track.id })
      await engine.request('importTrack', { trackId: 'auto-a', path: fixture }, 20000)
      await engine.request('renameTrack', { trackId: 'auto-a', name: 'Auto A' })
      await engine.request('setRecordFolder', { path: recordFolder })
      fs.rmSync(recordFolder, { recursive: true, force: true })
      await reloadPage()
      const initial = await state()
      const rate = initial.sampleRate || fixtureRate

      const closed = await js<{ autos: number, headers: number, version: string }>(`({ autos: document.querySelectorAll('.auto-header').length, headers: document.querySelectorAll('.lane-header').length, version: document.querySelector('.eyebrow').textContent })`)
      record('editor layout unchanged with automation hidden', closed.autos === 0 && closed.headers === 1 && closed.version === 'Phase 2.3', `${closed.headers} track header, ${closed.autos} automation rows, label ${closed.version}`)
      await shot('01-default-layout')

      const opened = await press('button[aria-label="Auto A automation lane"]')
      await wait(300)
      const options = await js<string[]>(`Array.from(document.querySelectorAll('.auto-header select[aria-label$="parameter"] option')).map((o) => o.textContent)`)
      const aligned = await rowsAligned()
      record('A button shows the automation lane under its track', opened && aligned.ok && options.join('|') === 'Volume|Pan', `${aligned.detail}; parameters ${options.join(', ')}`)

      // Add two points by clicking the lane, then drag the second.
      let g = await geometry()
      await click(xAt(g, 0.25), yAt(g, 0, volumeFraction(1)))
      let current = await until((s) => (trackByName(s, 'Auto A')?.automation[0]?.points.length ?? 0) === 1)
      let lane = trackByName(current, 'Auto A')?.automation[0]
      const first = lane?.points[0]
      record('click on the lane adds a point at that time and value', lane?.param === 'volume' && first != null && Math.abs(first.time - 0.25) < 1e-9 && Math.abs(20 * Math.log10(first.value)) < 0.6,
        lane == null ? 'no lane' : lanesText([lane]))
      await click(xAt(g, 1.5), yAt(g, 0, 0.3))
      current = await until((s) => (trackByName(s, 'Auto A')?.automation[0]?.points.length ?? 0) === 2)
      await drag(xAt(g, 1.5), yAt(g, 0, 0.3), xAt(g, 1.0), yAt(g, 0, volumeFraction(0.5)))
      current = await until((s) => Math.abs((trackByName(s, 'Auto A')?.automation[0]?.points[1]?.time ?? 0) - 1.0) < 1e-9)
      lane = trackByName(current, 'Auto A')?.automation[0]
      const moved = lane?.points[1]
      record('drag moves a point in time and value', moved != null && Math.abs(moved.time - 1.0) < 1e-9 && Math.abs(20 * Math.log10(moved.value) + 6.02) < 0.6 && lane?.points.length === 2,
        lane == null ? 'no lane' : lanesText([lane]))

      // Select the first point and make it a step.
      await click(xAt(g, 0.25), yAt(g, 0, volumeFraction(first?.value ?? 1)))
      await choose('.auto-header select[aria-label$="interpolation"]', 'step')
      current = await until((s) => trackByName(s, 'Auto A')?.automation[0]?.points[0]?.interpolation === 'step')
      lane = trackByName(current, 'Auto A')?.automation[0]
      record('interpolation select switches the selected point to step', lane?.points[0]?.interpolation === 'step' && lane.points[1]?.interpolation === 'linear', lane == null ? 'no lane' : lanesText([lane]))

      // Typed point editing: the selected first point gets an exact time and value.
      const valueField = '.auto-header input[aria-label="Auto A automation point value"]'
      const timeField = '.auto-header input[aria-label="Auto A automation point time"]'
      const shown = await js<{ time: string, value: string, unit: string }>(`(() => {
        const box = document.querySelector('.auto-point')
        return { time: box?.querySelector('input[aria-label$="point time"]')?.value ?? '', value: box?.querySelector('input[aria-label$="point value"]')?.value ?? '', unit: box?.querySelectorAll('span')[1]?.textContent ?? '' }
      })()`)
      const typedValue = await typeInto(valueField, '-3')
      current = await until((s) => Math.abs((trackByName(s, 'Auto A')?.automation[0]?.points[0]?.value ?? 0) - 0.7079) < 1e-4)
      const typedTime = await typeInto(timeField, '0.3')
      current = await until((s) => Math.abs((trackByName(s, 'Auto A')?.automation[0]?.points[0]?.time ?? 0) - 0.3) < 1e-9)
      lane = trackByName(current, 'Auto A')?.automation[0]
      const edited = lane?.points[0]
      record('typed time and value edit the selected point', typedValue && typedTime && shown.time === '0.250' && shown.unit === 'dB' && edited != null
          && Math.abs(edited.time - 0.3) < 1e-9 && Math.abs(edited.value - 0.7079) < 1e-4 && edited.interpolation === 'step' && lane?.points.length === 2,
        `fields showed ${shown.time} s / ${shown.value} ${shown.unit}; after typing -3 and 0.3: ${lane == null ? 'no lane' : lanesText([lane])}`)
      await shot('02-volume-lane')

      // Visual indication and manual override rule.
      const marks = await js<{ option: string, autoClass: boolean, gainDisabled: boolean, gainLabel: string }>(`(() => {
        const option = document.querySelector('.auto-header select[aria-label$="parameter"] option')
        const header = document.querySelector('.lane-header')
        const gain = header.querySelector('input[aria-label="Auto A gain"]')
        return { option: option.textContent, autoClass: header.querySelector('.auto-button').classList.contains('automated'), gainDisabled: gain.disabled, gainLabel: gain.closest('label').querySelector('span').textContent }
      })()`)
      const manual = await engine.request('setTrack', { trackId: 'auto-a', gain: 0.25 })
      record('automated parameter is marked and its manual control locked', marks.option.startsWith('●') && marks.autoClass && marks.gainDisabled && marks.gainLabel === 'Gain auto' && !manual.ok,
        `option "${marks.option}", A highlighted ${marks.autoClass}, gain slider disabled ${marks.gainDisabled} ("${marks.gainLabel}"); manual set: ${manual.error ?? 'accepted'}`)

      // Playback and export follow the lane.
      const exported = await exportTo(exportBuild, rate)
      const renderPath = path.join(outDir, 'render-build.wav')
      const rendered = await engine.request('renderPlayback', { path: renderPath }, 60000)
      const render = rendered.ok ? readWav(renderPath) : null
      const points = lane?.points ?? []
      const probes = [0.1, 0.6, 0.95, 1.5, 1.9]
      let worst = exported == null || points.length === 0 ? 1 : 0
      const seen: string[] = []
      for (const t of probes) {
        const i = Math.round(t * rate)
        const expected = dc * centre * laneValue(points, t)
        const got = exported?.left[i] ?? 0
        worst = Math.max(worst, Math.abs(got - expected))
        seen.push(`${t}s ${got.toFixed(4)}/${expected.toFixed(4)}`)
      }
      let renderDiff = render == null || exported == null || render.left.length !== exported.left.length ? 1 : 0
      for (let i = 0; render != null && exported != null && i < Math.min(render.left.length, exported.left.length); i++)
        renderDiff = Math.max(renderDiff, Math.abs(render.left[i] - exported.left[i]), Math.abs(render.right[i] - exported.right[i]))
      record('export follows the automation lane', worst < 1e-3, seen.join(', '))
      record('playback render equals export with automation', renderDiff < 1e-6, `max diff ${renderDiff.toExponential(2)}`)

      // Off returns to the manual value.
      await press('.auto-header button[aria-label="Auto A automation enabled"]')
      current = await until((s) => trackByName(s, 'Auto A')?.automation[0]?.enabled === false)
      const offFile = await exportTo(path.join(outDir, 'export-off.wav'), rate)
      const offOk = offFile != null && probes.every((t) => Math.abs(offFile.left[Math.round(t * rate)] - dc * centre) < 1e-4)
      const unlocked = await js<boolean>(`!document.querySelector('input[aria-label="Auto A gain"]').disabled`)
      record('lane Off plays the manual value and unlocks the control', trackByName(current, 'Auto A')?.automation[0]?.enabled === false && offOk && unlocked,
        offFile == null ? 'export failed' : `at 0.6 s ${offFile.left[Math.round(0.6 * rate)].toFixed(4)} (manual ${(dc * centre).toFixed(4)}), gain slider enabled ${unlocked}`)
      await press('.auto-header button[aria-label="Auto A automation enabled"]')
      await until((s) => trackByName(s, 'Auto A')?.automation[0]?.enabled === true)

      // Delete by double-click and by the Delete key.
      g = await geometry()
      await click(xAt(g, 1.75), yAt(g, 0, 0.5))
      await until((s) => (trackByName(s, 'Auto A')?.automation[0]?.points.length ?? 0) === 3)
      await wait(700)
      await doubleClick(xAt(g, 1.75), yAt(g, 0, 0.5))
      current = await until((s) => (trackByName(s, 'Auto A')?.automation[0]?.points.length ?? 0) === 2)
      const afterDouble = trackByName(current, 'Auto A')?.automation[0]?.points.length ?? 0
      await click(xAt(g, 1.25), yAt(g, 0, 0.5))
      await until((s) => (trackByName(s, 'Auto A')?.automation[0]?.points.length ?? 0) === 3)
      await key('Delete')
      current = await until((s) => (trackByName(s, 'Auto A')?.automation[0]?.points.length ?? 0) === 2)
      const afterKey = trackByName(current, 'Auto A')?.automation[0]?.points.length ?? 0
      record('double-click and the Delete key remove points', afterDouble === 2 && afterKey === 2 && (trackByName(current, 'Auto A')?.clips.length ?? 0) === 1,
        `after double-click ${afterDouble} points, after Delete ${afterKey} points; clip kept`)

      // Effect parameter lane, then bus/master lanes.
      const added = await engine.request('addEffect', { target: 'track', ownerId: 'auto-a', type: 'eq' })
      const eqId = (added.result as { createdEffectId?: string } | undefined)?.createdEffectId ?? ''
      await reloadPage()
      await press('button[aria-label="Auto A automation lane"]')
      const param = `fx:${eqId}:outputGain`
      const picked = await choose('.auto-header select[aria-label$="parameter"]', param)
      g = await geometry()
      await click(xAt(g, 0.5), yAt(g, 0, 0.25))
      current = await until((s) => trackByName(s, 'Auto A')?.automation.some((l) => l.param === param && l.points.length === 1) === true)
      const fxLane = trackByName(current, 'Auto A')?.automation.find((l) => l.param === param)
      record('effect parameter lane edited from the editor', picked && fxLane != null && Math.abs((fxLane.points[0]?.value ?? 0) - -12) < 1.5, fxLane == null ? 'no effect lane' : lanesText([fxLane]))
      await press('button[aria-pressed]', 'Bus lanes')
      await wait(300)
      const busRows = await js<string[]>(`Array.from(document.querySelectorAll('.auto-header')).map((h) => h.getAttribute('aria-label'))`)
      const alignedAll = await rowsAligned()
      record('bus and master automation lanes shown and aligned', busRows.includes('Master automation') && alignedAll.ok, `${busRows.join(', ')}; ${alignedAll.detail}`)

      // Master volume lane: a click on the master row adds a -6 dB point and locks the master gain.
      const masterRow = busRows.indexOf('Master automation')
      const masterParam = await js<string>(`document.querySelector('.auto-header[aria-label="Master automation"] select[aria-label$="parameter"]')?.value ?? ''`)
      g = await geometry()
      await click(xAt(g, 0.5), yAt(g, masterRow, volumeFraction(0.5)))
      current = await until((s) => s.masterAutomation.some((l) => l.param === 'volume' && l.points.length === 1))
      const masterLane = current.masterAutomation.find((l) => l.param === 'volume')
      const masterUi = await js<{ disabled: boolean, label: string }>(`(() => {
        const input = document.querySelector('input[aria-label="Master gain"]')
        return { disabled: input?.disabled === true, label: input?.closest('label')?.querySelector('span')?.textContent ?? '' }
      })()`)
      const masterManual = await engine.request('setMaster', { gain: 0.25 })
      record('master volume lane added from the editor locks the master gain', masterRow >= 0 && masterParam === 'volume' && masterLane != null
          && Math.abs(masterLane.points[0].time - 0.5) < 1e-9 && Math.abs(20 * Math.log10(masterLane.points[0].value) + 6.02) < 0.6
          && masterUi.disabled && masterUi.label === 'Master auto' && !masterManual.ok,
        `${masterLane == null ? 'no master volume lane' : lanesText([masterLane])}; Master slider disabled ${masterUi.disabled} ("${masterUi.label}"); manual set: ${masterManual.error ?? 'accepted'}`)
      await shot('03-effect-and-master-lanes')

      // Mixer: automated controls are locked and marked.
      await press('.view-toggle button', 'Mixer')
      await wait(400)
      await press('button[aria-label^="Auto A effects"]')
      await wait(300)
      const mixer = await js<{ fader: boolean, readout: string, output: boolean, outputText: string, master: boolean, masterText: string }>(`(() => {
        const fader = document.querySelector('input[aria-label="Auto A fader"]')
        const master = document.querySelector('input[aria-label="Master fader"]')
        const param = Array.from(document.querySelectorAll('.fx-param')).find((p) => p.querySelector('span')?.textContent === 'Output')
        return { fader: fader?.disabled === true, readout: fader?.closest('.fader')?.querySelector('.db-readout')?.textContent ?? '', output: param?.querySelector('input')?.disabled === true, outputText: param?.querySelector('output')?.textContent ?? '',
          master: master?.disabled === true, masterText: master?.closest('.fader')?.querySelector('.db-readout')?.textContent ?? '' }
      })()`)
      record('mixer marks and locks automated volume and effect parameter', mixer.fader && mixer.readout === 'A · Auto' && mixer.output && mixer.outputText === 'A · Auto',
        `fader disabled ${mixer.fader} "${mixer.readout}", EQ output disabled ${mixer.output} "${mixer.outputText}"`)
      record('mixer master fader locked by the master volume lane', mixer.master && mixer.masterText === 'A · Auto', `master fader disabled ${mixer.master} "${mixer.masterText}"`)
      await shot('04-mixer-automated')
      await press('.view-toggle button', 'Editor')
      await wait(400)

      // Recording from the test signal onto a new track.
      await press('.transport button', 'Add track')
      current = await until((s) => s.tracks.length === 2)
      const vox = current.tracks.find((track) => track.id !== 'auto-a')
      const voxLabel = vox?.name || vox?.id || ''
      const monitorDefault = vox != null && !vox.monitorInput && !vox.armed
      const recordDisabled = await js<boolean>(`document.querySelector('.record-button').disabled`)
      await press(`button[aria-label="${voxLabel} record arm"]`)
      current = await until((s) => s.tracks.some((track) => track.id === vox?.id && track.armed))
      await choose('select[aria-label="Record from"]', 'virtual')
      answer(recordFolder)
      await press('.record-panel button', 'Choose folder')
      current = await until((s) => s.record.virtualInput.enabled && path.resolve(s.record.folder) === path.resolve(recordFolder))
      const panel = await js<{ input: string, mode: string, monitor: string }>(`(() => {
        const box = document.querySelector('.record-track')
        return { input: box?.querySelector('select[aria-label$="record input"]')?.value ?? '', mode: box?.querySelector('select[aria-label$="record mode"]')?.value ?? '', monitor: box?.querySelector('button')?.textContent?.trim() ?? '' }
      })()`)
      record('record arm, input routing and monitoring controls', monitorDefault && recordDisabled && current.tracks.some((t) => t.id === vox?.id && t.armed) && current.record.virtualInput.enabled
        && panel.input === '1' && panel.mode === 'dry' && panel.monitor === 'Monitor off',
        `monitoring off by default ${monitorDefault}, Record disabled before arming ${recordDisabled}, input ${panel.input}, mode ${panel.mode}, "${panel.monitor}", folder ${current.record.folder}`)

      if (!current.deviceOpen) {
        checks.push({ scenario: 'record a take from the test signal through the Record button', result: 'NOT RUN', detail: 'no audio output device is open, so the audio callback that records does not run' })
      } else {
        await press('.transport button', 'Record')
        const during = await until((s) => s.record.state === 'recording')
        await wait(1300)
        const ui = await js<{ status: string, play: boolean, seek: boolean }>(`({ status: document.querySelector('.rec-status')?.textContent ?? '', play: Array.from(document.querySelectorAll('.transport button')).find((b) => b.textContent === 'Play').disabled, seek: document.querySelector('input[aria-label="Seek"]').disabled })`)
        await shot('05-recording')
        await press('.transport button', 'Stop rec')
        current = await until((s) => s.record.state === 'idle' && (s.tracks.find((t) => t.id === vox?.id)?.clips.length ?? 0) === 1, 10000)
        const take = current.record.lastTake
        const file = take?.takes[0]
        let mismatches = file == null ? 1 : 0
        let frames = 0
        if (file != null && fs.existsSync(file.path)) {
          const wav = readWav(file.path)
          frames = wav.left.length
          const vi = current.record.virtualInput
          for (let k = 0; k < wav.left.length; k++) {
            if (Math.abs(wav.left[k] - virtualSample(vi.frequency, vi.level, wav.rate, take!.startSamples + k, 0)) > 1e-6)
              mismatches++
          }
        }
        const partials = fs.existsSync(recordFolder) ? fs.readdirSync(recordFolder).filter((name) => name.endsWith('.part')) : ['missing folder']
        const banner = await js<string>(`document.querySelector('.banner')?.textContent ?? ''`)
        const clip = current.tracks.find((t) => t.id === vox?.id)?.clips[0]
        record('record a take from the test signal through the Record button', during.record.state === 'recording' && ui.status.includes('REC') && ui.play && ui.seek
          && file != null && file.channels === 1 && frames > current.sampleRate && mismatches === 0 && partials.length === 0 && clip != null && Math.abs(clip.timelineStart - take!.startSamples / current.sampleRate) < 1e-9
          && banner.includes('Recorded'),
          `status "${ui.status}", Play disabled ${ui.play}, seek disabled ${ui.seek}; ${frames} frames, ${mismatches} samples differ from the test signal, partial files ${partials.length}; clip at ${clip?.timelineStart ?? -1} s; banner "${banner.slice(0, 90)}"`)
        await shot('06-take-placed')
      }

      answer(projectPath)
      await press('.devices button', 'Save project')
      await wait(800)
      current = await state()
      fs.writeFileSync(savedStatePath, JSON.stringify(current, null, 2))
      const saved = fs.existsSync(projectPath) ? JSON.parse(fs.readFileSync(projectPath, 'utf8')) as { version?: number } : {}
      await exportTo(exportBuild, rate)
      record('save project through the Save project button', saved.version === 5, `${projectPath} version ${saved.version ?? 'missing'}`)
    } else {
      const before = JSON.parse(fs.readFileSync(savedStatePath, 'utf8')) as State
      for (const track of (await state()).tracks)
        await engine.request('removeTrack', { trackId: track.id })
      await reloadPage()
      answer(projectPath)
      await press('.devices button', 'Load project')
      const current = await until((s) => s.tracks.length === before.tracks.length, 15000)
      const sameLanes = (a: Lane[], b: Lane[]): boolean => lanesText(a) === lanesText(b)
      const lanesOk = before.tracks.every((track) => sameLanes(track.automation, current.tracks.find((t) => t.id === track.id)?.automation ?? []))
        && sameLanes(before.masterAutomation, current.masterAutomation)
      record('automation lanes, points and enable states restored', lanesOk, current.tracks.map((t) => `${t.name}: ${lanesText(t.automation)}`).join(' | '))
      const recordOk = before.tracks.every((track) => {
        const now = current.tracks.find((t) => t.id === track.id)
        return now != null && now.armed === track.armed && now.recordInput === track.recordInput && now.recordMode === track.recordMode && now.monitorInput === track.monitorInput
          && now.clips.length === track.clips.length && now.clips.every((clip, i) => Math.abs(clip.timelineStart - track.clips[i].timelineStart) < 1e-9)
      })
      record('record configuration and recorded clip references restored', recordOk,
        current.tracks.map((t) => `${t.name}: armed ${t.armed} input ${t.recordInput} mode ${t.recordMode} monitor ${t.monitorInput}, ${t.clips.length} clip(s)`).join(' | '))
      const rate = current.sampleRate || fixtureRate
      const after = await exportTo(path.join(outDir, 'export-reload.wav'), rate)
      const reference = fs.existsSync(exportBuild) ? readWav(exportBuild) : null
      let diff = after == null || reference == null || after.left.length !== reference.left.length ? 1 : 0
      for (let i = 0; after != null && reference != null && i < Math.min(after.left.length, reference.left.length); i++)
        diff = Math.max(diff, Math.abs(after.left[i] - reference.left[i]), Math.abs(after.right[i] - reference.right[i]))
      record('export after reload equals export before save', diff < 1e-6, `max diff ${diff.toExponential(2)} over ${after?.left.length ?? 0} frames`)
      await press('button[aria-label="Auto A automation lane"]')
      await wait(300)
      const option = await js<string>(`Array.from(document.querySelectorAll('.auto-header select[aria-label$="parameter"] option')).map((o) => o.textContent).join('|')`)
      record('reloaded lanes show as automated in the editor', option.includes('● Volume') && option.includes('● 1. EQ Output'), option)
      await shot('07-reloaded')
    }
  } catch (error) {
    record('automation check run', false, error instanceof Error ? error.stack ?? error.message : String(error))
  }

  checks.push({ scenario: 'record from a real microphone', result: 'NOT RUN', detail: 'NOT RUN — NO HARDWARE: no microphone is connected; recording was tested with the virtual test signal only' })
  fs.writeFileSync(path.join(outDir, `${phase}-results.json`), JSON.stringify({ checks }, null, 2))
  for (const check of checks)
    console.log(`${check.result} ${check.scenario} — ${check.detail}`)
  return checks.every((check) => check.result !== 'FAIL') ? 0 : 1
}
