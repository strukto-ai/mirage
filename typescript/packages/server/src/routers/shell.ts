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

import { Buffer } from 'node:buffer'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ShellExplanation } from '@struktoai/mirage-core/policy/types'
import { z } from '@struktoai/mirage-core/vfs/secrets'
import type { WorkspaceRegistry } from '../registry.ts'
import type { ExecutionTable } from '../jobs.ts'
import { ExecutionStatus, type ExecutionRecord } from '@struktoai/mirage-core/execution/types'
import { explanationToDict, ioResultToDict } from '../io_serde.ts'
import { MAX_REQUEST_PART, MultipartError, partEvents, type PartEvent } from '../multipart.ts'
import { UploadStdin } from '../stdin.ts'
import { ShellOutput, shellResponse } from '../stream.ts'
import { RouteError, failure, queryFlag, requireEntry, sessionOf } from './vfs.ts'

export interface ShellRoutesDeps {
  registry: WorkspaceRegistry
  jobs: ExecutionTable
}

interface ShellParams {
  wsId: string
}

const ShellBodySchema = z
  .object({
    command: z.string(),
    agent_id: z.string().optional(),
    cwd: z.string().optional(),
    runtime: z.string().optional(),
    record: z.boolean().optional(),
  })
  .strict()

type ShellBody = z.infer<typeof ShellBodySchema>

interface ShellUpload {
  body: ShellBody
  stdin: UploadStdin | Uint8Array | undefined
  /** Settles once the body is read, with why it failed, if it did. */
  failed: Promise<unknown>
  finish: () => Promise<void>
}

function parseRequestPart(chunks: Uint8Array[]): ShellBody {
  return ShellBodySchema.parse(JSON.parse(Buffer.concat(chunks).toString()))
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
 * begins, or the body ends without one; a foreground `stdin` part then
 * goes to the line as it arrives. A background one is read whole, since
 * the job id answers only after the body is done.
 */
async function readShellBody(
  req: FastifyRequest,
  background: boolean,
  capacity: number,
): Promise<ShellUpload> {
  const contentType = req.headers['content-type'] ?? ''
  if (!contentType.startsWith('multipart/')) {
    return {
      body: ShellBodySchema.parse(req.body),
      stdin: undefined,
      failed: Promise.resolve(undefined),
      finish: () => Promise.resolve(),
    }
  }
  const events = partEvents(req.raw, contentType)
  const request: Uint8Array[] = []
  let size = 0
  let body: ShellBody | undefined
  let name = ''
  for (let next = await events.next(); next.done !== true; next = await events.next()) {
    const event = next.value
    if (event.kind === 'begin') {
      name = event.name
      if (name !== 'stdin') continue
      if (body === undefined) {
        throw new MultipartError(400, "the 'request' part must come before 'stdin'")
      }
      if (background) {
        const chunks: Uint8Array[] = []
        await readPart(
          events,
          (data) => {
            chunks.push(data)
          },
          () => undefined,
        )
        return {
          body,
          stdin: new Uint8Array(Buffer.concat(chunks)),
          failed: Promise.resolve(undefined),
          finish: () => Promise.resolve(),
        }
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
        (error: unknown) => {
          stdin.discard()
          return error
        },
      )
      return {
        body,
        stdin,
        failed,
        finish: async () => {
          stdin.discard()
          const error = await failed
          if (error instanceof MultipartError) throw error
          if (error !== undefined) req.log.debug({ err: error }, 'shell upload ended early')
        },
      }
    }
    if (name !== 'request') continue
    if (event.kind === 'data') {
      request.push(event.data)
      size += event.data.byteLength
      if (size > MAX_REQUEST_PART) throw new MultipartError(413, 'request part too large')
    } else {
      body = parseRequestPart(request)
    }
  }
  if (body === undefined) throw new MultipartError(400, "multipart body missing 'request' part")
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
  jobs: ExecutionTable,
  jobId: string,
  reply: FastifyReply,
  upload: Promise<unknown>,
): Promise<ExecutionRecord> {
  const gone = (): void => {
    if (!reply.raw.writableFinished) jobs.cancel(jobId)
  }
  void upload.then((error) => {
    if (error !== undefined) gone()
  })
  reply.raw.once('close', gone)
  try {
    return await jobs.wait(jobId)
  } finally {
    reply.raw.off('close', gone)
  }
}

/**
 * Answer a refused shell body. The rest of a refused multipart body is
 * left unread, so the connection closes after the answer.
 */
function refuse(req: FastifyRequest, reply: FastifyReply, error: unknown): FastifyReply {
  if (req.headers['content-type']?.startsWith('multipart/') === true) {
    reply.header('connection', 'close')
  }
  if (error instanceof MultipartError) {
    return reply.status(error.statusCode).send({ detail: error.message })
  }
  if (error instanceof SyntaxError || error instanceof z.ZodError) {
    return reply.status(400).send({ detail: `bad shell request: ${error.message}` })
  }
  throw error
}

interface ShellQuery {
  background?: string
  session_id?: string
  explain?: string
  stream?: string
}

/**
 * What a line would do as a session, without running any of it
 * (`session.explain.shell`). Only the line is read: a working directory, a
 * runtime, stdin or a background job would change what runs, which an
 * explanation cannot follow, so each is refused. Mirrors Python's
 * `_explained`.
 */
async function explained(
  req: FastifyRequest<{ Params: ShellParams; Body: ShellBody; Querystring: ShellQuery }>,
  reply: FastifyReply,
  deps: ShellRoutesDeps,
): Promise<FastifyReply> {
  let said: ShellExplanation
  try {
    const entry = requireEntry(deps.registry, req.params.wsId, req.account)
    const parsed = ShellBodySchema.safeParse(req.body)
    if (
      queryFlag(req.query.background, 'background') ||
      req.headers['content-type']?.startsWith('multipart/') === true ||
      (parsed.success && (parsed.data.cwd !== undefined || parsed.data.runtime !== undefined))
    ) {
      throw new RouteError(
        400,
        'explain takes the line alone: no stdin, cwd, runtime or background',
      )
    }
    if (!parsed.success) throw new RouteError(400, `bad shell request: ${parsed.error.message}`)
    const session = await sessionOf(entry.runner.ws, req.query.session_id)
    said = await session.explain.shell(parsed.data.command)
  } catch (err) {
    return failure(reply, err)
  }
  return reply.send(explanationToDict(said))
}

export function registerShellRoutes(app: FastifyInstance, deps: ShellRoutesDeps): void {
  app.post<{ Params: ShellParams; Body: ShellBody; Querystring: ShellQuery }>(
    '/v1/workspaces/:wsId/shell',
    async (req, reply) => {
      let streaming: boolean
      try {
        streaming = queryFlag(req.query.stream, 'stream')
        if (
          streaming &&
          (queryFlag(req.query.background, 'background') || queryFlag(req.query.explain, 'explain'))
        ) {
          throw new RouteError(400, 'stream cannot be combined with background or explain')
        }
        if (queryFlag(req.query.explain, 'explain')) return await explained(req, reply, deps)
      } catch (err) {
        return failure(reply, err)
      }
      const { wsId } = req.params
      const entry = deps.registry.visible(wsId, req.account)
      if (entry === null) {
        return reply.status(404).send({ detail: 'workspace not found' })
      }
      const background = req.query.background === 'true'
      let upload: ShellUpload
      try {
        upload = await readShellBody(req, background, entry.runner.ws.io.bufferBytes)
      } catch (error) {
        return refuse(req, reply, error)
      }
      const { body, stdin } = upload
      await entry.runner.ws.ensureSessionsLoaded()
      const sessionId = req.query.session_id ?? entry.runner.ws.defaultSessionId
      const output = streaming ? new ShellOutput(entry.runner.ws.io.bufferBytes) : undefined
      let job = deps.jobs.submit(
        wsId,
        body.command,
        async (signal, executionScope) => {
          const options = {
            sessionId,
            executionScope,
            ...(body.agent_id !== undefined ? { agentId: body.agent_id } : {}),
            ...(body.cwd !== undefined ? { cwd: body.cwd } : {}),
            ...(body.runtime !== undefined ? { runtime: body.runtime } : {}),
            ...(body.record !== undefined ? { record: body.record } : {}),
            ...(stdin !== undefined ? { stdin } : {}),
            signal,
          }
          if (output === undefined)
            return ioResultToDict(await entry.runner.ws.shell(body.command, options))
          const execution = await entry.runner.ws.shell(body.command, { ...options, stream: true })
          try {
            for await (const chunk of execution.events) await output.emit(chunk.stream, chunk.data)
            return ioResultToDict(await execution.wait())
          } finally {
            await execution.close()
          }
        },
        sessionId,
      )
      reply.header('X-Mirage-Job-Id', job.id)
      if (output !== undefined)
        return shellResponse(output, deps.jobs, job, reply, upload.failed, stdin)
      if (background) {
        await upload.finish()
        return reply.status(202).send({
          job_id: job.id,
          workspace_id: wsId,
          submitted_at: job.submittedAt,
        })
      }
      job = await waitAttended(deps.jobs, job.id, reply, upload.failed)
      try {
        await upload.finish()
      } catch (error) {
        return refuse(req, reply, error)
      }
      if (job.status === ExecutionStatus.CANCELED) {
        return reply.status(499).send({ detail: 'job canceled' })
      }
      if (job.status === ExecutionStatus.FAILED) {
        return reply.status(500).send({ detail: job.error ?? 'shell failed' })
      }
      return job.result
    },
  )
}
