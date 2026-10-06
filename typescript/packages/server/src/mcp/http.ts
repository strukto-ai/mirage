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

import {
  createMcpHandler,
  DEFAULT_MAX_REQUEST_BODY_SIZE,
  type McpHttpHandler,
} from '@modelcontextprotocol/server'
import { ioToStr } from '@struktoai/mirage-core/workspace/tools/io_text'
import {
  MirageToolOperations,
  type ToolResult,
} from '@struktoai/mirage-core/workspace/tools/tool_operations'
import { Session } from '@struktoai/mirage-core/workspace/workspace/handle'
import type { SessionState } from '@struktoai/mirage-core/workspace/session/session'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { JsonValue } from '@struktoai/mirage-core/types'
import { InFlight, rpcMessages } from '../inflight.ts'
import { ioResultToDict } from '../io_serde.ts'
import { JobStatus, type JobTable } from '../jobs.ts'
import type { WorkspaceEntry, WorkspaceRegistry } from '../registry.ts'
import { createMirageMcpServer } from './server.ts'

const MCP_PATH = '/v1/workspaces/:workspaceId/mcp'
const CALLS: Readonly<Record<string, boolean>> = { tools: false, all: true }
/**
 * The tool table as the daemon serves it: through its own API.
 *
 * `shell` is a job, submitted to the daemon's job table the way
 * `POST /shell` submits one, so an MCP command is listed by `/v1/jobs`,
 * can be cancelled there, and is recorded like any other. The caller's
 * `signal` (an MCP client's cancel) cancels the job too. The other tools
 * run through the session's own table (`session.tools`), so a read
 * through any door guards a write through another.
 */
export class DaemonToolOperations extends MirageToolOperations {
  constructor(
    private readonly entry: WorkspaceEntry,
    private readonly jobs: JobTable,
    private readonly sessionId: string,
  ) {
    super(new Session(entry.runner.ws, sessionId))
  }

  override async call(
    name: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    if (name === 'shell') return super.call(name, args, signal)
    return new Session(this.entry.runner.ws, this.sessionId).tools.call(name, args, signal)
  }

  override async shell(command: string, signal?: AbortSignal): Promise<ToolResult> {
    const ws = this.entry.runner.ws
    let answer: ToolResult | undefined
    let job = await this.jobs.submit(
      this.entry.id,
      command,
      async (signal, executionScope) => {
        const io = await ws.shell(command, { sessionId: this.sessionId, executionScope, signal })
        const payload = ioResultToDict(io)
        answer = { content: [{ type: 'text', text: ioToStr(io) }] }
        if (io.exitCode !== 0) answer.isError = true
        return payload
      },
      this.sessionId,
    )
    const jobId = job.id
    const cancel = (): void => void this.jobs.cancel(jobId)
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted === true) cancel()
    try {
      job = await this.jobs.wait(jobId)
    } finally {
      signal?.removeEventListener('abort', cancel)
    }
    if (job.status === JobStatus.CANCELED) {
      return { content: [{ type: 'text', text: 'job canceled' }], isError: true }
    }
    if (job.status === JobStatus.FAILED || answer === undefined) {
      return { content: [{ type: 'text', text: job.error ?? 'shell failed' }], isError: true }
    }
    return answer
  }
}

/**
 * Serves every workspace's tools over MCP's streamable HTTP.
 *
 * The endpoint is stateless: each request runs in the workspace's default
 * session, or the one `?session_id=` names, as `/shell` picks its
 * session. `?calls=all` also serves the VFS calls and explain; `tools`,
 * the default, serves the agent tools alone. One tool table per
 * workspace and live session outlives the requests,
 * so the read one request stamps guards the edit the next one makes; the
 * SDK builds a server per request around it.
 */
export class McpDoor {
  private readonly served = new Map<
    string,
    {
      entry: WorkspaceEntry
      session: SessionState
      operations: DaemonToolOperations
      handlers: Map<boolean, McpHttpHandler>
    }
  >()

  /** Tool calls still running, so a client's cancel reaches them. */
  readonly inflight = new InFlight()

  constructor(
    private readonly registry: WorkspaceRegistry,
    private readonly jobs: JobTable,
  ) {}

  private async fetch(
    request: Request,
    parsedBody: unknown,
    account: string | null,
  ): Promise<Response> {
    const url = new URL(request.url)
    if (!Object.hasOwn(CALLS, url.searchParams.get('calls') ?? 'tools')) {
      return Response.json({ detail: 'calls must be tools or all' }, { status: 400 })
    }
    const target = await this.target(url, account)
    if (typeof target === 'string') return Response.json({ detail: target }, { status: 404 })
    const { handler, workspaceId, sessionId } = target
    const options = parsedBody === undefined ? {} : { parsedBody }
    const calls: string[] = []
    for (const message of rpcMessages(parsedBody)) {
      const params = message.params as { requestId?: JsonValue } | undefined
      if (message.method === 'notifications/cancelled') {
        this.inflight.cancel(InFlight.key(workspaceId, sessionId, params?.requestId))
      } else if (message.method === 'tools/call' && 'id' in message) {
        calls.push(InFlight.key(workspaceId, sessionId, message.id as JsonValue))
      }
    }
    if (calls.length === 0) return handler.fetch(request, options)
    const stop = new AbortController()
    const abort = (): void => {
      stop.abort()
    }
    for (const call of calls) this.inflight.add(call, abort)
    const settle = (): void => {
      for (const call of calls) this.inflight.discard(call, abort)
    }
    const signal = AbortSignal.any([request.signal, stop.signal])
    let response: Response
    try {
      response = await handler.fetch(new Request(request, { signal }), options)
    } catch (error) {
      settle()
      throw error
    }
    if (response.body === null) {
      settle()
      return response
    }
    const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader()
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read()
          if (next.done) {
            settle()
            controller.close()
          } else {
            controller.enqueue(next.value)
          }
        } catch (error) {
          settle()
          throw error
        }
      },
      cancel(reason: unknown) {
        settle()
        return reader.cancel(reason)
      },
    })
    return new Response(body, response)
  }

  async handle(req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
    const headers = new Headers()
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue
      headers.set(name, Array.isArray(value) ? value.join(', ') : value)
    }
    const gone = new AbortController()
    reply.raw.once('close', () => {
      if (!reply.raw.writableFinished) gone.abort()
    })
    const request = new Request(`http://${req.headers.host ?? 'localhost'}${req.url}`, {
      method: req.method,
      headers,
      signal: gone.signal,
    })
    return reply.send(await this.fetch(request, req.body, req.account))
  }

  /** Close every handler; the app's `onClose` awaits it. */
  async close(): Promise<void> {
    const handlers = [...this.served.values()].flatMap((s) => [...s.handlers.values()])
    this.served.clear()
    await Promise.all(handlers.map((h) => h.close()))
  }

  /**
   * The tool table a workspace session is served by, or why there is
   * none: the workspace or the session does not exist. One table per
   * workspace and live session, shared by every door that serves the
   * tools (this endpoint, the HTTP tool routes, the RPC endpoint and the
   * CLI through them), so a read through one door stamps the file for an
   * edit through another. No session is the workspace's default; another
   * account's workspace is not found.
   */
  async tools(
    workspaceId: string,
    sessionId: string | null,
    account: string | null,
  ): Promise<DaemonToolOperations | string> {
    const served = await this.servedFor(workspaceId, sessionId ?? '', account)
    return typeof served === 'string' ? served : served.operations
  }

  /**
   * The handler a request's URL is for, by its workspace, session and
   * `?calls=`, or why there is none: the workspace or the session does
   * not exist.
   */
  private async target(
    url: URL,
    account: string | null,
  ): Promise<{ handler: McpHttpHandler; workspaceId: string; sessionId: string } | string> {
    const match = /^\/v1\/workspaces\/([^/]+)\/mcp$/.exec(url.pathname)
    if (match === null) return 'not found'
    const workspaceId = decodeURIComponent(match[1] ?? '')
    const served = await this.servedFor(
      workspaceId,
      url.searchParams.get('session_id') ?? '',
      account,
    )
    if (typeof served === 'string') return served
    const handler = served.handlers.get(CALLS[url.searchParams.get('calls') ?? 'tools'] === true)
    if (handler === undefined) return 'not found'
    return { handler, workspaceId, sessionId: served.session.sessionId }
  }

  private async servedFor(
    workspaceId: string,
    named: string,
    account: string | null,
  ): Promise<
    | {
        entry: WorkspaceEntry
        session: SessionState
        operations: DaemonToolOperations
        handlers: Map<boolean, McpHttpHandler>
      }
    | string
  > {
    await this.dropStale()
    const entry = this.registry.visible(workspaceId, account)
    if (entry === null) return 'workspace not found'
    const ws = entry.runner.ws
    await ws.ensureSessionsLoaded()
    const sessionId = named === '' ? ws.defaultSessionId : named
    const key = `${workspaceId}\u0000${sessionId}`
    const session = ws.listSessions().find((s) => s.sessionId === sessionId)
    if (session === undefined) {
      await this.forget(key)
      return 'session not found'
    }
    const current = this.served.get(key)
    if (current?.session === session) return current
    await this.forget(key)
    const operations = new DaemonToolOperations(entry, this.jobs, sessionId)
    const handlers = new Map(
      Object.values(CALLS).map((allCalls) => [
        allCalls,
        createMcpHandler(() => createMirageMcpServer(ws, { sessionId, operations, allCalls })),
      ]),
    )
    const served = { entry, session, operations, handlers }
    this.served.set(key, served)
    return served
  }

  private async dropStale(): Promise<void> {
    for (const [key, served] of [...this.served]) {
      const id = served.entry.id
      const live =
        this.registry.has(id) &&
        this.registry.get(id) === served.entry &&
        served.entry.runner.ws.listSessions().includes(served.session)
      if (!live) await this.forget(key)
    }
  }

  private async forget(key: string): Promise<void> {
    const served = this.served.get(key)
    if (served === undefined) return
    this.served.delete(key)
    await Promise.all([...served.handlers.values()].map((h) => h.close()))
  }
}

/**
 * Serve MCP at `/v1/workspaces/:workspaceId/mcp`, behind the app's host
 * check and auth as every other route is.
 */
export function registerMcpRoutes(
  app: FastifyInstance,
  registry: WorkspaceRegistry,
  jobs: JobTable,
): McpDoor {
  const door = new McpDoor(registry, jobs)
  app.route({
    method: ['GET', 'POST', 'DELETE'],
    url: MCP_PATH,
    bodyLimit: DEFAULT_MAX_REQUEST_BODY_SIZE,
    handler: (req, reply) => door.handle(req, reply),
  })
  return door
}
