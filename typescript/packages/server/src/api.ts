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

import type { ResourceStore } from '@struktoai/mirage-core/resources/base'
import type { S3Config } from '@struktoai/mirage-core/vfs/s3/config'
import type { AuthConfig } from './auth/config.ts'
import { registerMcpRoutes, type McpEndpoint } from './mcp/http.ts'
import type { WorkspaceRegistry } from './registry.ts'
import { registerRpcRoutes } from './rpc/http.ts'
import { registerAsksRoutes } from './routers/asks.ts'
import { registerDocumentsRoutes } from './routers/documents.ts'
import { registerHealthRoutes } from './routers/health.ts'
import { registerOAuthRoutes } from './routers/oauth.ts'
import { registerPoliciesRoutes } from './routers/policies.ts'
import { registerSessionsRoutes } from './routers/sessions.ts'
import { registerShellRoutes } from './routers/shell.ts'
import { registerTemplatesRoutes } from './routers/templates.ts'
import { registerToolsRoutes } from './routers/tools.ts'
import { registerVfsRoutes } from './routers/vfs.ts'
import { registerWorkspacesRoutes } from './routers/workspaces.ts'
import type { RouteApp, ServerHost } from './routes.ts'

export interface ApiDeps {
  registry: WorkspaceRegistry
  host: ServerHost
  auth: AuthConfig
  /** When the server started, in seconds since the epoch. */
  startedAt: number
  /** What `POST /v1/shutdown` runs. */
  exit: () => void
  snapshotStore: S3Config | undefined
  /** Saved configs; undefined serves no `/v1/templates` and creates from no template. */
  resources?: ResourceStore | undefined
}

/**
 * Register every HTTP route of the server API on `app`, on any host: the
 * Node daemon and a web `Request`/`Response` host register the same set.
 * Answers the MCP endpoint, which the host closes when it closes.
 */
export function registerApi(app: RouteApp, deps: ApiDeps): McpEndpoint {
  const { registry, host } = deps
  const jobs = registry.jobs
  registerHealthRoutes(app, { registry, startedAt: deps.startedAt, exit: deps.exit })
  registerOAuthRoutes(app, { auth: deps.auth })
  registerWorkspacesRoutes(app, {
    registry,
    host,
    snapshotStore: deps.snapshotStore,
    resources: deps.resources,
  })
  if (deps.resources !== undefined) {
    registerTemplatesRoutes(app, { resources: deps.resources, registry })
    registerPoliciesRoutes(app, { resources: deps.resources, registry })
  }
  registerSessionsRoutes(app, { registry, loadProfile: (profile) => host.loadProfile(profile) })
  registerDocumentsRoutes(app, { registry })
  registerAsksRoutes(app, { registry })
  registerShellRoutes(app, { registry, jobs })
  const mcp = registerMcpRoutes(app, registry, jobs)
  registerRpcRoutes(app, registry, jobs, mcp)
  registerToolsRoutes(app, { mcp })
  registerVfsRoutes(app, { registry })
  return mcp
}
