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
import { explanationToDict } from '../io_serde.ts'

export interface ExplainRoutesDeps {
  registry: WorkspaceRegistry
}

interface WsIdParams {
  wsId: string
}

interface ExplainShellRequest {
  command?: unknown
  session_id?: unknown
}

export function registerExplainRoutes(app: FastifyInstance, deps: ExplainRoutesDeps): void {
  app.post<{ Params: WsIdParams; Body: ExplainShellRequest | undefined }>(
    '/v1/workspaces/:wsId/explain/shell',
    async (req, reply) => {
      // What a line would do as a session, without running any of it:
      // `session.explain.shell`, the dry run of `POST /shell`.
      const { wsId } = req.params
      if (deps.registry.visible(wsId, req.account) === null) {
        return reply.status(404).send({ detail: 'workspace not found' })
      }
      const body: ExplainShellRequest = req.body ?? {}
      if (typeof body.command !== 'string') {
        return reply.status(422).send({ detail: 'command must be a string' })
      }
      const sessionId = typeof body.session_id === 'string' ? body.session_id : ''
      const ws = deps.registry.get(wsId).runner.ws
      await ws.ensureSessionsLoaded()
      if (sessionId !== '' && !ws.listSessions().some((s) => s.sessionId === sessionId)) {
        return reply.status(404).send({ detail: 'session not found' })
      }
      const said = await ws.explain(body.command, sessionId)
      return { explanations: said.map(explanationToDict) }
    },
  )
}
