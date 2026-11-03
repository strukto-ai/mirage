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

import type { Policy } from '@struktoai/mirage-core/policy/base'
import type { S3Config } from '@struktoai/mirage-core/vfs/s3/config'
import { watchNetwork } from '@struktoai/mirage-core/io/web/network'
import { registerApi } from '@struktoai/mirage-server/api'
import { AuthMode, resolveAuthConfig, type AuthConfig } from '@struktoai/mirage-server/auth/config'
import { authenticator, PUBLIC_PATHS } from '@struktoai/mirage-server/auth/middleware'
import { WorkspaceRegistry } from '@struktoai/mirage-server/registry'
import { edgeHost, RAMRecordClient } from './host.ts'
import { WebRoutes } from './router.ts'

interface Served {
  check: NonNullable<ReturnType<typeof authenticator>>
  registry: WorkspaceRegistry
  routes: WebRoutes
  mcp: ReturnType<typeof registerApi>
}

export interface EdgeAppOptions {
  /**
   * How each request is checked: a shared bearer token, or JWTs from an
   * issuer. Undefined reads the `MIRAGE_AUTH_*` and `MIRAGE_JWT_*` env vars
   * the Node server reads.
   */
  auth?: AuthConfig
  /** The most workspaces held at once; past it a create answers 503. */
  maxWorkspaces?: number
  /** The most sessions each workspace holds; past it a new session answers 429. */
  maxSessions?: number
  /** The server's own policies, answered before a workspace is built and registered on each. */
  policies?: readonly Policy[]
  /** The S3-like store a snapshot request may name a key in. */
  snapshotStore?: S3Config
}

export interface EdgeApp {
  /** Answer one request, as the Node daemon answers it. */
  fetch(request: Request): Promise<Response>
  /** Close every workspace and the jobs still running. */
  close(): Promise<void>
}

function unauthorized(reason: string): Response {
  console.warn(`rejecting request: ${reason}`)
  return Response.json(
    { detail: 'Unauthorized' },
    { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } },
  )
}

/**
 * The server API on an edge runtime's web `Request`/`Response`: the same
 * routes the Node daemon serves, over workspaces held in this isolate's
 * memory. SSH, kernel mounts and policy files on disk are the Node
 * daemon's alone. `export default createApp()` serves it.
 */
export function createApp(options: EdgeAppOptions = {}): EdgeApp {
  // Built on the first request: an isolate's env and clock are not set at
  // global scope, where an app is built, and the server's uptime counts
  // from here.
  let served: Served | null = null
  const serve = (): Served => {
    if (served !== null) return served
    const auth = options.auth ?? resolveAuthConfig()
    const check = authenticator(auth)
    if (check === null) {
      throw new Error(
        'an edge app needs MIRAGE_AUTH_MODE=token with MIRAGE_AUTH_TOKEN, or MIRAGE_AUTH_MODE=jwt',
      )
    }
    const registry = new WorkspaceRegistry({
      accountsRequired: auth.mode === AuthMode.Jwt,
      owners: new RAMRecordClient(),
      watchNetwork,
      ...(options.maxWorkspaces !== undefined ? { maxWorkspaces: options.maxWorkspaces } : {}),
      ...(options.maxSessions !== undefined ? { maxSessions: options.maxSessions } : {}),
      policies: options.policies ?? [],
    })
    const routes = new WebRoutes()
    const mcp = registerApi(routes, {
      registry,
      host: edgeHost(),
      auth,
      startedAt: Date.now() / 1000,
      exit: () => undefined,
      snapshotStore: options.snapshotStore,
    })
    // The WebSocket routes run ssh2 and Codex's exec-server, which only
    // the Node server hosts.
    for (const path of ['/v1/workspaces/:id/ssh', '/v1/workspaces/:id/codex-exec']) {
      routes.get(path, (_req, reply) =>
        reply.status(501).send({ detail: `${path.split('/').pop() ?? ''} needs the Node server` }),
      )
    }
    served = { check, registry, routes, mcp }
    return served
  }
  // The requests still being answered, which close lets finish first, as
  // the Node server's close waits for its open requests.
  const answering = new Set<Promise<Response>>()
  const answer = async (request: Request): Promise<Response> => {
    const { check, routes } = serve()
    let account: string | null = null
    if (!PUBLIC_PATHS.has(new URL(request.url).pathname)) {
      const verdict = await check(request.headers.get('authorization') ?? undefined)
      if (typeof verdict === 'string') return unauthorized(verdict)
      account = verdict.account
    }
    return routes.fetch(request, account)
  }
  return {
    fetch(request) {
      const response = answer(request)
      const settle = (): void => {
        answering.delete(response)
      }
      answering.add(response)
      response.then(settle, settle)
      return response
    },
    async close() {
      if (served === null) return
      const { mcp, registry } = served
      // New workspaces and lines are refused from here; the running lines
      // are cancelled, and every request still open settles before the
      // workspaces close.
      await registry.drain(0)
      await Promise.allSettled([...answering])
      try {
        await mcp.close()
        await registry.jobs.close()
      } finally {
        await registry.closeAll()
      }
    },
  }
}
