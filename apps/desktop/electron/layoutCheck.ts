import type { BrowserWindow } from 'electron'
import fs from 'fs'
import path from 'path'
import type { EngineHost } from './engineHost'

interface Check {
  scenario: string
  result: 'PASS' | 'FAIL'
  detail: string
}

const measureScript = `(() => {
  const app = document.querySelector('.app')
  const scroller = document.querySelector('.lanes-scroll')
  const canvas = document.querySelector('.timeline-canvas')
  const ruler = document.querySelector('.timeline-ruler')
  const rulerGap = document.querySelector('.ruler-gap')
  const headers = Array.from(document.querySelectorAll('.lane-header'))
  if (app == null || scroller == null || canvas == null || ruler == null)
    return { error: 'timeline elements are missing' }
  const laneHeight = parseFloat(getComputedStyle(app).getPropertyValue('--lane-height'))
  const canvasRect = canvas.getBoundingClientRect()
  const problems = []
  headers.forEach((header, index) => {
    const r = header.getBoundingClientRect()
    const offset = r.top - canvasRect.top - index * laneHeight
    if (Math.abs(offset) > 0.5)
      problems.push('header ' + index + ' is ' + offset.toFixed(1) + 'px from its lane')
    if (Math.abs(r.height - laneHeight) > 0.5)
      problems.push('header ' + index + ' height ' + r.height.toFixed(1) + ' != lane ' + laneHeight)
    if (header.scrollWidth > header.clientWidth + 1 || header.scrollHeight > header.clientHeight + 1)
      problems.push('header ' + index + ' content overflows')
    header.querySelectorAll('button, input').forEach((control) => {
      const c = control.getBoundingClientRect()
      const label = (control.textContent || control.getAttribute('aria-label') || control.tagName).trim()
      if (c.width < 1 || c.height < 1)
        problems.push('header ' + index + ' ' + label + ' has no size')
      if (c.left < r.left - 0.5 || c.right > r.right + 0.5 || c.top < r.top - 0.5 || c.bottom > r.bottom + 0.5)
        problems.push('header ' + index + ' ' + label + ' is outside its header')
      if (control.tagName === 'BUTTON' && control.scrollWidth > control.clientWidth + 1)
        problems.push('header ' + index + ' button ' + label + ' text is cut off')
    })
  })
  const expectedCanvas = Math.max(headers.length, 1) * laneHeight
  if (Math.abs(canvasRect.height - expectedCanvas) > 0.5)
    problems.push('canvas height ' + canvasRect.height.toFixed(1) + ' != ' + expectedCanvas)
  if (document.documentElement.scrollWidth > window.innerWidth + 1)
    problems.push('page scrolls horizontally')
  if (scroller.scrollWidth > scroller.clientWidth + 1)
    problems.push('track area scrolls horizontally')
  const rulerRect = ruler.getBoundingClientRect()
  const gapRect = rulerGap == null ? rulerRect : rulerGap.getBoundingClientRect()
  return {
    count: headers.length,
    laneHeight,
    problems,
    rulerTop: rulerRect.top,
    gapTop: gapRect.top,
    scrollerTop: scroller.getBoundingClientRect().top,
    scrollTop: scroller.scrollTop,
    maxScroll: scroller.scrollHeight - scroller.clientHeight,
    firstHeaderToCanvas: headers.length > 0 ? headers[0].getBoundingClientRect().top - canvasRect.top : 0,
    lastHeaderBottom: headers.length > 0 ? headers[headers.length - 1].getBoundingClientRect().bottom : 0,
    scrollerBottom: scroller.getBoundingClientRect().bottom,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight
  }
})()`

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function runLayoutCheck(win: BrowserWindow, engine: EngineHost, outDir: string, fixtureDir: string): Promise<number> {
  fs.mkdirSync(outDir, { recursive: true })
  const checks: Check[] = []
  const measurements: Record<string, unknown> = {}
  const fixtures = [path.join(fixtureDir, 'test_music_440hz.wav'), path.join(fixtureDir, 'test_music_880hz.wav')]
  const web = win.webContents

  async function measure(label: string): Promise<{ count: number, problems: string[], [key: string]: unknown }> {
    await wait(400)
    const value = await web.executeJavaScript(measureScript, true) as { count: number, problems: string[], error?: string }
    if (value.error != null)
      return { count: 0, problems: [value.error] }
    measurements[label] = value
    return value
  }

  async function shot(name: string): Promise<void> {
    const image = await web.capturePage()
    fs.writeFileSync(path.join(outDir, `${name.replace(/[^\w-]+/g, '-')}.png`), image.toPNG())
  }

  async function waitForCount(count: number): Promise<boolean> {
    for (let attempt = 0; attempt < 50; attempt++) {
      const seen = await web.executeJavaScript('document.querySelectorAll(".lane-header").length', true) as number
      if (seen === count)
        return true
      await wait(100)
    }
    return false
  }

  function record(scenario: string, ok: boolean, detail: string): void {
    checks.push({ scenario, result: ok ? 'PASS' : 'FAIL', detail })
  }

  async function setTracks(count: number): Promise<void> {
    const state = await engine.request('getState')
    const tracks = ((state.result as { tracks?: Array<{ id: string }> } | undefined)?.tracks ?? [])
    for (const track of tracks)
      await engine.request('removeTrack', { trackId: track.id })
    for (let index = 0; index < count; index++) {
      const trackId = `layout-${index + 1}`
      await engine.request('importTrack', { trackId, path: fixtures[index % 2] }, 20000)
      const name = index === 1 ? 'A very long track name that must not push controls out' : `Track ${index + 1}`
      await engine.request('renameTrack', { trackId, name })
    }
    web.reload()
    await new Promise<void>((resolve) => web.once('did-finish-load', () => resolve()))
    await waitForCount(count)
  }

  async function sizeTo(width: number, height: number): Promise<boolean> {
    if (win.isMaximized())
      win.unmaximize()
    win.setSize(width, height)
    await wait(700)
    const [w, h] = win.getSize()
    return Math.abs(w - width) <= 2 && Math.abs(h - height) <= 2
  }

  async function scrollCheck(label: string): Promise<void> {
    const before = await measure(`${label}-top`)
    await web.executeJavaScript('(() => { const s = document.querySelector(".lanes-scroll"); s.scrollTop = s.scrollHeight; return s.scrollTop })()', true)
    const after = await measure(`${label}-bottom`)
    await shot(`${label}-scrolled`)
    const maxScroll = Number(before.maxScroll)
    if (before.innerWidth !== after.innerWidth || before.innerHeight !== after.innerHeight) {
      record(`${label} vertical scrolling`, false, `window changed size during the check (${before.innerWidth}x${before.innerHeight} -> ${after.innerWidth}x${after.innerHeight})`)
      return
    }
    if (maxScroll <= 1) {
      record(`${label} vertical scrolling`, true, 'all tracks fit, no scroll needed')
      record(`${label} ruler fixed`, Math.abs(Number(after.rulerTop) - Number(before.rulerTop)) < 0.5, `ruler top ${before.rulerTop} -> ${after.rulerTop}`)
      return
    }
    const synced = after.problems.length === 0 && Number(after.scrollTop) > 0
    record(`${label} vertical scrolling`, synced, `scrollTop ${after.scrollTop}/${maxScroll}; ${after.problems.join('; ') || 'headers stay on their lanes'}`)
    const fixed = Math.abs(Number(after.rulerTop) - Number(before.rulerTop)) < 0.5 && Math.abs(Number(after.gapTop) - Number(before.gapTop)) < 0.5
    record(`${label} ruler fixed`, fixed, `ruler top ${before.rulerTop} -> ${after.rulerTop}`)
    const lastVisible = Number(after.lastHeaderBottom) <= Number(after.scrollerBottom) + 0.5
    record(`${label} last track reachable`, lastVisible, `last header bottom ${after.lastHeaderBottom}, area bottom ${after.scrollerBottom}`)
    await web.executeJavaScript('document.querySelector(".lanes-scroll").scrollTop = 0', true)
  }

  try {
    win.setMaximizable(false)
    win.setFullScreenable(false)
    await sizeTo(1180, 860)
    for (const count of [2, 4, 8, 16]) {
      await setTracks(count)
      await sizeTo(1180, 860)
      const result = await measure(`tracks-${count}`)
      await shot(`tracks-${count}`)
      const viewport = `viewport ${result.innerWidth}x${result.innerHeight}`
      record(`${count} tracks layout`, result.count === count && result.problems.length === 0, result.count !== count ? `saw ${result.count} headers` : `${result.problems.join('; ') || 'controls visible, headers aligned'} (${viewport})`)
      await scrollCheck(`${count} tracks`)
    }

    for (const [width, height] of [[960, 700], [1600, 1000], [1180, 860]]) {
      const applied = await sizeTo(width, height)
      const result = await measure(`resize-${width}x${height}`)
      await shot(`resize-${width}x${height}`)
      const viewport = `viewport ${result.innerWidth}x${result.innerHeight}`
      record(`resize ${width}x${height} with 16 tracks`, applied && result.count === 16 && result.problems.length === 0, applied ? `${result.problems.join('; ') || 'controls visible, headers aligned'} (${viewport})` : `window size was not applied (${viewport})`)
      await scrollCheck(`resize ${width}x${height}`)
    }

    await setTracks(4)
    for (let n = 0; n < 3; n++) {
      await web.executeJavaScript('Array.from(document.querySelectorAll(".transport button")).find((b) => b.textContent === "Add track").click()', true)
      await waitForCount(5 + n)
    }
    const added = await measure('add-via-button')
    await shot('add-via-button')
    record('add 3 tracks with the Add track button', added.count === 7 && added.problems.length === 0, added.count !== 7 ? `saw ${added.count} headers` : added.problems.join('; ') || 'layout intact')
    for (let n = 0; n < 2; n++) {
      await web.executeJavaScript('Array.from(document.querySelectorAll(".lane-header button")).filter((b) => b.textContent === "Remove")[1].click()', true)
      await waitForCount(6 - n)
    }
    const removed = await measure('remove-via-button')
    await shot('remove-via-button')
    record('remove 2 tracks with Remove buttons', removed.count === 5 && removed.problems.length === 0, removed.count !== 5 ? `saw ${removed.count} headers` : removed.problems.join('; ') || 'layout intact')
    await scrollCheck('after add/remove')

    await setTracks(16)
    await engine.request('transport', { action: 'stop' })
    const played = await engine.request('transport', { action: 'play' })
    await wait(600)
    const playing = await engine.request('getState')
    await engine.request('transport', { action: 'stop' })
    const position = Number((playing.result as { position?: number } | undefined)?.position ?? 0)
    if (played.ok)
      record('16-track playback advances in the app', position > 0.2, `position ${position.toFixed(3)} s`)
  } catch (error) {
    record('layout check run', false, error instanceof Error ? error.message : String(error))
  }

  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({ checks, measurements }, null, 2))
  for (const check of checks)
    console.log(`${check.result} ${check.scenario} — ${check.detail}`)
  return checks.every((check) => check.result === 'PASS') ? 0 : 1
}
