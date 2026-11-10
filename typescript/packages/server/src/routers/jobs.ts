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

import type { Job, JobState } from '@struktoai/mirage-core/execution/job/types'
import { JobId, LineId } from '@struktoai/mirage-core/execution/types'
import type { RouteApp } from '../routes.ts'
import type { WorkspaceRegistry } from '../registry.ts'
import { failure, invalidChoice } from './vfs.ts'

interface WsIdParams {
  wsId: string
}

interface WsJobParams {
  wsId: string
  jobId: string
}

interface ListJobsQuery {
  session_id?: string
  state?: string
  line_id?: string
}

interface JobResponse {
  id: string
  number: number
  session_id: string
  command: string
  cwd: string
  line_id: string | null
  group: number | null
  pid: number | null
  state: string
  started_at: number
  ended_at: number | null
  exit: number | null
  signal: number | null
}

interface JobDetailResponse extends JobResponse {
  processes: number[]
}

const STATES: readonly JobState[] = ['running', 'stopping', 'exited']

function toResponse(record: Job): JobResponse {
  return {
    id: record.id.console,
    number: record.number,
    session_id: record.sessionId,
    command: record.command,
    cwd: record.cwd,
    line_id: record.line?.value ?? null,
    group: record.group,
    pid: record.pid,
    state: record.state,
    started_at: record.startedAt,
    ended_at: record.endedAt,
    exit: record.exit,
    signal: record.signal,
  }
}

export function registerJobsRoutes(
  app: RouteApp,
  deps: {
    registry: WorkspaceRegistry
  },
): void {
  app.get<{ Params: WsIdParams; Querystring: ListJobsQuery }>(
    '/v1/workspaces/:wsId/jobs',
    async (req, reply) => {
      // The jobs the workspace's sessions list, as `jobs` does, a
      // session's, those in a state or those a line started when named.
      const { wsId } = req.params
      const { session_id: sessionId, state, line_id: lineId } = req.query
      if (state !== undefined && !(STATES as readonly string[]).includes(state)) {
        return failure(reply, invalidChoice(['query', 'state'], STATES, state))
      }
      if (deps.registry.visible(wsId, req.account) === null) {
        return reply.status(404).send({ detail: 'workspace not found' })
      }
      const ws = deps.registry.get(wsId).runner.ws
      const records = await ws.jobs({
        ...(sessionId !== undefined && sessionId !== '' ? { sessionId } : {}),
        ...(state !== undefined ? { state: state as JobState } : {}),
        ...(lineId !== undefined && lineId !== '' ? { lineId: new LineId(lineId) } : {}),
      })
      return records.map(toResponse)
    },
  )

  app.get<{ Params: WsJobParams }>('/v1/workspaces/:wsId/jobs/:jobId', async (req, reply) => {
    // One job, named by the id its listing gives, with the pids of the
    // processes it ran that the workspace still keeps: its own and every
    // one under it.
    const { wsId, jobId } = req.params
    if (deps.registry.visible(wsId, req.account) === null) {
      return reply.status(404).send({ detail: 'workspace not found' })
    }
    const ws = deps.registry.get(wsId).runner.ws
    const record = await ws.job(new JobId(ws.workspaceId, jobId))
    if (record === null) return reply.status(404).send({ detail: 'job not found' })
    const detail: JobDetailResponse = {
      ...toResponse(record),
      processes: (await ws.processes({ jobId: record.id })).map((process) => process.id.pid),
    }
    return detail
  })
}
