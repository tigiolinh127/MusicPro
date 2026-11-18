import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { EffectState } from '../../../../packages/shared/src/protocol'
import {
  axisToDb, compFromParams, compressorTransferDb, dbToAxis, defaultCompParams, defaultLimParams,
  limFromParams, limiterTransferDb, transferCurve
} from './dynamicsTransfer'
import { effectSpec, formatParam, fromSlider, toSlider, type ParamSpec } from './effects'

type Command = (op: string, payload?: Record<string, unknown>, timeoutMs?: number) => Promise<boolean>

/**
 * Phase 2.8.4 — compressor / limiter visual transfer curve + GR meter with peak hold.
 * Curve matches native steady-state gain computer (soft knee / sample-peak ceiling).
 */
export function DynamicsEditor(props: {
  effect: EffectState
  kind: 'compressor' | 'limiter'
  reduction: number
  command: Command
  label: string
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [hold, setHold] = useState(0)
  const bypassed = !props.effect.enabled
  const reduction = Math.max(0, props.reduction ?? 0)
  const spec = effectSpec(props.kind)

  useEffect(() => {
    setHold((prev) => Math.max(reduction, prev * 0.92))
  }, [reduction])

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas == null)
      return
    const width = canvas.clientWidth || 320
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

    ctx.strokeStyle = '#1e2633'
    ctx.lineWidth = 1
    for (const db of [-48, -36, -24, -12]) {
      const x = width - dbToAxis(db, width)
      const y = dbToAxis(db, height)
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, height)
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(width, y)
      ctx.stroke()
    }
    // Unity diagonal
    ctx.strokeStyle = '#3a4558'
    ctx.beginPath()
    ctx.moveTo(width - dbToAxis(-60, width), dbToAxis(-60, height))
    ctx.lineTo(width - dbToAxis(0, width), dbToAxis(0, height))
    ctx.stroke()

    const curve = transferCurve(props.kind, props.effect.params, 97)
    ctx.beginPath()
    for (let i = 0; i < curve.inDb.length; ++i) {
      const x = width - dbToAxis(curve.inDb[i], width)
      const y = dbToAxis(curve.outDb[i], height)
      if (i === 0)
        ctx.moveTo(x, y)
      else
        ctx.lineTo(x, y)
    }
    ctx.strokeStyle = bypassed ? '#5a6578' : '#7eb6ff'
    ctx.lineWidth = 2
    ctx.stroke()

    if (props.kind === 'compressor') {
      const c = compFromParams(props.effect.params)
      const thrX = width - dbToAxis(c.threshold, width)
      ctx.strokeStyle = '#e0a24a'
      ctx.setLineDash([4, 3])
      ctx.beginPath()
      ctx.moveTo(thrX, 0)
      ctx.lineTo(thrX, height)
      ctx.stroke()
      ctx.setLineDash([])
      const outAtThr = compressorTransferDb(c, c.threshold)
      ctx.fillStyle = '#f0c27a'
      ctx.beginPath()
      ctx.arc(thrX, dbToAxis(outAtThr, height), 5, 0, Math.PI * 2)
      ctx.fill()
    } else {
      const lim = limFromParams(props.effect.params)
      const y = dbToAxis(lim.ceiling, height)
      ctx.strokeStyle = '#e0a24a'
      ctx.setLineDash([4, 3])
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(width, y)
      ctx.stroke()
      ctx.setLineDash([])
      const atCeil = limiterTransferDb(lim, lim.ceiling)
      ctx.fillStyle = '#f0c27a'
      ctx.beginPath()
      ctx.arc(width - dbToAxis(lim.ceiling, width), dbToAxis(atCeil, height), 5, 0, Math.PI * 2)
      ctx.fill()
    }

    if (bypassed) {
      ctx.fillStyle = 'rgba(16, 20, 28, 0.45)'
      ctx.fillRect(0, 0, width, height)
      ctx.fillStyle = '#c8d0dc'
      ctx.font = '12px Segoe UI'
      ctx.fillText(props.kind === 'limiter' ? 'Limiter bypassed' : 'Compressor bypassed', 10, 20)
    }
  }, [props.effect.params, props.kind, bypassed])

  async function setParams(patch: Record<string, number>): Promise<void> {
    await props.command('setEffect', { effectId: props.effect.id, params: patch })
  }

  function onCanvasPointer(event: ReactPointerEvent<HTMLCanvasElement>): void {
    if (bypassed)
      return
    const canvas = canvasRef.current
    if (canvas == null)
      return
    const rect = canvas.getBoundingClientRect()
    const x = event.clientX - rect.left
    const y = event.clientY - rect.top
    if (props.kind === 'compressor') {
      const threshold = Number(axisToDb(rect.width - x, rect.width).toFixed(1))
      void setParams({ threshold: Math.min(0, Math.max(-60, threshold)) })
    } else {
      const ceiling = Number(axisToDb(y, rect.height).toFixed(1))
      void setParams({ ceiling: Math.min(0, Math.max(-24, ceiling)) })
    }
  }

  const grShown = bypassed ? 0 : reduction
  const holdShown = bypassed ? 0 : hold

  return (
    <div className="dynamics-editor" data-panel="dynamics-284" data-dynamics-kind={props.kind} aria-label={`${props.label} dynamics`}>
      <canvas
        ref={canvasRef}
        className="dynamics-canvas"
        data-dynamics-canvas="1"
        aria-label={`${props.label} transfer curve`}
        onPointerDown={onCanvasPointer}
        onPointerMove={(event) => { if (event.buttons === 1) onCanvasPointer(event) }}
      />
      <p className="hint">
        {props.kind === 'limiter'
          ? 'Sample-peak limiter (stereo-linked, no lookahead / not true-peak). Drag vertically to set ceiling.'
          : 'Input→output transfer (soft knee when Knee > 0). Drag horizontally to set threshold.'}
      </p>
      <div className="fx-gr" data-gr-meter="1" title="Gain reduction" aria-label={`${props.label} gain reduction`}>
        <span className="fx-gr-label">{bypassed ? 'BYP' : 'GR'}</span>
        <div className="fx-gr-bar">
          <span className="fx-gr-hold" style={{ width: `${Math.min(1, holdShown / 24) * 100}%` }} />
          <span style={{ width: `${Math.min(1, grShown / 24) * 100}%` }} />
        </div>
        <output data-gr-value="1">
          {bypassed ? 'bypassed' : grShown >= 0.05 ? `-${grShown.toFixed(1)} dB` : '0.0 dB'}
          {!bypassed && holdShown > grShown + 0.2 ? ` · pk -${holdShown.toFixed(1)}` : ''}
        </output>
      </div>
      <div className="dynamics-params">
        {spec.params.map((item) => (
          <DynamicsParam
            key={item.name}
            effect={props.effect}
            item={item}
            label={props.label}
            disabled={bypassed}
            onChange={(value) => void setParams({ [item.name]: value })}
          />
        ))}
      </div>
      <div className="eq-actions">
        <button
          type="button"
          data-action="dynamics-reset"
          onClick={() => void setParams(props.kind === 'limiter' ? { ...defaultLimParams(), release: 50, attack: 0.1 } : {
            ...defaultCompParams(), attack: 10, release: 100
          })}
        >Reset</button>
        <button
          type="button"
          data-action="dynamics-bypass"
          aria-pressed={bypassed}
          onClick={() => void props.command('setEffect', { effectId: props.effect.id, enabled: bypassed })}
        >{bypassed ? 'Activate' : 'Bypass'}</button>
      </div>
    </div>
  )
}

function DynamicsParam(props: {
  effect: EffectState
  item: ParamSpec
  label: string
  disabled: boolean
  onChange: (value: number) => void
}) {
  const { item } = props
  const value = props.effect.params[item.name] ?? item.defaultValue
  if (item.choices != null) {
    return (
      <label className="field">
        {item.label}
        <select
          data-action={`dynamics-${item.name}`}
          disabled={props.disabled}
          value={Math.round(value)}
          onChange={(event) => props.onChange(Number(event.target.value))}
        >
          {item.choices.map((choice, index) => <option key={choice} value={index}>{choice}</option>)}
        </select>
      </label>
    )
  }
  return (
    <label className="field dynamics-param" aria-label={`${props.label} ${item.label}`}>
      <span>{item.label}</span>
      <input
        type="range"
        min={0}
        max={1000}
        data-action={`dynamics-${item.name}`}
        disabled={props.disabled}
        value={toSlider(item, value)}
        onChange={(event) => props.onChange(fromSlider(item, Number(event.target.value)))}
      />
      <input
        type="number"
        min={item.min}
        max={item.max}
        step={item.step ?? (item.log ? undefined : 0.1)}
        data-action={`dynamics-${item.name}-num`}
        disabled={props.disabled}
        value={Number(value.toFixed(item.unit === 'ms' && value < 10 ? 2 : 2))}
        onChange={(event) => {
          const next = Number(event.target.value)
          if (Number.isFinite(next))
            props.onChange(Math.min(item.max, Math.max(item.min, next)))
        }}
      />
      <output>{formatParam(item, value)}</output>
    </label>
  )
}
