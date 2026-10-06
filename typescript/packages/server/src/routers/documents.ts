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
import { PolicyError } from '@struktoai/mirage-core/policy/errors'
import { isFsError } from '@struktoai/mirage-core/utils/errors'
import type { WorkspaceRegistry } from '../registry.ts'

export interface DocumentsRoutesDeps {
  registry: WorkspaceRegistry
}
interface DocumentParams {
  wsId: string
  sessionId?: string
}
interface DocumentQuery {
  profile?: string
  session_id?: string
}
interface DocumentPath {
  path: string
}

export function registerDocumentsRoutes(app: FastifyInstance, deps: DocumentsRoutesDeps): void {
  for (const kind of ['vfs', 'skill'] as const) {
    for (const base of ['/v1/workspaces/:wsId', '/v1/workspaces/:wsId/sessions/:sessionId']) {
      for (const method of ['GET', 'PUT'] as const) {
        app.route<{ Params: DocumentParams; Querystring: DocumentQuery; Body: DocumentPath }>({
          method,
          url: `${base}/${kind}-md`,
          ...(method === 'PUT'
            ? {
                schema: {
                  body: {
                    type: 'object',
                    properties: { path: { type: 'string' } },
                    required: ['path'],
                    additionalProperties: false,
                  },
                },
              }
            : {}),
          handler: async (req, reply) => {
            const entry = deps.registry.visible(req.params.wsId, req.account)
            if (entry === null) return reply.status(404).send({ detail: 'workspace not found' })
            const ws = entry.runner.ws
            // Loaded before the error mapping: a store that cannot be read
            // is the server's failure, never a 403 or 404 to the client.
            await ws.ensureSessionsLoaded()
            const sessionId = req.params.sessionId ?? req.query.session_id
            const path = method === 'PUT' ? req.body.path : undefined
            try {
              const options = {
                ...(sessionId !== undefined ? { sessionId } : {}),
                ...(req.query.profile !== undefined ? { profile: req.query.profile } : {}),
              }
              const content = await (kind === 'vfs'
                ? ws.vfsMd(path, options)
                : ws.skillMd(path, options))
              return await reply.type('text/markdown; charset=utf-8').send(content)
            } catch (error) {
              // The session is looked up inside the call, as Python does, so
              // one closed since the request arrived answers 404 too.
              if (error instanceof Error && error.message.startsWith('unknown session'))
                return reply.status(404).send({ detail: 'session not found' })
              const code = error instanceof Error && 'code' in error ? String(error.code) : ''
              const status = (
                { ENOENT: 404, ENOTDIR: 422, EEXIST: 409, EACCES: 403 } as Record<string, number>
              )[code]
              if (status !== undefined) return reply.status(status).send({ detail: String(error) })
              if (isFsError(error)) throw error
              if (
                error instanceof PolicyError ||
                (error instanceof Error &&
                  (error.message.startsWith('profile is only') ||
                    error.message.startsWith('document path must')))
              ) {
                return reply.status(422).send({ detail: error.message })
              }
              throw error
            }
          },
        })
      }
    }
  }
}
