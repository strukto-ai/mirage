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
import { classify } from '@struktoai/mirage-core/errors/classify'
import type { JsonValue } from '@struktoai/mirage-core/types'
import type { Workspace } from '@struktoai/mirage-core/workspace/workspace/workspace'
import { Session } from '@struktoai/mirage-core/workspace/workspace/workspace'
import { stderr } from 'node:process'
import { format } from 'node:util'
import { errorOf, errorResponse, fsError, HttpError, WorkspaceMissing } from '../errors.ts'
import { answered, CallArgsError, checked, customAnswer } from '../io_serde.ts'
import type { WorkspaceEntry, WorkspaceRegistry } from '../registry.ts'
import { streamOf, type RouteApp, type RouteReply } from '../routes.ts'
import { VFS_CALLS } from '../vfs_calls.ts'

// Diagnostics go to stderr, never stdout, which a stdio transport speaks on;
// written whole, as a Worker's node:console cannot build a Console.
const logger = {
  debug: (...args: unknown[]): void => {
    stderr.write(`${format(...args)}\n`)
  },
}

interface CallQuery {
  session_id?: string
  explain?: string
}

/** The workspace a route names, as the caller may see it. Mirrors Python's `require_entry`. */
export function requireEntry(
  registry: WorkspaceRegistry,
  wsId: string,
  account: string | null,
): WorkspaceEntry {
  if (registry.visible(wsId, account) === null) throw new WorkspaceMissing(wsId)
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
    throw new HttpError('not_found', 'session not found')
  }
  return new Session(ws, sessionId === undefined || sessionId === '' ? null : sessionId)
}

/**
 * Whether each named boolean query flag is set. Accepts what a FastAPI `bool`
 * does (`true`/`false`, `1`/`0`, `yes`/`no`, `on`/`off`, `t`/`f`, `y`/`n`, any
 * case); anything else, an empty value included, is refused naming the first
 * bad flag, in the order named. A flag given more than once, which a host
 * hands over as a list, takes its last value, as FastAPI does. Absent is false.
 */
export function queryFlag<K extends string>(
  query: Partial<Record<K, string | string[]>>,
  ...names: K[]
): Record<K, boolean> {
  const flags = {} as Record<K, boolean>
  for (const name of names) {
    const given: string | string[] | undefined = query[name]
    const value = typeof given === 'object' ? given.at(-1) : given
    const spelled = value?.toLowerCase() ?? 'false'
    flags[name] = ['true', '1', 'yes', 'on', 't', 'y'].includes(spelled)
    if (!flags[name] && !['false', '0', 'no', 'off', 'f', 'n'].includes(spelled)) {
      throw new HttpError('invalid_value', `${name} must be a boolean`, { param: name })
    }
  }
  return flags
}

/**
 * The JSON object a route reads as its body: an empty body is not JSON, and
 * JSON that is not an object is refused. Bytes that do not parse answer
 * `invalid_json` before the route runs. Mirrors Python's `json_body`.
 */
export function jsonBody(body: unknown): Record<string, unknown> {
  if (body === undefined) throw new HttpError('invalid_json', 'body must be JSON')
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError('invalid_request', 'body must be a JSON object')
  }
  return body as Record<string, unknown>
}

/**
 * A call's failure as the HTTP entry points answer it: an `HttpError` as it
 * is, an argument refusal as its own, a named errno by its code (with a
 * policy's refusal record), anything else `internal`, its cause logged. A
 * missing workspace is thrown on, for the app to tell a stopped one from an
 * unknown one. Mirrors Python's `failure`.
 */
export function failure(reply: RouteReply, err: unknown): RouteReply {
  if (err instanceof WorkspaceMissing) throw err
  if (err instanceof CallArgsError) return errorResponse(reply, err.error())
  if (!(err instanceof HttpError) && classify(err) !== null)
    return errorResponse(reply, fsError(err))
  return errorResponse(reply, errorOf(err))
}

/**
 * Serve each `session.vfs` call at `POST /v1/workspaces/:wsId/vfs/<call>`,
 * as the session `?session_id=` names. `?explain=true` answers what a VFS call
 * would do instead of doing it. A `read` that asks for `stream` answers its
 * bytes as they are pulled, over HTTP only, where the body can carry them
 * raw. Mirrors Python's `vfs_route`.
 */
export function registerVfsRoutes(
  app: RouteApp,
  deps: {
    registry: WorkspaceRegistry
  },
): void {
  for (const call of VFS_CALLS) {
    app.post<{ Params: { wsId: string }; Querystring: CallQuery }>(
      `/v1/workspaces/:wsId/vfs/${call.name}`,
      { bodyLimit: DEFAULT_MAX_REQUEST_BODY_SIZE },
      async (req, reply) => {
        let body: JsonValue
        try {
          const { explain } = queryFlag(req.query, 'explain')
          const ws = requireEntry(deps.registry, req.params.wsId, req.account).runner.ws
          const params = jsonBody(req.body)
          const asked = call.name === 'read' && params.stream !== undefined
          const stream = asked ? params.stream : false
          if (typeof stream !== 'boolean') {
            throw new HttpError('invalid_value', 'stream must be a boolean', { param: 'stream' })
          }
          const args = await checked(
            call,
            asked
              ? Object.fromEntries(Object.entries(params).filter(([key]) => key !== 'stream'))
              : params,
          )
          const session = await sessionOf(ws, req.query.session_id)
          if (stream && !explain) {
            const source = await session.vfs.read(args.path as string, {
              offset: (args.offset as number | undefined) ?? 0,
              size: (args.size as number | null | undefined) ?? null,
              raw: args.raw === true,
              stream: true,
            })
            return reply
              .type('application/octet-stream')
              .header('Cache-Control', 'no-store')
              .send(streamOf(source))
          }
          body = await answered(session, call, args, explain)
        } catch (err) {
          logger.debug('vfs/%s failed', call.name, err)
          return failure(reply, err)
        }
        return reply.type('application/json; charset=utf-8').send(JSON.stringify(body))
      },
    )
  }
  app.post<{ Params: { wsId: string; name: string }; Querystring: CallQuery }>(
    '/v1/workspaces/:wsId/vfs/:name',
    { bodyLimit: DEFAULT_MAX_REQUEST_BODY_SIZE },
    async (req, reply) => {
      try {
        const ws = requireEntry(deps.registry, req.params.wsId, req.account).runner.ws
        const params = jsonBody(req.body)
        const session = await sessionOf(ws, req.query.session_id)
        return reply
          .type('application/json; charset=utf-8')
          .send(JSON.stringify(await customAnswer(session, req.params.name, params)))
      } catch (err) {
        logger.debug('vfs/%s failed', req.params.name, err)
        return failure(reply, err)
      }
    },
  )
}
