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
import { toBriefDict, type JobBriefDict, type JobEntry, type JobTable } from '../jobs.ts'
import type { JsonValue } from '@struktoai/mirage-core/types'
import type { WorkspaceRegistry } from '../registry.ts'

export interface JobsRoutesDeps {
  jobs: JobTable
  registry: WorkspaceRegistry
}

interface JobIdParams {
  id: string
}

interface JobsListQuery {
  workspace_id?: string
}

interface WaitBody {
  timeout_s?: number
}

interface JobDetailDict extends JobBriefDict {
  result: JsonValue
  error: string | null
}

function toDetailDict(entry: JobEntry): JobDetailDict {
  const brief = toBriefDict(entry)
  return { ...brief, result: entry.result, error: entry.error }
}

export function registerJobsRoutes(app: FastifyInstance, deps: JobsRoutesDeps): void {
  /**
   * The job, when its workspace is the caller's to reach; a job of
   * another account's workspace answers null like a missing one.
   */
  const reachable = async (id: string, account: string | null): Promise<JobEntry | null> => {
    const entry = await deps.jobs.store.get(id)
    if (entry === null) return null
    return (await deps.registry.allows(entry.workspaceId, account, entry.submittedAt))
      ? entry
      : null
  }

  app.get<{ Querystring: JobsListQuery }>('/v1/jobs', async (req) => {
    const jobs: JobEntry[] = []
    for (const job of await deps.jobs.list(req.query.workspace_id)) {
      if (await deps.registry.allows(job.workspaceId, req.account, job.submittedAt)) jobs.push(job)
    }
    return jobs.map(toBriefDict)
  })

  app.get<{ Params: JobIdParams }>('/v1/jobs/:id', async (req, reply) => {
    const entry = await reachable(req.params.id, req.account)
    if (entry === null) return reply.status(404).send({ detail: 'job not found' })
    return toDetailDict(entry)
  })

  app.post<{ Params: JobIdParams; Body: WaitBody | null }>(
    '/v1/jobs/:id/wait',
    async (req, reply) => {
      const { id } = req.params
      if ((await reachable(id, req.account)) === null)
        return reply.status(404).send({ detail: 'job not found' })
      const entry = await deps.jobs.wait(id, req.body?.timeout_s)
      return toDetailDict(entry)
    },
  )

  app.delete<{ Params: JobIdParams }>('/v1/jobs/:id', async (req, reply) => {
    const { id } = req.params
    if ((await reachable(id, req.account)) === null)
      return reply.status(404).send({ detail: 'job not found' })
    return { job_id: id, canceled: await deps.jobs.cancel(id) }
  })
}
