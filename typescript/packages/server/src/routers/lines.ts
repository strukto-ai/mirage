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

import type { Line, LineState } from '@struktoai/mirage-core/execution/line/types'
import { LineId } from '@struktoai/mirage-core/execution/types'
import type { RouteApp } from '../routes.ts'
import type { WorkspaceRegistry } from '../registry.ts'

interface WsIdParams {
  wsId: string
}

interface WsLineParams {
  wsId: string
  lineId: string
}

interface ListLinesQuery {
  session_id?: string
  state?: string
}

interface LineResponse {
  id: string
  session_id: string
  command: string
  state: string
  started_at: number
  ended_at: number | null
  exit: number | null
  signal: number | null
  error: string | null
}

interface LineDetailResponse extends LineResponse {
  jobs: string[]
  processes: number[]
}

const STATES: readonly LineState[] = ['waiting', 'running', 'stopping', 'exited']

function toResponse(record: Line): LineResponse {
  return {
    id: record.id.value,
    session_id: record.sessionId,
    command: record.command,
    state: record.state,
    started_at: record.startedAt,
    ended_at: record.endedAt,
    exit: record.exit,
    signal: record.signal,
    error: record.error,
  }
}

export function registerLinesRoutes(
  app: RouteApp,
  deps: {
    registry: WorkspaceRegistry
  },
): void {
  app.get<{ Params: WsIdParams; Querystring: ListLinesQuery }>(
    '/v1/workspaces/:wsId/lines',
    (req, reply) => {
      // The lines the workspace keeps, oldest first: every one not ended
      // yet and the newest ended ones, a session's or those in a state
      // when named.
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
        .lines({
          ...(sessionId !== undefined && sessionId !== '' ? { sessionId } : {}),
          ...(state !== undefined ? { state: state as LineState } : {}),
        })
        .map(toResponse)
    },
  )

  app.get<{ Params: WsLineParams }>('/v1/workspaces/:wsId/lines/:lineId', (req, reply) => {
    // One line, with the ids of the jobs it started and the pids of the
    // processes it ran.
    const { wsId, lineId } = req.params
    if (deps.registry.visible(wsId, req.account) === null) {
      return reply.status(404).send({ detail: 'workspace not found' })
    }
    const ws = deps.registry.get(wsId).runner.ws
    const record = ws.line(new LineId(lineId))
    if (record === null) return reply.status(404).send({ detail: 'line not found' })
    const detail: LineDetailResponse = {
      ...toResponse(record),
      jobs: ws
        .jobs()
        .filter((job) => job.line?.value === record.id.value)
        .map((job) => job.id.console),
      processes: ws.processes({ lineId: record.id }).map((process) => process.id.pid),
    }
    return detail
  })
}
