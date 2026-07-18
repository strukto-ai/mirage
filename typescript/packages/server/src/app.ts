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

import Fastify from 'fastify'
import multipart from '@fastify/multipart'
import rateLimit from '@fastify/rate-limit'
import { WorkspaceRegistry } from './registry.ts'
import { JobTable } from './jobs.ts'
import type { AuthConfig } from './auth/index.ts'
import { registerAuth, resolveAuthConfig } from './auth/index.ts'
import { isHostAllowed, resolveAllowedHosts } from './host_validation.ts'
import { registerExecuteRoutes } from './routers/execute.ts'
import { registerHealthRoutes } from './routers/health.ts'
import { registerJobsRoutes } from './routers/jobs.ts'
import { registerSessionsRoutes } from './routers/sessions.ts'
import { registerVersionsRoutes } from './routers/versions.ts'
import { registerWorkspacesRoutes } from './routers/workspaces.ts'
import { readDaemonTable, validateDaemonTable } from './daemon_config.ts'
import {
  mirageHome,
  pidFilePath,
  snapshotRootPath,
  stateRootPath,
  versionRootPath,
} from './paths.ts'
import { LocalBackend } from './version/backend.ts'

export interface BuildAppOptions {
  idleGraceSeconds?: number
  onIdleExit?: () => void
  allowedHosts?: readonly string[]
  authConfig?: AuthConfig
  versionRoot?: string
  snapshotRoot?: string
  stateRoot?: string
  pidFile?: string
}

export type MirageApp = ReturnType<typeof buildApp>

function noop(): void {
  /* intentional no-op for onIdleExit default */
}

export function buildApp(options: BuildAppOptions = {}) {
  validateDaemonTable(readDaemonTable(mirageHome()))
  const startedAt = Date.now() / 1000
  const exitFn = options.onIdleExit ?? noop
  const registry = new WorkspaceRegistry({
    ...(options.idleGraceSeconds !== undefined
      ? { idleGraceSeconds: options.idleGraceSeconds }
      : {}),
    onIdleExit: exitFn,
  })
  const jobs = new JobTable()
  const versionBackend = new LocalBackend(versionRootPath(options.versionRoot))
  const snapshotRoot = snapshotRootPath(options.snapshotRoot)
  const stateRoot = stateRootPath(options.stateRoot)
  const pidFile = pidFilePath(options.pidFile)
  const app = Fastify({ logger: false })
  void app.register(rateLimit, {
    global: true,
    max: 1000,
    timeWindow: '1 minute',
  })
  const allowedHosts = resolveAllowedHosts(options.allowedHosts)
  if (!allowedHosts.includes('*')) {
    app.addHook('onRequest', (request, reply, done) => {
      if (!isHostAllowed(request.headers.host, allowedHosts)) {
        console.warn(
          `rejecting request from ${request.ip}: Host=${JSON.stringify(request.headers.host)} not in allowlist ${JSON.stringify(allowedHosts)}`,
        )
        void reply.code(400).send({ detail: 'Invalid host header' })
        return
      }
      done()
    })
  }
  const authConfig = options.authConfig ?? resolveAuthConfig()
  registerAuth(app, authConfig)
  void app.register(multipart, {
    limits: { fileSize: 10 * 1024 * 1024 * 1024 },
  })
  registerHealthRoutes(app, { registry, startedAt, exit: exitFn })
  registerWorkspacesRoutes(app, { registry, snapshotRoot, stateRoot })
  registerVersionsRoutes(app, { registry, versionBackend })
  registerSessionsRoutes(app, { registry })
  registerExecuteRoutes(app, { registry, jobs })
  registerJobsRoutes(app, { jobs })
  app.addHook('onClose', async () => {
    await registry.closeAll()
  })
  return Object.assign(app, { registry, jobs, versionBackend, pidFile })
}
