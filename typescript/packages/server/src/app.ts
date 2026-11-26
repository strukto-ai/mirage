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

import { Buffer } from 'node:buffer'
import { timingSafeEqual } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import Fastify, {
  type FastifyInstance,
  type FastifyListenOptions,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify'
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
import {
  type RateLimit,
  RateLimitBuckets,
  registerRateLimits,
  resolveRateLimits,
} from './rate_limit.ts'
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
import { AuthMode, resolveAuthConfig } from './auth/index.ts'
import { authenticator, registerAuth, registerE2BAuth } from './auth/middleware.ts'
import {
  refusal,
  refusalLine,
  resolveAllowedHosts,
  resolveForwardedAllowIps,
} from './host_validation.ts'
import { registerApi } from './api.ts'
import { router as registerSshRoutes } from './routers/ssh.ts'
import { DaemonConfigError, readDaemonTable, validateDaemonTable } from './daemon_config.ts'
import { loadDaemonId, mirageHome, pidFilePath, stateRootPath } from './paths.ts'
import type { S3Config } from '@struktoai/mirage-core/vfs/s3/config'
import { resolveSSHConfig, type SSHConfig } from './ssh/config.ts'
import type { SSHEndpoint } from './ssh/types.ts'
import websocket from '@fastify/websocket'
import { fastifyRoutes, type ServerHost } from './routes.ts'
import { loadProfilePolicy } from '@struktoai/mirage-node'
import {
  answer,
  errorOf,
  errorResponse,
  HttpError,
  registerErrorHandlers,
  WorkspaceMissing,
} from './errors.ts'
import { RAW_BODIES } from './constants.ts'
import { traceContextMiddleware } from './trace.ts'
import { isStopped } from './routers/workspaces.ts'
import { ENV_E2B_PORT } from './env.ts'
import { CONNECT_STREAM } from './e2b/constants.ts'
import { connectCode } from './e2b/errors.ts'
import { Sandboxes } from './e2b/sandbox.ts'
import {
  acceptsRawBody,
  isDataRequest,
  isLifecycleRequest,
  router as registerE2BRoutes,
  sandboxAccount,
  sandboxWorkspace,
} from './routers/e2b.ts'

export interface BuildAppOptions {
  idleGraceSeconds?: number
  onIdleExit?: () => void
  /**
   * `Host` names the app answers besides the loopback names (`127.0.0.1`,
   * `localhost`, `::1`), which it always answers. Undefined reads
   * `$MIRAGE_ALLOWED_HOSTS`, else the `allowed_hosts` key in config.toml's
   * `[daemon]`. `['*']` skips the Host comparison, safe only behind a trusted
   * proxy; a browser request from another origin is refused either way.
   */
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
  /** Loopback HTTP port for E2B. Undefined reads `MIRAGE_E2B_PORT`. False disables the listener. */
  e2bPort?: number | false
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

function matchesAccessToken(expected: string, presented: string): boolean {
  const expectedBytes = Buffer.from(expected)
  const presentedBytes = Buffer.from(presented)
  return (
    expectedBytes.length === presentedBytes.length && timingSafeEqual(expectedBytes, presentedBytes)
  )
}

export function resolveE2bPort(
  port?: number,
  env: Record<string, string | undefined> = process.env,
): number | undefined {
  const raw = env[ENV_E2B_PORT]?.trim()
  if (port === undefined && raw === undefined) return undefined
  const value = port ?? (/^\d+$/.test(raw ?? '') ? Number(raw) : NaN)
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new DaemonConfigError(`${ENV_E2B_PORT} must be an integer from 1 to 65535`)
  }
  return value
}

type ListenCallback = (err: Error | null, address: string) => void

function listenTogether(app: FastifyInstance, e2b: FastifyInstance, port: number): void {
  const listenNative = app.listen.bind(app)
  let starting: Promise<string> | undefined
  function listen(options?: FastifyListenOptions): Promise<string>
  function listen(options: FastifyListenOptions, callback: ListenCallback): void
  function listen(callback: ListenCallback): void
  function listen(
    options?: FastifyListenOptions | ListenCallback,
    callback?: ListenCallback,
  ): Promise<string> | void {
    const done = typeof options === 'function' ? options : callback
    const listenOptions = typeof options === 'function' ? undefined : options
    const listening =
      starting === undefined
        ? (starting = start(listenOptions))
        : starting.then(() => listenNative(listenOptions))
    if (done === undefined) return listening
    void listening.then(
      (address) => {
        done(null, address)
      },
      (error: unknown) => {
        done(error instanceof Error ? error : new Error(String(error)), '')
      },
    )
  }
  async function start(options: FastifyListenOptions | undefined): Promise<string> {
    try {
      const address = await listenNative(options)
      await e2b.listen({ host: '127.0.0.1', port })
      return address
    } catch (error) {
      try {
        await app.close()
      } catch (cleanup) {
        console.debug('could not close server after listen failure:', cleanup)
      }
      throw error
    }
  }
  app.listen = listen
}

/**
 * Count each request in flight, so the daemon's idle exit waits for it to be
 * answered. Installed ahead of every other hook, since a hook that answers
 * skips the ones after it.
 */
function idleExitHold(app: FastifyInstance, registry: WorkspaceRegistry): void {
  app.addHook('onRequest', (_request, reply, done) => {
    registry.requestBegan()
    reply.raw.once('close', () => {
      registry.requestEnded()
    })
    done()
  })
}

function requestGuards(
  app: FastifyInstance,
  allowedHosts: readonly string[],
  replyError: (reply: FastifyReply, error: HttpError) => FastifyReply,
): void {
  app.addHook('preHandler', traceContextMiddleware)
  app.decorateRequest('closed', null as never)
  app.addHook('onRequest', (request, reply, done) => {
    const gone = new AbortController()
    reply.raw.once('close', () => {
      if (!reply.raw.writableFinished) gone.abort()
    })
    request.closed = gone.signal
    const { host, origin, 'sec-fetch-site': fetchSite } = request.headers
    const refused = refusal(host, origin, fetchSite, allowedHosts)
    if (refused === undefined) {
      done()
      return
    }
    console.warn(refusalLine(request.ip, refused, host, origin, fetchSite, allowedHosts))
    void replyError(reply, refused)
  })
}

function e2bError(reply: FastifyReply, error: HttpError): FastifyReply {
  const request = reply.request
  const data = isDataRequest(request.method, request.routeOptions.url ?? '')
  for (const [name, value] of Object.entries(error.headers)) reply.header(name, value)
  return reply
    .code(error.status)
    .send({ code: data ? connectCode(error.status) : error.status, message: error.message })
}

export function buildApp(options: BuildAppOptions = {}) {
  validateDaemonTable(readDaemonTable(mirageHome()))
  registerSecrets(STRUKTO, StruktoSourceConfig, fetchStrukto)
  const startedAt = Date.now() / 1000
  const exitFn = options.onIdleExit ?? noop
  const authConfig = options.authConfig ?? resolveAuthConfig()
  const check = authenticator(authConfig)
  const e2bPort = options.e2bPort === false ? undefined : resolveE2bPort(options.e2bPort)
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
  const rateLimitBuckets = new RateLimitBuckets(resolveRateLimits(options.rateLimits))
  const jobs = registry.jobs
  const pidFile = pidFilePath(options.pidFile)
  const proxies = resolveForwardedAllowIps(options.forwardedAllowIps)
  const server = (replyError: (reply: FastifyReply, error: HttpError) => FastifyReply) =>
    Fastify({
      logger: false,
      ajv: { customOptions: { coerceTypes: false, removeAdditional: false, allErrors: true } },
      trustProxy: proxies.includes('*') ? true : proxies.length > 0 ? proxies : false,
      return503OnClosing: false,
      frameworkErrors: (err, _req, reply) => {
        void replyError(reply, errorOf(err))
      },
    })
  const app = server(errorResponse)
  idleExitHold(app, registry)
  registerErrorHandlers(app, answerMissing({ registry, host }))
  lenientJson(app)
  const allowedHosts = resolveAllowedHosts(options.allowedHosts)
  requestGuards(app, allowedHosts, errorResponse)
  registerRateLimits(app, rateLimitBuckets)
  registerAuth(app, authConfig, check)
  registerRateLimits(app, rateLimitBuckets, true)
  const resources = options.resourceStore ?? buildResourceStore(resolveResourceStore())
  const routes = fastifyRoutes(app)
  const mcp = registerApi(routes, {
    registry,
    host,
    auth: authConfig,
    startedAt,
    exit: exitFn,
    snapshotStore: options.snapshotStore,
    resources,
  })
  const companion =
    e2bPort === undefined
      ? null
      : {
          app: server(e2bError),
          sandboxes: new Sandboxes(registry, matchesAccessToken),
          port: e2bPort,
        }
  if (companion !== null) {
    const { app: e2b, sandboxes, port } = companion
    idleExitHold(e2b, registry)
    e2b.setErrorHandler((err, _req, reply) => {
      void e2bError(reply, errorOf(err))
    })
    e2b.setNotFoundHandler((_req, reply) => {
      void e2bError(reply, new HttpError('not_found', 'not found'))
    })
    lenientJson(e2b)
    requestGuards(e2b, allowedHosts, e2bError)
    const workspaceOf = (request: FastifyRequest) =>
      sandboxWorkspace(sandboxes, request.routeOptions.url ?? '', request)
    registerRateLimits(e2b, rateLimitBuckets, false, e2bError, workspaceOf)
    registerE2BAuth(
      e2b,
      check,
      (request) => isLifecycleRequest(request.method, request.routeOptions.url ?? ''),
      (request) => sandboxAccount(sandboxes, request.headers),
    )
    registerRateLimits(e2b, rateLimitBuckets, true, e2bError, workspaceOf)
    e2b.removeContentTypeParser(RAW_BODIES)
    for (const media of [RAW_BODIES, CONNECT_STREAM]) {
      e2b.addContentTypeParser(media, (request, _payload, parsed) => {
        const contentType =
          request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() ?? ''
        if (acceptsRawBody(request.method, request.routeOptions.url ?? '', contentType)) {
          parsed(null)
        } else {
          parsed(
            new HttpError('invalid_request', 'expected JSON on a unary E2B route', {
              headers: { connection: 'close' },
            }),
          )
        }
      })
    }
    registerE2BRoutes(fastifyRoutes(e2b), {
      registry,
      host,
      resources,
      snapshotStore: options.snapshotStore,
      sandboxes,
    })
    listenTogether(app, e2b, port)
  }
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
    try {
      if (gracefulTimeout > 0) await registry.drain(gracefulTimeout)
    } finally {
      try {
        await companion?.sandboxes.close()
      } finally {
        await companion?.app.close()
      }
    }
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
  return Object.assign(app, {
    registry,
    jobs,
    pidFile,
    ssh,
    mcp,
    resources,
    e2b: companion?.app ?? null,
  })
}
