import { PipeClosed } from '@struktoai/mirage-core/io/errors'
import { BytePipe, CAPACITY } from '@struktoai/mirage-core/io/pipe'
import { atDeadline, hasAborted, runWithDeadline } from '@struktoai/mirage-core/utils/abort'
import { decodeBase64, encodeBase64 } from '@struktoai/mirage-core/utils/base64'
import { z } from '@struktoai/mirage-core/vfs/secrets'
import type { ShellExecution } from '@struktoai/mirage-core/workspace/shell_execution'
import { HttpError } from '../errors.ts'
import { MAX_REQUEST_PART } from '../multipart.ts'
import type { WorkspaceRegistry } from '../registry.ts'
import { streamOf, type RouteApp, type RouteReply, type RouteRequest } from '../routes.ts'
import { closeUnreadBody, readBody, readJsonBody, unaryContentType } from './body.ts'
import {
  decodeStart,
  encodeMessage,
  endStream,
  InvalidConnectRequest,
  UnsupportedProcessOption,
  type StartCommand,
} from './connect.ts'
import type { LiveProcess, Sandboxes, SandboxLease } from './leases.ts'

const PROCESS_PREFIX = '/process.Process/'
const START = PROCESS_PREFIX + 'Start'
const CONTROL_METHODS = ['List', 'SendInput', 'CloseStdin', 'SendSignal'] as const
const PROCESS_PATHS = new Set([START, ...CONTROL_METHODS.map((method) => PROCESS_PREFIX + method)])
export const CONNECT_STREAM = 'application/connect+json'
const DEADLINE_MESSAGE = 'command deadline exceeded'
const MAX_CONTROL_BODY = 2 * CAPACITY
const List = z.object({})
const Selector = z.object({
  process: z.object({ pid: z.number().int().min(1).max(0xffffffff), tag: z.null().optional() }),
})
const Input = z.object({
  input: z.object({
    stdin: z.string().regex(/^[A-Za-z0-9+/_-]*={0,2}$/),
    pty: z.null().optional(),
  }),
})
const KillSignal = z.object({ signal: z.union([z.literal(9), z.literal('SIGNAL_SIGKILL')]) })

export function isProcessStart(method: string, path: string): boolean {
  return method === 'POST' && path === START
}

export function isProcessRequest(method: string, path: string): boolean {
  return method === 'POST' && PROCESS_PATHS.has(path)
}

function requestDeadline(request: RouteRequest): number | null {
  const raw = request.headers['connect-timeout-ms']
  if (raw === undefined) return null
  if (!/^\d{1,10}$/.test(raw)) {
    throw new HttpError('invalid_request', 'invalid Connect timeout')
  }
  return performance.now() + Number(raw)
}

function timeLeft(deadline: number | null): number | null {
  return deadline === null ? null : Math.max(0, deadline - performance.now()) / 1000
}

async function readStart(request: RouteRequest, signal: AbortSignal): Promise<StartCommand> {
  return decodeStart(await readBody(request, signal, MAX_REQUEST_PART, 'command request too large'))
}

function events(
  lease: SandboxLease,
  command: StartCommand,
  deadlineAt: number | null,
  pid: number,
  closed: AbortSignal,
  reply: RouteReply,
): RouteReply {
  const canceled = new AbortController()
  const connection = AbortSignal.any([closed, canceled.signal])
  const deadline = new AbortController()
  const expire = (): void => {
    deadline.abort(new DOMException(DEADLINE_MESSAGE, 'TimeoutError'))
  }
  const signal = AbortSignal.any([connection, deadline.signal])
  const { runner } = lease.entry

  async function* events(): AsyncGenerator<Uint8Array> {
    if (hasAborted(connection)) return
    const timeout = timeLeft(deadlineAt)
    if (timeout === 0) {
      yield endStream('deadline_exceeded', DEADLINE_MESSAGE)
      return
    }
    const disarm = timeout === null ? undefined : atDeadline(timeout, expire)
    let execution: ShellExecution | undefined
    let process: LiveProcess | undefined
    const stdin = command.stdin ? new BytePipe() : undefined
    try {
      execution = await runWithDeadline(timeout, expire, () => {
        if (!lease.entry.acceptingJobs || lease.expiresAt <= performance.now()) {
          throw new DOMException('command canceled', 'AbortError')
        }
        return runner.ws.shell(command.line, {
          sessionId: runner.ws.defaultSessionId,
          cwd: command.cwd ?? '/home/user',
          env: { ...lease.envVars, ...command.envs },
          ...(stdin === undefined ? {} : { stdin: stdin.stream() }),
          signal,
          stream: true,
        })
      })
      process = { command, execution, stdin, killed: false }
      lease.processes.set(pid, process)
      execution.onSettled(() => {
        lease.processes.delete(pid)
        stdin?.closeReader()
      })
      yield encodeMessage({ start: { pid } })
      for await (const event of execution.events) {
        if (signal.aborted) break
        yield encodeMessage({ data: { [event.stream]: encodeBase64(event.data) } })
      }
      const { exitCode } = await execution.wait()
      if (hasAborted(connection)) return
      if (deadline.signal.aborted || timeLeft(deadlineAt) === 0) {
        yield endStream('deadline_exceeded', DEADLINE_MESSAGE)
        return
      }
      disarm?.()
      yield encodeMessage({
        end: { exitCode, exited: true, status: 'exited' },
      })
      yield endStream()
    } catch (error) {
      if (hasAborted(connection)) return
      if (deadline.signal.aborted) {
        yield endStream('deadline_exceeded', DEADLINE_MESSAGE)
      } else if (process?.killed === true) {
        yield encodeMessage({ end: { exitCode: 137, exited: true, status: 'signal: killed' } })
        yield endStream()
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
      stdin?.closeReader()
      await execution?.close()
    }
  }

  return reply.type(CONNECT_STREAM).send(
    streamOf(events(), () => {
      canceled.abort()
    }),
  )
}

function failure(reply: RouteReply, status: number, code: string, message: string): RouteReply {
  return reply.code(status).send({ code, message })
}

async function control(
  lease: SandboxLease,
  method: (typeof CONTROL_METHODS)[number],
  body: unknown,
  reply: RouteReply,
): Promise<RouteReply> {
  if (method === 'List') {
    if (!List.safeParse(body).success) {
      return failure(reply, 400, 'invalid_argument', 'expected a command request')
    }
    const processes = [...lease.processes].flatMap(([pid, process]) => {
      if (process.killed) return []
      const { line, cwd, envs } = process.command
      return [
        {
          pid,
          config: {
            cmd: '/bin/bash',
            args: ['-l', '-c', line],
            envs,
            ...(cwd === null ? {} : { cwd }),
          },
        },
      ]
    })
    return reply.send({ processes })
  }
  const selector = Selector.safeParse(body)
  if (!selector.success) return failure(reply, 400, 'invalid_argument', 'expected a command PID')
  const process = lease.processes.get(selector.data.process.pid)
  if (process === undefined || process.killed) {
    return failure(reply, 404, 'not_found', 'command not found')
  }
  if (method === 'SendSignal') {
    if (!KillSignal.safeParse(body).success) {
      return failure(reply, 501, 'unimplemented', 'only SIGKILL is supported')
    }
    process.killed = true
    process.execution.cancel()
    process.stdin?.closeReader()
    return reply.send({})
  }
  const { stdin } = process
  if (stdin === undefined || stdin.closedReader) {
    return failure(reply, 400, 'failed_precondition', 'command stdin is closed')
  }
  if (method === 'CloseStdin') {
    stdin.end()
    process.stdin = undefined
    return reply.send({})
  }
  const input = Input.safeParse(body)
  let data: Uint8Array
  try {
    if (!input.success)
      return failure(reply, 400, 'invalid_argument', 'expected base64 stdin bytes')
    data = decodeBase64(input.data.input.stdin.replaceAll('-', '+').replaceAll('_', '/'))
  } catch (error) {
    if (!(error instanceof DOMException)) throw error
    return failure(reply, 400, 'invalid_argument', 'expected base64 stdin bytes')
  }
  if (data.length + stdin.bufferedBytes > CAPACITY) {
    return failure(reply, 429, 'resource_exhausted', 'command stdin buffer is full')
  }
  try {
    await stdin.write(data)
  } catch (error) {
    if (!(error instanceof PipeClosed)) throw error
    return failure(reply, 400, 'failed_precondition', 'command stdin is closed')
  }
  return reply.send({})
}

export function registerProcess(
  app: RouteApp,
  sandboxes: Sandboxes,
  registry: WorkspaceRegistry,
): void {
  let nextPid = 0
  app.post(START, async (req, reply) => {
    const uploadDeadline = new AbortController()
    const expire = (): void => {
      uploadDeadline.abort(new DOMException(DEADLINE_MESSAGE, 'TimeoutError'))
    }
    let disarm: (() => void) | undefined
    try {
      const lease = sandboxes.requireAccess(req.headers)
      const contentType = req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
      if (contentType !== CONNECT_STREAM) {
        throw new HttpError('invalid_request', 'expected a Connect JSON stream')
      }
      const deadline = requestDeadline(req)
      const remaining = timeLeft(deadline)
      if (remaining === 0) expire()
      else if (remaining !== null) disarm = atDeadline(remaining, expire)
      const command = await readStart(
        req,
        AbortSignal.any([req.closed, uploadDeadline.signal, lease.revoked]),
      )
      if (timeLeft(deadline) === 0) {
        return reply.type(CONNECT_STREAM).send(endStream('deadline_exceeded', DEADLINE_MESSAGE))
      }
      sandboxes.requireAccess(req.headers)
      if (registry.draining) throw new HttpError('shutting_down', 'server is shutting down')
      do {
        nextPid = (nextPid % 0xffffffff) + 1
      } while (lease.processes.has(nextPid))
      return events(lease, command, deadline, nextPid, req.closed, reply)
    } catch (error) {
      closeUnreadBody(req, reply)
      if (uploadDeadline.signal.aborted && error === uploadDeadline.signal.reason) {
        return reply.type(CONNECT_STREAM).send(endStream('deadline_exceeded', DEADLINE_MESSAGE))
      }
      if (error instanceof UnsupportedProcessOption) {
        return failure(reply, 501, 'unimplemented', error.message)
      }
      if (!(error instanceof InvalidConnectRequest)) throw error
      throw new HttpError('invalid_request', 'invalid Connect start request', { cause: error })
    } finally {
      disarm?.()
    }
  })
  for (const method of CONTROL_METHODS) {
    app.post(PROCESS_PREFIX + method, { rawBody: true }, async (req, reply) => {
      try {
        const lease = sandboxes.requireAccess(req.headers)
        if (unaryContentType(req, CONNECT_STREAM) !== 'application/json') {
          closeUnreadBody(req, reply)
          return failure(reply, 415, 'invalid_argument', 'expected Connect JSON')
        }
        const body = await readJsonBody(
          req,
          AbortSignal.any([lease.revoked, req.closed]),
          MAX_CONTROL_BODY,
        )
        lease.checkFiles()
        return await control(lease, method, body, reply)
      } catch (error) {
        closeUnreadBody(req, reply)
        throw error
      }
    })
  }
}
