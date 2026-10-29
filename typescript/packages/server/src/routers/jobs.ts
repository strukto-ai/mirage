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

import type { FastifyInstance } from 'fastify'
import type { ExecutionTable } from '../jobs.ts'
import type { ExecutionRecord, ExecutionStatus } from '@struktoai/mirage-core/execution/types'
import type { JsonValue } from '@struktoai/mirage-core/types'
import type { WorkspaceRegistry } from '../registry.ts'

export interface JobsRoutesDeps {
  jobs: ExecutionTable
  registry: WorkspaceRegistry
}

interface JobIdParams {
  id: string
}

interface JobsListQuery {
  workspace_id?: string
}

interface WaitRequest {
  timeout_s?: number
}

interface JobBrief {
  job_id: string
  workspace_id: string
  session_id: string
  command: string
  status: ExecutionStatus
  cancel_requested: boolean
  submitted_at: number
  started_at: number | null
  finished_at: number | null
}

function toBrief(entry: ExecutionRecord): JobBrief {
  return {
    job_id: entry.id,
    workspace_id: entry.workspaceId,
    session_id: entry.sessionId,
    command: entry.command,
    status: entry.status,
    cancel_requested: entry.cancelRequested,
    submitted_at: entry.submittedAt,
    started_at: entry.startedAt,
    finished_at: entry.finishedAt,
  }
}

interface JobDetail extends JobBrief {
  result: JsonValue
  error: string | null
}

function toDetail(entry: ExecutionRecord): JobDetail {
  const brief = toBrief(entry)
  return { ...brief, result: entry.result, error: entry.error }
}

export function registerJobsRoutes(app: FastifyInstance, deps: JobsRoutesDeps): void {
  /**
   * The job, when its workspace is the caller's to reach; a job of
   * another account's workspace answers null like a missing one.
   */
  const reachable = async (id: string, account: string | null): Promise<ExecutionRecord | null> => {
    const entry = deps.jobs.get(id)
    if (entry === null) return null
    return (await deps.registry.allows(entry.workspaceId, account, entry.submittedAt))
      ? deps.jobs.get(id)
      : null
  }

  app.get<{ Querystring: JobsListQuery }>('/v1/jobs', async (req) => {
    const allowed = new Set<string>()
    for (const job of deps.jobs.list(req.query.workspace_id)) {
      if (await deps.registry.allows(job.workspaceId, req.account, job.submittedAt))
        allowed.add(job.id)
    }
    return deps.jobs
      .list(req.query.workspace_id)
      .filter((job) => allowed.has(job.id))
      .map(toBrief)
  })

  app.get<{ Params: JobIdParams }>('/v1/jobs/:id', async (req, reply) => {
    const entry = await reachable(req.params.id, req.account)
    if (entry === null) return reply.status(404).send({ detail: 'job not found' })
    return toDetail(entry)
  })

  app.post<{ Params: JobIdParams; Body: WaitRequest | null }>(
    '/v1/jobs/:id/wait',
    async (req, reply) => {
      const { id } = req.params
      if ((await reachable(id, req.account)) === null)
        return reply.status(404).send({ detail: 'job not found' })
      try {
        const entry = await deps.jobs.wait(id, req.body?.timeout_s)
        return toDetail(entry)
      } catch (error) {
        if (deps.jobs.get(id) !== null) throw error
        req.log.debug({ err: error }, 'job removed before wait')
        return reply.status(404).send({ detail: 'job not found' })
      }
    },
  )

  app.delete<{ Params: JobIdParams }>('/v1/jobs/:id', async (req, reply) => {
    const { id } = req.params
    if ((await reachable(id, req.account)) === null)
      return reply.status(404).send({ detail: 'job not found' })
    return { job_id: id, canceled: deps.jobs.cancel(id) }
  })
}
