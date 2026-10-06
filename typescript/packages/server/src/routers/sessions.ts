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

import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { Workspace } from '@struktoai/mirage-core/workspace/workspace/workspace'
import type { WorkspaceRegistry } from '../registry.ts'
import type { MountMode } from '@struktoai/mirage-core/types'

export interface SessionsRoutesDeps {
  registry: WorkspaceRegistry
}

interface WsIdParams {
  wsId: string
}

interface WsSessionParams {
  wsId: string
  sessionId: string
}

interface CreateSessionBody {
  session_id?: string
  /**
   * Optional per-mount modes for this session: a mapping of prefix to
   * mode ('read', 'write', 'exec', or the filesystem aliases), never a
   * bare list. A list of prefixes used to mean "only these mounts" and
   * now means nothing at all, so it is refused here rather than
   * accepted as a no-op that reads like confinement. A named mount is
   * narrowed to the weaker of its own mode and this one; a mount the
   * mapping omits keeps its own mode.
   */
  mounts?: Record<string, string> | null
  /** The profile this session runs under, by name from the workspace. */
  profile?: string | null
}

export function registerSessionsRoutes(app: FastifyInstance, deps: SessionsRoutesDeps): void {
  app.post<{ Params: WsIdParams; Body: CreateSessionBody }>(
    '/v1/workspaces/:wsId/sessions',
    async (req, reply) => {
      const { wsId } = req.params
      if (deps.registry.visible(wsId, req.account) === null) {
        return reply.status(404).send({ detail: 'workspace not found' })
      }
      const sid = req.body.session_id ?? `sess_${randomBytes(6).toString('hex')}`
      const ws = deps.registry.get(wsId).runner.ws
      await ws.ensureSessionsLoaded()
      if (ws.listSessions().some((s) => s.sessionId === sid)) {
        return reply.status(409).send({ detail: `session id already exists: ${sid}` })
      }
      const mounts = req.body.mounts ?? null
      const profile = req.body.profile ?? null
      let sess
      try {
        sess = ws.createSession(sid, {
          ...(mounts !== null ? { mounts: mounts as Record<string, MountMode> } : {}),
          ...(profile !== null ? { profile } : {}),
        })
      } catch (err) {
        return reply.status(422).send({ detail: err instanceof Error ? err.message : String(err) })
      }
      await ws.flushSessions()
      return reply.status(201).send({ session_id: sess.sessionId, cwd: sess.cwd })
    },
  )

  app.get<{ Params: WsIdParams }>('/v1/workspaces/:wsId/sessions', async (req, reply) => {
    const { wsId } = req.params
    if (deps.registry.visible(wsId, req.account) === null) {
      return reply.status(404).send({ detail: 'workspace not found' })
    }
    const ws = deps.registry.get(wsId).runner.ws
    await ws.ensureSessionsLoaded()
    return ws.listSessions().map((s) => ({ session_id: s.sessionId, cwd: s.cwd }))
  })

  app.delete<{ Params: WsSessionParams }>(
    '/v1/workspaces/:wsId/sessions/:sessionId',
    async (req, reply) => {
      const ws = await sessionWorkspace(req.params, req.account)
      if (typeof ws === 'string') return reply.status(404).send({ detail: ws })
      await ws.closeSession(req.params.sessionId)
      return { session_id: req.params.sessionId }
    },
  )

  /** Replace the session's profile; its cwd, env and history stay. */
  app.patch<{ Params: WsSessionParams; Body: { profile: string | null } }>(
    '/v1/workspaces/:wsId/sessions/:sessionId',
    {
      schema: {
        body: {
          type: 'object',
          required: ['profile'],
          properties: { profile: { type: ['string', 'null'] } },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const ws = await sessionWorkspace(req.params, req.account)
      if (typeof ws === 'string') return reply.status(404).send({ detail: ws })
      try {
        const session = await ws.setSessionProfile(req.params.sessionId, req.body.profile)
        return { session_id: session.sessionId, cwd: session.cwd }
      } catch (err) {
        return reply.status(422).send({ detail: err instanceof Error ? err.message : String(err) })
      }
    },
  )

  /**
   * Cancel the session's running and queued lines, from every door. The
   * session stays open; answers once those lines have ended.
   */
  app.post<{ Params: WsSessionParams }>(
    '/v1/workspaces/:wsId/sessions/:sessionId/cancel',
    async (req, reply) => {
      const ws = await sessionWorkspace(req.params, req.account)
      if (typeof ws === 'string') return reply.status(404).send({ detail: ws })
      return { canceled: await ws.cancel(req.params.sessionId) }
    },
  )

  /** Kill the session's background jobs and runners; it stays open. */
  app.post<{ Params: WsSessionParams }>(
    '/v1/workspaces/:wsId/sessions/:sessionId/kill',
    async (req, reply) => {
      const ws = await sessionWorkspace(req.params, req.account)
      if (typeof ws === 'string') return reply.status(404).send({ detail: ws })
      return { killed: await ws.kill(req.params.sessionId) }
    },
  )

  /** The workspace holding the session, or what is missing. */
  async function sessionWorkspace(
    params: WsSessionParams,
    account: string | null,
  ): Promise<Workspace | string> {
    const entry = deps.registry.visible(params.wsId, account)
    if (entry === null) return 'workspace not found'
    const ws = entry.runner.ws
    await ws.ensureSessionsLoaded()
    if (!ws.listSessions().some((s) => s.sessionId === params.sessionId)) {
      return 'session not found'
    }
    return ws
  }
}
