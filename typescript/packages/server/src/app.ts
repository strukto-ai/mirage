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

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import {
  buildVfs,
  configToWorkspaceArgs,
  DiskRecordClient,
  DiskWorkspaceStateStore,
  DOT_IDS,
  loadPolicyFile,
  Workspace,
} from '@struktoai/mirage-node'
import { configStateStore } from '@struktoai/mirage-node/config'
import { CONFIG_SCHEMAS } from '@struktoai/mirage-node/vfs/registry'
import { watchNetwork } from '@struktoai/mirage-node/io/network'
import { quoteName } from '@struktoai/mirage-node/workspace/record/disk'
import type { Policy } from '@struktoai/mirage-core/policy/base'
import { registerMetrics } from './metrics.ts'
import type { ResourceStore } from '@struktoai/mirage-core/resources/base'
import { type RateLimit, registerRateLimits, resolveRateLimits } from './rate_limit.ts'
import { STRUKTO } from '@struktoai/mirage-core/resources/constants'
import { registerSecrets } from '@struktoai/mirage-core/secrets/registry'
import { buildResourceStore, resolveResourceStore } from './resources/config.ts'
import { StruktoSourceConfig, fetchStrukto } from './resources/strukto.ts'
import {
  CONFIGS_PREFIX,
  OWNERS_PREFIX,
  resolveCeilings,
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
import { registerApi } from './api.ts'
import { registerSshRoutes } from './routers/ssh.ts'
import { readDaemonTable, validateDaemonTable } from './daemon_config.ts'
import { loadDaemonId, mirageHome, pidFilePath, stateRootPath } from './paths.ts'
import type { S3Config } from '@struktoai/mirage-core/vfs/s3/config'
import { resolveSSHConfig, type SSHConfig } from './ssh/config.ts'
import type { SSHEndpoint } from './ssh/types.ts'
import websocket from '@fastify/websocket'
import { fastifyRoutes, type ServerHost } from './routes.ts'
import { loadProfilePolicy } from '@struktoai/mirage-node'
import {
  answer,
  errorResponse,
  HttpError,
  registerErrorHandlers,
  WorkspaceMissing,
} from './errors.ts'
import { RAW_BODIES } from './constants.ts'
import { isStopped } from './routers/workspaces.ts'

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
   * `$MIRAGE_RATE_LIMITS` or the `rate_limits` config key, else allows
   * 1000 requests per minute per IP. An empty list disables the limits.
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
   * config key, else 16.
   */
  maxSessions?: number
  /**
   * How long closing the app lets running lines finish, holding new ones
   * and refusing new workspaces, before it cancels the rest. Undefined
   * reads `$MIRAGE_GRACEFUL_TIMEOUT` or the `graceful_timeout` config key, else 0.
   */
  gracefulTimeout?: number
  /**
   * The most a workspace's `max_memory` reaches, a lifted one included, as
   * a size. Undefined reads `$MIRAGE_MAX_MEMORY` or the `max_memory` config
   * key, else sets no ceiling.
   */
  maxMemory?: string | number
  /**
   * The most a session's `processes.max` reaches, a lifted one included.
   * Undefined reads `$MIRAGE_MAX_PROCESSES` or the `max_processes` config
   * key, else sets no ceiling.
   */
  maxProcesses?: number
  /**
   * The most seconds a line runs, whatever `@line` a config or profile
   * sets. Undefined reads `$MIRAGE_MAX_LINE_SECONDS` or the
   * `max_line_seconds` config key, else sets no ceiling.
   */
  maxLineSeconds?: number
  /**
   * The most a workspace's `max_env` reaches, a lifted one included, as a
   * size. Undefined reads `$MIRAGE_MAX_ENV` or the `max_env` config key,
   * else sets no ceiling.
   */
  maxEnv?: string | number
  /**
   * Where saved vfs, cli, runtime, policy and template configs are kept.
   * Undefined reads `$MIRAGE_RESOURCE_STORE` or the `resource_store`
   * config key, else files under the mirage home.
   */
  resourceStore?: ResourceStore
}

export type MirageApp = ReturnType<typeof buildApp>

export async function writePidFile(p: string): Promise<void> {
  await mkdir(dirname(p), { recursive: true })
  await writeFile(p, String(process.pid))
}

export async function removePidFile(p: string): Promise<void> {
  try {
    await rm(p, { force: true })
  } catch (err) {
    console.debug(`could not remove pid file ${p}`, err)
  }
}

/**
 * A workspace a route needs and the caller has none of live: 409 when the
 * caller's own is stopped, else 404, every other error as `answer` gives
 * it. Mirrors Python's `answer_missing`.
 */
function answerMissing(deps: {
  registry: WorkspaceRegistry
  host: ServerHost
}): (err: unknown, req: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (err, req, reply) => {
    if (!(err instanceof WorkspaceMissing)) {
      answer(err, req, reply)
      return
    }
    const stopped = await isStopped(deps, err.workspaceId, req.account)
    void errorResponse(reply, stopped ? err.stopped() : err)
  }
}

/**
 * Read a request body as JSON whatever its Content-Type says, save a
 * multipart or raw byte upload (`RAW_BODIES`), which a route reads as
 * sent, so `curl -d` reaches a JSON route as sent. An empty body is none.
 * Mirrors Python's `LenientJson`.
 */
function lenientJson(app: FastifyInstance): void {
  const json = app.getDefaultJsonParser('error', 'error')
  app.removeAllContentTypeParsers()
  app.addContentTypeParser(RAW_BODIES, (_req, _payload, done) => {
    done(null)
  })
  app.addContentTypeParser('*', { parseAs: 'string' }, (req, body, done) => {
    if (body.length === 0) done(null, undefined)
    else void json(req, body as string, done)
  })
}

function noop(): void {
  /* intentional no-op for onIdleExit default */
}

export function buildApp(options: BuildAppOptions = {}) {
  validateDaemonTable(readDaemonTable(mirageHome()))
  registerSecrets(STRUKTO, StruktoSourceConfig, fetchStrukto)
  const startedAt = Date.now() / 1000
  const exitFn = options.onIdleExit ?? noop
  const authConfig = options.authConfig ?? resolveAuthConfig()
  const stateRoot = stateRootPath(options.stateRoot)
  const host: ServerHost = {
    Workspace,
    workspaceArgs: configToWorkspaceArgs,
    buildVfs,
    vfsSchemas: CONFIG_SCHEMAS,
    loadProfile: loadProfilePolicy,
    // Daemon default is disk (a created workspace survives restart with
    // zero infrastructure, like git init); the library default stays ram.
    stateStore: (cfg) =>
      (cfg === undefined ? undefined : configStateStore(cfg)) ??
      new DiskWorkspaceStateStore({ root: stateRoot }),
    daemonId: () => loadDaemonId(stateRoot),
    quoteName,
    reservedIds: DOT_IDS,
    watchNetwork,
    mountKernel: async (ws, prefix, mountpoint, backend) => {
      await (ws as Workspace).addFuseMount(prefix, mountpoint, undefined, backend)
    },
  }
  const registry = new WorkspaceRegistry({
    ...(options.idleGraceSeconds !== undefined
      ? { idleGraceSeconds: options.idleGraceSeconds }
      : {}),
    onIdleExit: exitFn,
    accountsRequired: authConfig.mode === AuthMode.Jwt,
    owners: new DiskRecordClient(stateRoot, OWNERS_PREFIX),
    configs: new DiskRecordClient(stateRoot, CONFIGS_PREFIX),
    watchNetwork,
    maxWorkspaces: resolveMaxWorkspaces(options.maxWorkspaces),
    policies: options.policies ?? [],
    programs: resolvePolicyFile(loadPolicyFile, options.policyFile),
    maxSessions: resolveMaxSessions(options.maxSessions),
    ceilings: resolveCeilings(options),
  })
  const gracefulTimeout = resolveGracefulTimeout(options.gracefulTimeout)
  const rateLimits = resolveRateLimits(options.rateLimits)
  const jobs = registry.jobs
  const pidFile = pidFilePath(options.pidFile)
  const proxies = resolveForwardedAllowIps(options.forwardedAllowIps)
  // A drain serves reads and running lines to the end; it refuses new
  // workspaces and holds new lines itself.
  const app = Fastify({
    logger: false,
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false, allErrors: true } },
    trustProxy: proxies.includes('*') ? true : proxies.length > 0 ? proxies : false,
    return503OnClosing: false,
    frameworkErrors: answer,
  })
  registerErrorHandlers(app, answerMissing({ registry, host }))
  lenientJson(app)
  const allowedHosts = resolveAllowedHosts(options.allowedHosts)
  app.decorateRequest('closed', null as never)
  app.addHook('onRequest', (request, reply, done) => {
    const gone = new AbortController()
    reply.raw.once('close', () => {
      if (!reply.raw.writableFinished) gone.abort()
    })
    request.closed = gone.signal
    const { host, origin, 'sec-fetch-site': fetchSite } = request.headers
    if (!isHostAllowed(host, allowedHosts)) {
      console.warn(
        `rejecting request from ${request.ip}: Host=${JSON.stringify(host)} not in allowlist ${JSON.stringify(allowedHosts)}`,
      )
      void errorResponse(reply, new HttpError('host_not_allowed', 'host header is not allowed'))
      return
    }
    if (isCrossOrigin(host, origin, fetchSite)) {
      console.warn(
        `rejecting request from ${request.ip}: Origin=${JSON.stringify(origin)} Sec-Fetch-Site=${JSON.stringify(fetchSite)} is not Host=${JSON.stringify(host)}`,
      )
      void errorResponse(reply, new HttpError('origin_not_allowed', 'cross-origin request refused'))
      return
    }
    done()
  })
  registerRateLimits(app, rateLimits)
  registerAuth(app, authConfig)
  registerRateLimits(app, rateLimits, true)
  const resources = options.resourceStore ?? buildResourceStore(resolveResourceStore())
  const mcp = registerApi(fastifyRoutes(app), {
    registry,
    host,
    auth: authConfig,
    startedAt,
    exit: exitFn,
    snapshotStore: options.snapshotStore,
    resources,
  })
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
  // Reported once the app is up, so one whose setup fails never is.
  let unregisterMetrics = noop
  app.addHook('onReady', (done) => {
    unregisterMetrics = registerMetrics(registry)
    done()
  })
  app.addHook('preClose', async () => {
    registry.draining = true
    if (gracefulTimeout > 0) await registry.drain(gracefulTimeout)
  })
  app.addHook('onClose', async () => {
    if (ssh.listener !== null) await ssh.listener.close()
    try {
      await mcp.close()
      await jobs.close()
    } finally {
      try {
        await registry.closeAll()
      } finally {
        unregisterMetrics()
      }
    }
  })
  return Object.assign(app, { registry, jobs, pidFile, ssh, mcp, resources })
}
