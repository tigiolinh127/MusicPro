import type { BrowserWindow } from 'electron'
import fs from 'fs'
import path from 'path'
import type { EngineHost } from './engineHost'
import type { EngineEvent } from './protocol'
import { readWav, writeWav24 } from './workflowCheck'

interface Effect { id: string, type: string, enabled: boolean, params: Record<string, number> }
interface Send { bus: string, level: number, preFader: boolean }
interface Track { id: string, name: string, gain: number, pan: number, mute: boolean, solo: boolean, output: string, sends: Send[], effects: Effect[] }
interface Bus { id: string, name: string, kind: 'group' | 'return', gain: number, mute: boolean, solo: boolean, output: string, effects: Effect[] }
interface RenderTail { enabled: boolean, maxSeconds: number, thresholdDb: number }
interface State { tracks: Track[], buses: Bus[], masterEffects: Effect[], masterGain: number, deviceOpen: boolean, transport: string, renderTail?: RenderTail }
interface Check { scenario: string, result: 'PASS' | 'FAIL' | 'NOT RUN', detail: string }
interface Stereo { l: number, r: number }

export interface FxCheckOptions {
  outDir: string
  phase: 'build' | 'reload'
  answer: (filePath: string) => void
}

const rate = 48000
const seconds = 6
const impulseAt = rate
const probe = rate * 3

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function db(value: number): number {
  return 20 * Math.log10(value)
}

// Steady-state response of an insert chain to a constant (DC) input, written independently of
// the engine from the documented effect behaviour. Reverb is only modelled for silent input.
function chainDc(chain: Effect[], input: Stereo): Stereo & { exact: boolean } {
  let { l, r } = input
  let exact = true
  for (const effect of chain) {
    if (!effect.enabled)
      continue
    const p = effect.params
    if (effect.type === 'eq') {
      let gain = Math.pow(10, p.outputGain / 20)
      for (let band = 1; band <= 4; band++) {
        if (Math.round(p[`band${band}Type`]) === 0)
          gain *= Math.pow(10, p[`band${band}Gain`] / 20)   // a low shelf passes DC at its full gain; bells and high shelves at 0 dB
      }
      l *= gain
      r *= gain
    } else if (effect.type === 'compressor') {
      const level = Math.max(Math.abs(l), Math.abs(r))
      const over = (level > 1e-9 ? db(level) : -180) - p.threshold
      const slope = 1 - 1 / Math.max(1, p.ratio)
      const knee = Math.max(0, p.knee ?? 0)
      let reduction = 0
      if (knee <= 1e-9) {
        reduction = over > 0 ? over * slope : 0
      } else {
        const half = knee * 0.5
        if (over > -half) {
          if (over >= half)
            reduction = over * slope
          else {
            const x = over + half
            reduction = slope * x * x / (2 * knee)
          }
        }
      }
      const gain = Math.pow(10, (p.makeup - reduction) / 20)
      l *= gain
      r *= gain
    } else if (effect.type === 'limiter') {
      const level = Math.max(Math.abs(l), Math.abs(r))
      const ceiling = Math.pow(10, Math.min(0, p.ceiling ?? -0.3) / 20)
      const gain = level > ceiling && level > 1e-12 ? ceiling / level : 1
      l *= gain
      r *= gain
    } else if (effect.type === 'gate') {
      const level = Math.max(Math.abs(l), Math.abs(r))
      const gain = level >= Math.pow(10, p.threshold / 20) ? 1 : Math.pow(10, p.range / 20)
      l *= gain
      r *= gain
    } else if (effect.type === 'delay') {
      const gain = (1 - p.mix) + p.mix / (1 - p.feedback)
      l *= gain
      r *= gain
    } else if (effect.type === 'reverb') {
      exact = exact && l === 0 && r === 0
    }
  }
  return { l, r, exact }
}

function modelDc(state: State, dc: (trackId: string) => number): Stereo & { exact: boolean } {
  const byId = new Map(state.buses.map((bus) => [bus.id, bus]))
  const inputs = new Map<string, Stereo>()
  let exact = true
  const add = (id: string, l: number, r: number): void => {
    const slot = inputs.get(id) ?? { l: 0, r: 0 }
    slot.l += l
    slot.r += r
    inputs.set(id, slot)
  }
  for (const track of state.tracks) {
    const v = dc(track.id)
    const inserted = chainDc(track.effects, { l: v, r: v })
    exact = exact && inserted.exact
    const angle = (Math.max(-1, Math.min(1, track.pan)) + 1) * Math.PI / 4
    const pl = Math.cos(angle)
    const pr = Math.sin(angle)
    const dest = byId.get(track.output)?.kind === 'group' ? track.output : 'master'
    const audible = !track.mute
    add(dest, audible ? inserted.l * track.gain * pl : 0, audible ? inserted.r * track.gain * pr : 0)
    for (const send of track.sends) {
      if (byId.get(send.bus)?.kind !== 'return' || track.mute)
        continue
      add(send.bus, send.preFader ? inserted.l * send.level : inserted.l * send.level * track.gain * pl,
        send.preFader ? inserted.r * send.level : inserted.r * send.level * track.gain * pr)
    }
  }
  const busOut = (id: string, depth: number): Stereo => {
    const bus = byId.get(id)!
    const sum = { ...(inputs.get(id) ?? { l: 0, r: 0 }) }
    if (depth < 64) {
      for (const other of state.buses) {
        if (other.output === id) {
          const out = busOut(other.id, depth + 1)
          sum.l += out.l
          sum.r += out.r
        }
      }
    }
    const processed = chainDc(bus.effects, sum)
    exact = exact && processed.exact
    const gain = bus.mute ? 0 : bus.gain
    return { l: processed.l * gain, r: processed.r * gain }
  }
  const master = { ...(inputs.get('master') ?? { l: 0, r: 0 }) }
  for (const bus of state.buses) {
    if (bus.output === 'master') {
      const out = busOut(bus.id, 0)
      master.l += out.l
      master.r += out.r
    }
  }
  const processed = chainDc(state.masterEffects, master)
  return { l: processed.l * state.masterGain, r: processed.r * state.masterGain, exact: exact && processed.exact }
}

function describeEffects(chain: Effect[]): string {
  return chain.map((e) => `${e.id}:${e.type}${e.enabled ? '' : '(off)'}{${Object.keys(e.params).sort().map((k) => `${k}=${e.params[k].toFixed(4)}`).join(',')}}`).join(' > ')
}

function describe(s: State): string {
  const tracks = s.tracks.map((t) => `${t.name}->${t.output} g${t.gain.toFixed(3)} [${t.sends.map((x) => `${x.bus}:${x.level.toFixed(3)}`).join(',')}] fx[${describeEffects(t.effects)}]`)
  const buses = s.buses.map((b) => `${b.name}(${b.kind})->${b.output} fx[${describeEffects(b.effects)}]`)
  return `${tracks.join('; ')} | ${buses.join('; ')} | master fx[${describeEffects(s.masterEffects)}]`
}

export async function runFxCheck(win: BrowserWindow, engine: EngineHost, options: FxCheckOptions): Promise<number> {
  const { outDir, phase, answer } = options
  fs.mkdirSync(outDir, { recursive: true })
  const web = win.webContents
  const checks: Check[] = []
  const fixtures = [path.join(outDir, 'dc-04.wav'), path.join(outDir, 'dc-02.wav'), path.join(outDir, 'impulse.wav')]
  const dcValues = [0.4, 0.2, 0]
  const projectPath = path.join(outDir, 'effects.msp.json')
  const savedStatePath = path.join(outDir, 'build-state.json')
  const exportPath = path.join(outDir, `${phase}-export.wav`)
  const playbackPath = path.join(outDir, `${phase}-playback.wav`)
  let lastMeter: EngineEvent | null = null
  const previousHandler = engine.onEvent
  engine.onEvent = (event: EngineEvent) => {
    if (event.event === 'meter')
      lastMeter = event
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
    return (await engine.request('getState')).result as State
  }
  async function until(predicate: (current: State) => boolean, timeoutMs = 5000): Promise<State> {
    const started = Date.now()
    let current = await state()
    while (!predicate(current) && Date.now() - started < timeoutMs) {
      await wait(100)
      current = await state()
    }
    await wait(200)
    return current
  }
  function mouse(type: 'mouseDown' | 'mouseUp' | 'mouseMove', x: number, y: number, held = false): void {
    web.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, modifiers: held ? ['leftButtonDown'] : [] })
  }
  async function click(x: number, y: number): Promise<void> {
    mouse('mouseMove', x, y)
    await wait(30)
    mouse('mouseDown', x, y)
    await wait(40)
    mouse('mouseUp', x, y)
    await wait(250)
  }
  async function drag(x0: number, y0: number, x1: number, y1: number): Promise<void> {
    mouse('mouseMove', x0, y0)
    await wait(30)
    mouse('mouseDown', x0, y0)
    await wait(60)
    const steps = Math.max(10, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 3))
    for (let step = 1; step <= steps; step++) {
      mouse('mouseMove', x0 + (x1 - x0) * step / steps, y0 + (y1 - y0) * step / steps, true)
      await wait(15)
    }
    mouse('mouseUp', x1, y1)
    await wait(400)
  }
  async function typeKey(keyCode: string): Promise<void> {
    web.sendInputEvent({ type: 'keyDown', keyCode })
    web.sendInputEvent({ type: 'char', keyCode })
    await wait(20)
    web.sendInputEvent({ type: 'keyUp', keyCode })
    await wait(300)
  }
  async function rect(selector: string): Promise<{ x: number, y: number, left: number, top: number, width: number, height: number, bottom: number, right: number } | null> {
    return await js(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)})
      if (element == null)
        return null
      element.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      const r = element.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left, top: r.top, width: r.width, height: r.height, bottom: r.bottom, right: r.right }
    })()`)
  }
  async function clickSelector(selector: string): Promise<boolean> {
    const r = await rect(selector)
    if (r == null)
      return false
    await click(r.x, r.y)
    return true
  }
  async function pressButton(text: string): Promise<boolean> {
    const point = await js<{ x: number, y: number } | null>(`(() => {
      const button = Array.from(document.querySelectorAll('button')).find((item) => item.textContent.trim() === ${JSON.stringify(text)})
      if (button == null || button.disabled)
        return null
      button.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      const r = button.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    })()`)
    if (point == null)
      return false
    await click(point.x, point.y)
    return true
  }
  async function dragHorizontal(selector: string, fraction: number): Promise<boolean> {
    const r = await rect(selector)
    if (r == null)
      return false
    const value = await js<{ v: number, min: number, max: number }>(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); return { v: Number(e.value), min: Number(e.min), max: Number(e.max) } })()`)
    const thumb = 16
    const xFor = (f: number): number => r.left + thumb / 2 + f * (r.width - thumb)
    await drag(xFor((value.v - value.min) / (value.max - value.min)), r.y, xFor(fraction), r.y)
    return true
  }
  async function focusAndArrow(selector: string, key: 'Down' | 'Up' = 'Down'): Promise<void> {
    await js(`document.querySelector(${JSON.stringify(selector)}).focus()`)
    await wait(100)
    web.sendInputEvent({ type: 'keyDown', keyCode: key })
    await wait(20)
    web.sendInputEvent({ type: 'keyUp', keyCode: key })
    await wait(300)
  }
  // Adds an effect with the rack's "Add effect" list by typing the first letter of its name.
  async function addEffect(letter: string): Promise<void> {
    await js(`document.querySelector('.fx-head select').focus()`)
    await wait(1200)   // let the select's type-ahead buffer expire so this letter starts a new search
    await typeKey(letter)
  }
  async function reloadPage(): Promise<void> {
    web.reload()
    await new Promise<void>((resolve) => web.once('did-finish-load', () => resolve()))
    await wait(1000)
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
  async function rackLayout(): Promise<{ header: string, cards: number, problems: string[], visible: boolean, listScrolls: boolean, stripProblems: string[] }> {
    return await js(`(() => {
      const rack = document.querySelector('.fx-rack')
      if (rack == null)
        return { header: '', cards: 0, problems: ['no rack'], visible: false, listScrolls: false, stripProblems: [] }
      const r = rack.getBoundingClientRect()
      const master = document.querySelector('.strip.master').getBoundingClientRect()
      const problems = []
      for (const element of rack.querySelectorAll('button, input, select, output')) {
        const e = element.getBoundingClientRect()
        const label = element.getAttribute('aria-label') || element.textContent.trim()
        if (e.width < 8 || e.height < 8)
          problems.push(label + ' is too small (' + e.width.toFixed(0) + 'x' + e.height.toFixed(0) + ')')
        if (e.left < r.left - 0.5 || e.right > r.right + 0.5)
          problems.push(label + ' is clipped horizontally')
        if (element.tagName === 'OUTPUT' && element.scrollWidth > element.clientWidth + 1)
          problems.push(label + ' text truncated: ' + element.textContent)
      }
      const list = rack.querySelector('.fx-list')
      const stripProblems = []
      for (const strip of document.querySelectorAll('.mixer .strip')) {
        const s = strip.getBoundingClientRect()
        if (strip.scrollHeight > strip.clientHeight + 1)
          stripProblems.push(strip.getAttribute('aria-label') + ' overflows')
        for (const element of strip.querySelectorAll('button, input, select')) {
          const e = element.getBoundingClientRect()
          if (e.left < s.left - 0.5 || e.right > s.right + 0.5 || e.top < s.top - 0.5 || e.bottom > s.bottom + 0.5)
            stripProblems.push((element.getAttribute('aria-label') || element.textContent.trim()) + ' clipped by its strip')
        }
      }
      return {
        header: rack.querySelector('.fx-head h2').textContent,
        cards: rack.querySelectorAll('.fx-card').length,
        problems,
        visible: r.left >= master.right - 0.5 && r.right <= window.innerWidth + 0.5 && r.width >= 280 && r.height >= 200,
        listScrolls: list.scrollHeight > list.clientHeight + 1,
        stripProblems
      }
    })()`)
  }
  // Scrolls the effect list to the bottom and confirms the last control is inside the visible list.
  async function lastControlReachable(): Promise<boolean> {
    return await js(`(() => {
      const list = document.querySelector('.fx-list')
      list.scrollTop = list.scrollHeight
      const controls = list.querySelectorAll('input, select, button')
      const last = controls[controls.length - 1].getBoundingClientRect()
      const box = list.getBoundingClientRect()
      return last.bottom <= box.bottom + 0.5 && last.top >= box.top - 0.5
    })()`)
  }
  async function exportWav(file: string): Promise<{ left: Float32Array, right: Float32Array } | null> {
    if (fs.existsSync(file))
      fs.rmSync(file)
    answer(file)
    await pressButton('Export WAV')
    if (!await waitForFile(file))
      return null
    const wav = readWav(file)
    return wav.rate === rate ? wav : null
  }
  async function exportAndModel(label: string, file = exportPath): Promise<{ left: Float32Array, right: Float32Array } | null> {
    const wav = await exportWav(file)
    if (wav == null) {
      record(`${label}: export through the Export WAV button`, false, 'no file written')
      return null
    }
    const current = await state()
    const dc = (id: string): number => dcValues[Math.max(0, current.tracks.findIndex((t) => t.id === id))] ?? 0
    const expected = modelDc(current, dc)
    const ok = expected.exact && Math.abs(wav.left[probe] - expected.l) < 3e-4 && Math.abs(wav.right[probe] - expected.r) < 3e-4
    record(`${label}: exported WAV matches the effect model`, ok,
      `frame ${probe}: L ${wav.left[probe]?.toFixed(5)} R ${wav.right[probe]?.toFixed(5)}, model L ${expected.l.toFixed(5)} R ${expected.r.toFixed(5)}${expected.exact ? '' : ' (model not exact)'}`)
    const response = await engine.request('renderPlayback', { path: playbackPath }, 20000)
    if (response.ok) {
      const played = readWav(playbackPath)
      let worst = played.left.length === wav.left.length ? 0 : Number.POSITIVE_INFINITY
      for (let i = 0; i < played.left.length && i < wav.left.length; i++)
        worst = Math.max(worst, Math.abs(played.left[i] - wav.left[i]), Math.abs(played.right[i] - wav.right[i]))
      record(`${label}: realtime playback path equals export`, worst < 1e-6, `worst sample difference ${worst.toExponential(2)}`)
    } else {
      record(`${label}: realtime playback path equals export`, false, response.error ?? 'renderPlayback failed')
    }
    return wav
  }
  const card = (index: number, inner = ''): string => `.fx-list > .fx-card:nth-of-type(${index + 1})${inner === '' ? '' : ' ' + inner}`
  const param = (index: number, suffix: string): string => card(index, `input[aria-label$=" ${suffix}"]`)
  const fxButton = (owner: string): string => `button[aria-label^=${JSON.stringify(`${owner} effects (`)}]`
  async function valueText(selector: string): Promise<string> {
    return await js<string>(`document.querySelector(${JSON.stringify(selector)})?.getAttribute('aria-valuetext') ?? ''`)
  }

  try {
    win.setMaximizable(false)
    if (win.isMaximized())
      win.unmaximize()
    win.setSize(1280, 820)
    win.show()
    await wait(600)

    if (phase === 'build') {
      writeWav24(fixtures[0], rate, rate * seconds, () => 0.4, () => 0.4)
      writeWav24(fixtures[1], rate, rate * seconds, () => 0.2, () => 0.2)
      writeWav24(fixtures[2], rate, rate * seconds, (i) => i === impulseAt ? 0.5 : 0, (i) => i === impulseAt ? 0.5 : 0)
      const initial = await state()
      for (const track of initial.tracks)
        await engine.request('removeTrack', { trackId: track.id })
      for (const bus of initial.buses ?? [])
        await engine.request('removeBus', { busId: bus.id })
      for (const effect of initial.masterEffects ?? [])
        await engine.request('removeEffect', { effectId: effect.id })
      for (let i = 0; i < 3; i++)
        await engine.request('importTrack', { trackId: `fx-${i}`, path: fixtures[i] }, 20000)
      await reloadPage()
      await pressButton('Mixer')
      await wait(500)
      let current = await state()
      const name1 = current.tracks[0].name || current.tracks[0].id

      let layout = await rackLayout()
      record('mixer shows the effect rack beside the master strip (Master selected, empty chain)', layout.visible && layout.header === 'FX · Master' && layout.cards === 0 && layout.problems.length === 0 && layout.stripProblems.length === 0,
        `header "${layout.header}", cards ${layout.cards}, visible ${layout.visible}${layout.problems.length + layout.stripProblems.length > 0 ? ', problems: ' + [...layout.problems, ...layout.stripProblems].slice(0, 5).join('; ') : ''}`)

      await clickSelector(fxButton(name1))
      await wait(300)
      layout = await rackLayout()
      const highlighted = await js<boolean>(`document.querySelector('.mixer-scroll .strip:not(.bus)').classList.contains('selected')`)
      record('FX button on a track strip selects it and shows its rack', layout.header === `FX · ${name1}` && highlighted, `header "${layout.header}", strip highlighted ${highlighted}`)

      await addEffect('E')
      current = await until((s) => s.tracks[0].effects.length === 1)
      await addEffect('C')
      current = await until((s) => s.tracks[0].effects.length === 2)
      record('add EQ and compressor with the rack Add effect list', current.tracks[0].effects.map((e) => e.type).join(',') === 'eq,compressor' && (await rackLayout()).cards === 2,
        `track 1 chain: ${current.tracks[0].effects.map((e) => e.type).join(' > ')}`)
      const [eqId, compId] = current.tracks[0].effects.map((e) => e.id)

      await dragHorizontal(param(0, 'band 1 Gain'), 0.625)
      current = await until((s) => Math.abs(s.tracks[0].effects[0].params.band1Gain) > 0.5)
      const eqGain = current.tracks[0].effects[0].params.band1Gain
      const eqText = await valueText(param(0, 'band 1 Gain'))
      record('drag EQ band 1 gain; engine value and readout agree', Math.abs(eqGain - 6) < 1.5 && eqText === `${eqGain > 0 ? '+' : ''}${eqGain.toFixed(1)} dB`, `band1Gain ${eqGain} dB, readout "${eqText}"`)

      await dragHorizontal(param(1, 'Threshold'), 0.5)
      current = await until((s) => Math.abs(s.tracks[0].effects[1].params.threshold + 18) > 1)
      const threshold = current.tracks[0].effects[1].params.threshold
      record('drag compressor threshold', Math.abs(threshold + 30) < 3, `threshold ${threshold} dB, readout "${await valueText(param(1, 'Threshold'))}"`)

      await clickSelector(card(1, 'button[aria-label^="Move "][aria-label$=" up"]'))
      current = await until((s) => s.tracks[0].effects[0].id === compId)
      const upOrder = current.tracks[0].effects.map((e) => e.type).join(',')
      await shot('fx-reordered')
      await clickSelector(card(0, 'button[aria-label^="Move "][aria-label$=" down"]'))
      current = await until((s) => s.tracks[0].effects[0].id === eqId)
      record('reorder with the ↑ and ↓ buttons', upOrder === 'compressor,eq' && current.tracks[0].effects.map((e) => e.type).join(',') === 'eq,compressor', `after ↑ ${upOrder}, after ↓ ${current.tracks[0].effects.map((e) => e.type).join(',')}`)
      await shot('fx-track-rack')

      win.setSize(960, 700)
      await wait(700)
      layout = await rackLayout()
      const reachable = await lastControlReachable()
      await shot('fx-rack-min-window')
      record('960x700 minimum window: rack and strips have no clipped controls; long chains scroll inside the rack', layout.visible && layout.problems.length === 0 && layout.stripProblems.length === 0 && layout.listScrolls && reachable,
        `visible ${layout.visible}, list scrolls ${layout.listScrolls}, last control reachable ${reachable}${layout.problems.length + layout.stripProblems.length > 0 ? ', problems: ' + [...layout.problems, ...layout.stripProblems].slice(0, 5).join('; ') : ''}`)
      win.setSize(1280, 820)
      await wait(500)

      await exportAndModel('track inserts EQ > compressor')
      await clickSelector(card(1, '.fx-power'))
      current = await until((s) => !s.tracks[0].effects[1].enabled)
      const bypassText = await js<string>(`document.querySelector(${JSON.stringify(card(1, '.fx-power'))}).textContent`)
      record('compressor On/Off button bypasses it', !current.tracks[0].effects[1].enabled && bypassText === 'Off', `enabled ${current.tracks[0].effects[1].enabled}, button "${bypassText}"`)
      await exportAndModel('compressor bypassed')
      await clickSelector(card(1, '.fx-power'))
      current = await until((s) => s.tracks[0].effects[1].enabled)
      await clickSelector(card(0, 'button[aria-label^="Remove "]'))
      current = await until((s) => s.tracks[0].effects.length === 1)
      record('remove the EQ with its ✕ button', current.tracks[0].effects.map((e) => e.id).join(',') === compId, `chain ${current.tracks[0].effects.map((e) => e.type).join(',')}`)
      await exportAndModel('EQ removed, compressor re-enabled')

      // Group bus insert: track 2 -> Group 1 with a noise gate whose threshold is above the signal.
      await pressButton('Add group bus')
      current = await until((s) => s.buses.length === 1)
      const group = current.buses[0]
      await focusAndArrow('.mixer-scroll .strip:not(.bus):nth-child(2) select')
      current = await until((s) => s.tracks[1].output === group.id)
      await clickSelector(fxButton(group.name))
      await wait(300)
      await addEffect('N')
      current = await until((s) => s.buses[0].effects.length === 1)
      await dragHorizontal(param(0, 'Threshold'), 0.875)
      current = await until((s) => s.buses[0].effects[0].params.threshold > -20)
      layout = await rackLayout()
      record('group bus rack: add a noise gate and raise its threshold', current.tracks[1].output === group.id && current.buses[0].effects[0]?.type === 'gate' && layout.header === `FX · ${group.name}`,
        `track 2 -> ${current.tracks[1].output}, gate threshold ${current.buses[0].effects[0]?.params.threshold} dB, header "${layout.header}"`)
      await shot('fx-group-rack')
      await exportAndModel('group bus gate closes on the quieter track')

      // Return bus via a send: impulse track -> Return 1 with a 100 % wet reverb.
      await pressButton('Add return bus')
      current = await until((s) => s.buses.length === 2)
      const ret = current.buses[1]
      await dragHorizontal('.mixer-scroll .strip:not(.bus):nth-child(3) .send-row input', 60 / 72)
      current = await until((s) => (s.tracks[2].sends[0]?.level ?? 0) > 0.5)
      await clickSelector(fxButton(ret.name))
      await wait(300)
      await addEffect('R')
      current = await until((s) => s.buses[1].effects.length === 1)
      await dragHorizontal(param(0, 'Wet/dry'), 1)
      current = await until((s) => s.buses[1].effects[0].params.mix > 0.9)
      const withReverb = await exportAndModel('return bus reverb fed by a send')
      await clickSelector(card(0, '.fx-power'))
      current = await until((s) => !s.buses[1].effects[0].enabled)
      const withoutReverb = await exportWav(path.join(outDir, 'build-reverb-bypassed.wav'))
      await clickSelector(card(0, '.fx-power'))
      current = await until((s) => s.buses[1].effects[0].enabled)
      if (withReverb != null && withoutReverb != null) {
        let before = 0
        let tail = 0
        for (let i = 0; i < impulseAt; i++)
          before = Math.max(before, Math.abs(withReverb.left[i] - withoutReverb.left[i]))
        for (let i = impulseAt + 2400; i < impulseAt + 24000; i++)
          tail += (withReverb.left[i] - withoutReverb.left[i]) ** 2
        tail = Math.sqrt(tail / 21600)
        record('reverb adds a decaying tail after the impulse and nothing before it', before === 0 && tail > 1e-4, `difference before impulse ${before}, tail RMS 50-500 ms after ${tail.toExponential(2)}`)
      } else {
        record('reverb adds a decaying tail after the impulse and nothing before it', false, 'exports missing')
      }

      // Master insert: a delay, checked sample by sample against y_out(t) = (1 - m) y(t) + m y(t - T).
      await clickSelector('.strip.master .fx-button')
      await wait(300)
      await addEffect('D')
      current = await until((s) => s.masterEffects.length === 1)
      await dragHorizontal(param(0, 'Feedback'), 0)
      await dragHorizontal(param(0, 'Wet/dry'), 0.5)
      await dragHorizontal(param(0, 'Time'), Math.log(500) / Math.log(2000))
      current = await until((s) => s.masterEffects[0].params.feedback === 0 && Math.abs(s.masterEffects[0].params.mix - 0.5) < 0.1 && s.masterEffects[0].params.time !== 250)
      const delay = current.masterEffects[0].params
      layout = await rackLayout()
      await shot('fx-master-rack')
      const delayed = await exportAndModel('master delay')
      await clickSelector(card(0, '.fx-power'))
      await until((s) => !s.masterEffects[0].enabled)
      const dry = await exportWav(path.join(outDir, 'build-delay-bypassed.wav'))
      await clickSelector(card(0, '.fx-power'))
      current = await until((s) => s.masterEffects[0].enabled)
      const delaySamples = delay.time * rate / 1000
      if (delayed != null && dry != null && Number.isInteger(delaySamples)) {
        let worst = 0
        for (let i = 0; i < dry.left.length && i < delayed.left.length; i++) {
          const expected = (1 - delay.mix) * dry.left[i] + delay.mix * (i >= delaySamples ? dry.left[i - delaySamples] : 0)
          worst = Math.max(worst, Math.abs(delayed.left[i] - expected))
        }
        record('master delay: echo lands exactly at the set time with the set mix', layout.header === 'FX · Master' && worst < 2e-4 && delay.time > 300,
          `time ${delay.time} ms (${delaySamples} samples), mix ${delay.mix}, feedback ${delay.feedback}, worst deviation ${worst.toExponential(2)}`)
      } else {
        record('master delay: echo lands exactly at the set time with the set mix', false, `time ${delay.time} ms is not a whole number of samples, or exports missing`)
      }
      fs.copyFileSync(exportPath, path.join(outDir, 'build-final-export.wav'))

      // Effect tail controls in the device panel. Master delay feedback makes the tail decay over several seconds.
      {
        const timelineFrames = rate * seconds
        const tailSelect = 'select[aria-label="Effect tail"]'
        const floorSelect = 'select[aria-label="Tail floor"]'
        await dragHorizontal(param(0, 'Feedback'), 0.6 / 0.95)
        const feedback = (await until((s) => Math.abs(s.masterEffects[0].params.feedback - 0.6) < 0.05)).masterEffects[0].params.feedback
        const startTail = (await state()).renderTail
        await js(`document.querySelector(${JSON.stringify(tailSelect)}).focus()`)
        await wait(1200)
        await typeKey('O')
        await until((s) => s.renderTail?.enabled === false)
        const off = await exportWav(path.join(outDir, 'build-tail-off.wav'))
        await focusAndArrow(tailSelect)
        const two = (await until((s) => s.renderTail?.enabled === true && s.renderTail.maxSeconds === 2)).renderTail
        const short = await exportWav(path.join(outDir, 'build-tail-2s.wav'))
        await focusAndArrow(tailSelect)
        await focusAndArrow(tailSelect)
        const ten = (await until((s) => s.renderTail?.maxSeconds === 10)).renderTail
        const full = await exportWav(path.join(outDir, 'build-tail-10s.wav'))
        await shot('fx-tail-controls')
        record('Effect tail control: Off exports exactly the timeline, "Up to 2 s" caps the tail, "Up to 10 s" renders it out',
          off != null && short != null && full != null && startTail?.enabled === true && startTail.maxSeconds === 10 && two?.maxSeconds === 2 && ten?.maxSeconds === 10
            && off.left.length === timelineFrames && short.left.length === timelineFrames + 2 * rate && full.left.length > short.left.length && full.left.length < timelineFrames + 10 * rate,
          `delay feedback ${feedback.toFixed(2)}; timeline ${timelineFrames} frames; off ${off?.left.length}, 2 s ${short?.left.length}, 10 s ${full?.left.length}`)
        await focusAndArrow(floorSelect, 'Up')
        await focusAndArrow(floorSelect, 'Up')
        const sixty = (await until((s) => s.renderTail?.thresholdDb === -60)).renderTail
        const shorter = await exportWav(path.join(outDir, 'build-tail-60db.wav'))
        await focusAndArrow(floorSelect)
        await focusAndArrow(floorSelect)
        const restored = (await until((s) => s.renderTail?.thresholdDb === -90)).renderTail
        record('Tail floor control: -60 dBFS ends the tail earlier than -90 dBFS',
          shorter != null && full != null && sixty?.thresholdDb === -60 && restored?.thresholdDb === -90 && shorter.left.length > timelineFrames && shorter.left.length < full.left.length,
          `-60 dBFS ${shorter?.left.length} frames, -90 dBFS ${full?.left.length} frames`)
        await dragHorizontal(param(0, 'Feedback'), 0)
        await until((s) => s.masterEffects[0].params.feedback === 0)
      }

      // Live gain-reduction meter on the track 1 compressor.
      current = await state()
      if (current.deviceOpen) {
        await clickSelector(fxButton(name1))
        await wait(300)
        await engine.request('transport', { action: 'seek', position: 0.5 })
        await pressButton('Play')
        await wait(900)
        const shown = await js<string>(`document.querySelector(${JSON.stringify(card(0, '.fx-gr output'))})?.textContent ?? ''`)
        const width = await js<number>(`parseFloat(document.querySelector(${JSON.stringify(card(0, '.fx-gr-bar span'))})?.style.width ?? '0')`)
        const native = (lastMeter as EngineEvent | null)?.effects?.find((m) => m.id === compId)?.reduction ?? 0
        const comp = current.tracks[0].effects[0].params
        const expected = (db(0.4) - comp.threshold) * (1 - 1 / comp.ratio)
        await shot('fx-gain-reduction')
        await pressButton('Stop')
        await wait(1500)
        const after = await js<string>(`document.querySelector(${JSON.stringify(card(0, '.fx-gr output'))})?.textContent ?? ''`)
        const displayed = parseFloat(shown.replace('-', ''))
        record('compressor gain-reduction meter shows the native value during playback and clears after Stop',
          Math.abs(native - expected) < 0.2 && Math.abs(displayed - native) < 0.15 && width > 0 && after === '0.0 dB',
          `display "${shown}" (bar ${width.toFixed(0)} %), native ${native.toFixed(2)} dB, model ${expected.toFixed(2)} dB, after Stop "${after}"`)
      } else {
        record('compressor gain-reduction meter shows the native value during playback and clears after Stop', null, 'no output device open')
      }

      answer(projectPath)
      await pressButton('Save project')
      const saved = await waitForFile(projectPath)
      current = await state()
      fs.writeFileSync(savedStatePath, JSON.stringify(current, null, 2))
      const savedJson = saved ? JSON.parse(fs.readFileSync(projectPath, 'utf8')) as { version: number, masterEffects?: unknown[], buses: Array<{ effects?: unknown[] }>, tracks: Array<{ effects?: unknown[] }> } : null
      record('save project through the Save project button (current schema v5 with effect chains)',
        saved && savedJson?.version === 5 && savedJson.masterEffects?.length === 1 && savedJson.tracks[0].effects?.length === 1 && savedJson.buses.every((b) => b.effects?.length === 1),
        `${projectPath} version ${savedJson?.version}, master ${savedJson?.masterEffects?.length} effect(s)`)
    } else {
      if (!fs.existsSync(projectPath) || !fs.existsSync(savedStatePath)) {
        record('reopen and load the effects project', false, 'run the build phase first')
      } else {
        const saved = JSON.parse(fs.readFileSync(savedStatePath, 'utf8')) as State
        answer(projectPath)
        await pressButton('Load project')
        const current = await until((s) => s.buses.length === saved.buses.length && s.tracks.length === saved.tracks.length && s.masterEffects.length === saved.masterEffects.length, 15000)
        record('reopen app and load: effect chains, order, parameters and bypass states restored', describe(current) === describe(saved), describe(current))
        record('reopen app and load: effect tail settings restored', JSON.stringify(current.renderTail) === JSON.stringify(saved.renderTail) && saved.renderTail != null,
          JSON.stringify(current.renderTail))
        await pressButton('Mixer')
        await wait(600)
        const name1 = current.tracks[0].name || current.tracks[0].id
        await clickSelector(fxButton(name1))
        await wait(300)
        const layout = await rackLayout()
        const comp = current.tracks[0].effects[0]
        const thresholdText = await valueText(param(0, 'Threshold'))
        record('rack shows the restored chain and values', layout.header === `FX · ${name1}` && layout.cards === 1 && thresholdText === `${comp.params.threshold > 0 ? '+' : ''}${comp.params.threshold.toFixed(1)} dB`,
          `header "${layout.header}", cards ${layout.cards}, threshold readout "${thresholdText}"`)
        await shot('fx-reloaded')
        const exported = await exportAndModel('reloaded')
        const firstPath = path.join(outDir, 'build-final-export.wav')
        if (exported != null && fs.existsSync(firstPath)) {
          const first = readWav(firstPath).left
          let worst = first.length === exported.left.length ? 0 : Number.POSITIVE_INFINITY
          for (let i = 0; i < first.length && i < exported.left.length; i++)
            worst = Math.max(worst, Math.abs(first[i] - exported.left[i]))
          record('export after reopening equals the export before closing', worst < 1e-6, `worst ${worst.toExponential(2)}`)
        } else {
          record('export after reopening equals the export before closing', false, 'missing export')
        }
      }
    }
  } catch (error) {
    record('effects check run', false, error instanceof Error ? error.stack ?? error.message : String(error))
  }
  engine.onEvent = previousHandler
  fs.writeFileSync(path.join(outDir, `${phase}-results.json`), JSON.stringify(checks, null, 2))
  return checks.every((check) => check.result !== 'FAIL') ? 0 : 1
}
