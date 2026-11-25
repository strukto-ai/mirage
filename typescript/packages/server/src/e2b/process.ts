import { atDeadline, hasAborted, runWithDeadline } from '@struktoai/mirage-core/utils/abort'
import { encodeBase64 } from '@struktoai/mirage-core/utils/base64'
import type { ShellExecution } from '@struktoai/mirage-core/workspace/shell_execution'
import { HttpError } from '../errors.ts'
import type { WorkspaceRegistry } from '../registry.ts'
import { streamOf, type RouteApp, type RouteReply } from '../routes.ts'
import {
  decodeStart,
  encodeMessage,
  endStream,
  InvalidConnectRequest,
  type StartCommand,
} from './connect.ts'
import type { Sandboxes, SandboxLease } from './leases.ts'

const START = '/process.Process/Start'
export const CONNECT_STREAM = 'application/connect+json'

export function isProcessStart(method: string, path: string): boolean {
  return method === 'POST' && path === START
}

function requestTimeout(raw: string | undefined): number | null {
  if (raw === undefined) return null
  if (!/^\d{1,10}$/.test(raw)) {
    throw new HttpError('invalid_request', 'invalid Connect timeout')
  }
  return Number(raw) / 1000
}

function events(
  lease: SandboxLease,
  command: StartCommand,
  timeout: number | null,
  pid: number,
  closed: AbortSignal,
  reply: RouteReply,
): RouteReply {
  const canceled = new AbortController()
  const connection = AbortSignal.any([closed, canceled.signal])
  const deadline = new AbortController()
  const expire = (): void => {
    deadline.abort(new DOMException('command deadline exceeded', 'TimeoutError'))
  }
  const signal = AbortSignal.any([connection, deadline.signal])
  const { runner } = lease.entry

  async function* events(): AsyncGenerator<Uint8Array> {
    if (hasAborted(connection)) return
    if (timeout === 0) {
      yield endStream('deadline_exceeded', 'command deadline exceeded')
      return
    }
    const disarm = timeout === null ? undefined : atDeadline(timeout, expire)
    let execution: ShellExecution | undefined
    try {
      execution = await runWithDeadline(timeout, expire, () =>
        runner.ws.shell(command.line, {
          sessionId: runner.ws.defaultSessionId,
          cwd: command.cwd ?? '/home/user',
          env: { ...lease.envVars, ...command.envs },
          signal,
          stream: true,
        }),
      )
      yield encodeMessage({ start: { pid } })
      for await (const event of execution.events) {
        if (signal.aborted) break
        yield encodeMessage({ data: { [event.stream]: encodeBase64(event.data) } })
      }
      const { exitCode } = await execution.wait()
      if (hasAborted(connection)) return
      if (deadline.signal.aborted) {
        yield endStream('deadline_exceeded', 'command deadline exceeded')
        return
      }
      disarm?.()
      yield encodeMessage({
        end: { exitCode, exited: true, status: `exit status ${String(exitCode)}` },
      })
      yield endStream()
    } catch (error) {
      if (hasAborted(connection)) return
      if (deadline.signal.aborted) {
        yield endStream('deadline_exceeded', 'command deadline exceeded')
      } else if (
        !lease.entry.acceptingJobs ||
        (error instanceof Error && error.name === 'AbortError')
      ) {
        yield endStream('canceled', 'command canceled')
      } else {
        console.error(`sandbox ${lease.entry.id} command failed:`, error)
        yield endStream('internal', 'command failed')
      }
    } finally {
      disarm?.()
      await execution?.close()
    }
  }

  return reply.type(CONNECT_STREAM).send(
    streamOf(events(), () => {
      canceled.abort()
    }),
  )
}

export function registerProcess(
  app: RouteApp,
  sandboxes: Sandboxes,
  registry: WorkspaceRegistry,
): void {
  let nextPid = 0
  app.post(START, (req, reply) => {
    const lease = sandboxes.requireAccess(req.headers)
    const contentType = req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
    if (contentType !== CONNECT_STREAM || !(req.body instanceof Uint8Array)) {
      throw new HttpError('invalid_request', 'expected a Connect JSON stream')
    }
    const timeout = requestTimeout(req.headers['connect-timeout-ms'])
    let command
    try {
      command = decodeStart(req.body)
    } catch (error) {
      if (!(error instanceof InvalidConnectRequest)) throw error
      throw new HttpError('invalid_request', error.message, { cause: error })
    }
    if (registry.draining) throw new HttpError('shutting_down', 'server is shutting down')
    nextPid = (nextPid % 0xffffffff) + 1
    return events(lease, command, timeout, nextPid, req.closed, reply)
  })
}
