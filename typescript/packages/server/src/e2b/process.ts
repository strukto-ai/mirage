import { PipeClosed } from '@struktoai/mirage-core/io/errors'
import { CAPACITY } from '@struktoai/mirage-core/io/pipe'
import { atDeadline } from '@struktoai/mirage-core/utils/abort'
import { decodeBase64 } from '@struktoai/mirage-core/utils/base64'
import { z } from '@struktoai/mirage-core/vfs/secrets'
import { HttpError } from '../errors.ts'
import { MAX_REQUEST_PART } from '../multipart.ts'
import type { RouteApp, RouteReply, RouteRequest } from '../routes.ts'
import { closeUnreadBody, readBody, readJsonBody, unaryContentType } from './body.ts'
import { decodeStart, endStream, type StartCommand } from './connect.ts'
import * as constants from './constants.ts'
import { InvalidConnectRequest, UnsupportedProcessOption } from './errors.ts'
import { type CommandTransport, processResponse, remainingSeconds } from './stream.ts'
import type { Sandbox } from './sandbox.ts'

const PROCESS_PATHS = new Set([
  constants.START,
  ...constants.CONTROL_METHODS.map((method) => constants.PROCESS_PREFIX + method),
])
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
  return method === 'POST' && path === constants.START
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

async function readStart(request: RouteRequest, signal: AbortSignal): Promise<StartCommand> {
  return decodeStart(await readBody(request, signal, MAX_REQUEST_PART, 'command request too large'))
}

function failure(reply: RouteReply, status: number, code: string, message: string): RouteReply {
  return reply.code(status).send({ code, message })
}

async function control(
  lease: Sandbox,
  method: (typeof constants.CONTROL_METHODS)[number],
  body: unknown,
  reply: RouteReply,
  signal: AbortSignal,
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
    await stdin.write(data, signal)
  } catch (error) {
    if (!(error instanceof PipeClosed)) throw error
    return failure(reply, 400, 'failed_precondition', 'command stdin is closed')
  }
  return reply.send({})
}

/** How the data routes reach the sandbox a request runs against. */
export interface DataAccess {
  /** The sandbox `request` names, or throw the refusal the daemon answers. */
  sandbox(request: RouteRequest): Sandbox
  /** Whether the host is shutting down and starts no new command. */
  draining(): boolean
  readonly transport: CommandTransport
}

/** The command stream: run one command and stream its output. */
export function registerStart(app: RouteApp, access: DataAccess): void {
  let nextPid = 0
  app.post(constants.START, { rawBody: true }, async (req, reply) => {
    const uploadDeadline = new AbortController()
    const expire = (): void => {
      uploadDeadline.abort(new DOMException(constants.DEADLINE_MESSAGE, 'TimeoutError'))
    }
    let disarm: (() => void) | undefined
    try {
      const lease = access.sandbox(req)
      const contentType = req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
      if (contentType !== constants.CONNECT_STREAM) {
        closeUnreadBody(req, reply)
        return failure(reply, 415, 'invalid_argument', 'expected Connect JSON')
      }
      const deadline = requestDeadline(req)
      const remaining = remainingSeconds(deadline)
      if (remaining === 0) expire()
      else if (remaining !== null) disarm = atDeadline(remaining, expire)
      const command = await readStart(
        req,
        AbortSignal.any([req.closed, uploadDeadline.signal, lease.stopped]),
      )
      if (remainingSeconds(deadline) === 0) {
        return reply
          .type(constants.CONNECT_STREAM)
          .send(endStream('deadline_exceeded', constants.DEADLINE_MESSAGE))
      }
      access.sandbox(req)
      if (access.draining()) throw new HttpError('shutting_down', 'server is shutting down')
      do {
        nextPid = (nextPid % 0xffffffff) + 1
      } while (lease.processes.has(nextPid))
      return processResponse(lease, command, deadline, nextPid, req.closed, reply, access.transport)
    } catch (error) {
      closeUnreadBody(req, reply)
      if (uploadDeadline.signal.aborted && error === uploadDeadline.signal.reason) {
        return reply
          .type(constants.CONNECT_STREAM)
          .send(endStream('deadline_exceeded', constants.DEADLINE_MESSAGE))
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
}

/**
 * List, send input, close stdin and send signal: the commands a sandbox
 * still runs, which only a host that keeps them past one request can reach.
 */
export function registerControl(app: RouteApp, access: DataAccess): void {
  for (const method of constants.CONTROL_METHODS) {
    app.post(constants.PROCESS_PREFIX + method, { rawBody: true }, async (req, reply) => {
      const deadlineSignal = new AbortController()
      const expire = (): void => {
        deadlineSignal.abort(new DOMException(constants.DEADLINE_MESSAGE, 'TimeoutError'))
      }
      let disarm: (() => void) | undefined
      try {
        const lease = access.sandbox(req)
        if (unaryContentType(req, constants.CONNECT_STREAM) !== 'application/json') {
          closeUnreadBody(req, reply)
          return failure(reply, 415, 'invalid_argument', 'expected Connect JSON')
        }
        const deadline = requestDeadline(req)
        const remaining = remainingSeconds(deadline)
        if (remaining === 0) expire()
        else if (remaining !== null) disarm = atDeadline(remaining, expire)
        const signal = AbortSignal.any([lease.stopped, req.closed, deadlineSignal.signal])
        signal.throwIfAborted()
        const body = await readJsonBody(req, signal, constants.MAX_CONTROL_BODY)
        lease.stopped.throwIfAborted()
        if (remainingSeconds(deadline) === 0) expire()
        signal.throwIfAborted()
        return await control(lease, method, body, reply, signal)
      } catch (error) {
        closeUnreadBody(req, reply)
        if (deadlineSignal.signal.aborted) {
          return failure(reply, 504, 'deadline_exceeded', constants.DEADLINE_MESSAGE)
        }
        throw error
      } finally {
        disarm?.()
      }
    })
  }
}
