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
import type { FastifyInstance } from 'fastify'
import type { WorkspaceRegistry } from '../registry.ts'
import { JobStatus, type JobTable } from '../jobs.ts'
import { ioResultToDict } from '../io_serde.ts'

export interface ExecuteRoutesDeps {
  registry: WorkspaceRegistry
  jobs: JobTable
}

interface ExecuteParams {
  wsId: string
}

interface ExecuteBody {
  command: string
  sessionId?: string
  provision?: boolean
  agentId?: string
  native?: boolean
  stdinBase64?: string
}

interface ExecuteQuery {
  background?: string
}

export function registerExecuteRoutes(app: FastifyInstance, deps: ExecuteRoutesDeps): void {
  app.post<{ Params: ExecuteParams; Body: ExecuteBody; Querystring: ExecuteQuery }>(
    '/v1/workspaces/:wsId/execute',
    async (req, reply) => {
      const { wsId } = req.params
      if (!deps.registry.has(wsId)) {
        return reply.status(404).send({ detail: 'workspace not found' })
      }
      const body = req.body
      const background = req.query.background === 'true'
      const entry = deps.registry.get(wsId)
      const job = deps.jobs.submit(wsId, body.command, async (signal) =>
        entry.runner.ws.execute(body.command, {
          ...(body.sessionId !== undefined ? { sessionId: body.sessionId } : {}),
          ...(body.agentId !== undefined ? { agentId: body.agentId } : {}),
          ...(body.native !== undefined ? { native: body.native } : {}),
          ...(body.provision === true ? { provision: true as const } : {}),
          ...(body.stdinBase64 !== undefined
            ? { stdin: new Uint8Array(Buffer.from(body.stdinBase64, 'base64')) }
            : {}),
          signal,
        }),
      )
      if (background) {
        return reply.status(202).send({
          jobId: job.id,
          workspaceId: wsId,
          submittedAt: job.submittedAt,
        })
      }
      await deps.jobs.wait(job.id)
      reply.header('X-Mirage-Job-Id', job.id)
      if (job.status === JobStatus.FAILED) {
        return reply.status(500).send({ detail: job.error ?? 'execute failed' })
      }
      return ioResultToDict(job.result)
    },
  )
}
