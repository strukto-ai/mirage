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

import { Outcome, Scope, type Decision } from '@struktoai/mirage-core/policy/index'
import type { RouteApp } from '../routes.ts'
import type { WorkspaceRegistry } from '../registry.ts'
import { z } from '@struktoai/mirage-core/vfs/secrets'
import { HttpError, validationError } from '../errors.ts'
import { requireEntry, sessionOf, queryFlag } from './vfs.ts'

interface WsIdParams {
  wsId: string
}

interface WsAskParams {
  wsId: string
  askId: string
}

interface ListAsksQuery {
  session_id?: string
  all?: string
}

/** An answer to one waiting ask. */
const AnswerAskRequest = z.object({
  answer: z.enum(['allow', 'deny']),
  scope: z.enum(['once', 'session']).optional(),
  note: z.string().optional(),
})

interface AskResponse {
  id: string
  session_id: string
  command: string
  argv: string[]
  cwd: string
  paths: string[]
  reason: string
  outcome: string | null
  scope: string
  note: string
}

function toResponse(record: Decision): AskResponse {
  return {
    id: record.id,
    session_id: record.sessionId,
    command: record.command,
    argv: [...record.argv],
    cwd: record.cwd,
    paths: [...record.paths],
    reason: record.reason,
    outcome: record.outcome,
    scope: record.scope,
    note: record.note,
  }
}

export function registerAsksRoutes(
  app: RouteApp,
  deps: {
    registry: WorkspaceRegistry
  },
): void {
  app.get<{ Params: WsIdParams; Querystring: ListAsksQuery }>(
    '/v1/workspaces/:wsId/asks',
    async (req) => {
      // The workspace's asks: pending by default, every decision under
      // all=true. The ledger already serves both views from one store,
      // so the entry point only picks which query to run. A mistyped
      // session filter is the caller's error, answered in the sessions
      // router's voice rather than as a 500.
      const settled = queryFlag(req.query, 'all').all
      const ws = requireEntry(deps.registry, req.params.wsId, req.account).runner.ws
      const sessionId = req.query.session_id ?? ''
      await sessionOf(ws, sessionId)
      const records = settled ? ws.decisions.list(sessionId) : ws.decisions.pending(sessionId)
      return records.map(toResponse)
    },
  )

  app.post<{ Params: WsAskParams; Body: unknown }>(
    '/v1/workspaces/:wsId/asks/:askId',
    async (req) => {
      // Answer one waiting ask, allow or deny, and return the settled
      // record. A known id with nothing waiting is 409 rather than 404,
      // so an operator retrying a click reads "already answered", not
      // "not found".
      const { wsId, askId } = req.params
      const parsed = AnswerAskRequest.safeParse(req.body)
      if (!parsed.success) throw validationError(parsed.error, req.body)
      const body = parsed.data
      const answer = body.answer
      const scope = body.scope ?? 'once'
      const ws = requireEntry(deps.registry, wsId, req.account).runner.ws
      if (answer === 'deny' && scope === 'session') {
        // covers() never lets a session-scoped deny answer anything: a
        // deny refuses the retry once, and asking again raises a new
        // record. Recording one would be a rule that can never speak.
        throw new HttpError(
          'invalid_request',
          'a deny answers once; asking again raises a new record',
        )
      }
      const note = body.note ?? ''
      await ws.ensureSessionsLoaded()
      const held = ws.decisions.list()
      const waiting = held.find((r) => r.id === askId && r.outcome === null)
      if (waiting === undefined) {
        if (held.some((r) => r.id === askId)) {
          throw new HttpError('conflict', `ask already answered: ${askId}`)
        }
        throw new HttpError('not_found', 'ask not found')
      }
      const outcome = answer === 'allow' ? Outcome.ALLOW : Outcome.DENY
      const scopeValue = scope === 'once' ? Scope.ONCE : Scope.SESSION
      await ws.decisions.answer(askId, outcome, scopeValue, note)
      return toResponse({ ...waiting, outcome, scope: scopeValue, note })
    },
  )
}
