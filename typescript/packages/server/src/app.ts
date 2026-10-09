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
import rateLimit from '@fastify/rate-limit'
import { DiskRecordClient } from '@struktoai/mirage-node'
import type { ExecutionStore } from '@struktoai/mirage-core/execution/base'
import { OWNERS_PREFIX, WorkspaceRegistry } from './registry.ts'
import { JobTable } from './jobs.ts'
import type { AuthConfig } from './auth/index.ts'
import { AuthMode, registerAuth, resolveAuthConfig } from './auth/index.ts'
import { isHostAllowed, resolveAllowedHosts } from './host_validation.ts'
import { registerMcpRoutes } from './mcp/http.ts'
import { registerRpcRoutes } from './rpc/http.ts'
import { registerAsksRoutes } from './routers/asks.ts'
import { registerShellRoutes } from './routers/shell.ts'
import { registerToolsRoutes } from './routers/tools.ts'
import { registerVfsRoutes } from './routers/vfs.ts'
import { registerHealthRoutes } from './routers/health.ts'
import { registerJobsRoutes } from './routers/jobs.ts'
import { registerDocumentsRoutes } from './routers/documents.ts'
import { registerOAuthRoutes } from './routers/oauth.ts'
import { registerSessionsRoutes } from './routers/sessions.ts'
import { registerSshRoutes } from './routers/ssh.ts'
import { registerWorkspacesRoutes } from './routers/workspaces.ts'
import { readDaemonTable, validateDaemonTable } from './daemon_config.ts'
import { mirageHome, pidFilePath, stateRootPath } from './paths.ts'
import type { S3Config } from '@struktoai/mirage-core/vfs/s3/config'
import { resolveSSHConfig, type SSHConfig } from './ssh/config.ts'
import type { SSHDoor } from './ssh/types.ts'
import websocket from '@fastify/websocket'

export interface BuildAppOptions {
  idleGraceSeconds?: number
  onIdleExit?: () => void
  allowedHosts?: readonly string[]
  authConfig?: AuthConfig
  /**
   * The S3-like store a snapshot request may name a key in. Undefined
   * has none: a snapshot then only goes back to the caller, as the
   * server never writes one to its own disk.
   */
  snapshotStore?: S3Config
  stateRoot?: string
  pidFile?: string
  /**
   * The SSH settings: the TCP door opens when the app is ready and closes
   * with it, and the HTTPS route carries SSH either way. Undefined resolves
   * them from the `MIRAGE_SSH_*` env vars and the `ssh_*` config keys; the
   * TCP door stays shut unless a port is set.
   */
  sshConfig?: SSHConfig
  /** Borrowed record storage; the caller closes it. Records do not resume work. */
  executionStore?: ExecutionStore
}

export type MirageApp = ReturnType<typeof buildApp>

function noop(): void {
  /* intentional no-op for onIdleExit default */
}

export function buildApp(options: BuildAppOptions = {}) {
  validateDaemonTable(readDaemonTable(mirageHome()))
  const startedAt = Date.now() / 1000
  const exitFn = options.onIdleExit ?? noop
  const authConfig = options.authConfig ?? resolveAuthConfig()
  const stateRoot = stateRootPath(options.stateRoot)
  const registry = new WorkspaceRegistry({
    ...(options.idleGraceSeconds !== undefined
      ? { idleGraceSeconds: options.idleGraceSeconds }
      : {}),
    onIdleExit: exitFn,
    accountsRequired: authConfig.mode === AuthMode.Jwt,
    owners: new DiskRecordClient(stateRoot, OWNERS_PREFIX),
  })
  const jobs = new JobTable(options.executionStore)
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
  registerAuth(app, authConfig)
  app.addContentTypeParser(/^multipart\//, (_req, _payload, done) => {
    done(null)
  })
  registerHealthRoutes(app, { registry, startedAt, exit: exitFn })
  registerOAuthRoutes(app, { auth: authConfig })
  registerWorkspacesRoutes(app, { registry, stateRoot, snapshotStore: options.snapshotStore })
  registerSessionsRoutes(app, { registry })
  registerDocumentsRoutes(app, { registry })
  registerAsksRoutes(app, { registry })
  registerShellRoutes(app, { registry, jobs })
  registerJobsRoutes(app, { jobs, registry })
  const mcp = registerMcpRoutes(app, registry, jobs)
  registerRpcRoutes(app, registry, jobs, mcp)
  registerToolsRoutes(app, { mcp })
  registerVfsRoutes(app, { registry })
  const ssh: SSHDoor = {
    config: options.sshConfig ?? resolveSSHConfig(),
    listener: null,
  }
  void app.register(websocket)
  void app.register((scope, _opts, done) => {
    registerSshRoutes(scope, { registry, ssh })
    done()
  })
  const sshConfig = ssh.config
  if (sshConfig.port !== null) {
    // A configured door that cannot open (the port is taken, ssh2 is
    // missing) fails the start rather than leaving the daemon up without
    // the door its config asked for. Loaded on demand so a daemon with no
    // SSH never loads ssh2 or the node barrel the SFTP side needs.
    app.addHook('onReady', async () => {
      const { startSSHServer } = await import('./ssh/server.ts')
      ssh.listener = await startSSHServer(registry, sshConfig)
    })
  }
  app.addHook('onClose', async () => {
    if (ssh.listener !== null) await ssh.listener.close()
    try {
      await mcp.close()
      await jobs.close()
    } finally {
      await registry.closeAll()
    }
  })
  return Object.assign(app, { registry, jobs, pidFile, ssh, mcp })
}
