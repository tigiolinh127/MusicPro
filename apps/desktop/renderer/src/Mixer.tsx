import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { masterBusId, type AutomationLaneState, type BusState, type EffectState, type EffectTarget, type EngineState, type SendState, type StripMeter, type TrackState } from '../../../../packages/shared/src/protocol'
import { isAutomated } from './automation'
import { effectSpec, effectSpecs, formatParam, fromSlider, sliderSteps, toSlider, type ParamSpec } from './effects'
import { DynamicsEditor } from './DynamicsEditor'
import { ParametricEqEditor } from './ParametricEqEditor'
import { getMasterMeter, getStripMeter, subscribeMeters } from './meterStore'

const automatedHint = 'Automated: follows its automation lane. Turn the lane off in the editor to set it by hand.'

const maxEffectsPerChain = 8

const minDb = -60
const maxDb = 12
const maxGain = 4

export function gainToDb(gain: number): number {
  if (!(gain > 0))
    return minDb
  return Math.max(minDb, Math.min(maxDb, 20 * Math.log10(gain)))
}

export function dbToGain(db: number): number {
  if (db <= minDb)
    return 0
  return Math.min(maxGain, Math.pow(10, db / 20))
}

export function dbText(gain: number): string {
  if (!(gain > 0.001))
    return '-inf dB'
  const db = 20 * Math.log10(gain)
  return `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`
}

function meterFraction(level: number): number {
  if (!(level > 0))
    return 0
  const db = 20 * Math.log10(level)
  return Math.max(0, Math.min(1, (db - minDb) / (6 - minDb)))
}

function formatDbFS(db: number | undefined): string {
  if (db == null || !(Number.isFinite(db)) || db <= -119.5)
    return '−∞'
  const sign = db > 0 ? '+' : db < 0 ? '−' : ''
  return `${sign}${Math.abs(db).toFixed(1)}`
}

const zeroDbFraction = (0 - minDb) / (6 - minDb)

type Command = (op: string, payload?: Record<string, unknown>) => Promise<boolean>

function useStripMeter(key: string | null): StripMeter | undefined {
  return useSyncExternalStore(
    subscribeMeters,
    () => (key == null ? getMasterMeter() : getStripMeter(key)),
    () => undefined
  )
}

// Sends the latest value shortly after the user stops moving a control, and immediately on release.
function useLiveValue(value: number, commit: (next: number) => void): [number, (next: number) => void, () => void] {
  const [local, setLocal] = useState(value)
  const timer = useRef<number | null>(null)
  const pending = useRef<number | null>(null)
  const active = useRef(false)
  useEffect(() => {
    if (!active.current)
      setLocal(value)
  }, [value])
  useEffect(() => () => {
    if (timer.current != null)
      window.clearTimeout(timer.current)
  }, [])
  const flush = (): void => {
    if (timer.current != null)
      window.clearTimeout(timer.current)
    timer.current = null
    active.current = false
    if (pending.current != null) {
      const next = pending.current
      pending.current = null
      commit(next)
    }
  }
  const change = (next: number): void => {
    active.current = true
    setLocal(next)
    pending.current = next
    if (timer.current != null)
      window.clearTimeout(timer.current)
    timer.current = window.setTimeout(flush, 80)
  }
  return [local, change, flush]
}

function Meter(props: { meterKey: string | null, label: string, onReset: () => void, available: boolean }) {
  const meter = useStripMeter(props.meterKey)
  const available = props.available && meter?.available !== false
  const left = available ? meterFraction(meter?.levelL ?? 0) : 0
  const right = available ? meterFraction(meter?.levelR ?? 0) : 0
  const holdL = available ? meterFraction(meter?.peakHoldL ?? 0) : 0
  const holdR = available ? meterFraction(meter?.peakHoldR ?? 0) : 0
  const clip = available && meter?.clip === true
  const peakDb = meter?.peakDbFS
  const rmsDb = meter?.rmsDbFS
  return (
    <div className={`strip-meter${available ? '' : ' unavailable'}`} aria-label={`${props.label} meter`} data-strip-meter={props.meterKey ?? 'master'}>
      <button
        className={`clip-led${clip ? ' on' : ''}`}
        data-action="reset-clip"
        data-strip={props.meterKey ?? 'master'}
        aria-label={`${props.label} clip indicator${clip ? ' (clipped, click to clear peaks)' : ''}`}
        title={clip ? 'Clipped above 0 dBFS. Click to clear peak hold and clip indicators.' : 'Clear peak hold / clip indicators'}
        onClick={props.onReset}
      />
      {!available ? (
        <span className="meter-unavailable" data-meter-unavailable>Unavailable</span>
      ) : (
        <>
          <div className="meter-bars">
            <div className="meter-bar">
              <span style={{ height: `${left * 100}%` }} className={left >= zeroDbFraction ? 'clip' : left >= zeroDbFraction - 6 / 66 ? 'hot' : ''} />
              <i className="peak-hold" style={{ bottom: `${holdL * 100}%` }} />
            </div>
            <div className="meter-bar">
              <span style={{ height: `${right * 100}%` }} className={right >= zeroDbFraction ? 'clip' : right >= zeroDbFraction - 6 / 66 ? 'hot' : ''} />
              <i className="peak-hold" style={{ bottom: `${holdR * 100}%` }} />
            </div>
            <i className="zero-line" style={{ bottom: `${zeroDbFraction * 100}%` }} />
          </div>
          <div className="meter-dbfs" data-meter-dbfs>
            <span data-meter-peak-db title="Peak dBFS">P {formatDbFS(peakDb)}</span>
            <span data-meter-rms-db title="RMS dBFS">R {formatDbFS(rmsDb)}</span>
          </div>
        </>
      )}
    </div>
  )
}

function Fader(props: { gain: number, label: string, automated?: boolean, onCommit: (gain: number) => void }) {
  const [db, change, flush] = useLiveValue(gainToDb(props.gain), (next) => props.onCommit(dbToGain(next)))
  const automated = props.automated === true
  return (
    <div className="fader" title={automated ? automatedHint : undefined}>
      <input
        type="range"
        className="vertical"
        min={minDb}
        max={maxDb}
        step={0.1}
        value={db}
        disabled={automated}
        aria-label={`${props.label} fader`}
        data-action="strip-fader"
        aria-valuetext={automated ? 'automated' : dbText(dbToGain(db))}
        onChange={(event) => change(Number(event.target.value))}
        onPointerUp={flush}
        onKeyUp={flush}
        onDoubleClick={() => { if (!automated) { change(0); flush() } }}
      />
      <span className={`db-readout${automated ? ' automated' : ''}`} data-fader-db>{automated ? 'A · Auto' : dbText(dbToGain(db))}</span>
    </div>
  )
}

function SendRow(props: { track: TrackState, bus: BusState, send?: SendState, command: Command }) {
  const label = `${props.track.name} send to ${props.bus.name}`
  const [level, change, flush] = useLiveValue(gainToDb(props.send?.level ?? 0), (next) => {
    void props.command('setSend', { trackId: props.track.id, busId: props.bus.id, level: dbToGain(next) })
  })
  const pre = props.send?.preFader ?? false
  return (
    <div className="send-row" title={`${props.bus.name}: ${dbText(dbToGain(level))} ${pre ? 'pre-fader' : 'post-fader'}`}>
      <span className="send-name">{props.bus.name}</span>
      <input
        type="range"
        min={minDb}
        max={maxDb}
        step={0.5}
        value={level}
        aria-label={`${label} level`}
        aria-valuetext={dbText(dbToGain(level))}
        onChange={(event) => change(Number(event.target.value))}
        onPointerUp={flush}
        onKeyUp={flush}
      />
      <button
        className="pre-toggle"
        aria-pressed={pre}
        aria-label={`${label} ${pre ? 'pre-fader' : 'post-fader'}`}
        onClick={() => void props.command('setSend', { trackId: props.track.id, busId: props.bus.id, preFader: !pre })}
      >{pre ? 'Pre' : 'Post'}</button>
    </div>
  )
}

function NameField(props: { value: string, label: string, onCommit: (name: string) => void }) {
  const [name, setName] = useState(props.value)
  useEffect(() => setName(props.value), [props.value])
  return (
    <input
      className="strip-name"
      aria-label={`${props.label} name`}
      title={props.value}
      value={name}
      onChange={(event) => setName(event.target.value)}
      onBlur={() => {
        const next = name.trim()
        if (next.length > 0 && next !== props.value)
          props.onCommit(next)
        else
          setName(props.value)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter')
          event.currentTarget.blur()
      }}
    />
  )
}

function busReaches(buses: BusState[], start: string, target: string): boolean {
  let at = start
  for (let steps = 0; steps <= buses.length; steps++) {
    if (at === target)
      return true
    const bus = buses.find((item) => item.id === at)
    if (bus == null)
      return false
    at = bus.output
  }
  return true
}

function FxButton(props: { label: string, count: number, selected: boolean, onSelect: () => void }) {
  return (
    <button
      className={`fx-button${props.count > 0 ? ' active' : ''}`}
      aria-pressed={props.selected}
      aria-label={`${props.label} effects (${props.count})`}
      title={`Show the ${props.label} effect rack (${props.count} effect${props.count === 1 ? '' : 's'})`}
      onClick={props.onSelect}
    >FX{props.count > 0 ? ` ${props.count}` : ''}</button>
  )
}

function ParamSlider(props: { effect: EffectState, spec: ParamSpec, label: string, lanes?: AutomationLaneState[], command: Command }) {
  const { effect, spec } = props
  const automated = isAutomated(props.lanes, `fx:${effect.id}:${spec.name}`)
  const [value, change, flush] = useLiveValue(effect.params[spec.name] ?? spec.defaultValue, (next) => {
    void props.command('setEffect', { effectId: effect.id, params: { [spec.name]: next } })
  })
  return (
    <label className={`fx-param${automated ? ' automated' : ''}`} title={automated ? `${spec.label}: ${automatedHint}` : `${spec.label}: ${formatParam(spec, value)} (double-click to reset)`}>
      <span>{spec.label}</span>
      <input
        type="range"
        min={0}
        max={sliderSteps}
        step={1}
        value={toSlider(spec, value)}
        disabled={automated}
        aria-label={`${props.label} ${spec.label}`}
        aria-valuetext={automated ? 'automated' : formatParam(spec, value)}
        onChange={(event) => change(fromSlider(spec, Number(event.target.value)))}
        onPointerUp={flush}
        onKeyUp={flush}
        onDoubleClick={() => { if (!automated) { change(spec.defaultValue); flush() } }}
      />
      <output>{automated ? 'A · Auto' : formatParam(spec, value)}</output>
    </label>
  )
}

function EffectCard(props: {
  effect: EffectState
  index: number
  count: number
  owner: string
  target: EffectTarget
  ownerId: string
  sampleRate: number
  reduction?: number
  lanes?: AutomationLaneState[]
  command: Command
}) {
  const { effect, index, command } = props
  const spec = effectSpec(effect.type)
  const label = `${props.owner} ${spec.label} ${index + 1}`
  const reduction = Math.max(0, props.reduction ?? 0)
  return (
    <section className={`fx-card${effect.enabled ? '' : ' bypassed'}`} aria-label={`${label} effect`}>
      <div className="fx-card-head">
        <button
          className="fx-power"
          aria-pressed={effect.enabled}
          aria-label={`${label} enabled`}
          title={effect.enabled ? 'Active. Click to bypass.' : 'Bypassed. Click to activate.'}
          onClick={() => void command('setEffect', { effectId: effect.id, enabled: !effect.enabled })}
        >{effect.enabled ? 'On' : 'Off'}</button>
        <span className="fx-title" title={spec.label}>{index + 1}. {spec.label}</span>
        <button aria-label={`Move ${label} up`} title="Move earlier in the chain" disabled={index === 0} onClick={() => void command('moveEffect', { effectId: effect.id, index: index - 1 })}>↑</button>
        <button aria-label={`Move ${label} down`} title="Move later in the chain" disabled={index === props.count - 1} onClick={() => void command('moveEffect', { effectId: effect.id, index: index + 1 })}>↓</button>
        <button aria-label={`Remove ${label}`} title="Remove effect" onClick={() => void command('removeEffect', { effectId: effect.id })}>✕</button>
      </div>
      {spec.reduction === true && effect.type !== 'compressor' && effect.type !== 'limiter' ? (
        <div className="fx-gr" title="Gain reduction" aria-label={`${label} gain reduction`}>
          <span className="fx-gr-label">{effect.enabled ? 'GR' : 'BYP'}</span>
          <div className="fx-gr-bar"><span style={{ width: `${effect.enabled ? Math.min(1, reduction / 24) * 100 : 0}%` }} /></div>
          <output>{!effect.enabled ? 'bypassed' : reduction >= 0.05 ? `-${reduction.toFixed(1)} dB` : '0.0 dB'}</output>
        </div>
      ) : null}
      {effect.type === 'eq' ? (
        <ParametricEqEditor
          effect={effect}
          sampleRate={props.sampleRate}
          target={props.target}
          ownerId={props.ownerId}
          command={command}
          label={label}
        />
      ) : effect.type === 'compressor' || effect.type === 'limiter' ? (
        <DynamicsEditor
          effect={effect}
          kind={effect.type}
          reduction={reduction}
          command={command}
          label={label}
        />
      ) : (
        <div className="fx-params">
          {spec.params.map((item) => <ParamSlider key={item.name} effect={effect} spec={item} label={label} lanes={props.lanes} command={command} />)}
        </div>
      )}
    </section>
  )
}

function FxRack(props: {
  target: EffectTarget
  ownerId: string
  owner: string
  effects: EffectState[]
  lanes: AutomationLaneState[]
  effectMeters: Record<string, number>
  sampleRate: number
  command: Command
}) {
  const { effects, command } = props
  const full = effects.length >= maxEffectsPerChain
  const where = props.target === 'track' ? 'before the fader and sends' : props.target === 'bus' ? 'on the summed bus, before its fader' : 'on the master, before the master fader'
  return (
    <aside className="fx-rack" aria-label={`${props.owner} effect rack`}>
      <div className="fx-head">
        <h2 title={`${props.owner} insert effects run ${where}`}>FX · {props.owner}</h2>
        <select
          aria-label={`Add effect to ${props.owner}`}
          value=""
          disabled={full}
          title={full ? `A chain holds at most ${maxEffectsPerChain} effects` : 'Add an effect at the end of the chain'}
          onChange={(event) => {
            if (event.target.value !== '')
              void command('addEffect', { target: props.target, ownerId: props.ownerId, type: event.target.value })
          }}
        >
          <option value="">{full ? 'Chain full' : '+ Add effect'}</option>
          {effectSpecs.map((spec) => <option key={spec.type} value={spec.type}>{spec.label}</option>)}
        </select>
      </div>
      <div className="fx-list">
        {effects.length === 0 ? <p className="hint">No effects. Inserts run {where}, top to bottom.</p> : null}
        {effects.map((effect, index) => (
          <EffectCard
            key={effect.id}
            effect={effect}
            index={index}
            count={effects.length}
            owner={props.owner}
            target={props.target}
            ownerId={props.ownerId}
            sampleRate={props.sampleRate}
            reduction={props.effectMeters[effect.id]}
            lanes={props.lanes}
            command={command}
          />
        ))}
      </div>
    </aside>
  )
}

function TrackStrip(props: { track: TrackState, buses: BusState[], metersAvailable: boolean, command: Command, onResetClips: () => void, selected: boolean, onSelect: () => void }) {
  const { track, buses, command } = props
  const label = track.name || track.id
  const groups = buses.filter((bus) => bus.kind === 'group')
  const returns = buses.filter((bus) => bus.kind === 'return')
  const [pan, changePan, flushPan] = useLiveValue(track.pan, (next) => void command('setTrack', { trackId: track.id, pan: next }))
  const volumeAuto = isAutomated(track.automation, 'volume')
  const panAuto = isAutomated(track.automation, 'pan')
  return (
    <section className={`strip${props.selected ? ' selected' : ''}`} aria-label={`${label} channel strip`} data-strip-track={track.id}>
      <NameField value={label} label={label} onCommit={(name) => void command('renameTrack', { trackId: track.id, name })} />
      <select className="strip-output" title="Main output" aria-label={`${label} output`} value={track.output || masterBusId} onChange={(event) => void command('setTrack', { trackId: track.id, output: event.target.value })}>
        <option value={masterBusId}>→ Master</option>
        {groups.map((bus) => <option key={bus.id} value={bus.id}>→ {bus.name}</option>)}
      </select>
      <div className="sends" aria-label={`${label} sends`}>
        <span className="strip-kind">{track.missing ? 'Track · missing media' : track.clips.length === 0 ? 'Track · empty' : 'Track · sends'}</span>
        {returns.length === 0 ? <span className="hint">No return buses</span> : returns.map((bus) => (
          <SendRow key={bus.id} track={track} bus={bus} send={track.sends?.find((send) => send.bus === bus.id)} command={command} />
        ))}
      </div>
      <label className={`strip-pan${panAuto ? ' automated' : ''}`} title={panAuto ? automatedHint : undefined}>
        <span>{panAuto ? 'A' : pan === 0 ? 'C' : pan < 0 ? `L${Math.round(-pan * 100)}` : `R${Math.round(pan * 100)}`}</span>
        <input
          type="range"
          min={-1}
          max={1}
          step={0.01}
          value={pan}
          disabled={panAuto}
          aria-label={`${label} pan`}
          data-action="strip-pan"
          onChange={(event) => changePan(Number(event.target.value))}
          onPointerUp={flushPan}
          onKeyUp={flushPan}
          onDoubleClick={() => { if (!panAuto) { changePan(0); flushPan() } }}
        />
      </label>
      <div className="fader-row">
        <Fader gain={track.gain} label={label} automated={volumeAuto} onCommit={(gain) => void command('setTrack', { trackId: track.id, gain })} />
        <Meter meterKey={`t:${track.id}`} label={label} onReset={props.onResetClips} available={props.metersAvailable} />
      </div>
      <div className="strip-buttons">
        <button aria-pressed={track.mute} aria-label={`${label} mute`} data-action="strip-mute" data-track-id={track.id} onClick={() => void command('setTrack', { trackId: track.id, mute: !track.mute })}>M</button>
        <button aria-pressed={track.solo} aria-label={`${label} solo`} data-action="strip-solo" data-track-id={track.id} onClick={() => void command('setTrack', { trackId: track.id, solo: !track.solo })}>S</button>
        <FxButton label={label} count={track.effects?.length ?? 0} selected={props.selected} onSelect={props.onSelect} />
      </div>
    </section>
  )
}

function BusStrip(props: { bus: BusState, buses: BusState[], metersAvailable: boolean, command: Command, onResetClips: () => void, selected: boolean, onSelect: () => void }) {
  const { bus, buses, command } = props
  const targets = buses.filter((other) => other.kind === 'group' && other.id !== bus.id && !busReaches(buses, other.id, bus.id))
  return (
    <section className={`strip bus ${bus.kind}${props.selected ? ' selected' : ''}`} aria-label={`${bus.name} ${bus.kind} bus strip`} data-strip-bus={bus.id}>
      <NameField value={bus.name} label={bus.name} onCommit={(name) => void command('renameBus', { busId: bus.id, name })} />
      <select className="strip-output" title="Bus output" aria-label={`${bus.name} output`} value={bus.output || masterBusId} onChange={(event) => void command('setBus', { busId: bus.id, output: event.target.value })}>
        <option value={masterBusId}>→ Master</option>
        {targets.map((other) => <option key={other.id} value={other.id}>→ {other.name}</option>)}
      </select>
      <div className="sends">
        <span className="strip-kind">{bus.kind === 'group' ? 'Group bus' : 'Return bus'}</span>
        <span className="hint">{bus.kind === 'return' ? 'Receives track sends' : 'Sums routed tracks'}</span>
      </div>
      <div className="strip-pan" />
      <div className="fader-row">
        <Fader gain={bus.gain} label={bus.name} automated={isAutomated(bus.automation, 'volume')} onCommit={(gain) => void command('setBus', { busId: bus.id, gain })} />
        <Meter meterKey={`b:${bus.id}`} label={bus.name} onReset={props.onResetClips} available={props.metersAvailable} />
      </div>
      <div className="strip-buttons">
        <button aria-pressed={bus.mute} aria-label={`${bus.name} mute`} data-action="bus-mute" data-bus-id={bus.id} onClick={() => void command('setBus', { busId: bus.id, mute: !bus.mute })}>M</button>
        <button aria-pressed={bus.solo} aria-label={`${bus.name} solo`} data-action="bus-solo" data-bus-id={bus.id} onClick={() => void command('setBus', { busId: bus.id, solo: !bus.solo })}>S</button>
        <FxButton label={bus.name} count={bus.effects?.length ?? 0} selected={props.selected} onSelect={props.onSelect} />
        <button aria-label={`Remove ${bus.name}`} title="Remove bus. Its inputs move to its output." onClick={() => void command('removeBus', { busId: bus.id })}>✕</button>
      </div>
    </section>
  )
}

export function Mixer(props: {
  state: EngineState | null
  effectMeters: Record<string, number>
  command: Command
  exportReady?: boolean
  onBackToEditor?: () => void
  onExport?: () => void
}) {
  const tracks = props.state?.tracks ?? []
  const buses = props.state?.buses ?? []
  const groups = buses.filter((bus) => bus.kind === 'group')
  const returns = buses.filter((bus) => bus.kind === 'return')
  const metersAvailable = props.state != null && props.state.deviceOpen === true
  const resetClips = (): void => { void props.command('resetClips') }
  const scrollRef = useRef<HTMLDivElement>(null)
  const [selection, setSelection] = useState<{ target: EffectTarget, id: string }>({ target: 'master', id: masterBusId })
  const selectedTrack = selection.target === 'track' ? tracks.find((track) => track.id === selection.id) : undefined
  const selectedBus = selection.target === 'bus' ? buses.find((bus) => bus.id === selection.id) : undefined
  const rack = selectedTrack != null
    ? { target: 'track' as const, id: selectedTrack.id, owner: selectedTrack.name || selectedTrack.id, effects: selectedTrack.effects ?? [], lanes: selectedTrack.automation ?? [] }
    : selectedBus != null
      ? { target: 'bus' as const, id: selectedBus.id, owner: selectedBus.name, effects: selectedBus.effects ?? [], lanes: selectedBus.automation ?? [] }
      : { target: 'master' as const, id: masterBusId, owner: 'Master', effects: props.state?.masterEffects ?? [], lanes: props.state?.masterAutomation ?? [] }
  const isSelected = (target: EffectTarget, id: string): boolean => rack.target === target && rack.id === id
  return (
    <section className="mixer panel" aria-label="Mixer" data-panel="mixer-ux-273">
      <div className="mixer-integration" data-mixer-integration-275>
        <p className="hint">
          Mixing continues the Recording → Mix → Export workflow. Track and Master meters are post-fader;
          Unavailable when the audio stream is closed. Export uses the same committed mixer path as the devices bar.
        </p>
        <div className="mixer-integration-actions">
          {props.onBackToEditor != null && (
            <button type="button" data-action="mixer-back-editor" onClick={props.onBackToEditor}>Back to Editor</button>
          )}
          {props.onExport != null && (
            <button
              type="button"
              data-action="mixer-export-wav"
              data-export-ready={props.exportReady === true ? 'true' : 'false'}
              disabled={props.exportReady !== true}
              title={props.exportReady === true ? 'Export mix WAV' : 'Record/import audio and clear vocal previews before export'}
              onClick={props.onExport}
            >Export WAV</button>
          )}
          <span className="hint" data-mixer-meters-available={metersAvailable ? 'true' : 'false'}>
            Meters: {metersAvailable ? 'available' : 'unavailable (device closed)'}
          </span>
        </div>
      </div>
      <div className="mixer-toolbar">
        <button onClick={() => void props.command('addBus', { kind: 'group' })}>Add group bus</button>
        <button onClick={() => void props.command('addBus', { kind: 'return' })}>Add return bus</button>
        <button data-action="clear-peaks" onClick={resetClips} title="Clear peak hold and clip indicators on all strips">Clear peaks</button>
        <span className="hint">{tracks.length} tracks · {groups.length} groups · {returns.length} returns · meters: post-fader Peak/RMS dBFS (inserts before fader on tracks/buses/master)</span>
      </div>
      <div className="mixer-body">
        <div
          className="mixer-scroll"
          ref={scrollRef}
          onWheel={(event) => {
            const element = scrollRef.current
            if (element == null || event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY))
              return
            const target = event.target as HTMLElement
            if (target.tagName === 'INPUT' || target.tagName === 'SELECT')
              return
            element.scrollLeft += event.deltaY
          }}
        >
          {tracks.length === 0 ? <p className="hint mixer-empty">No tracks yet. Use Add track or Import WAV in the editor.</p> : null}
          {tracks.map((track) => (
            <TrackStrip key={track.id} track={track} buses={buses} metersAvailable={metersAvailable} command={props.command} onResetClips={resetClips}
              selected={isSelected('track', track.id)} onSelect={() => setSelection({ target: 'track', id: track.id })} />
          ))}
          {groups.length + returns.length > 0 ? <div className="strip-divider" aria-hidden="true" /> : null}
          {[...groups, ...returns].map((bus) => (
            <BusStrip key={bus.id} bus={bus} buses={buses} metersAvailable={metersAvailable} command={props.command} onResetClips={resetClips}
              selected={isSelected('bus', bus.id)} onSelect={() => setSelection({ target: 'bus', id: bus.id })} />
          ))}
        </div>
        <section className={`strip master${isSelected('master', masterBusId) ? ' selected' : ''}`} aria-label="Master strip" data-strip-master>
          <span className="strip-name static">Master</span>
          <span className="strip-kind master-out">Stereo out</span>
          <div className="sends"><span className="hint">{props.state?.outputDevice || 'No output'}</span></div>
          <div className="strip-pan" />
          <div className="fader-row">
            <Fader gain={props.state?.masterGain ?? 1} label="Master" automated={isAutomated(props.state?.masterAutomation, 'volume')} onCommit={(gain) => void props.command('setMaster', { gain })} />
            <Meter meterKey={null} label="Master" onReset={resetClips} available={metersAvailable} />
          </div>
          <div className="strip-buttons">
            <FxButton label="Master" count={props.state?.masterEffects?.length ?? 0} selected={isSelected('master', masterBusId)} onSelect={() => setSelection({ target: 'master', id: masterBusId })} />
            <button type="button" data-action="master-clear-peaks" onClick={resetClips} title="Clear peak hold and clip indicators">Clear peaks</button>
          </div>
        </section>
        <FxRack
          target={rack.target}
          ownerId={rack.id}
          owner={rack.owner}
          effects={rack.effects}
          lanes={rack.lanes}
          effectMeters={props.effectMeters}
          sampleRate={props.state?.sampleRate ?? 48000}
          command={props.command}
        />
      </div>
    </section>
  )
}
