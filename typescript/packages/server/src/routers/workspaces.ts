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
import { createHash } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { MountSpec } from '@struktoai/mirage-core/workspace/workspace/workspace'
import type { BaseVFS } from '@struktoai/mirage-core/vfs/base'
import type { Mount } from '@struktoai/mirage-core/workspace/mount/spec'
import { DiskWorkspaceStateStore, DOT_IDS, Workspace } from '@struktoai/mirage-node'
import { newWorkspaceId } from '@struktoai/mirage-core/utils/ids'
import { isSafeBlobPath } from '@struktoai/mirage-core/workspace/snapshot/utils'
import { quoteName } from '@struktoai/mirage-node/workspace/record/disk'
import type { S3Config } from '@struktoai/mirage-core/vfs/s3/config'
import { type WorkspaceRegistry } from '../registry.ts'
import { z } from '@struktoai/mirage-core/vfs/secrets'
import { SecretsError } from '@struktoai/mirage-core/secrets/errors'
import { VFSConfigError } from '@struktoai/mirage-core/vfs/errors'
import { buildOverrideMounts, cloneWorkspaceWithOverride, type OverrideShape } from '../clone.ts'
import {
  configToWorkspaceArgs,
  loadWorkspaceConfig,
  type WorkspaceArgs,
  type WorkspaceConfigRaw,
} from '@struktoai/mirage-node'
import { makeBrief, makeDetail } from '../summary.ts'
import { MAX_REQUEST_PART, MAX_SNAPSHOT_PART, MultipartError, partEvents } from '../multipart.ts'

export interface WorkspaceRoutesDeps {
  registry: WorkspaceRegistry
  stateRoot: string
  /** The S3-like store a snapshot request may name a key in. */
  snapshotStore: S3Config | undefined
}

const WRITE_RATE_LIMIT = {
  config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
}

interface CreateWorkspaceBody {
  config: Record<string, unknown>
  id?: string
}

interface WorkspaceIdParams {
  id: string
}

interface WorkspaceGetQuery {
  verbose?: string
}

interface CloneWorkspaceBody {
  id?: string
  override?: OverrideShape
}

const SnapshotBodySchema = z.object({ key: z.string() }).strict()

const LoadBodySchema = z
  .object({
    key: z.string().optional(),
    id: z.string().optional(),
    override: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()

interface LoadWorkspaceBody {
  key?: string
  id?: string
  override?: OverrideShape
}

function parseLoadRequest(raw: unknown): LoadWorkspaceBody {
  const parsed = LoadBodySchema.safeParse(raw ?? {})
  if (!parsed.success) {
    throw new MultipartError(400, `bad load request: ${parsed.error.message}`)
  }
  return parsed.data as LoadWorkspaceBody
}

/**
 * Read an uploaded snapshot: a `request` part, then the tar. The tar is
 * held in memory, never spooled to the server's disk.
 *
 * @throws MultipartError 400 for a body without both parts, or with a
 *   `key`; 413 for an oversized request part.
 */
async function readLoadBody(req: FastifyRequest): Promise<[LoadWorkspaceBody, Uint8Array]> {
  let name = ''
  const request: Uint8Array[] = []
  const tar: Uint8Array[] = []
  const seen = new Set<string>()
  let size = 0
  let tarSize = 0
  for await (const event of partEvents(req.raw, req.headers['content-type'] ?? '')) {
    if (event.kind === 'begin') {
      name = event.name
      seen.add(name)
    } else if (event.kind === 'data' && name === 'request') {
      request.push(event.data)
      size += event.data.byteLength
      if (size > MAX_REQUEST_PART) throw new MultipartError(413, 'request part too large')
    } else if (event.kind === 'data' && name === 'snapshot') {
      tar.push(event.data)
      tarSize += event.data.byteLength
      if (tarSize > MAX_SNAPSHOT_PART) throw new MultipartError(413, 'snapshot part too large')
    }
  }
  if (!seen.has('snapshot')) {
    throw new MultipartError(400, "multipart body missing 'snapshot' part")
  }
  let raw: unknown
  try {
    raw = JSON.parse(Buffer.concat(request).toString() || '{}')
  } catch (e) {
    throw new MultipartError(400, `bad load request: ${(e as Error).message}`)
  }
  const body = parseLoadRequest(raw)
  if (body.key !== undefined) {
    throw new MultipartError(400, "load takes a 'key' or an uploaded 'snapshot', not both")
  }
  const joined = Buffer.concat(tar, tarSize)
  return [body, new Uint8Array(joined.buffer, joined.byteOffset, joined.byteLength)]
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
 * The key the caller's snapshot `key` has in the store, or null for a key
 * that is not a plain relative path. An account's snapshots live under
 * its own prefix, so no account can write or load another's by naming
 * its key.
 */
function storeKey(account: string | null, key: string): string | null {
  if (!isSafeBlobPath(key)) return null
  return account === null ? key : `${ACCOUNTS_DIR}/${quoteName(account)}/${key}`
}

function noStore(reply: FastifyReply): FastifyReply {
  return reply.status(400).send({ detail: 'this server has no snapshot store' })
}

/** Refuse an id that would name the state root, not a workspace. */
function refuseId(reply: FastifyReply, id: string): FastifyReply {
  return reply.status(400).send({ detail: `invalid workspace id: ${id}` })
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

export function registerWorkspacesRoutes(app: FastifyInstance, deps: WorkspaceRoutesDeps): void {
  app.post<{ Body: CreateWorkspaceBody }>(
    '/v1/workspaces',
    async (req: FastifyRequest<{ Body: CreateWorkspaceBody }>, reply: FastifyReply) => {
      const body = req.body
      const config: unknown = body.config
      if (config === null || typeof config !== 'object' || Array.isArray(config)) {
        return reply.status(400).send({ detail: 'config must be a mapping' })
      }
      let cfg: WorkspaceConfigRaw
      try {
        cfg = loadWorkspaceConfig(config as Record<string, unknown>)
        for (const entry of cfg.runtimes ?? []) {
          if (typeof entry === 'string') continue
          const runtimeConfig = entry.config
          if (
            runtimeConfig !== null &&
            typeof runtimeConfig === 'object' &&
            Object.hasOwn(runtimeConfig, 'initModule')
          ) {
            throw new Error('runtime initModule is only allowed in operator-owned configuration')
          }
        }
      } catch (e) {
        return reply.status(400).send({ detail: (e as Error).message })
      }
      // The registry id and the state-store scope must be the same identity,
      // so resolve it before construction: explicit REST id, then the
      // config's workspaceId, then a fresh mint. A held id is answered or
      // refused here, before its secrets resolve or its mounts build, and
      // before a second Workspace opens the live one's state: creating is
      // idempotent for one config, so an id held by a workspace created
      // from an identical config answers it with 200, and an id held by
      // anything else, or by one being deleted, is refused. Creates of one
      // id run one at a time, so a second of the same config answers what
      // the first built, and one of another config is refused at once.
      const wid = body.id ?? cfg.workspaceId ?? newWorkspaceId()
      if (DOT_IDS.has(wid)) return refuseId(reply, wid)
      const digest = configDigest(config)
      return deps.registry.creating(wid, digest, async (admitted) => {
        if (!admitted) {
          return reply.status(409).send({ detail: `workspace id already exists: ${wid}` })
        }
        if (deps.registry.has(wid)) {
          const held = deps.registry.visible(wid, req.account)
          if (held === null || deps.registry.removing(wid) || held.configDigest !== digest) {
            return reply.status(409).send({ detail: `workspace id already exists: ${wid}` })
          }
          return reply.status(200).send(await makeDetail(held))
        }
        if (!(await deps.registry.claim(wid, req.account))) {
          return reply.status(409).send({ detail: `workspace id already exists: ${wid}` })
        }
        let args: WorkspaceArgs
        try {
          args = await configToWorkspaceArgs(cfg)
        } catch (e) {
          if (e instanceof SecretsError || e instanceof z.ZodError || e instanceof VFSConfigError) {
            // A `secrets:` block the host cannot resolve is the caller's
            // config, not a backend that would not answer. Resolution moved
            // into configToWorkspaceArgs, so without this the same body that
            // python's create route refuses with 400 got a 502 here.
            return reply.status(400).send({ detail: e.message })
          }
          return reply.status(502).send({ detail: `VFS build failed: ${(e as Error).message}` })
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
          ws = new Workspace(vfsMap, {
            ...args.options,
            workspaceId: wid,
            // Daemon default is disk (a created workspace survives restart
            // with zero infrastructure, like git init); the library default
            // stays ram. An explicit store always wins.
            store: args.options.store ?? new DiskWorkspaceStateStore({ root: deps.stateRoot }),
            // Whichever of the two built it, no sibling workspace shares
            // it, so this workspace is the one that closes it.
            ownsStore: true,
          })
        } catch (e) {
          return reply.status(400).send({ detail: (e as Error).message })
        }
        let entry
        try {
          for (const [prefix, [backend, mountpoint]] of Object.entries(args.kernelMounts)) {
            await ws.addFuseMount(prefix, mountpoint, undefined, backend)
          }
          entry = deps.registry.add(ws, wid, req.account)
          entry.configDigest = digest
        } catch (e) {
          await ws.close()
          return reply.status(409).send({ detail: (e as Error).message })
        }
        return reply.status(201).send(await makeDetail(entry))
      })
    },
  )

  app.get('/v1/workspaces', (req) =>
    deps.registry
      .list()
      .filter((e) => deps.registry.visible(e.id, req.account) !== null)
      .map(makeBrief),
  )

  app.post('/v1/workspaces/load', WRITE_RATE_LIMIT, async (req, reply) => {
    const multipart = (req.headers['content-type'] ?? '').startsWith('multipart/')
    let body: LoadWorkspaceBody
    let source: string | Uint8Array
    try {
      if (multipart) {
        ;[body, source] = await readLoadBody(req)
      } else {
        body = parseLoadRequest(req.body)
        if (body.key === undefined) {
          throw new MultipartError(400, "load needs a 'key' or an uploaded 'snapshot' part")
        }
        const scoped = storeKey(req.account, body.key)
        if (scoped === null) throw new MultipartError(400, `invalid snapshot key: ${body.key}`)
        source = scoped
      }
    } catch (e) {
      if (!(e instanceof MultipartError)) throw e
      if (multipart) void reply.header('connection', 'close')
      return reply.status(e.statusCode).send({ detail: e.message })
    }
    const { key, id: workspaceId, override } = body
    if (workspaceId !== undefined && DOT_IDS.has(workspaceId)) return refuseId(reply, workspaceId)
    if (workspaceId !== undefined && deps.registry.has(workspaceId)) {
      return reply.status(409).send({ detail: `workspace id already exists: ${workspaceId}` })
    }
    const store = typeof source === 'string' ? deps.snapshotStore : undefined
    if (typeof source === 'string' && store === undefined) return noStore(reply)
    const wid = workspaceId ?? newWorkspaceId()
    if (!(await deps.registry.claim(wid, req.account))) {
      return reply.status(409).send({ detail: `workspace id already exists: ${wid}` })
    }
    let overrides: Record<string, BaseVFS | Mount>
    try {
      // An override mount's credential may be a pointer at one of
      // these declarations; a container the constructor will reject
      // is left for it to reject. Mirrors the python load route.
      overrides = await buildOverrideMounts(override ?? null, override?.secrets)
    } catch (e) {
      return reply.status(400).send({ detail: `override build failed: ${(e as Error).message}` })
    }
    let ws: Workspace
    try {
      ws = await Workspace.load(
        source,
        {
          ...(override?.secrets !== undefined ? { secrets: override.secrets } : {}),
          ...(store !== undefined ? { s3: store } : {}),
        },
        overrides,
      )
    } catch (e) {
      if ((e as { code?: unknown }).code === 'ENOENT') {
        return reply.status(400).send({ detail: `snapshot not found: ${String(key)}` })
      }
      return reply.status(400).send({ detail: `load failed: ${(e as Error).message}` })
    }
    let entry
    try {
      entry = deps.registry.add(ws, wid, req.account)
    } catch (e) {
      return reply.status(409).send({ detail: (e as Error).message })
    }
    return reply.status(201).send(await makeDetail(entry))
  })

  app.get<{ Params: WorkspaceIdParams; Querystring: WorkspaceGetQuery }>(
    '/v1/workspaces/:id',
    async (req, reply) => {
      const entry = deps.registry.visible(req.params.id, req.account)
      if (entry === null) return reply.status(404).send({ detail: 'workspace not found' })
      const verbose = req.query.verbose === 'true'
      return await makeDetail(entry, verbose)
    },
  )

  app.delete<{ Params: WorkspaceIdParams }>('/v1/workspaces/:id', async (req, reply) => {
    const { id } = req.params
    if (deps.registry.visible(id, req.account) === null) {
      return reply.status(404).send({ detail: 'workspace not found' })
    }
    try {
      await deps.registry.remove(id)
    } catch (err) {
      return reply
        .status(500)
        .send({ detail: `workspace delete failed: ${(err as Error).message}` })
    }
    return { id, closed_at: Date.now() / 1000 }
  })

  /** Close the workspace and keep its state for the owner to reopen. */
  app.post<{ Params: WorkspaceIdParams }>('/v1/workspaces/:id/close', async (req, reply) => {
    const { id } = req.params
    if (deps.registry.visible(id, req.account) === null) {
      return reply.status(404).send({ detail: 'workspace not found' })
    }
    await deps.registry.close(id)
    return { id, closed_at: Date.now() / 1000 }
  })

  /** Cancel every session's running and queued lines; all stay open. */
  app.post<{ Params: WorkspaceIdParams }>('/v1/workspaces/:id/cancel', async (req, reply) => {
    const entry = deps.registry.visible(req.params.id, req.account)
    if (entry === null) return reply.status(404).send({ detail: 'workspace not found' })
    return { canceled: await entry.runner.ws.cancel() }
  })

  /** Kill every session's background jobs and runners. */
  app.post<{ Params: WorkspaceIdParams }>('/v1/workspaces/:id/kill', async (req, reply) => {
    const entry = deps.registry.visible(req.params.id, req.account)
    if (entry === null) return reply.status(404).send({ detail: 'workspace not found' })
    return { killed: await entry.runner.ws.kill() }
  })

  app.post<{ Params: WorkspaceIdParams; Body: CloneWorkspaceBody }>(
    '/v1/workspaces/:id/clone',
    async (req, reply) => {
      const source = deps.registry.visible(req.params.id, req.account)
      if (source === null) return reply.status(404).send({ detail: 'workspace not found' })
      const body = req.body
      if (body.id !== undefined && DOT_IDS.has(body.id)) return refuseId(reply, body.id)
      if (body.id !== undefined && deps.registry.has(body.id)) {
        return reply.status(409).send({ detail: `workspace id already exists: ${body.id}` })
      }
      const wid = body.id ?? newWorkspaceId()
      if (!(await deps.registry.claim(wid, req.account))) {
        return reply.status(409).send({ detail: `workspace id already exists: ${wid}` })
      }
      const src = source.runner.ws
      let newWs
      try {
        newWs = await cloneWorkspaceWithOverride(src, body.override ?? null)
      } catch (e) {
        if (e instanceof SecretsError || e instanceof z.ZodError || e instanceof VFSConfigError) {
          // An override naming a source the host cannot resolve, or a
          // block the schema refuses, is the caller's mistake -- the
          // answer create, load and the historical clone already give.
          return reply.status(400).send({ detail: e.message })
        }
        if (isBusy(e)) return reply.status(409).send({ detail: (e as Error).message })
        throw e
      }
      let entry
      try {
        entry = deps.registry.add(newWs, wid, req.account)
      } catch (e) {
        return reply.status(409).send({ detail: (e as Error).message })
      }
      return reply.status(201).send(await makeDetail(entry))
    },
  )

  app.get<{ Params: WorkspaceIdParams }>('/v1/workspaces/:id/snapshot', async (req, reply) => {
    const entry = deps.registry.visible(req.params.id, req.account)
    if (entry === null) return reply.status(404).send({ detail: 'workspace not found' })
    let tar: Uint8Array
    try {
      tar = await entry.runner.ws.snapshot()
    } catch (e) {
      if (isBusy(e)) return reply.status(409).send({ detail: (e as Error).message })
      throw e
    }
    return reply
      .type('application/x-tar')
      .send(Buffer.from(tar.buffer, tar.byteOffset, tar.byteLength))
  })

  app.post<{ Params: WorkspaceIdParams }>(
    '/v1/workspaces/:id/snapshot',
    WRITE_RATE_LIMIT,
    async (req, reply) => {
      const { id } = req.params
      const entry = deps.registry.visible(id, req.account)
      if (entry === null) return reply.status(404).send({ detail: 'workspace not found' })
      const parsed = SnapshotBodySchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.status(400).send({ detail: `bad snapshot request: ${parsed.error.message}` })
      }
      if (deps.snapshotStore === undefined) return noStore(reply)
      const { key } = parsed.data
      const scoped = storeKey(req.account, key)
      if (scoped === null) {
        return reply.status(400).send({ detail: `invalid snapshot key: ${key}` })
      }
      let size: number
      try {
        size = await entry.runner.ws.snapshot(scoped, { s3: deps.snapshotStore })
      } catch (e) {
        if (isBusy(e)) return reply.status(409).send({ detail: (e as Error).message })
        throw e
      }
      return reply.status(200).send({ id, key, size })
    },
  )
}
