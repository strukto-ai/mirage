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

import { SessionProfile } from '@struktoai/mirage-core/policy/profile'
import type { JsonValue, MountMode } from '@struktoai/mirage-core/types'
import { z } from '@struktoai/mirage-core/vfs/secrets'
import type { Workspace } from '@struktoai/mirage-core/workspace/workspace/workspace'
import type { RouteApp } from '../routes.ts'
import { refused } from '../metrics.ts'
import type { WorkspaceRegistry } from '../registry.ts'
import { HttpError, loaderError, validationError, WorkspaceMissing } from '../errors.ts'

interface WsIdParams {
  wsId: string
}

interface WsSessionParams {
  wsId: string
  sessionId: string
}

/**
 * A new session: its id (generated when unset or empty), optional
 * per-mount modes and the profile it runs under, by name from the
 * workspace. `mounts` maps a prefix to its mode ('read', 'write', 'exec',
 * or the filesystem aliases), never a bare list. A list of prefixes used
 * to mean "only these mounts" and now means nothing at all, so it is
 * refused here rather than accepted as a no-op that reads like
 * confinement. A named mount is narrowed to the weaker of its own mode and
 * this one; a mount the mapping omits keeps its own mode. Fields it does
 * not name are ignored, as Python's model ignores them.
 */
const CreateSessionRequest = z.object({
  session_id: z.string().nullish(),
  mounts: z.record(z.string(), z.string()).nullish(),
  profile: z.string().nullish(),
})

/** A session's new profile: a name, null for none, or an inline profile. */
const UpdateSessionRequest = z
  .object({ profile: z.union([z.string(), z.null(), z.record(z.string(), z.unknown())]) })
  .strict()

export function registerSessionsRoutes(
  app: RouteApp,
  deps: {
    registry: WorkspaceRegistry
    /**
     * A profile with its path-form policy programs read in: the host's to
     * answer, since a path names a file on the host's disk.
     */
    loadProfile: (profile: SessionProfile) => SessionProfile
  },
): void {
  app.post<{ Params: WsIdParams; Body: JsonValue }>(
    '/v1/workspaces/:wsId/sessions',
    async (req, reply) => {
      const { wsId } = req.params
      const parsed = CreateSessionRequest.safeParse(req.body)
      if (!parsed.success) throw validationError(parsed.error, req.body)
      if (deps.registry.visible(wsId, req.account) === null) {
        throw new WorkspaceMissing(wsId)
      }
      const named = parsed.data.session_id ?? ''
      const sid =
        named !== ''
          ? named
          : `sess_${Array.from(crypto.getRandomValues(new Uint8Array(6)), (byte) => byte.toString(16).padStart(2, '0')).join('')}`
      const ws = deps.registry.get(wsId).runner.ws
      await ws.ensureSessionsLoaded()
      const held = ws.listSessions()
      if (held.some((s) => s.sessionId === sid)) {
        throw new HttpError('already_exists', 'session id already exists')
      }
      const cap = deps.registry.maxSessions
      if (cap !== null && held.length >= cap) {
        refused('max_sessions')
        throw new HttpError('session_limit', `workspace is at max_sessions (${String(cap)})`)
      }
      const mounts = parsed.data.mounts ?? null
      const profile = parsed.data.profile ?? null
      let sess
      try {
        sess = ws.createSession(sid, {
          ...(mounts !== null ? { mounts: mounts as Record<string, MountMode> } : {}),
          ...(profile !== null ? { profile } : {}),
        })
      } catch (err) {
        throw loaderError(err, ['profile'], profile)
      }
      await ws.flushSessions()
      return reply.status(201).send({ session_id: sess.sessionId, cwd: sess.cwd })
    },
  )

  app.get<{ Params: WsIdParams }>('/v1/workspaces/:wsId/sessions', async (req) => {
    const { wsId } = req.params
    if (deps.registry.visible(wsId, req.account) === null) {
      throw new WorkspaceMissing(wsId)
    }
    const ws = deps.registry.get(wsId).runner.ws
    await ws.ensureSessionsLoaded()
    return ws.listSessions().map((s) => ({ session_id: s.sessionId, cwd: s.cwd }))
  })

  app.delete<{ Params: WsSessionParams }>(
    '/v1/workspaces/:wsId/sessions/:sessionId',
    async (req) => {
      const ws = await sessionWorkspace(req.params, req.account)
      await ws.closeSession(req.params.sessionId)
      return { session_id: req.params.sessionId }
    },
  )

  /** Replace the session's profile; its cwd, env and history stay. */
  app.patch<{ Params: WsSessionParams; Body: JsonValue }>(
    '/v1/workspaces/:wsId/sessions/:sessionId',
    async (req) => {
      const parsed = UpdateSessionRequest.safeParse(req.body)
      if (!parsed.success) throw validationError(parsed.error, req.body)
      const ws = await sessionWorkspace(req.params, req.account)
      const asked = parsed.data.profile
      try {
        const profile =
          typeof asked === 'string' || asked === null
            ? asked
            : deps.loadProfile(SessionProfile(asked))
        const session = await ws.setSessionProfile(req.params.sessionId, profile)
        return { session_id: session.sessionId, cwd: session.cwd }
      } catch (err) {
        throw loaderError(err, ['profile'], asked)
      }
    },
  )

  /**
   * Cancel the session's running and queued lines, from every entry point. The
   * session stays open; answers once those lines have ended.
   */
  app.post<{ Params: WsSessionParams }>(
    '/v1/workspaces/:wsId/sessions/:sessionId/cancel',
    async (req) => {
      const ws = await sessionWorkspace(req.params, req.account)
      return { canceled: await ws.cancel(req.params.sessionId) }
    },
  )

  /** Kill the session's background jobs and runners; it stays open. */
  app.post<{ Params: WsSessionParams }>(
    '/v1/workspaces/:wsId/sessions/:sessionId/kill',
    async (req) => {
      const ws = await sessionWorkspace(req.params, req.account)
      return { killed: await ws.kill(req.params.sessionId) }
    },
  )

  /** The workspace holding the session; throws when either is missing. */
  async function sessionWorkspace(
    params: WsSessionParams,
    account: string | null,
  ): Promise<Workspace> {
    const entry = deps.registry.visible(params.wsId, account)
    if (entry === null) throw new WorkspaceMissing(params.wsId)
    const ws = entry.runner.ws
    await ws.ensureSessionsLoaded()
    if (!ws.listSessions().some((s) => s.sessionId === params.sessionId)) {
      throw new HttpError('not_found', 'session not found')
    }
    return ws
  }
}
