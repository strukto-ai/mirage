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
import { registerApi } from '@struktoai/mirage-server/api'
import { AuthMode, type AuthConfig } from '@struktoai/mirage-server/auth/config'
import { authenticator, PUBLIC_PATHS } from '@struktoai/mirage-server/auth/middleware'
import { WorkspaceRegistry } from '@struktoai/mirage-server/registry'
import { HOST } from './host.ts'
import { WebRoutes } from './router.ts'

interface Served {
  routes: WebRoutes
  mcp: ReturnType<typeof registerApi>
}

export interface EdgeAppOptions {
  /** How each request is checked: a shared bearer token, or JWTs from an issuer. */
  auth: AuthConfig
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
  readonly registry: WorkspaceRegistry
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
 * routes the Node daemon serves, over workspaces held in
 * this isolate's memory. SSH, kernel mounts and policy files on disk are
 * the Node daemon's alone.
 */
export function createApp(options: EdgeAppOptions): EdgeApp {
  const check = authenticator(options.auth)
  if (check === null) throw new Error('an edge app needs a bearer token or a JWT issuer')
  const registry = new WorkspaceRegistry({
    accountsRequired: options.auth.mode === AuthMode.Jwt,
    ...(options.maxWorkspaces !== undefined ? { maxWorkspaces: options.maxWorkspaces } : {}),
    ...(options.maxSessions !== undefined ? { maxSessions: options.maxSessions } : {}),
    policies: options.policies ?? [],
  })
  // Registered on the first request: a Worker's clock reads 0 at global
  // scope, where an app is built, and the server's uptime counts from here.
  let served: Served | null = null
  const serve = (): Served => {
    if (served !== null) return served
    const routes = new WebRoutes()
    const mcp = registerApi(routes, {
      registry,
      host: HOST,
      auth: options.auth,
      startedAt: Date.now() / 1000,
      exit: () => undefined,
      snapshotStore: options.snapshotStore,
    })
    served = { routes, mcp }
    return served
  }
  return {
    registry,
    async fetch(request) {
      let account: string | null = null
      if (!PUBLIC_PATHS.has(new URL(request.url).pathname)) {
        const answer = await check(request.headers.get('authorization') ?? undefined)
        if (typeof answer === 'string') return unauthorized(answer)
        account = answer.account
      }
      return serve().routes.fetch(request, account)
    },
    async close() {
      try {
        await served?.mcp.close()
        await registry.jobs.close()
      } finally {
        await registry.closeAll()
      }
    },
  }
}
