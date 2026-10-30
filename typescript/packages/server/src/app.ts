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
import { DiskRecordClient } from '@struktoai/mirage-node'
import type { Policy } from '@struktoai/mirage-core/policy/base'
import { registerMetrics } from './metrics.ts'
import { type RateLimit, registerRateLimits, resolveRateLimits } from './rate_limit.ts'
import {
  OWNERS_PREFIX,
  resolveGracefulTimeout,
  resolveMaxSessions,
  resolveMaxWorkspaces,
  resolvePolicyFile,
  WorkspaceRegistry,
} from './registry.ts'
import type { AuthConfig } from './auth/index.ts'
import { AuthMode, registerAuth, resolveAuthConfig } from './auth/index.ts'
import {
  isCrossOrigin,
  isHostAllowed,
  resolveAllowedHosts,
  resolveForwardedAllowIps,
} from './host_validation.ts'
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
import type { SSHEndpoint } from './ssh/types.ts'
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
   * The SSH settings: the TCP endpoint opens when the app is ready and closes
   * with it, and the HTTPS route carries SSH either way. Undefined resolves
   * them from the `MIRAGE_SSH_*` env vars and the `ssh_*` config keys; the
   * TCP endpoint stays shut unless a port is set.
   */
  sshConfig?: SSHConfig
  /**
   * The most workspaces the app holds at once; past it a create, clone or
   * load answers 503. Undefined reads `$MIRAGE_MAX_WORKSPACES` or the
   * `max_workspaces` config key, else sets no cap.
   */
  maxWorkspaces?: number
  /**
   * The server's own policies: each answers `preWorkspace` before a
   * create, clone or load builds anything, and is registered on every
   * workspace the app builds, so a tenant cannot lift it.
   */
  policies?: readonly Policy[]
  /**
   * A file of policy programs that answer the same way. Undefined reads
   * `$MIRAGE_POLICY_FILE` or the `policy_file` config key, else runs none.
   */
  policyFile?: string
  /**
   * Limits on the requests the app answers, each keyed on the client
   * address, the account, the workspace, a header or a function of the
   * request; past one a request answers 429. Undefined reads
   * `$MIRAGE_RATE_LIMITS` or the `rate_limits` config key, else sets none.
   */
  rateLimits?: readonly RateLimit[]
  /**
   * The proxies whose `X-Forwarded-For` names the client, addresses or
   * networks, `*` for any. Undefined reads `$MIRAGE_FORWARDED_ALLOW_IPS` or
   * the `forwarded_allow_ips` config key, else believes none.
   */
  forwardedAllowIps?: readonly string[]
  /**
   * The most sessions each workspace holds; past it a new session answers
   * 429. Undefined reads `$MIRAGE_MAX_SESSIONS` or the `max_sessions`
   * config key, else sets no cap.
   */
  maxSessions?: number
  /**
   * How long closing the app lets running lines finish, holding new ones
   * and refusing new workspaces, before it cancels the rest. Undefined
   * reads `$MIRAGE_GRACEFUL_TIMEOUT` or the `graceful_timeout` config key, else 0.
   */
  gracefulTimeout?: number
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
    maxWorkspaces: resolveMaxWorkspaces(options.maxWorkspaces),
    policies: options.policies ?? [],
    programs: resolvePolicyFile(options.policyFile),
    maxSessions: resolveMaxSessions(options.maxSessions),
  })
  const gracefulTimeout = resolveGracefulTimeout(options.gracefulTimeout)
  const rateLimits = resolveRateLimits(options.rateLimits)
  const jobs = registry.jobs
  const unregisterMetrics = registerMetrics(registry)
  const pidFile = pidFilePath(options.pidFile)
  const proxies = resolveForwardedAllowIps(options.forwardedAllowIps)
  // A drain serves reads and running lines to the end; it refuses new
  // workspaces and holds new lines itself.
  const app = Fastify({
    logger: false,
    trustProxy: proxies.includes('*') ? true : proxies.length > 0 ? proxies : false,
    return503OnClosing: false,
  })
  const allowedHosts = resolveAllowedHosts(options.allowedHosts)
  app.addHook('onRequest', (request, reply, done) => {
    const { host, origin, 'sec-fetch-site': fetchSite } = request.headers
    if (!isHostAllowed(host, allowedHosts)) {
      console.warn(
        `rejecting request from ${request.ip}: Host=${JSON.stringify(host)} not in allowlist ${JSON.stringify(allowedHosts)}`,
      )
      void reply.code(400).send({ detail: 'Invalid host header' })
      return
    }
    if (isCrossOrigin(host, origin, fetchSite)) {
      console.warn(
        `rejecting request from ${request.ip}: Origin=${JSON.stringify(origin)} Sec-Fetch-Site=${JSON.stringify(fetchSite)} is not Host=${JSON.stringify(host)}`,
      )
      void reply.code(400).send({ detail: 'Cross-origin request refused' })
      return
    }
    done()
  })
  registerRateLimits(app, rateLimits)
  registerAuth(app, authConfig)
  registerRateLimits(app, rateLimits, true)
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
  const ssh: SSHEndpoint = {
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
    // A configured entry point that cannot open (the port is taken, ssh2 is
    // missing) fails the start rather than leaving the daemon up without
    // the entry point its config asked for. Loaded on demand so a daemon with no
    // SSH never loads ssh2 or the node barrel the SFTP side needs.
    app.addHook('onReady', async () => {
      const { startSSHServer } = await import('./ssh/server.ts')
      ssh.listener = await startSSHServer(registry, sshConfig)
    })
  }
  app.addHook('preClose', async () => {
    registry.draining = true
    if (gracefulTimeout > 0) await registry.drain(gracefulTimeout)
  })
  app.addHook('onClose', async () => {
    unregisterMetrics()
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
