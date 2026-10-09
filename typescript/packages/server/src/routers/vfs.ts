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

import { DEFAULT_MAX_REQUEST_BODY_SIZE } from '@modelcontextprotocol/server'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { classify } from '@struktoai/mirage-core/errors/classify'
import type { FsCondition } from '@struktoai/mirage-core/errors/types'
import type { JsonValue } from '@struktoai/mirage-core/types'
import { Session } from '@struktoai/mirage-core/workspace/workspace/workspace'
import type { Workspace } from '@struktoai/mirage-core/workspace/workspace/workspace'
import { CallArgsError, answered, checked, failureToDict } from '../io_serde.ts'
import type { WorkspaceEntry, WorkspaceRegistry } from '../registry.ts'
import { VFS_CALLS } from '../vfs_calls.ts'

export interface VfsRoutesDeps {
  registry: WorkspaceRegistry
}

interface CallQuery {
  session_id?: string
  explain?: string
}

const STATUS: Partial<Record<FsCondition, number>> = {
  ENOENT: 404,
  NO_XATTR: 404,
  EACCES: 403,
  EPERM: 403,
  EROFS: 403,
  EEXIST: 409,
  ENOTEMPTY: 409,
  EBUSY: 409,
  ENOTDIR: 400,
  EISDIR: 400,
  EINVAL: 400,
  EXDEV: 400,
  ELOOP: 400,
  ENOTSUP: 400,
}

/** Thrown for a request the route answers with a fixed status and detail. */
export class RouteError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/** The workspace a route names, as the caller may see it. Mirrors Python's `require_entry`. */
export function requireEntry(
  registry: WorkspaceRegistry,
  wsId: string,
  account: string | null,
): WorkspaceEntry {
  if (registry.visible(wsId, account) === null) throw new RouteError(404, 'workspace not found')
  return registry.get(wsId)
}

/** The session a call acts as: the one named, or the default. Mirrors Python's `session_of`. */
export async function sessionOf(ws: Workspace, sessionId: string | undefined): Promise<Session> {
  await ws.ensureSessionsLoaded()
  if (
    sessionId !== undefined &&
    sessionId !== '' &&
    !ws.listSessions().some((s) => s.sessionId === sessionId)
  ) {
    throw new RouteError(404, 'session not found')
  }
  return new Session(ws, sessionId === undefined || sessionId === '' ? null : sessionId)
}

/** Whether a query flag is set; anything but `true` or `false` is refused. */
export function queryFlag(value: string | undefined, name: string): boolean {
  if (value === undefined || value === 'false') return false
  if (value === 'true') return true
  throw new RouteError(400, `${name} must be true or false`)
}

/**
 * A call's failure as the HTTP entry points answer it: the errno it names picks
 * the status, and the body carries the errno, the text and, for a policy's
 * refusal, its record. Mirrors Python's `failure`.
 */
export function failure(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof RouteError) return reply.status(err.status).send({ detail: err.message })
  if (err instanceof CallArgsError) return reply.status(400).send({ detail: err.message })
  const condition = classify(err)
  const status = condition === null ? 500 : (STATUS[condition] ?? 500)
  return reply.status(status).send(failureToDict(err))
}

/**
 * Serve each `session.vfs` call at `POST /v1/workspaces/:wsId/vfs/<call>`
 * and `session.glob` at `POST /v1/workspaces/:wsId/glob`, each as the
 * session `?session_id=` names. `?explain=true` answers what a VFS call
 * would do instead of doing it.
 */
export function registerVfsRoutes(app: FastifyInstance, deps: VfsRoutesDeps): void {
  for (const call of VFS_CALLS) {
    app.post<{ Params: { wsId: string }; Querystring: CallQuery }>(
      `/v1/workspaces/:wsId/vfs/${call.name}`,
      { bodyLimit: DEFAULT_MAX_REQUEST_BODY_SIZE },
      async (req, reply) => {
        let body: JsonValue
        try {
          const ws = requireEntry(deps.registry, req.params.wsId, req.account).runner.ws
          const explain = queryFlag(req.query.explain, 'explain')
          const args = await checked(call, req.body ?? {})
          const session = await sessionOf(ws, req.query.session_id)
          body = await answered(session, call, args, explain)
        } catch (err) {
          return failure(reply, err)
        }
        return reply.send(body)
      },
    )
  }
  app.post<{
    Params: { wsId: string }
    Querystring: CallQuery
    Body: { pattern?: unknown } | undefined
  }>(
    '/v1/workspaces/:wsId/glob',
    { bodyLimit: DEFAULT_MAX_REQUEST_BODY_SIZE },
    async (req, reply) => {
      let paths: string[]
      try {
        const ws = requireEntry(deps.registry, req.params.wsId, req.account).runner.ws
        const pattern = req.body?.pattern
        if (typeof pattern !== 'string') throw new RouteError(400, 'pattern must be a string')
        const session = await sessionOf(ws, req.query.session_id)
        paths = await session.glob(pattern)
      } catch (err) {
        return failure(reply, err)
      }
      return reply.send({ paths })
    },
  )
}
