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
import { ioToStr } from '@struktoai/mirage-agents/io_text'
import { MirageToolOperations, type ToolResult } from '@struktoai/mirage-agents/tool_operations'
import type { SessionState } from '@struktoai/mirage-core/workspace/session/session'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { ioResultToDict } from '../io_serde.ts'
import { JobStatus, type JobTable } from '../jobs.ts'
import type { WorkspaceEntry, WorkspaceRegistry } from '../registry.ts'
import { createMirageMcpServer } from './server.ts'

const MCP_PATH = '/v1/workspaces/:workspaceId/mcp'
/**
 * The tool table as the daemon serves it: through its own API.
 *
 * `shell` is a job, submitted to the daemon's job table the way
 * `POST /shell` submits one, so an MCP command is listed by `/v1/jobs`,
 * can be cancelled there, and is recorded like any other.
 */
export class DaemonToolOperations extends MirageToolOperations {
  constructor(
    private readonly entry: WorkspaceEntry,
    private readonly jobs: JobTable,
    private readonly session: string,
  ) {
    super(entry.runner.ws, { sessionId: session })
  }

  override async shell(command: string): Promise<ToolResult> {
    const ws = this.entry.runner.ws
    let answer: ToolResult | undefined
    let job = await this.jobs.submit(
      this.entry.id,
      command,
      async (signal, executionScope) => {
        const io = await ws.shell(command, { sessionId: this.session, executionScope, signal })
        const payload = ioResultToDict(io)
        answer = { content: [{ type: 'text', text: ioToStr(io) }] }
        if (io.exitCode !== 0) answer.isError = true
        return payload
      },
      this.session,
    )
    job = await this.jobs.wait(job.id)
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
 * session, or the one `?sessionId=` names, as `/shell` picks its
 * session. One tool table per workspace and live session outlives the requests,
 * so the read one request stamps guards the edit the next one makes; the
 * SDK builds a server per request around it. `fetch` answers a web
 * request with no auth in front, for a door that already admitted its
 * caller: the SSH relay.
 */
export class McpDoor {
  private readonly served = new Map<
    string,
    {
      entry: WorkspaceEntry
      session: SessionState
      operations: DaemonToolOperations
      handler: McpHttpHandler
    }
  >()

  constructor(
    private readonly registry: WorkspaceRegistry,
    private readonly jobs: JobTable,
  ) {}

  async fetch(request: Request, parsedBody?: unknown): Promise<Response> {
    const handler = await this.target(new URL(request.url))
    if (typeof handler === 'string') return Response.json({ detail: handler }, { status: 404 })
    return handler.fetch(request, parsedBody === undefined ? {} : { parsedBody })
  }

  async handle(req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
    const headers = new Headers()
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue
      headers.set(name, Array.isArray(value) ? value.join(', ') : value)
    }
    const request = new Request(`http://${req.headers.host ?? 'localhost'}${req.url}`, {
      method: req.method,
      headers,
    })
    return reply.send(await this.fetch(request, req.body))
  }

  /** Close every handler; the app's `onClose` awaits it. */
  async close(): Promise<void> {
    const handlers = [...this.served.values()].map((s) => s.handler)
    this.served.clear()
    await Promise.all(handlers.map((h) => h.close()))
  }

  /**
   * The tool table a workspace session is served by, or why there is
   * none: the workspace or the session does not exist. One table per
   * workspace and live session, shared by every door that serves the
   * tools (this endpoint, the HTTP tool routes, the CLI and SSH through
   * them), so a read through one door stamps the file for an edit
   * through another. No session is the workspace's default.
   */
  async tools(
    workspaceId: string,
    sessionId?: string | null,
  ): Promise<DaemonToolOperations | string> {
    const served = await this.servedFor(workspaceId, sessionId ?? '')
    return typeof served === 'string' ? served : served.operations
  }

  /**
   * The handler a request's URL is for, or why there is none: the
   * workspace or the session does not exist.
   */
  private async target(url: URL): Promise<McpHttpHandler | string> {
    const match = /^\/v1\/workspaces\/([^/]+)\/mcp$/.exec(url.pathname)
    if (match === null) return 'not found'
    const served = await this.servedFor(
      decodeURIComponent(match[1] ?? ''),
      url.searchParams.get('sessionId') ?? '',
    )
    return typeof served === 'string' ? served : served.handler
  }

  private async servedFor(
    workspaceId: string,
    named: string,
  ): Promise<
    | {
        entry: WorkspaceEntry
        session: SessionState
        operations: DaemonToolOperations
        handler: McpHttpHandler
      }
    | string
  > {
    await this.dropStale()
    if (!this.registry.has(workspaceId)) return 'workspace not found'
    const entry = this.registry.get(workspaceId)
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
    const handler = createMcpHandler(() =>
      createMirageMcpServer(ws, {
        operations,
        operationsFor: async (sid) => {
          const selected = await this.tools(workspaceId, sid)
          if (typeof selected === 'string') throw new Error(selected)
          return selected
        },
      }),
    )
    const served = { entry, session, operations, handler }
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
    await served.handler.close()
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
