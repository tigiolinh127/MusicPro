import { ChildProcessWithoutNullStreams, spawn } from 'child_process'
import type { EngineEvent, EngineResponse } from './protocol'

type Pending = {
  resolve: (value: EngineResponse) => void
  reject: (reason: Error) => void
  timer: NodeJS.Timeout
}

function isPipeClosedError(error: unknown): boolean {
  if (error == null || typeof error !== 'object')
    return false
  const code = (error as NodeJS.ErrnoException).code
  return code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED' || code === 'ERR_STREAM_WRITE_AFTER_END'
}

function engineUnavailableError(error?: unknown): Error {
  if (error instanceof Error && !isPipeClosedError(error) && error.message.length > 0
      && !error.message.includes('EPIPE') && !error.message.includes('write after end'))
    return error
  return new Error('The audio engine is not running.')
}

export class EngineHost {
  private readonly process: ChildProcessWithoutNullStreams
  private readonly pending = new Map<string, Pending>()
  private buffer = ''
  private sequence = 0
  private closed = false
  readonly startupError: string | null

  onEvent: (event: EngineEvent) => void = () => {}
  onExit: (code: number | null) => void = () => {}

  constructor(exePath: string | null) {
    if (exePath == null) {
      this.startupError = 'The native audio engine executable was not found. Build it with scripts/build-engine.ps1.'
      this.process = null as unknown as ChildProcessWithoutNullStreams
      return
    }
    this.startupError = null
    this.process = spawn(exePath, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    this.process.stdout.setEncoding('utf8')
    this.process.stdout.on('data', (chunk: string) => this.consume(chunk))
    this.process.stderr.setEncoding('utf8')
    this.process.stderr.on('data', (chunk: string) => {
      process.stderr.write(`[audio-engine] ${chunk}`)
    })
    // Without this listener, a write to a closed stdin raises an uncaught 'error' (EPIPE)
    // and can crash the Electron main process.
    this.process.stdin.on('error', (error) => {
      this.failAllPending(engineUnavailableError(error))
      this.closed = true
      if (!isPipeClosedError(error))
        this.onEvent({ v: 1, event: 'error', message: error.message })
    })
    this.process.on('exit', (code) => {
      this.closed = true
      this.failAllPending(new Error('The audio engine stopped.'))
      this.onExit(code)
    })
    this.process.on('error', (error) => {
      this.startupErrorText = error.message
      this.closed = true
      this.failAllPending(engineUnavailableError(error))
      this.onEvent({ v: 1, event: 'error', message: error.message })
    })
  }

  private startupErrorText: string | null = null

  private failAllPending(error: Error): void {
    for (const [id, waiter] of this.pending) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
      this.pending.delete(id)
    }
  }

  private canWrite(): boolean {
    if (this.closed || this.process == null)
      return false
    const stdin = this.process.stdin
    return stdin != null && !stdin.destroyed && stdin.writable
  }

  request(op: string, payload: Record<string, unknown> = {}, timeoutMs = 10000): Promise<EngineResponse> {
    if (this.startupError != null || this.process == null)
      return Promise.reject(new Error(this.startupError ?? 'The audio engine is not running.'))
    if (!this.canWrite())
      return Promise.reject(new Error('The audio engine is not running.'))
    const id = `ui-${++this.sequence}`
    const message = { v: 1, id, op, ...payload }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`The audio engine did not answer "${op}" in time.`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.process.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
          if (error) {
            clearTimeout(timer)
            this.pending.delete(id)
            this.closed = true
            reject(engineUnavailableError(error))
          }
        })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        this.closed = true
        reject(engineUnavailableError(error))
      }
    })
  }

  /** Abruptly terminate the child (tests / recovery). Prefer `shutdown()` for normal exit. */
  forceKill(): void {
    if (this.process == null)
      return
    try {
      this.process.kill()
    } catch {
      // already gone
    }
  }

  async shutdown(): Promise<void> {
    if (this.closed || this.process == null)
      return
    try {
      await this.request('shutdown', {}, 3000)
    } catch {
      // The process can exit before the response is delivered, or stdin may already be closed.
    }
    if (!this.closed)
      this.forceKill()
    // Give the exit handler a moment; callers (GUI checks) may exit the app next.
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
  }

  private consume(chunk: string): void {
    this.buffer += chunk
    let newline = this.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '')
      this.buffer = this.buffer.slice(newline + 1)
      if (line.trim().length > 0)
        this.dispatch(line)
      newline = this.buffer.indexOf('\n')
    }
  }

  private dispatch(line: string): void {
    let message: EngineResponse & Partial<EngineEvent>
    try {
      message = JSON.parse(line) as EngineResponse & Partial<EngineEvent>
    } catch {
      this.onEvent({ v: 1, event: 'error', message: 'The audio engine sent a response that was not valid JSON.' })
      return
    }
    if (typeof message.event === 'string') {
      this.onEvent(message as EngineEvent)
      return
    }
    if (typeof message.id === 'string' && this.pending.has(message.id)) {
      const waiter = this.pending.get(message.id)
      if (waiter == null)
        return
      clearTimeout(waiter.timer)
      this.pending.delete(message.id)
      if (typeof message.ok !== 'boolean') {
        waiter.reject(new Error('The audio engine returned a response without an ok flag.'))
        return
      }
      waiter.resolve(message)
      return
    }
    this.onEvent({ v: 1, event: 'error', message: 'The audio engine returned a response that did not match a command.' })
  }
}
