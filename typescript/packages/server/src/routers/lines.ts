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
import { PipeClosed } from '@struktoai/mirage-core/io/errors'
import type { BytePipe } from '@struktoai/mirage-core/io/pipe'
import type { RouteApp } from '../routes.ts'
import type { WorkspaceRegistry } from '../registry.ts'
import type { RequestTable } from '../requests.ts'
import { failure, HttpError, invalidChoice, requireEntry } from './vfs.ts'

const NOT_OPEN = "the line's stdin is not open"

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
  machines: string[]
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

/** A running line's open stdin: 404 when no such line runs there, 409 when it opened none. */
function openStdin(
  registry: WorkspaceRegistry,
  jobs: RequestTable,
  wsId: string,
  lineId: string,
  account: string | null,
): BytePipe {
  requireEntry(registry, wsId, account)
  const job = jobs.get(new LineId(lineId))
  if (job?.workspaceId !== wsId) throw new HttpError(404, 'line not found')
  if (job.stdin === undefined) throw new HttpError(409, NOT_OPEN)
  return job.stdin
}

export function registerLinesRoutes(
  app: RouteApp,
  deps: {
    registry: WorkspaceRegistry
    jobs: RequestTable
  },
): void {
  app.get<{ Params: WsIdParams; Querystring: ListLinesQuery }>(
    '/v1/workspaces/:wsId/lines',
    async (req, reply) => {
      // The lines the workspace keeps, oldest first: every one not ended
      // yet and the newest ended ones, a session's or those in a state
      // when named.
      const { wsId } = req.params
      const { session_id: sessionId, state } = req.query
      if (state !== undefined && !(STATES as readonly string[]).includes(state)) {
        return failure(reply, invalidChoice(['query', 'state'], STATES, state))
      }
      if (deps.registry.visible(wsId, req.account) === null) {
        return reply.status(404).send({ detail: 'workspace not found' })
      }
      const ws = deps.registry.get(wsId).runner.ws
      const records = await ws.lines({
        ...(sessionId !== undefined && sessionId !== '' ? { sessionId } : {}),
        ...(state !== undefined ? { state: state as LineState } : {}),
      })
      return records.map(toResponse)
    },
  )

  app.get<{ Params: WsLineParams }>('/v1/workspaces/:wsId/lines/:lineId', async (req, reply) => {
    // One line, with the ids of the jobs it started, the pids of the
    // processes it ran and the machines those ran on.
    const { wsId, lineId } = req.params
    if (deps.registry.visible(wsId, req.account) === null) {
      return reply.status(404).send({ detail: 'workspace not found' })
    }
    const ws = deps.registry.get(wsId).runner.ws
    const record = await ws.line(new LineId(lineId))
    if (record === null) return reply.status(404).send({ detail: 'line not found' })
    const processes = await ws.processes({ lineId: record.id })
    const detail: LineDetailResponse = {
      ...toResponse(record),
      jobs: (await ws.jobs({ lineId: record.id })).map((job) => job.id.console),
      processes: processes.map((process) => process.id.pid),
      machines: [...new Set(processes.map((process) => process.machine.toString()))],
    }
    return detail
  })

  app.post<{ Params: WsLineParams }>(
    '/v1/workspaces/:wsId/lines/:lineId/stdin',
    async (req, reply) => {
      // Send the body to a running line's open stdin. It answers once the
      // bytes are buffered, so a line that stops reading holds its writer
      // back.
      const { wsId, lineId } = req.params
      try {
        const stdin = openStdin(deps.registry, deps.jobs, wsId, lineId, req.account)
        for await (const chunk of req.raw) await stdin.write(chunk, req.closed)
      } catch (err) {
        // A caller that hung up takes the bytes not yet buffered with it.
        if (req.closed.aborted) return reply.status(499).send()
        // The rest of a refused body is left unread, so the connection closes
        // after the answer.
        reply.header('connection', 'close')
        return failure(reply, err instanceof PipeClosed ? new HttpError(409, NOT_OPEN) : err)
      }
      return reply.status(204).send()
    },
  )

  app.delete<{ Params: WsLineParams }>('/v1/workspaces/:wsId/lines/:lineId/stdin', (req, reply) => {
    // End a running line's open stdin: the line reads what was sent, then
    // end of file.
    const { wsId, lineId } = req.params
    try {
      openStdin(deps.registry, deps.jobs, wsId, lineId, req.account).end()
    } catch (err) {
      return failure(reply, err)
    }
    return reply.status(204).send()
  })
}
