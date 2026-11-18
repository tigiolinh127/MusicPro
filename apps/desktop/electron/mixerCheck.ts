import type { BrowserWindow } from 'electron'
import fs from 'fs'
import path from 'path'
import type { EngineHost } from './engineHost'
import type { EngineEvent } from './protocol'
import { readWav, writeWav24 } from './workflowCheck'

interface Send { bus: string, level: number, preFader: boolean }
interface Track { id: string, name: string, gain: number, pan: number, mute: boolean, solo: boolean, output: string, sends: Send[], clips: unknown[] }
interface Bus { id: string, name: string, kind: 'group' | 'return', gain: number, mute: boolean, solo: boolean, output: string }
interface State { tracks: Track[], buses: Bus[], masterGain: number, deviceOpen: boolean, transport: string }
interface Check { scenario: string, result: 'PASS' | 'FAIL' | 'NOT RUN', detail: string }

export interface MixerCheckOptions {
  outDir: string
  phase: 'build' | 'reload'
  answer: (filePath: string) => void
}

const rate = 48000
const seconds = 6
const dcValues = [0.4, 0.2, 0.1]

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Independent model of the routing rules for constant (DC) inputs.
function expectedDc(state: State, dc: (trackId: string) => number): { l: number, r: number } {
  const buses = state.buses
  const byId = new Map(buses.map((bus) => [bus.id, bus]))
  const anySolo = state.tracks.some((t) => t.solo) || buses.some((b) => b.solo)
  const inputs = new Map<string, { l: number, r: number }>()
  const add = (id: string, l: number, r: number): void => {
    const slot = inputs.get(id) ?? { l: 0, r: 0 }
    slot.l += l
    slot.r += r
    inputs.set(id, slot)
  }
  for (const track of state.tracks) {
    const v = dc(track.id)
    let included = track.solo
    let at = track.output
    for (let i = 0; i <= buses.length && !included && at !== 'master'; i++) {
      const bus = byId.get(at)
      if (bus == null)
        break
      included = bus.solo
      at = bus.output
    }
    const audible = !track.mute && (!anySolo || included)
    const angle = (Math.max(-1, Math.min(1, track.pan)) + 1) * Math.PI / 4
    const pl = Math.cos(angle)
    const pr = Math.sin(angle)
    const dest = byId.get(track.output)?.kind === 'group' ? track.output : 'master'
    add(dest, audible ? v * track.gain * pl : 0, audible ? v * track.gain * pr : 0)
    for (const send of track.sends) {
      const bus = byId.get(send.bus)
      if (bus == null || bus.kind !== 'return')
        continue
      const open = !track.mute && (!anySolo || included || bus.solo)
      add(bus.id, open ? (send.preFader ? v * send.level : v * send.level * track.gain * pl) : 0,
        open ? (send.preFader ? v * send.level : v * send.level * track.gain * pr) : 0)
    }
  }
  const busOut = (id: string, depth: number): { l: number, r: number } => {
    const bus = byId.get(id)!
    const sum = { ...(inputs.get(id) ?? { l: 0, r: 0 }) }
    if (depth < 64) {
      for (const other of buses) {
        if (other.output === id) {
          const out = busOut(other.id, depth + 1)
          sum.l += out.l
          sum.r += out.r
        }
      }
    }
    const gain = bus.mute ? 0 : bus.gain
    return { l: sum.l * gain, r: sum.r * gain }
  }
  const master = { ...(inputs.get('master') ?? { l: 0, r: 0 }) }
  for (const bus of buses) {
    if (bus.output === 'master') {
      const out = busOut(bus.id, 0)
      master.l += out.l
      master.r += out.r
    }
  }
  return { l: master.l * state.masterGain, r: master.r * state.masterGain }
}

export async function runMixerCheck(win: BrowserWindow, engine: EngineHost, options: MixerCheckOptions): Promise<number> {
  const { outDir, phase, answer } = options
  fs.mkdirSync(outDir, { recursive: true })
  const web = win.webContents
  const checks: Check[] = []
  const fixtures = dcValues.map((value, i) => path.join(outDir, `dc-${i}.wav`))
  const projectPath = path.join(outDir, 'mixer.msp.json')
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
  async function key(keyCode: string): Promise<void> {
    web.sendInputEvent({ type: 'keyDown', keyCode })
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
  async function pressButton(text: string, scope = 'body'): Promise<boolean> {
    const point = await js<{ x: number, y: number } | null>(`(() => {
      const button = Array.from(document.querySelectorAll(${JSON.stringify(`${scope} button`)})).find((item) => item.textContent.trim() === ${JSON.stringify(text)})
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
  // Moves a vertical fader by dragging from its thumb to the height for `db` (range -60..+12 dB).
  async function dragFader(selector: string, db: number): Promise<string> {
    const r = await rect(selector)
    if (r == null)
      return 'no fader'
    const current = await js<number>(`Number(document.querySelector(${JSON.stringify(selector)}).value)`)
    const thumb = 16
    const yFor = (value: number): number => r.bottom - thumb / 2 - (value + 60) / 72 * (r.height - thumb)
    const hit = await js<string>(`(() => { const e = document.elementFromPoint(${r.x}, ${yFor(current)}); return e == null ? 'none' : e.tagName + '.' + e.className + ' ' + (e.getAttribute('aria-label') ?? '') })()`)
    await js(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); window.__faderLog = []; for (const t of ['pointerdown', 'pointerup', 'input', 'change', 'dblclick', 'click', 'lostpointercapture']) e.addEventListener(t, (ev) => window.__faderLog.push(t + ':' + e.value + (ev.detail ? '/' + ev.detail : ''))) })()`)
    await drag(r.x, yFor(current), r.x, yFor(db))
    const after = await js<number>(`Number(document.querySelector(${JSON.stringify(selector)}).value)`)
    const log = await js<string[]>('window.__faderLog')
    return `start ${current} dB at y ${yFor(current).toFixed(0)} (fader ${r.top.toFixed(0)}-${r.bottom.toFixed(0)}), hit ${hit}, value after ${after}, events ${log.join(' ')}`
  }
  async function dragHorizontal(selector: string, fraction: number): Promise<void> {
    const r = await rect(selector)
    if (r == null)
      return
    const value = await js<{ v: number, min: number, max: number }>(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); return { v: Number(e.value), min: Number(e.min), max: Number(e.max) } })()`)
    const thumb = 16
    const xFor = (f: number): number => r.left + thumb / 2 + f * (r.width - thumb)
    await drag(xFor((value.v - value.min) / (value.max - value.min)), r.y, xFor(fraction), r.y)
  }
  async function focusAndArrow(selector: string, keyCode: 'Down' | 'Up'): Promise<void> {
    await js(`document.querySelector(${JSON.stringify(selector)}).focus()`)
    await wait(100)
    await key(keyCode)
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
  async function mixerLayout(): Promise<{ strips: number, trackStrips: number, problems: string[], scrollWidth: number, clientWidth: number, masterOk: boolean, mixerFits: boolean, faderHeight: number }> {
    return await js(`(() => {
      const strips = Array.from(document.querySelectorAll('.mixer .strip'))
      const problems = []
      for (const strip of strips) {
        const r = strip.getBoundingClientRect()
        const name = strip.getAttribute('aria-label')
        if (strip.scrollHeight > strip.clientHeight + 1)
          problems.push(name + ' overflows vertically by ' + (strip.scrollHeight - strip.clientHeight) + 'px')
        for (const element of strip.querySelectorAll('button, input, select')) {
          const e = element.getBoundingClientRect()
          const label = element.getAttribute('aria-label') || element.textContent.trim()
          if (e.width < 8 || e.height < 8)
            problems.push(label + ' is too small (' + e.width.toFixed(0) + 'x' + e.height.toFixed(0) + ')')
          if (e.left < r.left - 0.5 || e.right > r.right + 0.5 || e.top < r.top - 0.5 || e.bottom > r.bottom + 0.5)
            problems.push(label + ' is clipped by its strip')
        }
        for (const text of strip.querySelectorAll('.db-readout, .strip-kind')) {
          if (text.scrollWidth > text.clientWidth + 1)
            problems.push(name + ' text truncated: ' + text.textContent)
        }
      }
      const scroll = document.querySelector('.mixer-scroll')
      const mixer = document.querySelector('.mixer').getBoundingClientRect()
      const master = document.querySelector('.strip.master').getBoundingClientRect()
      const footer = document.querySelector('footer').getBoundingClientRect()
      const fader = document.querySelector('.mixer .fader input')
      return {
        strips: strips.length,
        trackStrips: document.querySelectorAll('.mixer-scroll .strip:not(.bus)').length,
        problems,
        scrollWidth: scroll.scrollWidth,
        clientWidth: scroll.clientWidth,
        masterOk: master.right <= mixer.right + 0.5 && master.left >= mixer.left && master.width >= 100,
        mixerFits: mixer.bottom <= footer.top + 0.5 && footer.bottom <= window.innerHeight + 0.5,
        faderHeight: fader == null ? 0 : fader.getBoundingClientRect().height
      }
    })()`)
  }
  async function exportAndCompare(label: string): Promise<Float32Array | null> {
    answer(exportPath)
    await pressButton('Export WAV')
    const ok = await waitForFile(exportPath)
    if (!ok) {
      record(`${label}: export through the Export WAV button`, false, 'no file written')
      return null
    }
    const current = await state()
    const wav = readWav(exportPath)
    const dc = (id: string): number => dcValues[Math.min(2, Math.max(0, current.tracks.findIndex((t) => t.id === id)))]
    const expected = expectedDc(current, dc)
    const at = rate * 3
    const okValue = wav.rate === rate && Math.abs(wav.left[at] - expected.l) < 2e-4 && Math.abs(wav.right[at] - expected.r) < 2e-4
    record(`${label}: exported WAV matches the routing shown in the mixer`, okValue,
      `frame ${at}: L ${wav.left[at]?.toFixed(5)} R ${wav.right[at]?.toFixed(5)}, model from engine state L ${expected.l.toFixed(5)} R ${expected.r.toFixed(5)}`)
    const response = await engine.request('renderPlayback', { path: playbackPath }, 20000)
    if (response.ok) {
      const played = readWav(playbackPath)
      let worst = played.left.length === wav.left.length ? 0 : Number.POSITIVE_INFINITY
      for (let i = 0; i < played.left.length && i < wav.left.length; i++)
        worst = Math.max(worst, Math.abs(played.left[i] - wav.left[i]), Math.abs(played.right[i] - wav.right[i]))
      record(`${label}: realtime playback mix equals export`, worst < 1e-6, `worst sample difference ${worst.toExponential(2)}`)
    } else {
      record(`${label}: realtime playback mix equals export`, false, response.error ?? 'renderPlayback failed')
    }
    return wav.left
  }
  function describe(s: State): string {
    const name = (id: string): string => id === 'master' ? 'Master' : s.buses.find((b) => b.id === id)?.name ?? `?${id}`
    const tracks = s.tracks.map((t) => `${t.name}->${name(t.output)} g${t.gain.toFixed(3)} p${t.pan.toFixed(2)}${t.mute ? ' M' : ''}${t.solo ? ' S' : ''} [${t.sends.map((x) => `${name(x.bus)}:${x.level.toFixed(3)}${x.preFader ? 'pre' : 'post'}`).join(',')}]`)
    const buses = s.buses.map((b) => `${b.name}(${b.kind})->${name(b.output)} g${b.gain.toFixed(3)}${b.mute ? ' M' : ''}${b.solo ? ' S' : ''}`)
    return `${tracks.join('; ')} | ${buses.join('; ')} | master ${s.masterGain.toFixed(3)}`
  }

  try {
    win.setMaximizable(false)
    if (win.isMaximized())
      win.unmaximize()
    win.setSize(1280, 820)
    win.show()
    await wait(600)

    if (phase === 'build') {
      dcValues.forEach((value, i) => writeWav24(fixtures[i], rate, rate * seconds, () => value, () => value))
      const initial = await state()
      for (const track of initial.tracks)
        await engine.request('removeTrack', { trackId: track.id })
      for (const bus of initial.buses ?? [])
        await engine.request('removeBus', { busId: bus.id })

      let made = 0
      for (const count of [2, 4, 8, 16]) {
        for (; made < count; made++)
          await engine.request('importTrack', { trackId: `mx-${made}`, path: fixtures[Math.min(2, made)] }, 20000)
        await reloadPage()
        const switched = await pressButton('Mixer')
        await wait(500)
        const layout = await mixerLayout()
        record(`${count} tracks: mixer shows one strip per track with no clipped controls`, switched && layout.trackStrips === count && layout.problems.length === 0 && layout.masterOk && layout.mixerFits && layout.faderHeight >= 100,
          `${layout.trackStrips} track strips, master visible ${layout.masterOk}, fits window ${layout.mixerFits}, fader ${layout.faderHeight.toFixed(0)} px, scroll ${layout.clientWidth}/${layout.scrollWidth}px${layout.problems.length > 0 ? ', problems: ' + layout.problems.slice(0, 5).join('; ') : ''}`)
        await shot(`mixer-${count}-tracks`)
        const back = await pressButton('Editor')
        await wait(500)
        const editor = await js<{ lanes: number, canvas: boolean, mixer: boolean }>(`({ lanes: document.querySelectorAll('.lane-header').length, canvas: document.querySelector('.timeline-canvas') != null, mixer: document.querySelector('.mixer') != null })`)
        record(`${count} tracks: Mixer -> Editor switch keeps the timeline`, back && editor.lanes === count && editor.canvas && !editor.mixer, `${editor.lanes} lanes, timeline ${editor.canvas}`)
      }

      await pressButton('Mixer')
      await wait(400)
      const before = await js<number>(`document.querySelector('.mixer-scroll').scrollLeft`)
      const label = await rect('.mixer-scroll .strip:nth-child(3) .strip-kind')
      if (label != null) {
        mouse('mouseMove', label.x, label.y)
        await wait(50)
        web.sendInputEvent({ type: 'mouseWheel', x: Math.round(label.x), y: Math.round(label.y), deltaX: 0, deltaY: -240, wheelTicksX: 0, wheelTicksY: -2, canScroll: true })
        await wait(500)
      }
      const afterWheel = await js<number>(`document.querySelector('.mixer-scroll').scrollLeft`)
      record('16 tracks: mouse wheel over the strips scrolls the mixer sideways', afterWheel > before, `scrollLeft ${before} -> ${afterWheel}`)
      await js(`document.querySelector('.mixer-scroll').scrollLeft = 0`)
      await wait(200)
      const bar = await js<{ x: number, y: number, thickness: number }>(`(() => {
        const s = document.querySelector('.mixer-scroll')
        const r = s.getBoundingClientRect()
        const thickness = s.offsetHeight - s.clientHeight
        return { x: r.left + 40, y: r.bottom - Math.max(thickness, 4) / 2, thickness }
      })()`)
      if (bar.thickness > 0) {
        await drag(bar.x, bar.y, bar.x + 200, bar.y)
        const afterDrag = await js<number>(`document.querySelector('.mixer-scroll').scrollLeft`)
        record('16 tracks: drag the mixer scrollbar', afterDrag > 50, `scrollLeft 0 -> ${afterDrag}`)
      } else {
        record('16 tracks: drag the mixer scrollbar', null, 'no classic scrollbar to grab')
      }
      await shot('mixer-16-scrolled')
      win.setSize(960, 700)
      await wait(700)
      const small = await mixerLayout()
      await shot('mixer-16-min-window')
      const reach = await js<{ scrolls: boolean, visible: boolean, bodyHeight: number }>(`(() => {
        const body = document.querySelector('.mixer-body')
        body.scrollTop = body.scrollHeight
        const b = body.getBoundingClientRect()
        const mute = document.querySelector('.mixer-scroll .strip button[aria-label$=" mute"]').getBoundingClientRect()
        const masterFader = document.querySelector('.strip.master .fader input').getBoundingClientRect()
        return { scrolls: body.scrollHeight > body.clientHeight, visible: mute.bottom <= b.bottom + 0.5 && mute.top >= b.top - 0.5 && masterFader.bottom <= b.bottom + 0.5, bodyHeight: b.height }
      })()`)
      await wait(300)
      await shot('mixer-16-min-window-scrolled')
      record('16 tracks at the 960x700 minimum window size: no clipped controls; mixer scrolls vertically to reach them', small.problems.length === 0 && small.masterOk && small.mixerFits && small.faderHeight >= 60 && reach.visible,
        `fader ${small.faderHeight.toFixed(0)} px, mixer area ${reach.bodyHeight.toFixed(0)} px, vertical scroll ${reach.scrolls}, bottom controls reachable ${reach.visible}${small.problems.length > 0 ? ', problems: ' + small.problems.slice(0, 5).join('; ') : ''}`)
      await js(`document.querySelector('.mixer-body').scrollTop = 0`)
      win.setSize(1280, 820)
      await wait(500)

      for (let i = 15; i >= 4; i--)
        await engine.request('removeTrack', { trackId: `mx-${i}` })
      await reloadPage()
      await pressButton('Mixer')
      await wait(400)

      await pressButton('Add group bus')
      await until((s) => s.buses.length === 1)
      await pressButton('Add group bus')
      await until((s) => s.buses.length === 2)
      await pressButton('Add return bus')
      let current = await until((s) => s.buses.length === 3)
      const [g1, g2, r1] = current.buses
      record('Add group bus / Add return bus buttons create buses', current.buses.map((b) => `${b.name}:${b.kind}`).join(',') === 'Group 1:group,Group 2:group,Return 1:return', current.buses.map((b) => `${b.name}:${b.kind}`).join(', '))

      const trackSel = (index: number, inner: string): string => `.mixer-scroll .strip:not(.bus):nth-child(${index + 1}) ${inner}`
      const busSel = (busName: string, inner: string): string => `.mixer-scroll .strip.bus[aria-label^="${busName} "] ${inner}`
      await focusAndArrow(trackSel(0, 'select'), 'Down')
      current = await until((s) => s.tracks[0].output === g1.id)
      record('route track 1 to Group 1 with its output selector', current.tracks[0].output === g1.id, `output ${current.tracks[0].output}`)

      const g2Options = await js<string[]>(`Array.from(document.querySelector(${JSON.stringify(busSel('Group 2', 'select'))}).options).map((o) => o.textContent)`)
      await focusAndArrow(busSel('Group 1', 'select'), 'Down')
      current = await until((s) => s.buses[0].output === g2.id)
      const g2After = await js<string[]>(`Array.from(document.querySelector(${JSON.stringify(busSel('Group 2', 'select'))}).options).map((o) => o.textContent)`)
      record('nest Group 1 into Group 2; loops and returns are not offered', current.buses[0].output === g2.id && g2Options.join(',') === '→ Master,→ Group 1' && g2After.join(',') === '→ Master',
        `Group 1 -> ${current.buses.find((b) => b.id === current.buses[0].output)?.name}; Group 2 choices before ${g2Options.join('/')}, after ${g2After.join('/')}`)
      const loop = await engine.request('setBus', { busId: g2.id, output: g1.id })
      record('engine rejects a loop even if a client asks for it', !loop.ok, loop.error ?? 'accepted')

      await dragFader(busSel('Group 1', '.fader input'), -6)
      current = await until((s) => Math.abs(s.buses[0].gain - 1) > 0.01)
      const groupText = await js<string>(`document.querySelector(${JSON.stringify(busSel('Group 1', '.db-readout'))}).textContent`)
      record('drag the Group 1 fader; dB readout and engine gain agree', Math.abs(20 * Math.log10(current.buses[0].gain) + 6) < 1.5 && groupText === `${20 * Math.log10(current.buses[0].gain) >= 0 ? '+' : ''}${(20 * Math.log10(current.buses[0].gain)).toFixed(1)} dB`,
        `gain ${current.buses[0].gain.toFixed(4)} (${(20 * Math.log10(current.buses[0].gain)).toFixed(2)} dB), readout "${groupText}"`)

      await dragHorizontal(trackSel(1, '.send-row input'), 0.75)
      current = await until((s) => (s.tracks[1].sends[0]?.level ?? 0) > 0)
      const sendLevel = current.tracks[1].sends[0]?.level ?? 0
      await clickSelector(trackSel(1, '.send-row .pre-toggle'))
      current = await until((s) => s.tracks[1].sends[0]?.preFader === true)
      record('track 2 send to Return 1: drag the level and switch to pre-fader', sendLevel > 0 && current.tracks[1].sends[0]?.preFader === true && current.tracks[1].sends[0]?.bus === r1.id,
        `level ${sendLevel.toFixed(4)} (${(20 * Math.log10(sendLevel)).toFixed(1)} dB), pre ${current.tracks[1].sends[0]?.preFader}`)
      const faderDrag = await dragFader(trackSel(1, '.fader input'), -60)
      current = await until((s) => s.tracks[1].gain === 0)
      record('pull track 2 fader to -inf', current.tracks[1].gain === 0, `gain ${current.tracks[1].gain}${current.tracks[1].gain === 0 ? '' : '; ' + faderDrag}`)

      await dragHorizontal(trackSel(2, '.strip-pan input'), 0.2)
      current = await until((s) => s.tracks[2].pan < -0.3)
      record('pan track 3 left by dragging', current.tracks[2].pan < -0.3, `pan ${current.tracks[2].pan.toFixed(2)}`)

      await clickSelector(busSel('Return 1', 'button[aria-label$=" mute"]'))
      const muted = (await until((s) => s.buses[2].mute)).buses[2].mute
      await clickSelector(busSel('Return 1', 'button[aria-label$=" mute"]'))
      const unmuted = !(await until((s) => !s.buses[2].mute)).buses[2].mute
      await clickSelector(busSel('Group 2', 'button[aria-label$=" solo"]'))
      const soloed = (await until((s) => s.buses[1].solo)).buses[1].solo
      record('bus M and S buttons toggle engine state', muted && unmuted && soloed, `mute ${muted}, unmute ${unmuted}, Group 2 solo ${soloed}`)
      await exportAndCompare('Group 2 soloed')
      await clickSelector(busSel('Group 2', 'button[aria-label$=" solo"]'))
      current = await until((s) => !s.buses[1].solo)
      await shot('mixer-routed')
      const firstExport = await exportAndCompare('routed mix')
      if (firstExport != null)
        fs.copyFileSync(exportPath, path.join(outDir, 'build-routed-export.wav'))

      current = await state()
      if (current.deviceOpen) {
        await engine.request('transport', { action: 'seek', position: 0 })
        await pressButton('Play')
        await wait(700)
        const meterHeights = await js<number[]>(`Array.from(document.querySelectorAll('.mixer .strip')).map((s) => parseFloat(s.querySelector('.meter-bar span').style.height) || 0)`)
        const event = lastMeter as EngineEvent | null
        const meterA = event?.tracks?.find((m) => m.id === current.tracks[0].id)
        const expectA = 0.4 * current.tracks[0].gain * Math.SQRT1_2
        record('live meters move from native peaks during playback; post-fader meter is empty at -inf', meterHeights[0] > 0 && meterHeights[1] === 0 && meterHeights[2] > 0 && meterA != null && Math.abs(meterA.peakL - expectA) < 2e-3,
          `strip meter heights ${meterHeights.map((h) => h.toFixed(0)).join('/')} % (track 2 fader at -inf), track 1 native peak ${meterA?.peakL.toFixed(4)} (expected post-fader ${expectA.toFixed(4)})`)
        await dragFader(trackSel(0, '.fader input'), 12)
        await until((s) => s.tracks[0].gain > 3)
        await wait(400)
        const ledOn = await js<boolean>(`document.querySelector(${JSON.stringify(trackSel(0, '.clip-led'))}).classList.contains('on')`)
        const groupLed = await js<boolean>(`document.querySelector(${JSON.stringify(busSel('Group 1', '.clip-led'))}).classList.contains('on')`)
        await shot('mixer-clipping')
        await js(`(() => { const e = document.querySelector(${JSON.stringify(trackSel(0, '.fader input'))}); e.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })) })()`)
        await until((s) => Math.abs(s.tracks[0].gain - 1) < 1e-6)
        await pressButton('Reset clip indicators')
        await wait(400)
        const ledAfter = await js<boolean>(`document.querySelector(${JSON.stringify(trackSel(0, '.clip-led'))}).classList.contains('on')`)
        record('clip indicator lights above 0 dBFS on the hot strip only and resets', ledOn && !groupLed && !ledAfter, `track 1 LED ${ledOn}, Group 1 LED ${groupLed} (bus level stays below 0 dBFS), after reset ${ledAfter}`)
        await pressButton('Stop')
        await wait(4000)
        const settled = await js<number[]>(`Array.from(document.querySelectorAll('.mixer .strip')).map((s) => parseFloat(s.querySelector('.meter-bar span').style.height) || 0)`)
        record('meters fall to zero after Stop (no stale meters)', settled.every((h) => h < 1), `heights ${settled.map((h) => h.toFixed(1)).join('/')} %`)
      } else {
        record('live meters move from native peaks during playback', null, 'no output device open')
        record('clip indicator lights above 0 dBFS on the hot strip only and resets', null, 'no output device open')
        record('meters fall to zero after Stop (no stale meters)', null, 'no output device open')
      }

      answer(projectPath)
      await pressButton('Save project')
      const saved = await waitForFile(projectPath)
      current = await state()
      fs.writeFileSync(savedStatePath, JSON.stringify(current, null, 2))
      const savedJson = saved ? JSON.parse(fs.readFileSync(projectPath, 'utf8')) as { version: number, buses: unknown[] } : null
      record('save project through the Save project button (schema v3+ with buses)', saved && (savedJson?.version ?? 0) >= 3 && savedJson != null && savedJson.buses.length === 3, `${projectPath} version ${savedJson?.version}`)
    } else {
      if (!fs.existsSync(projectPath) || !fs.existsSync(savedStatePath)) {
        record('reopen and load the mixer project', false, 'run the build phase first')
      } else {
        const saved = JSON.parse(fs.readFileSync(savedStatePath, 'utf8')) as State
        answer(projectPath)
        await pressButton('Load project')
        const current = await until((s) => s.buses.length === saved.buses.length && s.tracks.length === saved.tracks.length, 15000)
        record('reopen app and load: tracks, buses, routing, sends and faders restored', describe(current) === describe(saved), describe(current))
        await pressButton('Mixer')
        await wait(600)
        const shown = await js<{ outputs: string[], buses: number }>(`({ outputs: Array.from(document.querySelectorAll('.mixer-scroll .strip select')).map((s) => s.selectedOptions[0]?.textContent ?? ''), buses: document.querySelectorAll('.mixer-scroll .strip.bus').length })`)
        record('mixer shows the restored routing', shown.buses === 3 && shown.outputs[0] === '→ Group 1' && shown.outputs[4] === '→ Group 2', `output selectors: ${shown.outputs.join(', ')}`)
        await shot('mixer-reloaded')
        const exported = await exportAndCompare('reloaded')
        const firstPath = path.join(outDir, 'build-routed-export.wav')
        if (exported != null && fs.existsSync(firstPath)) {
          const first = readWav(firstPath).left
          let worst = first.length === exported.length ? 0 : Number.POSITIVE_INFINITY
          for (let i = 0; i < first.length && i < exported.length; i++)
            worst = Math.max(worst, Math.abs(first[i] - exported[i]))
          record('export after reopening equals the export before closing', worst < 1e-6, `worst ${worst.toExponential(2)}`)
        }
      }
    }
  } catch (error) {
    record('mixer check run', false, error instanceof Error ? error.stack ?? error.message : String(error))
  }
  engine.onEvent = previousHandler
  fs.writeFileSync(path.join(outDir, `${phase}-results.json`), JSON.stringify(checks, null, 2))
  return checks.every((check) => check.result !== 'FAIL') ? 0 : 1
}
