// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import { WorkspaceHeldError } from '@struktoai/mirage-core/execution/errors'
import type { LineId } from '@struktoai/mirage-core/execution/types'
import { BytePipe } from '@struktoai/mirage-core/io/pipe'
import { currentRequest } from '@struktoai/mirage-core/io/web/request'
import type { ShellExplanation } from '@struktoai/mirage-core/policy/types'
import type { JsonValue } from '@struktoai/mirage-core/types'
import { z } from '@struktoai/mirage-core/vfs/secrets'
import type { ShellExecution } from '@struktoai/mirage-core/workspace/shell_execution'
import { WorkspaceRuntime } from '@struktoai/mirage-core/runtime/workspace'
import type { Workspace } from '@struktoai/mirage-core/workspace/workspace/workspace'
import { errorResponse, HttpError, INTERNAL_MESSAGE, validationError } from '../errors.ts'
import type { RouteApp, RouteReply, RouteRequest } from '../routes.ts'
import { Buffer } from 'node:buffer'
import { explanationToDict, ioResultToDict } from '../io_serde.ts'
import type { LineRequest, RequestTable } from '../requests.ts'
import { refused } from '../metrics.ts'
import { MAX_REQUEST_PART, partEvents, type PartEvent } from '../multipart.ts'
import type { WorkspaceEntry, WorkspaceRegistry } from '../registry.ts'
import { UploadStdin } from '../stdin.ts'
import { shellResponse } from '../stream.ts'
import { failure, queryFlag, requireEntry, sessionOf } from './vfs.ts'

export interface ShellRoutesDeps {
  registry: WorkspaceRegistry
  jobs: RequestTable
}

interface ShellParams {
  wsId: string
}

const ShellRequest = z
  .object({
    command: z.string(),
    cwd: z
      .string()
      .nullish()
      .transform((value) => value ?? undefined),
    runtime: z
      .string()
      .nullish()
      .transform((value) => value ?? undefined),
    machine: z
      .string()
      .nullish()
      .transform((value) => value ?? undefined),
    record: z
      .boolean()
      .nullish()
      .transform((value) => value ?? undefined),
    open_stdin: z
      .boolean()
      .nullish()
      .transform((value) => value ?? undefined),
  })
  .strict()

type ShellRequest = z.infer<typeof ShellRequest>

interface ShellUpload {
  body: ShellRequest
  stdin: UploadStdin | Uint8Array | undefined
  /** Settles once the body is read, with why it failed, if it did. */
  failed: Promise<unknown>
  finish: () => Promise<void>
}

/**
 * Refuse a runtime or machine the workspace does not have, before the line
 * is submitted, naming the workspace's own choices. Mirrors Python's
 * `_check_placement`.
 */
function checkPlacement(ws: Workspace, req: ShellRequest): void {
  const named = [
    [
      'runtime',
      req.runtime,
      ws
        .runtimes()
        .filter((runtime) => !(runtime instanceof WorkspaceRuntime))
        .map((runtime) => runtime.name),
    ],
    ['machine', req.machine, ws.machineTable.names()],
  ] as const
  for (const [param, given, names] of named) {
    if (given !== undefined && !names.includes(given)) {
      throw new HttpError(
        'invalid_value',
        names.length > 0
          ? `${param} must be one of ${names.join(', ')}`
          : `${param} must be unset: the workspace has no ${param}s`,
        { param },
      )
    }
  }
}

/** A shell request read from parsed JSON, else its first bad field. */
function shellRequest(data: unknown): ShellRequest {
  if (data === undefined) throw new HttpError('invalid_json', 'body must be JSON')
  const parsed = ShellRequest.safeParse(data)
  if (!parsed.success) throw validationError(parsed.error, data)
  return parsed.data
}

/** A multipart body's `request` part. Mirrors Python's `_parse_request_part`. */
function parseRequestPart(chunks: Uint8Array[]): ShellRequest {
  let data: JsonValue
  try {
    data = JSON.parse(Buffer.concat(chunks).toString()) as JsonValue
  } catch (error) {
    throw new HttpError('invalid_json', 'body must be JSON', { cause: error })
  }
  return shellRequest(data)
}

/**
 * A JSON shell body, which the host parsed once whatever its Content-Type
 * said. Mirrors Python's `_parse_json_body`.
 */
function parseJsonBody(req: RouteRequest): ShellRequest {
  return shellRequest(req.body)
}

/**
 * Read the rest of a body, handing the open part's data to `take` and
 * calling `end` once that part is done; later parts are read and dropped.
 */
async function readPart(
  events: AsyncIterator<PartEvent>,
  take: (data: Uint8Array) => Promise<void> | void,
  end: () => void,
): Promise<void> {
  let open = true
  for (let next = await events.next(); next.done !== true; next = await events.next()) {
    if (!open) continue
    if (next.value.kind === 'data') {
      await take(next.value.data)
    } else {
      open = false
      end()
    }
  }
}

/**
 * Read a shell body. A multipart body names the line in its `request`
 * part, which comes first. The line starts as soon as the `stdin` part
 * begins, or the body ends without one; a `stdin` part then goes to the
 * line as it arrives.
 */
async function readShellBody(req: RouteRequest, capacity: number): Promise<ShellUpload> {
  const contentType = req.headers['content-type'] ?? ''
  if (!contentType.startsWith('multipart/')) {
    return {
      body: parseJsonBody(req),
      stdin: undefined,
      failed: Promise.resolve(undefined),
      finish: () => Promise.resolve(),
    }
  }
  const events = partEvents(req.raw, contentType)
  const request: Uint8Array[] = []
  let size = 0
  let body: ShellRequest | undefined
  let name = ''
  for (let next = await events.next(); next.done !== true; next = await events.next()) {
    const event = next.value
    if (event.kind === 'begin') {
      name = event.name
      if (name !== 'stdin') continue
      if (body === undefined) {
        throw new HttpError('invalid_request', "the 'request' part must come before 'stdin'")
      }
      const stdin = new UploadStdin(capacity)
      const failed = readPart(
        events,
        (data) => stdin.feed(data),
        () => {
          stdin.close()
        },
      ).then(
        () => undefined,
        async (error: unknown) => {
          await stdin.fail(error)
          return error
        },
      )
      return {
        body,
        stdin,
        failed,
        finish: async () => {
          await stdin.discard()
          const error = await failed
          if (error instanceof HttpError) throw error
          if (error !== undefined) console.debug('shell upload ended early', error)
        },
      }
    }
    if (name !== 'request') continue
    if (event.kind === 'data') {
      request.push(event.data)
      size += event.data.byteLength
      if (size > MAX_REQUEST_PART) throw new HttpError('too_large', 'request part too large')
    } else {
      body = parseRequestPart(request)
    }
  }
  if (body === undefined) {
    throw new HttpError('invalid_request', "multipart body missing 'request' part")
  }
  return {
    body,
    stdin: undefined,
    failed: Promise.resolve(undefined),
    finish: () => Promise.resolve(),
  }
}

/**
 * Wait for a foreground job while its caller stays connected. A caller
 * that drops the request is gone for good, so its job is cancelled, as
 * the line would be if the caller had pressed Ctrl-C; an upload that
 * fails, the caller gone or the body bad, cancels the job the same way.
 */
async function waitAttended(
  jobs: RequestTable,
  jobId: LineId,
  closed: AbortSignal,
  upload: Promise<unknown>,
): Promise<LineRequest> {
  const gone = (): void => {
    jobs.cancel(jobId)
  }
  void upload.then((error) => {
    if (error !== undefined) gone()
  })
  closed.addEventListener('abort', gone, { once: true })
  try {
    return await jobs.wait(jobId)
  } finally {
    closed.removeEventListener('abort', gone)
  }
}

/**
 * Answer a refused shell body. The rest of a refused multipart body is
 * left unread, so the connection closes after the answer.
 */
function refuse(req: RouteRequest, reply: RouteReply, error: unknown): RouteReply {
  if (req.headers['content-type']?.startsWith('multipart/') === true) {
    reply.header('connection', 'close')
  }
  if (error instanceof HttpError) return failure(reply, error)
  throw error
}

interface ShellQuery {
  session_id?: string
  explain?: string
  stream?: string
}

/**
 * What a line would do as a session, without running any of it
 * (`session.explain.shell`). Only the line is read: a working directory, a
 * runtime, a machine or stdin would change what runs, which an
 * explanation cannot follow, so each is refused. Mirrors Python's
 * `_explained`.
 */
async function explained(
  req: RouteRequest<{ Params: ShellParams; Body: ShellRequest; Querystring: ShellQuery }>,
  reply: RouteReply,
  deps: ShellRoutesDeps,
): Promise<RouteReply> {
  let said: ShellExplanation
  try {
    const entry = requireEntry(deps.registry, req.params.wsId, req.account)
    const multipart = req.headers['content-type']?.startsWith('multipart/') === true
    const body = multipart ? null : parseJsonBody(req)
    if (
      body === null ||
      body.cwd !== undefined ||
      body.runtime !== undefined ||
      body.machine !== undefined ||
      body.open_stdin === true
    ) {
      throw new HttpError(
        'invalid_request',
        'explain takes the line alone: no stdin, cwd, runtime or machine',
      )
    }
    const session = await sessionOf(entry.runner.ws, req.query.session_id)
    said = await session.explain.shell(body.command)
  } catch (err) {
    return failure(reply, err)
  }
  return reply.send(explanationToDict(said))
}

export function registerShellRoutes(app: RouteApp, deps: ShellRoutesDeps): void {
  app.post<{ Params: ShellParams; Body: ShellRequest; Querystring: ShellQuery }>(
    '/v1/workspaces/:wsId/shell',
    async (req, reply) => {
      const { wsId } = req.params
      let streaming: boolean
      let entry: WorkspaceEntry
      try {
        const flags = queryFlag(req.query, 'explain', 'stream')
        streaming = flags.stream
        entry = requireEntry(deps.registry, wsId, req.account)
        if (streaming && flags.explain) {
          throw new HttpError('invalid_request', 'stream cannot be combined with explain')
        }
        if (flags.explain) return await explained(req, reply, deps)
      } catch (err) {
        return failure(reply, err)
      }
      try {
        await sessionOf(entry.runner.ws, req.query.session_id)
      } catch (err) {
        if (req.headers['content-type']?.startsWith('multipart/') === true) {
          reply.header('connection', 'close')
        }
        return failure(reply, err)
      }
      let upload: ShellUpload
      try {
        upload = await readShellBody(req, entry.runner.ws.io.bufferBytes)
      } catch (error) {
        return refuse(req, reply, error)
      }
      const { body, stdin } = upload
      if (body.open_stdin === true && (stdin !== undefined || !streaming)) {
        try {
          await upload.finish()
        } catch (error) {
          return refuse(req, reply, error)
        }
        return errorResponse(
          reply,
          new HttpError('invalid_request', 'open_stdin takes stream=true and no stdin part'),
        )
      }
      try {
        checkPlacement(entry.runner.ws, body)
      } catch (error) {
        try {
          await upload.finish()
        } catch (finished) {
          return refuse(req, reply, finished)
        }
        return refuse(req, reply, error)
      }
      const pipe =
        body.open_stdin === true
          ? new BytePipe(entry.runner.ws.io.bufferBytes, currentRequest() !== null)
          : undefined
      const source = pipe?.stream() ?? stdin
      await entry.runner.ws.ensureSessionsLoaded()
      const sessionId = (req.query.session_id ?? '') || entry.runner.ws.defaultSessionId
      if (deps.jobs.draining || !entry.acceptingJobs) {
        try {
          await upload.finish()
        } catch (error) {
          return refuse(req, reply, error)
        }
        if (deps.jobs.draining) {
          refused('shutting_down')
          return errorResponse(reply, new HttpError('shutting_down', 'server is shutting down'))
        }
        return errorResponse(reply, new HttpError('not_found', 'workspace not found'))
      }
      const table = entry.runner.ws.jobTable
      if (!table.claimed) {
        // Once held, the lease is this daemon's until the workspace closes,
        // so only a line on a workspace it does not hold yet waits for the
        // store here.
        try {
          await table.claim()
        } catch (err) {
          if (!(err instanceof WorkspaceHeldError)) throw err
          try {
            await upload.finish()
          } catch (error) {
            return refuse(req, reply, error)
          }
          return errorResponse(reply, new HttpError('workspace_busy', err.message))
        }
      }
      let opened!: (execution: ShellExecution | null) => void
      const execution = new Promise<ShellExecution | null>((resolve) => {
        opened = resolve
      })
      let job = deps.jobs.submit(
        wsId,
        body.command,
        async (signal, lineHandle) => {
          const options = {
            sessionId,
            lineHandle,
            ...(body.cwd !== undefined ? { cwd: body.cwd } : {}),
            ...(body.runtime !== undefined ? { runtime: body.runtime } : {}),
            ...(body.machine !== undefined ? { machine: body.machine } : {}),
            ...(body.record !== undefined ? { record: body.record } : {}),
            ...(source !== undefined ? { stdin: source } : {}),
            signal,
          }
          const lineId = lineHandle.id.value
          if (!streaming)
            return Object.assign(
              ioResultToDict(await entry.runner.ws.shell(body.command, options)),
              {
                line_id: lineId,
              },
            )
          // The response reads the events and closes the execution; the job
          // waits for its status, and a cancelled job's signal stops it.
          try {
            const shell = await entry.runner.ws.shell(body.command, { ...options, stream: true })
            opened(shell)
            return Object.assign(ioResultToDict(await shell.wait()), { line_id: lineId })
          } finally {
            opened(null)
          }
        },
        sessionId,
      )
      job.stdin = pipe
      if (streaming) {
        return shellResponse(execution, deps.jobs, job, reply, req.closed, upload.failed, stdin)
      }
      job = await waitAttended(deps.jobs, job.id, req.closed, upload.failed)
      try {
        await upload.finish()
      } catch (error) {
        return refuse(req, reply, error)
      }
      if (job.line.record.signal !== null) {
        return errorResponse(reply, new HttpError('canceled', 'job canceled'))
      }
      if (job.error !== null) {
        console.error(`mirage: line ${job.id.value} failed: ${job.error}`)
        return errorResponse(reply, new HttpError('internal', INTERNAL_MESSAGE))
      }
      return job.result
    },
  )
}
