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
import type { WorkspaceRegistry } from '../registry.ts'
import { Outcome, Scope, type Decision } from '@struktoai/mirage-core/policy/index'

export interface AsksRoutesDeps {
  registry: WorkspaceRegistry
}

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

interface AnswerAskBody {
  answer?: string
  scope?: string
  note?: string
}

interface AskResponse {
  id: string
  session_id: string
  agent_id: string
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
    agent_id: record.agentId,
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

export function registerAsksRoutes(app: FastifyInstance, deps: AsksRoutesDeps): void {
  app.get<{ Params: WsIdParams; Querystring: ListAsksQuery }>(
    '/v1/workspaces/:wsId/asks',
    async (req, reply) => {
      // The workspace's asks: pending by default, every decision under
      // all=true. The ledger already serves both views from one store,
      // so the door only picks which query to run.
      const { wsId } = req.params
      if (deps.registry.visible(wsId, req.account) === null) {
        return reply.status(404).send({ detail: 'workspace not found' })
      }
      const ws = deps.registry.get(wsId).runner.ws
      await ws.ensureSessionsLoaded()
      const sessionId = req.query.session_id ?? ''
      // The ledger reads a named session through SessionManager.get,
      // which throws for an unknown id; a mistyped filter is the
      // caller's error, answered in the sessions router's voice rather
      // than as a 500.
      if (sessionId !== '' && !ws.listSessions().some((s) => s.sessionId === sessionId)) {
        return reply.status(404).send({ detail: 'session not found' })
      }
      const records =
        req.query.all === 'true' ? ws.decisions.list(sessionId) : ws.decisions.pending(sessionId)
      return records.map(toResponse)
    },
  )

  app.post<{ Params: WsAskParams; Body: AnswerAskBody | undefined }>(
    '/v1/workspaces/:wsId/asks/:askId',
    async (req, reply) => {
      // Answer one waiting ask, allow or deny, and return the settled
      // record. A known id with nothing waiting is 409 rather than 404,
      // so an operator retrying a click reads "already answered", not
      // "not found".
      const { wsId, askId } = req.params
      if (deps.registry.visible(wsId, req.account) === null) {
        return reply.status(404).send({ detail: 'workspace not found' })
      }
      // Fastify's generic type does not validate at runtime: a POST
      // with no JSON body reaches here with req.body undefined, and
      // that is the caller's 422, not a 500.
      const body: AnswerAskBody = req.body ?? {}
      const answer = body.answer
      if (answer !== 'allow' && answer !== 'deny') {
        return reply.status(422).send({ detail: "answer must be 'allow' or 'deny'" })
      }
      const scope = body.scope ?? 'once'
      if (scope !== 'once' && scope !== 'session') {
        return reply.status(422).send({ detail: "scope must be 'once' or 'session'" })
      }
      if (answer === 'deny' && scope === 'session') {
        // covers() never lets a session-scoped deny answer anything: a
        // deny refuses the retry once, and asking again raises a new
        // record. Recording one would be a rule that can never speak.
        return reply
          .status(422)
          .send({ detail: 'a deny answers once; asking again raises a new record' })
      }
      const note = body.note ?? ''
      const ws = deps.registry.get(wsId).runner.ws
      await ws.ensureSessionsLoaded()
      const held = ws.decisions.list()
      const waiting = held.find((r) => r.id === askId && r.outcome === null)
      if (waiting === undefined) {
        if (held.some((r) => r.id === askId)) {
          return reply.status(409).send({ detail: `ask already answered: ${askId}` })
        }
        return reply.status(404).send({ detail: 'ask not found' })
      }
      const outcome = answer === 'allow' ? Outcome.ALLOW : Outcome.DENY
      const scopeValue = scope === 'once' ? Scope.ONCE : Scope.SESSION
      await ws.decisions.answer(askId, outcome, scopeValue, note)
      return toResponse({ ...waiting, outcome, scope: scopeValue, note })
    },
  )
}
