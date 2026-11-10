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

import { MCPToolsError } from '@struktoai/mirage-core/commands/cli/mcp/errors'
import { runWithNetwork } from '@struktoai/mirage-core/io/network'
import type { Policy } from '@struktoai/mirage-core/policy/base'
import { PolicyDenied } from '@struktoai/mirage-core/policy/errors'
import { SessionProfile } from '@struktoai/mirage-core/policy/profile'
import type { ResourceStore } from '@struktoai/mirage-core/resources/base'
import { ResourceError } from '@struktoai/mirage-core/resources/errors'
import { secretRefs } from '@struktoai/mirage-core/resources/refs'
import { SecretsError } from '@struktoai/mirage-core/secrets/errors'
import type { JsonValue } from '@struktoai/mirage-core/types'
import { checkName, newWorkspaceId } from '@struktoai/mirage-core/utils/ids'
import type { BaseVFS } from '@struktoai/mirage-core/vfs/base'
import { VFSConfigError } from '@struktoai/mirage-core/vfs/errors'
import type { S3Config } from '@struktoai/mirage-core/vfs/s3/config'
import { z } from '@struktoai/mirage-core/vfs/secrets'
import { SharedStorageError, WritePolicyError } from '@struktoai/mirage-core/workspace/mount/errors'
import type { Mount } from '@struktoai/mirage-core/workspace/mount/spec'
import { isSafeBlobPath } from '@struktoai/mirage-core/workspace/snapshot/utils'
import type { MountSpec } from '@struktoai/mirage-core/workspace/workspace/workspace'
import type { WorkspaceConfigRaw } from '@struktoai/mirage-core/config'
import type { WorkspaceStateStore } from '@struktoai/mirage-core/workspace/store/base'
import type { Workspace } from '@struktoai/mirage-core/workspace/workspace/workspace'
import {
  streamOf,
  type RouteApp,
  type RouteReply,
  type RouteRequest,
  type ServerHost,
} from '../routes.ts'
import { Buffer } from 'node:buffer'
import { completedLogs, logAttachment, logLines, logPage, sessionFilter } from '../logs.ts'
import { createHash } from 'node:crypto'
import { buildOverrideMounts, cloneWorkspaceWithOverride } from '../clone.ts'
import { MAX_SNAPSHOT_BYTES } from '../constants.ts'
import { explanationToDict, refusalToDict } from '../io_serde.ts'
import { refused } from '../metrics.ts'
import { MAX_REQUEST_PART, MAX_SNAPSHOT_PART, partEvents } from '../multipart.ts'
import { Claim, Forget, type WorkspaceRegistry } from '../registry.ts'
import {
  checkConfig,
  CloneWorkspaceRequest,
  CreateWorkspaceRequest,
  LoadWorkspaceRequest,
  SnapshotWorkspaceRequest,
  type WorkspaceBrief,
} from '../schemas.ts'
import { HttpError, INTERNAL_MESSAGE, loaderError, validationError } from '../errors.ts'
import type { OverrideShape } from '../clone.ts'
import { withPolicies } from '../resources/policies.ts'
import { withEntries } from '../resources/strukto.ts'
import { makeBrief, makeDetail, makeStoppedBrief, makeStoppedDetail } from '../summary.ts'
import { NO_WORKSPACE_ID, requireOneAccount, storeRefusal } from './templates.ts'
import { queryFlag, requireEntry } from './vfs.ts'

export interface WorkspaceRoutesDeps {
  registry: WorkspaceRegistry
  host: ServerHost
  /** The S3-like store a snapshot request may name a key in. */
  snapshotStore: S3Config | undefined
  /** Where a create finds the template it names; undefined keeps none. */
  resources?: ResourceStore | undefined
}

/**
 * The config a create builds, checked and as written: the body's own, or a
 * copy of the named template's, so a later edit of the template leaves the
 * workspace as it is. Refuses both or neither, an unknown template, a
 * template on a server of many accounts, or a config that fails its check.
 * Mirrors Python's `_config_of`.
 */
async function configOf(
  body: CreateWorkspaceRequest,
  cfg: WorkspaceConfigRaw | undefined,
  resources: ResourceStore | undefined,
  registry: WorkspaceRegistry,
): Promise<{ cfg: WorkspaceConfigRaw; written: Record<string, JsonValue> }> {
  const given = body.config ?? undefined
  const template = body.template ?? undefined
  if (template === undefined) {
    if (given === undefined || cfg === undefined) {
      throw new HttpError('invalid_request', 'give a template or a config')
    }
    return { cfg, written: given as Record<string, JsonValue> }
  }
  if (given !== undefined) {
    throw new HttpError('invalid_request', 'give a template or a config, not both')
  }
  if (resources === undefined)
    throw new HttpError('invalid_request', 'this server keeps no templates')
  requireOneAccount(registry)
  let written: Record<string, JsonValue>
  try {
    written = (await resources.getTemplate(template)).config
  } catch (e) {
    if (e instanceof ResourceError) throw storeRefusal(e)
    throw e
  }
  let checked: WorkspaceConfigRaw
  try {
    checked = checkConfig(written)
  } catch (e) {
    throw loaderError(e, ['config'], written)
  }
  if ((checked.workspaceId ?? null) !== null)
    throw new HttpError('invalid_request', NO_WORKSPACE_ID)
  return { cfg: checked, written }
}

/**
 * A create's body, read as Python's model reads one: the config's own
 * fields first, then the other declared fields, then an unknown key.
 */
function createRequest(body: unknown): {
  req: CreateWorkspaceRequest
  cfg: WorkspaceConfigRaw | undefined
} {
  const parsed = CreateWorkspaceRequest.safeParse(body)
  const first = parsed.error?.issues.find((issue) => issue.code !== 'unrecognized_keys')
  if (first !== undefined && (first.path.length === 0 || first.path[0] === 'config')) {
    throw validationError(parsed.error as z.ZodError, body)
  }
  const config = (body as { config?: unknown }).config
  let cfg: WorkspaceConfigRaw | undefined
  if (config !== undefined && config !== null) {
    try {
      cfg = checkConfig(config)
    } catch (e) {
      throw loaderError(e, ['config'], config)
    }
  }
  if (!parsed.success) throw validationError(parsed.error, body)
  return { req: parsed.data, cfg }
}

interface WorkspaceIdParams {
  id: string
}

interface WorkspaceGetQuery {
  verbose?: string
}

interface WorkspaceLogsQuery {
  session?: string
  limit?: string
  after?: string
  format?: string
}

/** A load's request, read from parsed JSON; none is an empty one. Mirrors Python's `_parse_load_request`. */
function parseLoadRequest(raw: unknown): LoadWorkspaceRequest {
  const body = raw ?? {}
  const parsed = LoadWorkspaceRequest.safeParse(body)
  if (!parsed.success) throw validationError(parsed.error, body)
  return parsed.data
}

/**
 * Read an uploaded snapshot: a `request` part, then the tar. The tar is
 * held in memory, never spooled to the server's disk.
 *
 * @throws HttpError 400 for a body without both parts, or with a
 *   `key`; 413 for an oversized request part.
 */
async function readLoadBody(req: RouteRequest): Promise<[LoadWorkspaceRequest, Uint8Array]> {
  let name = ''
  const request: Uint8Array[] = []
  const tar: Uint8Array[] = []
  const seen = new Set<string>()
  let size = 0
  let tarSize = 0
  for await (const event of partEvents(req.raw, req.headers['content-type'] ?? '')) {
    if (event.kind === 'begin') {
      name = event.name
      // The daemon routes a load by its first request part alone.
      if (name === 'request' && seen.has(name)) {
        throw new HttpError('invalid_request', "multipart body has more than one 'request' part")
      }
      seen.add(name)
    } else if (event.kind === 'data' && name === 'request') {
      request.push(event.data)
      size += event.data.byteLength
      if (size > MAX_REQUEST_PART) throw new HttpError('too_large', 'request part too large')
    } else if (event.kind === 'data' && name === 'snapshot') {
      tar.push(event.data)
      tarSize += event.data.byteLength
      if (tarSize > MAX_SNAPSHOT_PART) throw new HttpError('too_large', 'snapshot part too large')
    }
  }
  if (!seen.has('snapshot')) {
    throw new HttpError('invalid_request', "multipart body missing 'snapshot' part")
  }
  let raw: unknown
  try {
    raw = JSON.parse(Buffer.concat(request).toString() || '{}')
  } catch (e) {
    throw new HttpError('invalid_json', 'body must be JSON', { cause: e })
  }
  const body = parseLoadRequest(raw)
  if ((body.key ?? undefined) !== undefined) {
    throw new HttpError('invalid_request', "load takes a 'key' or an uploaded 'snapshot', not both")
  }
  const joined = Buffer.concat(tar, tarSize)
  return [body, new Uint8Array(joined.buffer, joined.byteOffset, joined.byteLength)]
}

/**
 * What a build the caller's config or snapshot made fail answers: the
 * project's own loader errors (and a plain `Error`, which is how most of
 * them are thrown) word theirs for the caller; an OS error or a failed
 * module import, which names the server's own paths and modules, answers
 * `fixed` and goes to the log; anything else is handed back to propagate.
 * Mirrors Python's `refused_build`.
 */
function refusedBuild(err: unknown, fixed: string): unknown {
  if (
    err instanceof SecretsError ||
    err instanceof z.ZodError ||
    err instanceof VFSConfigError ||
    err instanceof MCPToolsError ||
    err instanceof WritePolicyError ||
    err instanceof SharedStorageError
  ) {
    return loaderError(err)
  }
  const code = (err as { code?: unknown } | null)?.code
  if (typeof code === 'string' && (/^E[A-Z]+$/.test(code) || code === 'ERR_MODULE_NOT_FOUND')) {
    console.info(`mirage: ${fixed}: ${(err as Error).message}`)
    return new HttpError('invalid_request', fixed, { cause: err })
  }
  if (err instanceof Error && err.constructor === Error) return loaderError(err)
  return err
}

/**
 * Whether a capture (snapshot, clone) failed because the workspace's
 * lines did not end in time; such a request answers 409: cancel them and
 * retry.
 */
function isBusy(error: unknown): boolean {
  return (error as { code?: unknown }).code === 'EBUSY'
}

// Under the snapshot store: one key prefix per account.
const ACCOUNTS_DIR = 'accounts'

/**
 * The key the caller's snapshot `key` has in the store; refuses a key that
 * is not a plain relative path. An account's snapshots live under its own
 * prefix, so no account can write or load another's by naming its key.
 * Mirrors Python's `store_key`.
 */
function storeKey(host: ServerHost, account: string | null, key: string): string {
  const relative = key.replace(/^\/+/, '')
  if (!isSafeBlobPath(relative)) {
    throw new HttpError('invalid_value', 'key must be a relative path inside the snapshot store', {
      param: 'key',
    })
  }
  return account === null ? relative : `${ACCOUNTS_DIR}/${host.quoteName(account)}/${relative}`
}

/** The server's snapshot store; refuses when it has none. Mirrors Python's `_snapshot_store`. */
function snapshotStore(deps: WorkspaceRoutesDeps): S3Config {
  if (deps.snapshotStore === undefined) {
    throw new HttpError('invalid_request', 'this server has no snapshot store')
  }
  return deps.snapshotStore
}

/** Whether the server's state root holds state for `id`. */
async function hasState(host: ServerHost, id: string): Promise<boolean> {
  const store = host.stateStore()
  try {
    return (await store.loadMeta(id)) !== null
  } finally {
    await store.close()
  }
}

/**
 * The store a workspace built from `config` keeps its state in: the one
 * its `store:` block names, else the server's. A config that no longer
 * checks names none the server can open, so the server's is read.
 */
function storeOf(
  deps: WorkspaceRoutesDeps,
  config: Record<string, JsonValue> | null,
): WorkspaceStateStore {
  if (config?.store === undefined || config.store === null) return deps.host.stateStore()
  try {
    return deps.host.stateStore(checkConfig(config))
  } catch (e) {
    console.debug(`mirage: a saved config's store did not open: ${(e as Error).message}`)
    return deps.host.stateStore()
  }
}

/** What a stopped workspace keeps: the config it starts from, and when it was first created. */
interface Kept {
  config: Record<string, JsonValue>
  createdAt: number
}

/**
 * What `account`'s stopped `id` keeps: the config it starts from and when
 * it was first created, null when no config is saved. State alone, as a
 * rejected create leaves, is not a workspace to list or start. A store
 * that cannot be read, such as a Redis that is down, leaves the config
 * with no creation time. Mirrors Python's `_kept`.
 */
async function kept(
  deps: WorkspaceRoutesDeps,
  id: string,
  account: string | null,
): Promise<Kept | null> {
  if (!(await deps.registry.allows(id, account, 0))) return null
  const config = await deps.registry.savedConfig(id, account)
  if (config === null) return null
  const store = storeOf(deps, config)
  let meta: Record<string, unknown> | null
  try {
    meta = await store.loadMeta(id)
  } catch (e) {
    console.warn(`mirage: workspace ${id}'s store could not be read: ${(e as Error).message}`)
    meta = null
  } finally {
    await store.close()
  }
  const createdAt = meta?.created_at
  return { config, createdAt: typeof createdAt === 'number' ? createdAt : 0 }
}

/**
 * Whether `account`'s `id`, not live, is stopped: its state or its config
 * is kept. Mirrors Python's `is_stopped`.
 */
export async function isStopped(
  deps: Pick<WorkspaceRoutesDeps, 'registry' | 'host'>,
  id: string,
  account: string | null,
): Promise<boolean> {
  if (deps.host.reservedIds.has(id)) return false
  if (!(await deps.registry.allows(id, account, 0))) return false
  if (await hasState(deps.host, id)) return true
  return (await deps.registry.savedConfig(id, account)) !== null
}

/**
 * Refuse a workspace about to be built with policy_refused and the reason
 * when the server's policies refuse it, before any of it is built or any
 * secret it names is read. Mirrors Python's `_admit`.
 */
async function admit(deps: WorkspaceRoutesDeps, req: RouteRequest, config: unknown): Promise<void> {
  const deny = await deps.registry.refusal((config ?? {}) as Record<string, JsonValue>, req.account)
  if (deny !== null) throw new HttpError('policy_refused', deny.reason)
}

/**
 * Set `reply`'s status and hand back `body` unsent. Code that holds an id
 * answers this way, so the route sends only once the id is released and a
 * client that read the answer finds the id free.
 */
function answer<T>(reply: RouteReply, status: number, body: T): T {
  void reply.status(status)
  return body
}

/**
 * Run a create's `build` under the caller's claim on `id`, or answer 409
 * when the id is not theirs to create, and 503 before anything is built
 * when the server is at its `maxWorkspaces`. A claim this create made is released
 * when the build answers anything but success or throws before saving any
 * state, so a failed create leaves the id free. Once state is saved the
 * claim stays with it, as for the account's own closed workspace: the
 * account can create the id again, and no state is deleted that another
 * server sharing the state root may be using. One the account already
 * held stays.
 */
async function claimed(
  deps: WorkspaceRoutesDeps,
  req: RouteRequest,
  reply: RouteReply,
  id: string,
  build: () => Promise<unknown>,
): Promise<unknown> {
  if (deps.registry.draining) {
    refused('shutting_down')
    throw new HttpError('shutting_down', 'server is shutting down')
  }
  if (!deps.registry.hasRoom()) {
    refused('max_workspaces')
    throw new HttpError(
      'server_full',
      `server is at max_workspaces (${String(deps.registry.maxWorkspaces)})`,
    )
  }
  const stored = req.account !== null && (await hasState(deps.host, id))
  const claim = await deps.registry.claim(id, req.account, stored)
  if (claim === Claim.Taken) {
    throw new HttpError('already_exists', 'workspace id already exists')
  }
  let built = false
  try {
    const answer = await build()
    built = reply.statusCode < 300
    return answer
  } finally {
    if (!built && claim === Claim.New && !(await hasState(deps.host, id))) {
      await deps.registry.release(id)
    }
  }
}

/**
 * Hold `id` for a clone or load while it is built: no create of the id runs
 * alongside, so none can take over a claim this build made and then lose
 * it when the build fails and releases it. The caller's claim covers the
 * build.
 */
function building(
  deps: WorkspaceRoutesDeps,
  req: RouteRequest,
  reply: RouteReply,
  id: string,
  build: () => Promise<unknown>,
): Promise<unknown> {
  return deps.registry.creating(id, `build:${newWorkspaceId()}`, async (admitted) => {
    if (!admitted) throw new HttpError('already_exists', 'workspace id already exists')
    return claimed(deps, req, reply, id, build)
  })
}

/**
 * Why `ws` holds too many sessions for the server, null when it does not;
 * a refusal is counted. `holder` names what the sessions came from.
 * Mirrors Python's `_past_session_cap`.
 */
function pastSessionCap(ws: Workspace, cap: number | null, holder: string): string | null {
  const held = ws.listSessions().length
  if (cap === null || held <= cap) return null
  refused('max_sessions')
  return `${holder} holds ${String(held)} sessions, past max_sessions (${String(cap)})`
}

/**
 * Refuse an id that would name the state root, not a workspace, or that
 * breaks the rule every name a caller gives keeps. Mirrors Python's `_refuse_id`.
 */
function refuseId(id: string | null | undefined, reserved: ReadonlySet<string>): void {
  if (id === null || id === undefined) return
  try {
    checkName('workspace id', id)
  } catch (err) {
    throw loaderError(err)
  }
  if (reserved.has(id))
    throw new HttpError('invalid_value', 'id must not be . or ..', { param: 'id' })
}

/**
 * A stable fingerprint of the config a workspace was created from: the
 * SHA-256 of its JSON with every object's keys sorted. Mirrors Python's
 * `config_digest`.
 */
function configDigest(config: unknown): string {
  const canonical = JSON.stringify(config, (_key, value: unknown) =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : value,
  )
  return createHash('sha256').update(canonical).digest('hex')
}

/**
 * The config a create builds, with the saved entries its pointers name
 * filled in and each policy script that names a saved policy given its
 * source: after the digest and the policies, which judge the config as
 * written and never see a sealed value. Answers 501 for pointers on a server
 * of many accounts, and 400 for a name that is not saved or a saved value its
 * field cannot take.
 */
async function withSaved(
  deps: WorkspaceRoutesDeps,
  written: Record<string, JsonValue>,
  cfg: WorkspaceConfigRaw,
): Promise<WorkspaceConfigRaw> {
  const refs = secretRefs(written)
  const shared = deps.registry.accountsRequired
  try {
    const named =
      deps.resources !== undefined && !shared
        ? await withPolicies(deps.resources, written)
        : written
    if (refs.length === 0) return named === written ? cfg : checkConfig(named)
    requireOneAccount(deps.registry)
    if (deps.resources === undefined) {
      throw new HttpError('invalid_request', 'this server keeps no saved connections')
    }
    return await withEntries(deps.resources, named, refs)
  } catch (e) {
    if (!(e instanceof ResourceError)) throw e
    throw storeRefusal(e)
  }
}

/**
 * Build `cfg` as workspace `wid`, or answer the live one built from it, and
 * keep the config for `start`; `status` is the answer for a build. Builds of
 * one id run one at a time, so a second of the same config answers what the
 * first built, and one of another config is refused at once. A held id is
 * answered or refused before its secrets resolve or its mounts build, and
 * before a second Workspace opens the live one's state; one being deleted or
 * stopped is refused, since its state is about to go or is still being
 * written. The server's policies judge the config as written before any of
 * it is built. Mirrors Python's `_open_workspace`.
 */
function openWorkspace(
  deps: WorkspaceRoutesDeps,
  req: RouteRequest,
  reply: RouteReply,
  wid: string,
  cfg: WorkspaceConfigRaw,
  config: Record<string, JsonValue>,
  status: number,
): Promise<unknown> {
  const digest = configDigest(config)
  return deps.registry.creating(wid, digest, async (admitted) => {
    if (!admitted) {
      throw new HttpError('already_exists', 'workspace id already exists')
    }
    if (deps.registry.has(wid) || deps.registry.removing(wid)) {
      const held = deps.registry.visible(wid, req.account)
      if (held === null || deps.registry.removing(wid) || held.configDigest !== digest) {
        throw new HttpError('already_exists', 'workspace id already exists')
      }
      return answer(reply, 200, await makeDetail(held))
    }
    await admit(deps, req, config)
    const saved = await withSaved(deps, config, cfg)
    return claimed(deps, req, reply, wid, async () => {
      let args: Awaited<ReturnType<ServerHost['workspaceArgs']>>
      try {
        // Mounts that answer as they are built, and the secrets the
        // config names, go out under the network the workspace will be
        // held to.
        args = await runWithNetwork(deps.registry.ruleFor(cfg.network), () =>
          deps.host.workspaceArgs(saved),
        )
      } catch (e) {
        // A `secrets:` block the host cannot resolve is the caller's
        // config, not a backend that would not answer.
        throw refusedBuild(e, 'config could not be built')
      }
      // The Mounts ride through whole; see workspace_config.ts.
      const vfsMap: Record<string, MountSpec> = { ...args.mounts }
      let ws: Workspace
      try {
        // Every option the config produced rides through: enumerating
        // them by hand silently dropped `clis` and `guards`, so a yaml
        // clis block parsed, validated, and then installed nothing.
        // Only identity and the store default are the daemon's to
        // decide.
        ws = new deps.host.Workspace(vfsMap, {
          ...args.options,
          workspaceId: wid,
          // The workspace's lease names this daemon while it runs its
          // lines, by the id it keeps across restarts.
          daemonId: await deps.host.daemonId(),
          // Daemon default is disk (a created workspace survives restart
          // with zero infrastructure, like git init); the library default
          // stays ram. An explicit store always wins.
          store: args.options.store ?? deps.host.stateStore(),
          ceilings: deps.registry.ceilings,
          // Whichever of the two built it, no sibling workspace shares
          // it, so this workspace is the one that closes it.
          ownsStore: true,
        })
      } catch (e) {
        throw refusedBuild(e, 'config could not be built')
      }
      // Under max_sessions the sessions its store saved are loaded, and
      // more than the cap refuse the create.
      const cap = deps.registry.maxSessions
      if (cap !== null) {
        let past: string | null
        try {
          await ws.ensureSessionsLoaded()
          past = pastSessionCap(ws, cap, 'the saved workspace')
        } catch (e) {
          await ws.close()
          throw e
        }
        if (past !== null) {
          await ws.close()
          throw new HttpError('invalid_request', past)
        }
      }
      let entry
      try {
        for (const [prefix, [backend, mountpoint]] of Object.entries(args.kernelMounts)) {
          await deps.host.mountKernel(ws, prefix, mountpoint, backend)
        }
        await deps.registry.saveConfig(wid, config)
        entry = deps.registry.add(ws, wid, req.account)
        entry.configDigest = digest
      } catch (e) {
        await ws.close()
        throw new HttpError('conflict', (e as Error).message)
      }
      return answer(reply, status, await makeDetail(entry))
    })
  })
}

export function registerWorkspacesRoutes(app: RouteApp, deps: WorkspaceRoutesDeps): void {
  app.post<{ Body: unknown; Querystring: { explain?: string } }>(
    '/v1/workspaces',
    async (
      req: RouteRequest<{ Body: unknown; Querystring: { explain?: string } }>,
      reply: RouteReply,
    ) => {
      // The query is read before the body, as Python's route reads them.
      const { explain } = queryFlag(req.query, 'explain')
      const body = createRequest(req.body)
      // The policies judge, and the build uses, the same document.
      const { cfg, written: config } = await configOf(
        body.req,
        body.cfg,
        deps.resources,
        deps.registry,
      )
      // The server's policies judge the config as written before any of it
      // is built; explain answers what they say without creating anything.
      if (explain) {
        return explanationToDict(await deps.registry.explanation(config, req.account))
      }
      // The registry id and the state-store scope must be the same identity,
      // so resolve it before construction: explicit REST id, then the
      // config's workspaceId, then a fresh mint. Creating is idempotent for
      // one config, so an id held by a workspace created from an identical
      // config answers it with 200, and an id held by anything else is
      // refused.
      const wid = body.req.id ?? cfg.workspaceId ?? newWorkspaceId()
      refuseId(wid, deps.host.reservedIds)
      return openWorkspace(deps, req, reply, wid, cfg, config, 201)
    },
  )

  // The running workspaces, then the stopped ones.
  app.get('/v1/workspaces', async (req) => {
    const running = deps.registry
      .list()
      .filter((e) => deps.registry.visible(e.id, req.account) !== null)
      .map(makeBrief)
    // One that stops while this reads is listed once, as it was first read.
    const listed = new Set(running.map((w) => w.id))
    const idle: WorkspaceBrief[] = []
    for (const id of await deps.registry.stoppedIds(req.account)) {
      if (listed.has(id)) continue
      const k = await kept(deps, id, req.account)
      if (k !== null) idle.push(makeStoppedBrief(id, k.createdAt))
    }
    return [...running, ...idle]
  })

  app.post('/v1/workspaces/load', async (req, reply) => {
    const multipart = (req.headers['content-type'] ?? '').startsWith('multipart/')
    let body: LoadWorkspaceRequest
    let source: string | Uint8Array
    try {
      if (multipart) {
        ;[body, source] = await readLoadBody(req)
      } else {
        body = parseLoadRequest(req.body)
        const given = body.key ?? undefined
        if (given === undefined) {
          throw new HttpError(
            'invalid_request',
            "load needs a 'key' or an uploaded 'snapshot' part",
          )
        }
        source = storeKey(deps.host, req.account, given)
      }
    } catch (e) {
      if (e instanceof HttpError && multipart) void reply.header('connection', 'close')
      throw e
    }
    const workspaceId = body.id ?? undefined
    const override = (body.override ?? undefined) as OverrideShape | undefined
    refuseId(workspaceId, deps.host.reservedIds)
    if (
      workspaceId !== undefined &&
      (deps.registry.has(workspaceId) || deps.registry.removing(workspaceId))
    ) {
      throw new HttpError('already_exists', 'workspace id already exists')
    }
    await admit(deps, req, override)
    const store = typeof source === 'string' ? snapshotStore(deps) : undefined
    const wid = workspaceId ?? newWorkspaceId()
    // What the snapshot holds is built under the server's network; its own
    // setting is not known until it is read.
    const rule = deps.registry.ruleFor()
    return building(deps, req, reply, wid, async () => {
      let overrides: Record<string, BaseVFS | Mount>
      try {
        // An override mount's credential may be a pointer at one of
        // these declarations; a container the constructor will reject
        // is left for it to reject. Mirrors the python load route.
        overrides = await runWithNetwork(rule, () =>
          buildOverrideMounts(override ?? null, override?.secrets, (name, config, sources) =>
            deps.host.buildVfs(name, config, sources),
          ),
        )
      } catch (e) {
        throw refusedBuild(e, 'override could not be built')
      }
      let ws: Workspace
      let restoredWith: readonly Policy[] = []
      try {
        // The snapshot's saved values meet the server's policies as a live
        // write does, before any of them lands.
        ws = await deps.registry.restoring((policies) => {
          restoredWith = policies
          return runWithNetwork(rule, () =>
            deps.host.Workspace.load(
              source,
              {
                maxSnapshotBytes: MAX_SNAPSHOT_BYTES,
                maxSnapshotEncodedBytes: MAX_SNAPSHOT_PART,
                ...(override?.secrets !== undefined ? { secrets: override.secrets } : {}),
                ...(store !== undefined ? { s3: store } : {}),
                policies,
                ceilings: deps.registry.ceilings,
              },
              overrides,
            ),
          )
        })
      } catch (e) {
        if (e instanceof PolicyDenied) {
          throw new HttpError('policy_refused', e.refusal?.reason ?? e.message, {
            refusal: refusalToDict(e.refusal ?? null),
          })
        }
        if ((e as { code?: unknown }).code === 'ENOENT') {
          throw new HttpError('invalid_value', 'key names no snapshot', { param: 'key', cause: e })
        }
        throw refusedBuild(e, 'snapshot could not be loaded')
      }
      const past = pastSessionCap(ws, deps.registry.maxSessions, 'the snapshot')
      if (past !== null) {
        await ws.close()
        throw new HttpError('invalid_request', past)
      }
      let entry
      try {
        entry = deps.registry.add(ws, wid, req.account, restoredWith)
      } catch (e) {
        await ws.close()
        throw new HttpError('conflict', (e as Error).message)
      }
      await deps.registry.dropConfig(wid)
      return answer(reply, 201, await makeDetail(entry))
    })
  })

  app.get<{ Params: WorkspaceIdParams; Querystring: WorkspaceGetQuery }>(
    '/v1/workspaces/:id',
    async (req) => {
      const { verbose } = queryFlag(req.query, 'verbose')
      const entry = deps.registry.visible(req.params.id, req.account)
      if (entry === null) {
        const k = await kept(deps, req.params.id, req.account)
        if (k === null) throw new HttpError('not_found', 'workspace not found')
        return makeStoppedDetail(req.params.id, k.config, k.createdAt)
      }
      // A workspace being deleted keeps its id until the deletion is done,
      // but its runner has stopped answering: it is gone to a reader.
      if (deps.registry.removing(req.params.id)) {
        throw new HttpError('not_found', 'workspace not found')
      }
      return await makeDetail(entry, verbose)
    },
  )

  app.get<{ Params: WorkspaceIdParams; Querystring: WorkspaceLogsQuery }>(
    '/v1/workspaces/:id/logs',
    async (req, reply) => {
      const entry = requireEntry(deps.registry, req.params.id, req.account)
      if (deps.registry.removing(req.params.id)) {
        throw new HttpError('not_found', 'workspace not found')
      }
      let session: string | undefined
      try {
        session = sessionFilter(req.query.session)
        if (req.query.format !== 'jsonl') logPage([], req.query.limit, req.query.after)
      } catch (e) {
        throw loaderError(e)
      }
      const logs = completedLogs(await entry.runner.ws.observer.events(session))
      if (req.query.format === 'jsonl')
        return reply
          .header('content-type', 'application/x-ndjson')
          .header('content-disposition', logAttachment(req.params.id))
          .send(streamOf(logLines(logs)))
      try {
        return logPage(logs, req.query.limit, req.query.after)
      } catch (e) {
        throw loaderError(e)
      }
    },
  )

  // A stopped workspace is deleted as a running one is: its state, config
  // and owner go.
  app.delete<{ Params: WorkspaceIdParams }>('/v1/workspaces/:id', async (req) => {
    const { id } = req.params
    if (deps.registry.visible(id, req.account) === null) {
      const k = await kept(deps, id, req.account)
      if (k === null) throw new HttpError('not_found', 'workspace not found')
      const store = storeOf(deps, k.config)
      try {
        const forgot = await deps.registry.forget(id, req.account, k.config, store)
        if (forgot === Forget.Gone) throw new HttpError('not_found', 'workspace not found')
        if (forgot === Forget.Held) {
          throw new HttpError('workspace_busy', 'workspace is running on another server')
        }
        if (forgot === Forget.Busy) {
          throw new HttpError('workspace_busy', 'workspace is starting or stopping; try again')
        }
      } finally {
        await store.close()
      }
      return { id, closed_at: Date.now() / 1000 }
    }
    try {
      await deps.registry.remove(id)
    } catch (err) {
      console.error('mirage: workspace delete failed', err)
      throw new HttpError('internal', INTERNAL_MESSAGE, { cause: err })
    }
    return { id, closed_at: Date.now() / 1000 }
  })

  /**
   * Stop the workspace and keep its state and config for start. A stopped
   * workspace answers as it is, so a stop can be repeated.
   */
  app.post<{ Params: WorkspaceIdParams }>('/v1/workspaces/:id/stop', async (req) => {
    const { id } = req.params
    const live = deps.registry.visible(id, req.account) !== null
    if (!live && !(await isStopped(deps, id, req.account))) {
      throw new HttpError('not_found', 'workspace not found')
    }
    if (live || deps.registry.removing(id)) await deps.registry.stop(id)
    return { id, closed_at: Date.now() / 1000 }
  })

  /**
   * Start a stopped workspace from the config it was created with, over the
   * state it kept; a running one answers as it is. The server's policies
   * judge the config again, and the secrets and saved entries it names are
   * read again, so a rotated secret is picked up.
   */
  app.post<{ Params: WorkspaceIdParams }>('/v1/workspaces/:id/start', async (req, reply) => {
    const { id } = req.params
    const held = deps.registry.visible(id, req.account)
    if (held !== null && !deps.registry.removing(id)) return await makeDetail(held)
    const config = await deps.registry.savedConfig(id, req.account)
    if (config === null) throw new HttpError('not_found', 'workspace not found')
    let cfg: WorkspaceConfigRaw
    try {
      cfg = checkConfig(config)
    } catch (e) {
      throw loaderError(e, ['config'], config)
    }
    return openWorkspace(deps, req, reply, id, cfg, config, 200)
  })

  /** Cancel every session's running and queued lines; all stay open. */
  app.post<{ Params: WorkspaceIdParams }>('/v1/workspaces/:id/cancel', async (req) => {
    const entry = requireEntry(deps.registry, req.params.id, req.account)
    return { canceled: await entry.runner.ws.cancel() }
  })

  /** Kill every session's background jobs and runners. */
  app.post<{ Params: WorkspaceIdParams }>('/v1/workspaces/:id/kill', async (req) => {
    const entry = requireEntry(deps.registry, req.params.id, req.account)
    return { killed: await entry.runner.ws.kill() }
  })

  /**
   * Define a named profile on the live workspace, or replace it. Only the
   * live table changes: a session moves when it is updated onto the name,
   * and the workspace's config is never rewritten.
   */
  app.put<{ Params: { id: string; name: string }; Body: unknown }>(
    '/v1/workspaces/:id/profiles/:name',
    (req) => {
      const entry = requireEntry(deps.registry, req.params.id, req.account)
      const name = req.params.name
      try {
        entry.runner.ws.setProfile(
          name,
          deps.host.loadProfile(SessionProfile(req.body, `profile \`${name}\``)),
        )
      } catch (err) {
        throw loaderError(err, [], req.body)
      }
      return { name }
    },
  )

  app.post<{ Params: WorkspaceIdParams; Body: unknown }>(
    '/v1/workspaces/:id/clone',
    async (req, reply) => {
      const parsed = CloneWorkspaceRequest.safeParse(req.body ?? {})
      if (!parsed.success) throw validationError(parsed.error, req.body ?? {})
      const source = requireEntry(deps.registry, req.params.id, req.account)
      const id = parsed.data.id ?? undefined
      const override = (parsed.data.override ?? null) as OverrideShape | null
      refuseId(id, deps.host.reservedIds)
      if (id !== undefined && (deps.registry.has(id) || deps.registry.removing(id))) {
        throw new HttpError('already_exists', 'workspace id already exists')
      }
      const wid = id ?? newWorkspaceId()
      await admit(deps, req, override)
      return building(deps, req, reply, wid, async () => {
        const src = source.runner.ws
        let newWs
        try {
          newWs = await runWithNetwork(deps.registry.ruleFor(src.network), () =>
            cloneWorkspaceWithOverride(src, override, deps.host),
          )
        } catch (e) {
          if (isBusy(e)) throw new HttpError('conflict', (e as Error).message)
          // An override naming a source the host cannot resolve, or a
          // block the schema refuses, is the caller's mistake -- the
          // answer create, load and the historical clone already give.
          throw refusedBuild(e, 'override could not be built')
        }
        let entry
        try {
          entry = deps.registry.add(newWs, wid, req.account)
        } catch (e) {
          await newWs.close()
          throw new HttpError('conflict', (e as Error).message)
        }
        await deps.registry.dropConfig(wid)
        return answer(reply, 201, await makeDetail(entry))
      })
    },
  )

  app.get<{ Params: WorkspaceIdParams }>('/v1/workspaces/:id/snapshot', async (req, reply) => {
    const entry = requireEntry(deps.registry, req.params.id, req.account)
    let tar: Uint8Array
    try {
      tar = await entry.runner.ws.snapshot()
    } catch (e) {
      if (isBusy(e)) throw new HttpError('conflict', (e as Error).message)
      throw e
    }
    return reply
      .type('application/x-tar')
      .send(Buffer.from(tar.buffer, tar.byteOffset, tar.byteLength))
  })

  app.post<{ Params: WorkspaceIdParams }>('/v1/workspaces/:id/snapshot', async (req, reply) => {
    const { id } = req.params
    const parsed = SnapshotWorkspaceRequest.safeParse(req.body)
    if (!parsed.success) throw validationError(parsed.error, req.body)
    const entry = requireEntry(deps.registry, id, req.account)
    const store = snapshotStore(deps)
    const { key } = parsed.data
    const scoped = storeKey(deps.host, req.account, key)
    let size: number
    try {
      size = await entry.runner.ws.snapshot(scoped, { s3: store })
    } catch (e) {
      if (isBusy(e)) throw new HttpError('conflict', (e as Error).message)
      throw e
    }
    return reply.status(200).send({ id, key, size })
  })
}
