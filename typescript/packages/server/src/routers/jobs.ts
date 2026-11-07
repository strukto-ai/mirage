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
import { JobId } from '@struktoai/mirage-core/execution/types'
import type { RouteApp } from '../routes.ts'
import type { WorkspaceRegistry } from '../registry.ts'

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
}

interface JobResponse {
  id: string
  number: number
  session_id: string
  command: string
  cwd: string
  line_id: string | null
  group: number | null
  state: string
  started_at: number
  ended_at: number | null
  exit: number | null
  signal: number | null
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
    (req, reply) => {
      // The jobs the workspace's sessions list, as `jobs` does, a
      // session's or those in a state when named.
      const { wsId } = req.params
      if (deps.registry.visible(wsId, req.account) === null) {
        return reply.status(404).send({ detail: 'workspace not found' })
      }
      const { session_id: sessionId, state } = req.query
      if (state !== undefined && !(STATES as readonly string[]).includes(state)) {
        return reply.status(422).send({ detail: `state must be one of ${STATES.join(', ')}` })
      }
      const ws = deps.registry.get(wsId).runner.ws
      return ws
        .jobs({
          ...(sessionId !== undefined && sessionId !== '' ? { sessionId } : {}),
          ...(state !== undefined ? { state: state as JobState } : {}),
        })
        .map(toResponse)
    },
  )

  app.get<{ Params: WsJobParams }>('/v1/workspaces/:wsId/jobs/:jobId', (req, reply) => {
    // One job, named by the id its listing gives.
    const { wsId, jobId } = req.params
    if (deps.registry.visible(wsId, req.account) === null) {
      return reply.status(404).send({ detail: 'workspace not found' })
    }
    const ws = deps.registry.get(wsId).runner.ws
    const record = ws.job(new JobId(ws.workspaceId, jobId))
    if (record === null) return reply.status(404).send({ detail: 'job not found' })
    return toResponse(record)
  })
}
