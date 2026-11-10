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

import { refused } from '../metrics.ts'
import { DEFAULT_MAX_REQUEST_BODY_SIZE } from '@modelcontextprotocol/server'
import type { MirageToolOperations } from '@struktoai/mirage-core/workspace/tools/tool_operations'
import type { JsonValue } from '@struktoai/mirage-core/types'
import type { BytePipe } from '@struktoai/mirage-core/io/pipe'
import type { ByteSource } from '@struktoai/mirage-core/io/types'
import { InFlight } from '../inflight.ts'
import { ioResultToDict } from '../io_serde.ts'
import type { RequestTable } from '../requests.ts'
import type { McpEndpoint } from '../mcp/http.ts'
import type { WorkspaceEntry, WorkspaceRegistry } from '../registry.ts'
import type { RouteApp, RouteReply, RouteRequest } from '../routes.ts'
import { errorResponse as httpError, HttpError } from '../errors.ts'
import { RPC_INTERNAL_ERROR, RPC_INVALID_REQUEST, RPC_PARSE_ERROR } from './constants.ts'
import {
  CANCEL_REQUEST,
  errorResponse,
  MirageRpcServer,
  RPC_REQUEST_CANCELLED,
  RpcError,
} from './server.ts'

const RPC_PATH = '/v1/workspaces/:workspaceId/rpc'

/**
 * The RPC server as the daemon serves it. `shell` is a daemon job, as
 * `POST /shell` and MCP's `shell` are, so it drains at shutdown and a
 * cancelled request cancels it.
 */
class DaemonRpcServer extends MirageRpcServer {
  constructor(
    private readonly entry: WorkspaceEntry,
    private readonly jobs: RequestTable,
    sessionId: string,
    operations: MirageToolOperations,
    stdins: Map<string, BytePipe>,
  ) {
    super(entry.runner.ws, { sessionId, operations })
    this.stdins = stdins
  }

  override async runLine(
    command: string,
    options: { cwd?: string; env?: Record<string, string>; stdin?: ByteSource },
    signal?: AbortSignal,
    pipe?: BytePipe,
  ): Promise<JsonValue> {
    const ws = this.entry.runner.ws
    const sessionId = this.sessionId
    if (this.jobs.draining) {
      refused('shutting_down')
      throw new RpcError(RPC_INTERNAL_ERROR, 'server is shutting down')
    }
    if (!this.entry.acceptingJobs) throw new RpcError(RPC_INTERNAL_ERROR, 'workspace not found')
    const submitted = this.jobs.submit(
      this.entry.id,
      command,
      async (jobSignal, lineHandle) =>
        ioResultToDict(
          await ws.shell(command, { ...options, sessionId, lineHandle, signal: jobSignal }),
        ),
      sessionId,
    )
    submitted.stdin = pipe
    const job = await this.jobs.join(submitted.id, signal)
    if (job.line.record.signal !== null) throw new RpcError(RPC_REQUEST_CANCELLED, 'job canceled')
    if (job.error !== null) throw new RpcError(RPC_INTERNAL_ERROR, job.error)
    return job.result
  }
}

/**
 * Serves every workspace's Session API over JSON-RPC on HTTP. Each
 * `POST /v1/workspaces/:id/rpc` carries one message or a batch and is
 * answered with the responses. The endpoint is stateless, as the MCP one
 * is: `?session_id=` names the session, else the default, and the tool
 * table is the one MCP serves the session with. A request still running
 * is held in `inflight`, so `$/cancelRequest` on another request reaches
 * it, and a caller that drops the request cancels it.
 */
class RpcEndpoint {
  readonly inflight = new InFlight()
  readonly stdins = new Map<string, BytePipe>()

  constructor(
    private readonly registry: WorkspaceRegistry,
    private readonly jobs: RequestTable,
    private readonly mcp: McpEndpoint,
  ) {}

  /** The RPC server for a workspace session, or why there is none. */
  async server(
    workspaceId: string,
    sessionId: string | null,
    account: string | null,
  ): Promise<DaemonRpcServer | string> {
    const entry = this.registry.visible(workspaceId, account)
    if (entry === null) return 'workspace not found'
    const operations = await this.mcp.tools(workspaceId, sessionId, account)
    if (typeof operations === 'string') return operations
    if (!entry.acceptingJobs || this.registry.visible(workspaceId, account) !== entry)
      return 'workspace not found'
    return new DaemonRpcServer(
      entry,
      this.jobs,
      sessionId ?? entry.runner.ws.defaultSessionId,
      operations,
      this.stdins,
    )
  }

  async handle(
    req: RouteRequest<{ Params: { workspaceId: string }; Querystring: { session_id?: string } }>,
    reply: RouteReply,
  ): Promise<RouteReply> {
    const workspaceId = req.params.workspaceId
    const server = await this.server(workspaceId, req.query.session_id ?? null, req.account)
    if (typeof server === 'string') return httpError(reply, new HttpError('not_found', server))
    const parsed: unknown = req.body
    const batch = Array.isArray(parsed)
    const messages: unknown[] = batch ? parsed : [parsed]
    const held: [string, () => void][] = []
    const answers: Promise<Record<string, JsonValue> | null>[] = []
    for (const message of messages) {
      if (typeof message !== 'object' || message === null || Array.isArray(message)) {
        answers.push(
          Promise.resolve(errorResponse(null, RPC_INVALID_REQUEST, 'a message is an object')),
        )
        continue
      }
      const record = message as Record<string, unknown>
      if (record.method === CANCEL_REQUEST) {
        const params = record.params as { id?: JsonValue } | undefined
        this.inflight.cancel(InFlight.key(workspaceId, server.sessionId, params?.id))
        continue
      }
      const own = new AbortController()
      const signal = AbortSignal.any([req.closed, own.signal])
      if ('id' in record) {
        const key = InFlight.key(workspaceId, server.sessionId, record.id as JsonValue)
        const abort = (): void => {
          own.abort()
        }
        this.inflight.add(key, abort)
        held.push([key, abort])
      }
      answers.push(server.handle(record, signal))
    }
    let responses: (Record<string, JsonValue> | null)[]
    try {
      responses = await Promise.all(answers)
    } finally {
      for (const [key, abort] of held) this.inflight.discard(key, abort)
    }
    const sent = responses.filter((response) => response !== null)
    if (sent.length === 0) return reply.status(204).send()
    return reply.send(batch ? sent : sent[0])
  }
}

/**
 * Serve JSON-RPC at `/v1/workspaces/:workspaceId/rpc`, behind the app's
 * host check and auth as every other route is.
 */
export function registerRpcRoutes(
  app: RouteApp,
  registry: WorkspaceRegistry,
  jobs: RequestTable,
  mcp: McpEndpoint,
): void {
  const endpoint = new RpcEndpoint(registry, jobs, mcp)
  app.post<{ Params: { workspaceId: string }; Querystring: { session_id?: string } }>(
    RPC_PATH,
    {
      bodyLimit: DEFAULT_MAX_REQUEST_BODY_SIZE,
      invalidJson: errorResponse(null, RPC_PARSE_ERROR, 'parse error'),
    },
    (req, reply) => endpoint.handle(req, reply),
  )
}
