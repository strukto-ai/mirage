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

import type { Process, ProcessState } from '@struktoai/mirage-core/execution/process/types'
import { LineId, ProcessId } from '@struktoai/mirage-core/execution/types'
import type { RouteApp } from '../routes.ts'
import type { WorkspaceRegistry } from '../registry.ts'

interface WsIdParams {
  wsId: string
}

interface WsProcessParams {
  wsId: string
  pid: string
}

interface ListProcessesQuery {
  session_id?: string
  state?: string
  line_id?: string
}

interface ProcessResponse {
  pid: number
  session_id: string
  line_id: string | null
  parent: number | null
  group: number
  command: string
  cwd: string
  machine: string
  runtime: string | null
  machine_pid: number | null
  state: string
  started_at: number
  ended_at: number | null
  exit: number | null
  signal: number | null
  error: string | null
}

const STATES: readonly ProcessState[] = ['running', 'stopping', 'exited']

function toResponse(record: Process): ProcessResponse {
  return {
    pid: record.id.pid,
    session_id: record.sessionId,
    line_id: record.line?.value ?? null,
    parent: record.parent,
    group: record.group,
    command: record.command,
    cwd: record.cwd.virtual,
    machine: record.machine.toString(),
    runtime: record.runtime,
    machine_pid: record.machinePid?.pid ?? null,
    state: record.state,
    started_at: record.startedAt,
    ended_at: record.endedAt,
    exit: record.exit,
    signal: record.signal,
    error: record.error,
  }
}

export function registerProcessesRoutes(
  app: RouteApp,
  deps: {
    registry: WorkspaceRegistry
  },
): void {
  app.get<{ Params: WsIdParams; Querystring: ListProcessesQuery }>(
    '/v1/workspaces/:wsId/processes',
    (req, reply) => {
      // The processes the workspace keeps, by pid: every live one and the
      // newest ended ones, a session's, those in a state or those a line
      // ran when named.
      const { wsId } = req.params
      if (deps.registry.visible(wsId, req.account) === null) {
        return reply.status(404).send({ detail: 'workspace not found' })
      }
      const { session_id: sessionId, state, line_id: lineId } = req.query
      if (state !== undefined && !(STATES as readonly string[]).includes(state)) {
        return reply.status(422).send({ detail: `state must be one of ${STATES.join(', ')}` })
      }
      const ws = deps.registry.get(wsId).runner.ws
      return ws
        .processes({
          ...(sessionId !== undefined && sessionId !== '' ? { sessionId } : {}),
          ...(state !== undefined ? { state: state as ProcessState } : {}),
          ...(lineId !== undefined && lineId !== '' ? { lineId: new LineId(lineId) } : {}),
        })
        .map(toResponse)
    },
  )

  app.get<{ Params: WsProcessParams }>('/v1/workspaces/:wsId/processes/:pid', (req, reply) => {
    // One process, by its pid.
    const { wsId, pid } = req.params
    if (deps.registry.visible(wsId, req.account) === null) {
      return reply.status(404).send({ detail: 'workspace not found' })
    }
    if (!/^\d+$/.test(pid)) return reply.status(422).send({ detail: 'pid must be a number' })
    const ws = deps.registry.get(wsId).runner.ws
    const record = ws.process(new ProcessId(ws.workspaceId, Number(pid)))
    if (record === null) return reply.status(404).send({ detail: 'process not found' })
    return toResponse(record)
  })
}
