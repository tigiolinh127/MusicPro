import fs from 'fs'
import path from 'path'
import { EngineHost } from './engineHost'

interface Check { scenario: string, result: 'PASS' | 'FAIL' | 'NOT RUN', detail: string }

export interface EngineHostEpipeCheckOptions {
  outDir: string
  enginePath: string | null
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function runEngineHostEpipeCheck(options: EngineHostEpipeCheckOptions): Promise<number> {
  const { outDir, enginePath } = options
  fs.mkdirSync(outDir, { recursive: true })
  const checks: Check[] = []
  const uncaught: string[] = []

  function record(scenario: string, ok: boolean, detail: string): void {
    checks.push({ scenario, result: ok ? 'PASS' : 'FAIL', detail })
  }

  const onUncaught = (error: Error): void => {
    uncaught.push(error.stack ?? error.message)
  }
  const onRejection = (reason: unknown): void => {
    uncaught.push(reason instanceof Error ? (reason.stack ?? reason.message) : String(reason))
  }
  process.on('uncaughtException', onUncaught)
  process.on('unhandledRejection', onRejection)

  try {
    if (enginePath == null || !fs.existsSync(enginePath)) {
      record('engine executable present', false, enginePath ?? 'null')
    } else {
      record('engine executable present', true, enginePath)

      const host = new EngineHost(enginePath)
      record('EngineHost started', host.startupError == null, host.startupError ?? 'ok')

      const ping = await host.request('ping', {}, 5000).then(
        (response) => ({ ok: response.ok === true, detail: JSON.stringify(response) }),
        (error: Error) => ({ ok: false, detail: error.message })
      )
      record('ping before close', ping.ok, ping.detail)

      // Force-close the child so stdin becomes a broken pipe (simulates engine crash/exit).
      host.forceKill()
      await wait(400)

      const afterKill = await host.request('ping', {}, 2000).then(
        (response) => ({ ok: false, detail: `unexpected ok response: ${JSON.stringify(response)}` }),
        (error: Error) => ({
          ok: error.message === 'The audio engine is not running.' || error.message === 'The audio engine stopped.',
          detail: error.message,
          rawEpipe: /EPIPE|write EPIPE|ERR_STREAM/i.test(error.message)
        })
      )
      record('request after child death rejects cleanly', afterKill.ok && !(afterKill as { rawEpipe?: boolean }).rawEpipe,
        afterKill.detail)
      record('rejected message is not raw EPIPE', !(afterKill as { rawEpipe?: boolean }).rawEpipe, afterKill.detail)

      const second = await host.request('getState', {}, 2000).then(
        () => ({ ok: false, detail: 'unexpected success' }),
        (error: Error) => ({ ok: true, detail: error.message })
      )
      record('repeated request after death stays safe', second.ok, second.detail)

      await host.shutdown()
      record('shutdown after death is safe', true, 'returned')

      // Fresh host: graceful shutdown, then ensure no EPIPE crash on follow-up.
      const host2 = new EngineHost(enginePath)
      await host2.request('ping', {}, 5000)
      await host2.shutdown()
      await wait(200)
      const afterShutdown = await host2.request('ping', {}, 2000).then(
        () => ({ ok: false, detail: 'unexpected success' }),
        (error: Error) => ({
          ok: !/EPIPE|write EPIPE/i.test(error.message),
          detail: error.message
        })
      )
      record('request after graceful shutdown rejects without EPIPE', afterShutdown.ok, afterShutdown.detail)
    }

    record('no uncaughtException / unhandledRejection', uncaught.length === 0,
      uncaught.length === 0 ? 'none' : uncaught.join(' | '))
    checks.push({ scenario: 'live microphone', result: 'NOT RUN', detail: 'NOT RUN — NO HARDWARE' })
  } catch (error) {
    record('epipe check crashed', false, error instanceof Error ? error.message : String(error))
  } finally {
    process.off('uncaughtException', onUncaught)
    process.off('unhandledRejection', onRejection)
  }

  const summary = {
    pass: checks.filter((c) => c.result === 'PASS').length,
    fail: checks.filter((c) => c.result === 'FAIL').length,
    notRun: checks.filter((c) => c.result === 'NOT RUN').length,
    checks
  }
  fs.writeFileSync(path.join(outDir, 'engine-host-epipe-summary.json'), JSON.stringify(summary, null, 2))
  console.log(`ENGINE_HOST_EPIPE_CHECK pass=${summary.pass} fail=${summary.fail} not_run=${summary.notRun}`)
  for (const check of checks)
    console.log(`${check.result}\t${check.scenario}\t${check.detail}`)
  return summary.fail === 0 ? 0 : 1
}
