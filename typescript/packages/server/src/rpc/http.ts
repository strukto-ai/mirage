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

import { DEFAULT_MAX_REQUEST_BODY_SIZE } from '@modelcontextprotocol/server'
import type { MirageToolOperations } from '@struktoai/mirage-core/workspace/tools/tool_operations'
import type { JsonValue } from '@struktoai/mirage-core/types'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { InFlight } from '../inflight.ts'
import { ioResultToDict } from '../io_serde.ts'
import type { ExecutionTable } from '../jobs.ts'
import { ExecutionStatus } from '@struktoai/mirage-core/execution/types'
import type { McpEndpoint } from '../mcp/http.ts'
import type { WorkspaceEntry, WorkspaceRegistry } from '../registry.ts'
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
 * `POST /shell` and MCP's `shell` are, so it is listed by `/v1/jobs` and
 * a cancelled request cancels it.
 */
class DaemonRpcServer extends MirageRpcServer {
  constructor(
    private readonly entry: WorkspaceEntry,
    private readonly jobs: ExecutionTable,
    sessionId: string,
    operations: MirageToolOperations,
  ) {
    super(entry.runner.ws, { sessionId, operations })
  }

  override async runLine(
    command: string,
    options: { cwd?: string; env?: Record<string, string>; stdin?: Uint8Array },
    signal?: AbortSignal,
  ): Promise<JsonValue> {
    const ws = this.entry.runner.ws
    const sessionId = this.sessionId
    const submitted = this.jobs.submit(
      this.entry.id,
      command,
      async (jobSignal, executionScope) =>
        ioResultToDict(
          await ws.shell(command, { ...options, sessionId, executionScope, signal: jobSignal }),
        ),
      sessionId,
    )
    const job = await this.jobs.join(submitted.id, signal)
    if (job.status === ExecutionStatus.CANCELED)
      throw new RpcError(RPC_REQUEST_CANCELLED, 'job canceled')
    if (job.status === ExecutionStatus.FAILED) {
      throw new RpcError(RPC_INTERNAL_ERROR, job.error ?? 'shell failed')
    }
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

  constructor(
    private readonly registry: WorkspaceRegistry,
    private readonly jobs: ExecutionTable,
    private readonly mcp: McpEndpoint,
  ) {}

  /** The RPC server for a workspace session, or why there is none. */
  async server(
    workspaceId: string,
    sessionId: string | null,
    account: string | null,
  ): Promise<DaemonRpcServer | string> {
    const operations = await this.mcp.tools(workspaceId, sessionId, account)
    if (typeof operations === 'string') return operations
    const entry = this.registry.get(workspaceId)
    return new DaemonRpcServer(
      entry,
      this.jobs,
      sessionId ?? entry.runner.ws.defaultSessionId,
      operations,
    )
  }

  async handle(
    req: FastifyRequest<{ Params: { workspaceId: string }; Querystring: { session_id?: string } }>,
    reply: FastifyReply,
  ): Promise<FastifyReply> {
    const workspaceId = req.params.workspaceId
    const server = await this.server(workspaceId, req.query.session_id ?? null, req.account)
    if (typeof server === 'string') return reply.status(404).send({ detail: server })
    const parsed: unknown = req.body
    const batch = Array.isArray(parsed)
    const messages: unknown[] = batch ? parsed : [parsed]
    const stop = new AbortController()
    reply.raw.once('close', () => {
      if (!reply.raw.writableFinished) stop.abort()
    })
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
      const signal = AbortSignal.any([stop.signal, own.signal])
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
  app: FastifyInstance,
  registry: WorkspaceRegistry,
  jobs: ExecutionTable,
  mcp: McpEndpoint,
): void {
  const endpoint = new RpcEndpoint(registry, jobs, mcp)
  app.post<{ Params: { workspaceId: string }; Querystring: { session_id?: string } }>(
    RPC_PATH,
    {
      bodyLimit: DEFAULT_MAX_REQUEST_BODY_SIZE,
      errorHandler: (error, _req, reply) => {
        const code = (error as { code?: string }).code
        const parse =
          code === 'FST_ERR_CTP_INVALID_JSON_BODY' || code === 'FST_ERR_CTP_EMPTY_JSON_BODY'
        void reply.send(parse ? errorResponse(null, RPC_PARSE_ERROR, 'parse error') : error)
      },
    },
    (req, reply) => endpoint.handle(req, reply),
  )
}
