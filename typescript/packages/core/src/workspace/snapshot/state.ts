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

import { CacheEntry } from '../../cache/file/entry.ts'
import { RAMFileCacheStore } from '../../cache/file/ram.ts'
import type { Resource } from '../../resource/base.ts'
import { EVENT_CLEAR, EVENT_COMMAND, EVENT_DELETE } from '../../observe/log_entry.ts'
import type { EventDict } from '../../observe/observer.ts'
import { RAMResource, type RAMResourceState } from '../../resource/ram/ram.ts'
import { type ResourceStateBase, resourceRefOf } from '../../resource/base.ts'
import { z } from 'zod'

import { setCwd } from '../session/shell_dirs.ts'
import type { CLIInstall } from '../cli/types.ts'
import { CLISpec } from '../../commands/cli/types.ts'
import { ScriptSource } from '../../runtime/routing/types.ts'

/**
 * Per-name overrides for restoring installed CLIs: a plain mapping is a
 * fresh config (the spec resolves from the snapshot's registry key); a
 * [spec, config] tuple carries a live spec too, which is how copy()
 * shares directly installed programs.
 */
export type CLIOverrides = Record<
  string,
  Record<string, unknown> | [CLISpec, Record<string, unknown> | null]
>
import { HISTORY_PREFIX } from '../../resource/history/history.ts'
import {
  hasRedactedSecret,
  redactConfigWithSchema,
  resourceStateRequiresOverride,
} from '../../resource/secrets.ts'
import { Job, JobStatus } from '../../shell/job_table/index.ts'
import {
  Channel,
  type ConsoleChunk,
  JobConsole,
  KILLED_OUTCOME,
  RAMConsoleStore,
  exitOutcome,
} from '../../shell/console/index.ts'
import { ConsistencyPolicy, MountMode } from '../../types.ts'
import { VERSION } from '../../version.ts'
import type { NodeMeta } from '../mount/namespace/namespace.ts'
import { Session, varsFromFields, varsToFields } from '../session/session.ts'
import type { Workspace } from '../workspace/workspace.ts'
import type { MountArgs } from './config.ts'
import { captureFingerprints, liveOnlyMountPrefixes } from './drift.ts'
import type {
  CacheEntrySnapshot,
  CLISnapshot,
  FingerprintEntrySnapshot,
  JobSnapshot,
  MountSnapshot,
  NodeMetaSnapshot,
  ResourceState,
  SessionSnapshot,
  WorkspaceStateDict,
} from './types.ts'
import { FORMAT_VERSION, normMountPrefix } from './utils.ts'

const VALID_MODES: readonly string[] = [MountMode.READ, MountMode.WRITE, MountMode.EXEC]

export async function toStateDict(ws: Workspace): Promise<WorkspaceStateDict> {
  const skip = new Set(['/dev/', normMountPrefix(HISTORY_PREFIX)])
  const mounted = [...ws.registry.allMounts()]
  for (const mount of mounted) await mount.ensureReady()
  const mounts = mounted.filter((m) => !skip.has(m.prefix))
  const mountSnapshots: MountSnapshot[] = []
  for (let i = 0; i < mounts.length; i++) {
    const m = mounts[i]
    if (m === undefined) continue
    // The resource is no longer cast into a shape that promises getState:
    // the contract carries it, so a resource missing one fails to compile
    // rather than throwing here at save time. What remains narrows the
    // returned state to the snapshot format's union.
    const state = (await m.use(() => Promise.resolve(m.resource.getState()))) as ResourceState
    mountSnapshots.push({
      index: i,
      prefix: m.prefix,
      mode: m.mode,
      consistency: ConsistencyPolicy.LAZY,
      resource_class: m.resource.kind,
      resource_ref: resourceRefOf(m.resource),
      resource_state: state,
    })
  }
  const ramCache = ws.cache instanceof RAMFileCacheStore ? ws.cache : null
  const cacheEntries: CacheEntrySnapshot[] =
    ramCache !== null
      ? ramCache.snapshotEntries().map(({ key, entry }) => ({
          key,
          data: ramCache.store.files.get(key) ?? new Uint8Array(),
          fingerprint: entry.fingerprint,
          ttl: entry.ttl,
          cached_at: entry.cachedAt,
          size: entry.size,
        }))
      : []
  const sessions: SessionSnapshot[] = ws.sessionManager
    .list()
    .map((s) => s.toJSON() as unknown as SessionSnapshot)
  // Output is stored per channel rather than chunk by chunk: the manifest
  // externalizes byte fields into tar entries, so keeping chunks would
  // write one entry per write a job ever made. The cost is that a restored
  // job's stdout and stderr no longer interleave, which only affects jobs
  // that have already ended.
  const jobs: JobSnapshot[] = await Promise.all(
    ws.jobTable
      .listJobs()
      .filter((j) => j.status !== JobStatus.RUNNING)
      .map(async (j) => ({
        id: j.id,
        command: j.command,
        cwd: j.cwd,
        status: j.status,
        stdout: await j.console.snapshot(Channel.STDOUT),
        stderr: await j.console.snapshot(Channel.STDERR),
        exit_code: j.exitCode,
        created_at: j.createdAt,
        agent: j.agent,
        session_id: j.sessionId,
      })),
  )
  const clisState: CLISnapshot[] = [...ws.registry.clis.items()].map(([name, install]) => {
    const entry: CLISnapshot = {
      name,
      spec: install.spec.name,
      config: captureCliConfig(install),
    }
    // A script install has no name to resolve (the spec is synthesized
    // from a yaml `script:`), so its embedded program rides along and
    // load rebuilds the spec from it.
    const script = install.spec.script
    if (script !== null) {
      entry.script = {
        source: script.source,
        language: script.language,
        module: script.module,
      }
      entry.runtime = install.spec.runtime
    }
    return entry
  })
  const historyEvents = (await ws.observer.events()).filter(
    (e) => e.type === EVENT_COMMAND || e.type === EVENT_CLEAR || e.type === EVENT_DELETE,
  )
  const current = ws.registry.allMounts()
  if (current.length !== mounted.length || mounted.some((m, i) => m !== current[i] || m.retiring)) {
    throw new Error('mounts changed during snapshot')
  }
  const fingerprints: FingerprintEntrySnapshot[] = captureFingerprints(ws.records, ws.registry)
  const liveOnly = liveOnlyMountPrefixes(ws.registry)
  const nodes: Record<string, NodeMetaSnapshot> = {}
  for (const [path, meta] of ws.namespace.nodes) {
    const entry: NodeMetaSnapshot = {}
    if (meta.target !== undefined) entry.target = meta.target
    if (meta.mtime !== undefined) entry.mtime = meta.mtime
    if (meta.mode !== undefined) entry.mode = meta.mode
    if (meta.uid !== undefined) entry.uid = meta.uid
    if (meta.gid !== undefined) entry.gid = meta.gid
    if (meta.atime !== undefined) entry.atime = meta.atime
    nodes[path] = entry
  }
  return {
    version: FORMAT_VERSION,
    mirage_version: VERSION,
    default_session_id: ws.sessionManager.defaultId,
    default_agent_id: ws.agentId,
    current_agent_id: ws.agentId,
    sessions,
    env: varsToFields(ws.sessionManager.seedVars),
    mounts: mountSnapshots,
    cache: {
      limit: ws.cache.cacheLimit,
      max_drain_bytes: ramCache !== null ? ramCache.maxDrainBytes : null,
      entries: cacheEntries,
    },
    history: historyEvents,
    jobs,
    fingerprints,
    live_only_mounts: liveOnly,
    nodes,
    clis: clisState,
  }
}

/**
 * The spec a snapshot entry restores: a registry key or a program.
 *
 * Throws when the captured script names a language no runtime can
 * speak. The value comes from a file, so it is checked here rather than
 * carried to the selector, which would report the world's runtimes for
 * a language that never existed.
 */
function cliSpecFromEntry(entry: CLISnapshot): string | CLISpec {
  if (entry.script === undefined) return entry.spec
  const language = entry.script.language
  if (language !== 'python' && language !== 'js') {
    throw new Error(`snapshot cli '${entry.spec}': unknown script language '${language}'`)
  }
  return new CLISpec({
    name: entry.spec,
    script: new ScriptSource(entry.script.source, language, entry.script.module),
    runtime: entry.runtime ?? null,
  })
}

function captureCliConfig(install: CLIInstall): Record<string, unknown> | null {
  const model = install.spec.configModel
  if (model instanceof z.ZodObject) {
    return redactConfigWithSchema(model, install.config)
  }
  // A script's config is opaque, so it is captured verbatim rather than
  // guessed at; the config door refuses a secrets pointer in one for
  // exactly this reason (`validateConfigKeys`), since resolved, the
  // value would sit in this capture.
  if (install.config !== null && typeof install.config === 'object') {
    return install.config as Record<string, unknown>
  }
  return null
}

export function buildMountArgs(
  state: WorkspaceStateDict,
  overrides: Record<string, Resource> = {},
  cliOverrides: CLIOverrides = {},
): MountArgs {
  if (state.version < FORMAT_VERSION) {
    throw new Error(
      `snapshot format v${String(state.version)} not supported ` +
        `(loader expects v${String(FORMAT_VERSION)})`,
    )
  }
  const normalized: Record<string, Resource> = {}
  for (const [prefix, resource] of Object.entries(overrides)) {
    normalized[normMountPrefix(prefix)] = resource
  }
  // A mount with no override by now is one nobody can build: it asked to
  // be handed back live or was saved with a redacted secret, or the
  // registry `withRebuiltResources` consulted had nothing for its ref or
  // type. Only a mount this builder restores itself is exempt. Refusing
  // is what Python's `requires_resource_override` does for a class it
  // cannot import; an empty RAMResource in its place would lose the
  // backend without a word.
  const missing = state.mounts
    .filter(
      (m) =>
        normalized[normMountPrefix(m.prefix)] === undefined &&
        (resourceStateRequiresOverride(m.resource_state) || !restoresAsFreshRAM(m)),
    )
    .map((m) => m.prefix)
  if (missing.length > 0) {
    throw new Error(
      `Workspace.load: resources= must include overrides for: ${missing.join(', ')}. ` +
        `A listed mount was saved with redacted credentials, asked to be handed back live ` +
        `(needs_override), or names a resource this registry cannot build; register its ` +
        `factory (register) or pass a live instance.`,
    )
  }
  const mountArgs: Record<string, [Resource, MountMode]> = {}
  for (const m of state.mounts) {
    if (!VALID_MODES.includes(m.mode)) {
      throw new Error(`Workspace.fromState: mount '${m.prefix}' has invalid mode '${m.mode}'`)
    }
    mountArgs[m.prefix] = [
      normalized[normMountPrefix(m.prefix)] ?? new RAMResource(),
      m.mode as MountMode,
    ]
  }
  const cliEntries = state.clis ?? []
  const missingClis = cliEntries
    .filter((e) => hasRedactedSecret(e.config) && !(e.name in cliOverrides))
    .map((e) => e.name)
  if (missingClis.length > 0) {
    throw new Error(
      `Workspace.load: clis= must include fresh configs for: ${missingClis.join(', ')}. ` +
        `These CLIs were saved with redacted config secrets.`,
    )
  }
  const cliArgs: Record<string, [string | CLISpec, Record<string, unknown> | null]> = {}
  for (const e of cliEntries) {
    const override = cliOverrides[e.name]
    if (Array.isArray(override)) {
      // copy() shares the live spec alongside the revealed config, so a
      // directly installed (never registry-named) spec survives the
      // round trip like a shared live resource.
      cliArgs[e.name] = override
    } else {
      cliArgs[e.name] = [cliSpecFromEntry(e), override ?? e.config]
    }
  }

  return {
    mountArgs,
    consistency: ConsistencyPolicy.LAZY,
    defaultSessionId: state.default_session_id,
    defaultAgentId: state.default_agent_id,
    ...(cliEntries.length > 0 ? { clis: cliArgs } : {}),
  }
}

/** Builds the resource a saved mount names, or null when it cannot. */
export type SavedResourceBuilder = (entry: MountSnapshot) => Promise<Resource | null>

/**
 * The `resource_ref` a saved mount was built from, or null: for one
 * constructed in code, and for a v3 snapshot written before the key
 * existed, which carries none (the format version did not move).
 */
function savedRef(entry: MountSnapshot): string | null {
  return (entry.resource_ref as string | null | undefined) ?? null
}

/**
 * Whether `buildMountArgs` restores a saved mount itself, into a fresh
 * RAMResource, so no registry is asked about it: `disk` (its content
 * rides the state, and reopening the original root is exactly what a
 * restore must not do), and `ram` declared by its builtin name or
 * constructed in code. A `ram` mount whose ref points elsewhere is an
 * alias registered over RAMResource, and rebuilds through that alias so
 * the subclass survives; Python's `_construct_resource` calls `cls()` on
 * the class its ladder found for the same reason.
 */
export function restoresAsFreshRAM(entry: MountSnapshot): boolean {
  const type = entry.resource_state.type
  if (type === 'disk') return true
  const ref = savedRef(entry)
  return type === 'ram' && (ref === null || ref === type)
}

/**
 * What a saved mount asks a registry to build: the name and config, or
 * null when the registry has nothing to say. The `resource_ref` the
 * registry built the mount from when one was recorded (a registered name,
 * or a code reference, which is how a mount declared as
 * `./wiki.mjs:WikiResource` comes back), else the resource's `type`, the
 * one locator a resource constructed in code leaves. The ref comes first
 * because `type` is the class's `kind` and a subclass inherits it: an
 * alias registered over a builtin reports the builtin's type and rebuilt
 * as the builtin while the type was consulted first. A recorded ref this
 * registry cannot resolve is not a reason to fall back to that guess: the
 * answer is null, and `buildMountArgs` then asks for the mount live.
 */
export function savedResourceBuild(
  entry: MountSnapshot,
  known: (name: string) => boolean,
): { name: string; config: Record<string, unknown> } | null {
  if (restoresAsFreshRAM(entry)) return null
  const type = entry.resource_state.type
  const ref = savedRef(entry)
  const name =
    ref !== null ? (known(ref) || ref.includes(':') ? ref : null) : known(type) ? type : null
  if (name === null) return null
  const config = (entry.resource_state as ResourceStateBase).config
  return {
    name,
    config:
      typeof config === 'object' && config !== null && !Array.isArray(config)
        ? (config as Record<string, unknown>)
        : {},
  }
}

/**
 * The overrides `buildMountArgs` restores with: the caller's, plus every
 * mount the builder can rebuild from its saved state. A mount that asks
 * to be handed back live (`resourceStateRequiresOverride`) is never
 * built here, so the refusal `buildMountArgs` raises for it stands.
 */
export async function withRebuiltResources(
  state: WorkspaceStateDict,
  overrides: Record<string, Resource>,
  build: SavedResourceBuilder,
): Promise<Record<string, Resource>> {
  const merged: Record<string, Resource> = { ...overrides }
  const held = new Set(Object.keys(overrides).map(normMountPrefix))
  for (const m of state.mounts) {
    if (held.has(normMountPrefix(m.prefix))) continue
    if (resourceStateRequiresOverride(m.resource_state)) continue
    const built = await build(m)
    if (built !== null) merged[m.prefix] = built
  }
  return merged
}

export async function applyStateDict(ws: Workspace, state: WorkspaceStateDict): Promise<void> {
  for (const m of state.mounts) {
    if (resourceStateRequiresOverride(m.resource_state)) continue
    // Exact-prefix lookup, mirroring Python: a snapshot prefix the new
    // workspace does not mount is skipped, never resolved to an
    // ancestor mount (which would load state into the wrong resource).
    const mount = ws.registry.tryMountForPrefix(m.prefix)
    if (mount === null) continue
    // No cast, for the same reason as toStateDict above.
    await Promise.resolve(mount.resource.loadState(m.resource_state as RAMResourceState))
  }
  await restoreSessions(ws, state)
  // The env template is constructor state the rebuilt workspace was
  // never given: without it a session created after the load starts
  // bare while restored ones carry every workspace env entry.
  if (state.env !== undefined && Object.keys(state.env).length > 0) {
    ws.sessionManager.restoreSeed(varsFromFields(state.env))
  }
  // current_agent_id is not restored separately: TS models a single
  // readonly agentId, set to default_agent_id at construction (== current).
  restoreCache(ws, state)
  await restoreHistory(ws, state)
  restoreJobs(ws, state)
  await restoreNodes(ws, state)
}

async function restoreNodes(ws: Workspace, state: WorkspaceStateDict): Promise<void> {
  const entries = new Map<string, NodeMeta>()
  for (const [path, e] of Object.entries(state.nodes ?? {})) {
    const meta: NodeMeta = {}
    if (e.target !== undefined) meta.target = e.target
    if (e.mtime !== undefined) meta.mtime = e.mtime
    if (e.mode !== undefined) meta.mode = e.mode
    if (e.uid !== undefined) meta.uid = e.uid
    if (e.gid !== undefined) meta.gid = e.gid
    if (e.atime !== undefined) meta.atime = e.atime
    entries.set(path, meta)
  }
  await ws.namespace.replaceNodes(entries)
}

async function restoreSessions(ws: Workspace, state: WorkspaceStateDict): Promise<void> {
  // The snapshot's default session identity wins over the live one,
  // and the discovery record's pointer follows it. A state without the
  // pointer (older commit metas) keeps the live default, mirroring the
  // Python None-guard.
  if (state.default_session_id != null) {
    await ws.adoptDefaultSession(state.default_session_id)
  }
  const restored: Session[] = []
  for (const s of state.sessions) {
    const exists = ws.sessionManager.list().some((x) => x.sessionId === s.session_id)
    const session = exists
      ? ws.sessionManager.get(s.session_id)
      : ws.sessionManager.create(s.session_id)
    const fields = Session.fromJSON(s)
    setCwd(session, fields.cwd)
    session.vars = fields.vars
    session.mountModes = fields.mountModes
    restored.push(session)
  }
  // The snapshot's session table wins over prior store contents,
  // mirroring Namespace.replaceNodes.
  await ws.sessionManager.replaceFromSnapshot(restored)
}

function restoreCache(ws: Workspace, state: WorkspaceStateDict): void {
  if (!(ws.cache instanceof RAMFileCacheStore)) return
  for (const e of state.cache.entries) {
    ws.cache.loadEntry(
      e.key,
      e.data,
      new CacheEntry({
        size: e.size,
        cachedAt: e.cached_at,
        fingerprint: e.fingerprint,
        ttl: e.ttl,
      }),
    )
  }
}

async function restoreHistory(ws: Workspace, state: WorkspaceStateDict): Promise<void> {
  // Always load (loadEvents clears first): a snapshot with empty history
  // still rewinds the recorder, same as the cache clear. Foreign-format
  // entries (e.g. a Python snapshot's different history shape) are skipped
  // inside loadEvents.
  await ws.observer.loadEvents((state.history as EventDict[] | undefined) ?? [])
}

/** Rebuild a finished job's console from its serialized output. */
function restoredConsole(j: JobSnapshot): JobConsole {
  const chunks: ConsoleChunk[] = []
  for (const [channel, data] of [
    [Channel.STDOUT, j.stdout],
    [Channel.STDERR, j.stderr],
  ] as const) {
    if (data.byteLength > 0) {
      chunks.push({ seq: chunks.length, ts: j.created_at, channel, data })
    }
  }
  const outcome =
    (j.status as JobStatus) === JobStatus.KILLED ? KILLED_OUTCOME : exitOutcome(j.exit_code)
  chunks.push({
    seq: chunks.length,
    ts: j.created_at,
    channel: Channel.CONTROL,
    data: new TextEncoder().encode(outcome),
  })
  return new JobConsole(new RAMConsoleStore(null, chunks), true)
}

function restoreJobs(ws: Workspace, state: WorkspaceStateDict): void {
  for (const j of state.jobs) {
    ws.jobTable.loadJob(
      new Job({
        id: j.id,
        command: j.command,
        cwd: j.cwd,
        agent: j.agent,
        sessionId: j.session_id,
        createdAt: j.created_at,
        status: j.status as JobStatus,
        exitCode: j.exit_code,
        console: restoredConsole(j),
      }),
    )
  }
}
