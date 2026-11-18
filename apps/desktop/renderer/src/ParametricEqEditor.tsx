import { useEffect, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from 'react'
import type { EffectState } from '../../../../packages/shared/src/protocol'
import {
  dbToY, defaultEqParams, eqFromParams, freqToX, responseCurve, xToFreq, yToDb, type EqBandTypeId
} from './eqResponse'
import { getSpectrum, subscribeSpectrum } from './spectrumStore'

type Command = (op: string, payload?: Record<string, unknown>, timeoutMs?: number) => Promise<boolean>

const TYPE_LABELS = ['Low shelf', 'Bell', 'High shelf']

/**
 * Phase 2.8.3 — visual parametric EQ + spectrum overlay.
 * Curve from the same RBJ math as native EqDsp; spectrum from meter events (real audio).
 */
export function ParametricEqEditor(props: {
  effect: EffectState
  sampleRate: number
  target: 'track' | 'bus' | 'master'
  ownerId: string
  command: Command
  label: string
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [selected, setSelected] = useState(0)
  const [drag, setDrag] = useState<'freq-gain' | 'q' | null>(null)
  const spectrum = useSyncExternalStore(subscribeSpectrum, getSpectrum, getSpectrum)
  const eq = eqFromParams(props.effect.params)
  const bypassed = !props.effect.enabled
  const rate = Math.max(1000, props.sampleRate || 48000)

  useEffect(() => {
    void props.command('setSpectrumTap', {
      enabled: true,
      target: props.target,
      ownerId: props.target === 'master' ? undefined : props.ownerId
    })
    return () => {
      void props.command('setSpectrumTap', { enabled: false })
    }
  }, [props.target, props.ownerId, props.command])

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas == null)
      return
    const width = canvas.clientWidth || 360
    const height = canvas.clientHeight || 160
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
    }
    const ctx = canvas.getContext('2d')
    if (ctx == null)
      return
    ctx.clearRect(0, 0, width, height)
    ctx.fillStyle = '#10141c'
    ctx.fillRect(0, 0, width, height)

    // Grid
    ctx.strokeStyle = '#1e2633'
    ctx.lineWidth = 1
    for (const hz of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
      const x = freqToX(hz, width)
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, height)
      ctx.stroke()
    }
    for (const db of [-18, -12, -6, 0, 6, 12, 18]) {
      const y = dbToY(db, height)
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(width, y)
      ctx.stroke()
    }
    // 0 dB
    ctx.strokeStyle = '#3a4558'
    ctx.beginPath()
    ctx.moveTo(0, dbToY(0, height))
    ctx.lineTo(width, dbToY(0, height))
    ctx.stroke()

    // Spectrum (actual audio; unavailable → no fabricated fill)
    if (spectrum.available && spectrum.magnitudesDb.length > 1) {
      ctx.beginPath()
      ctx.moveTo(0, height)
      for (let i = 0; i < spectrum.magnitudesDb.length; ++i) {
        const hz = spectrum.frequenciesHz[i] ?? 20
        const db = Math.min(12, Math.max(-90, spectrum.magnitudesDb[i]))
        // Map analyzer dBFS-ish into visual range with offset so quiet material still shows shape.
        const y = dbToY(db + 48, height, -24, 24)
        ctx.lineTo(freqToX(hz, width), y)
      }
      ctx.lineTo(width, height)
      ctx.closePath()
      ctx.fillStyle = 'rgba(90, 140, 200, 0.22)'
      ctx.fill()
    }

    // Response curve
    const curve = responseCurve(eq, rate, 160)
    ctx.beginPath()
    for (let i = 0; i < curve.hz.length; ++i) {
      const x = freqToX(curve.hz[i], width)
      const y = dbToY(curve.db[i], height)
      if (i === 0)
        ctx.moveTo(x, y)
      else
        ctx.lineTo(x, y)
    }
    ctx.strokeStyle = bypassed ? '#5a6578' : '#e0a24a'
    ctx.lineWidth = 2
    ctx.stroke()
    if (bypassed) {
      ctx.fillStyle = 'rgba(16, 20, 28, 0.45)'
      ctx.fillRect(0, 0, width, height)
      ctx.fillStyle = '#c8d0dc'
      ctx.font = '12px Segoe UI'
      ctx.fillText('EQ bypassed', 10, 20)
    }

    // Band handles
    eq.bands.forEach((band, index) => {
      if (!band.enabled)
        return
      const x = freqToX(band.freq, width)
      const y = dbToY(band.gain, height)
      const active = index === selected
      ctx.beginPath()
      ctx.arc(x, y, active ? 7 : 5, 0, Math.PI * 2)
      ctx.fillStyle = active ? '#f0c27a' : '#7eb6ff'
      ctx.fill()
      ctx.strokeStyle = '#0b0e14'
      ctx.lineWidth = 1
      ctx.stroke()
    })
  }, [eq, spectrum, selected, bypassed, rate])

  async function setParams(patch: Record<string, number>): Promise<void> {
    await props.command('setEffect', { effectId: props.effect.id, params: patch })
  }

  function onPointerDown(event: ReactPointerEvent<HTMLCanvasElement>): void {
    const canvas = canvasRef.current
    if (canvas == null || bypassed)
      return
    const rect = canvas.getBoundingClientRect()
    const x = event.clientX - rect.left
    const y = event.clientY - rect.top
    let best = selected
    let bestDist = 1e9
    eq.bands.forEach((band, index) => {
      if (!band.enabled)
        return
      const dx = freqToX(band.freq, rect.width) - x
      const dy = dbToY(band.gain, rect.height) - y
      const d = Math.hypot(dx, dy)
      if (d < bestDist) {
        bestDist = d
        best = index
      }
    })
    setSelected(best)
    setDrag(event.shiftKey ? 'q' : 'freq-gain')
    canvas.setPointerCapture(event.pointerId)
  }

  function onPointerMove(event: ReactPointerEvent<HTMLCanvasElement>): void {
    if (drag == null || bypassed)
      return
    const canvas = canvasRef.current
    if (canvas == null)
      return
    const rect = canvas.getBoundingClientRect()
    const x = event.clientX - rect.left
    const y = event.clientY - rect.top
    const band = selected + 1
    if (drag === 'q') {
      const start = eq.bands[selected]?.q ?? 1
      const delta = (event.movementX - event.movementY) * 0.02
      const q = Math.min(18, Math.max(0.1, start * Math.pow(1.05, delta * 10)))
      void setParams({ [`band${band}Q`]: Number(q.toFixed(3)) })
      return
    }
    const freq = Number(xToFreq(x, rect.width).toFixed(2))
    const gain = Number(yToDb(y, rect.height).toFixed(2))
    void setParams({ [`band${band}Freq`]: freq, [`band${band}Gain`]: Math.min(24, Math.max(-24, gain)) })
  }

  function onPointerUp(event: ReactPointerEvent<HTMLCanvasElement>): void {
    setDrag(null)
    try {
      canvasRef.current?.releasePointerCapture(event.pointerId)
    } catch { /* ignore */ }
  }

  const band = eq.bands[selected]

  return (
    <div className="eq-editor" data-panel="parametric-eq-283" aria-label={`${props.label} parametric EQ`}>
      <canvas
        ref={canvasRef}
        className="eq-canvas"
        data-eq-canvas="1"
        aria-label={`${props.label} frequency response`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />
      <p className="hint">
        Drag handles: frequency / gain. Shift-drag: Q. Spectrum: {spectrum.available ? spectrum.tap : 'unavailable (no stream)'}.
      </p>
      <div className="eq-band-select" role="tablist" aria-label="EQ bands">
        {eq.bands.map((_, index) => (
          <button
            key={index}
            type="button"
            role="tab"
            aria-selected={selected === index}
            data-action={`eq-select-band-${index + 1}`}
            className={selected === index ? 'active' : ''}
            onClick={() => setSelected(index)}
          >Band {index + 1}</button>
        ))}
      </div>
      {band != null && (
        <div className="eq-band-numeric" data-eq-band={selected + 1}>
          <label>
            <input
              type="checkbox"
              data-action={`eq-band-${selected + 1}-enabled`}
              checked={band.enabled}
              onChange={(event) => void setParams({ [`band${selected + 1}Enabled`]: event.target.checked ? 1 : 0 })}
            /> Enable
          </label>
          <label>
            Type
            <select
              data-action={`eq-band-${selected + 1}-type`}
              value={band.type}
              onChange={(event) => void setParams({ [`band${selected + 1}Type`]: Number(event.target.value) })}
            >
              {TYPE_LABELS.map((label, index) => <option key={label} value={index}>{label}</option>)}
            </select>
          </label>
          <label>
            Freq (Hz)
            <input type="number" min={20} max={20000} step={1} data-action={`eq-band-${selected + 1}-freq`}
              value={Number(band.freq.toFixed(2))}
              onChange={(event) => void setParams({ [`band${selected + 1}Freq`]: Number(event.target.value) })} />
          </label>
          <label>
            Gain (dB)
            <input type="number" min={-24} max={24} step={0.1} data-action={`eq-band-${selected + 1}-gain`}
              value={Number(band.gain.toFixed(2))}
              onChange={(event) => void setParams({ [`band${selected + 1}Gain`]: Number(event.target.value) })} />
          </label>
          <label>
            Q
            <input type="number" min={0.1} max={18} step={0.01} data-action={`eq-band-${selected + 1}-q`}
              value={Number(band.q.toFixed(3))}
              onChange={(event) => void setParams({ [`band${selected + 1}Q`]: Number(event.target.value) })} />
          </label>
        </div>
      )}
      <label className="field">
        Output (dB)
        <input
          type="number"
          min={-24}
          max={24}
          step={0.1}
          data-action="eq-output-gain"
          value={Number(eq.outputGain.toFixed(2))}
          onChange={(event) => void setParams({ outputGain: Number(event.target.value) })}
        />
      </label>
      <div className="eq-actions">
        <button
          type="button"
          data-action="eq-reset"
          onClick={() => void setParams(defaultEqParams())}
        >Reset EQ</button>
        <button
          type="button"
          data-action="eq-bypass"
          aria-pressed={bypassed}
          onClick={() => void props.command('setEffect', { effectId: props.effect.id, enabled: bypassed })}
        >{bypassed ? 'Activate' : 'Bypass'}</button>
      </div>
    </div>
  )
}

// Silence unused import warning if TypeScript strips — keep EqBandTypeId for clarity.
export type { EqBandTypeId }
