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

import { MountRootPolicy } from '../../policy/builtin/mount_root.ts'
import { OutputCapPolicy } from '../../policy/builtin/output_cap.ts'
import { PermissionsPolicy } from '../../policy/builtin/permissions.ts'
import { type CompiledProfile, profileFromJSON, profileToJSON } from '../../policy/profile.ts'
import { ScriptPolicy } from '../../policy/script.ts'
import { DEFAULT_PROFILE } from '../session/constants.ts'
import {
  compileProfile,
  narrow,
  narrowingOf,
  narrowProfile,
  narrowRestored,
} from '../session/resolve.ts'
import { setCwd } from '../session/shell_dirs.ts'
import { gateRestoredVars } from '../session/state.ts'
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
import type { ShellVar } from '../../shell/variable.ts'
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
import { Session, type StoredSession, varsFromFields, varsToFields } from '../session/session.ts'
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
  WorkspaceStateDict,
} from './types.ts'
import { FORMAT_VERSION, normMountPrefix } from './utils.ts'

const VALID_MODES: readonly string[] = [MountMode.READ, MountMode.WRITE, MountMode.EXEC]
const VALID_CONSISTENCY: readonly string[] = [ConsistencyPolicy.LAZY, ConsistencyPolicy.ALWAYS]

// The policies every workspace registers itself (the registry seeds the
// first two, the workspace the other two), so they are not the
// deployment's to name and a snapshot records only the classes beyond
// them. A policy written as an object literal has no class name either
// (`Object`) and is not recorded.
const SEEDED_POLICIES: ReadonlySet<string> = new Set([
  MountRootPolicy.name,
  OutputCapPolicy.name,
  PermissionsPolicy.name,
  ScriptPolicy.name,
  'Object',
])

export async function toStateDict(ws: Workspace): Promise<WorkspaceStateDict> {
  const skip = new Set(['/dev/', normMountPrefix(HISTORY_PREFIX)])
  const mounted = [...ws.registry.allMounts()]
  for (const mount of mounted) await mount.ensureReady()
  const mounts = mounted.filter((m) => !skip.has(m.prefix))
  // The consistency knob is the workspace's, not a mount's: every entry
  // records the one value the workspace runs under.
  const consistency = ws.registry.getConsistency()
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
      consistency,
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
  const sessions: StoredSession[] = ws.sessionManager.list().map((s) => s.toJSON() as StoredSession)
  // Output is stored per channel rather than chunk by chunk: the manifest
  // externalizes byte fields into tar entries, so keeping chunks would
  // write one entry per write a job ever made. The cost is that a restored
  // job's stdout and stderr no longer interleave, which only affects jobs
  // that have already ended.
  const jobs: JobSnapshot[] = await Promise.all(
    ws.jobTable
      .allJobs()
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
    // The document the sessions were narrowed under, so a loader without
    // the deployment's config file lands each table under the profile of
    // the same name. Coded policies are named, not carried: they are the
    // loader's to register, and fromState warns about a name it does not
    // find.
    profiles: Object.fromEntries(
      Object.entries(ws.profiles).map(([name, profile]) => [name, profileToJSON(profile)]),
    ),
    profile: ws.defaultProfileName,
    policies: ws.policies.names().filter((name) => !SEEDED_POLICIES.has(name)),
    consistency,
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

  // The document keys are read with a default each, so a state written
  // before they existed restores as it always did.
  const profiles = Object.fromEntries(
    Object.entries(state.profiles ?? {}).map(([name, doc]) => [name, profileFromJSON(doc)]),
  )
  const saved = state.consistency
  if (saved !== undefined && !VALID_CONSISTENCY.includes(saved)) {
    throw new Error(`Workspace.fromState: invalid consistency '${saved}'`)
  }
  return {
    mountArgs,
    consistency: saved === undefined ? ConsistencyPolicy.LAZY : (saved as ConsistencyPolicy),
    defaultSessionId: state.default_session_id,
    defaultAgentId: state.default_agent_id,
    ...(cliEntries.length > 0 ? { clis: cliArgs } : {}),
    ...(Object.keys(profiles).length > 0 ? { profiles } : {}),
    profile: state.profile ?? null,
    policies: state.policies ?? [],
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

/**
 * Restore post-construction state into an already-built Workspace.
 *
 * Every session table and the env template clear the target's
 * `preSession` gate first (`gateRestoredState`), before any mount,
 * session or template lands, so a refusal aborts the load with the
 * workspace as it was; the same phase refuses a table whose profile the
 * target does not define. Each table then lands under the target's
 * profile of that name and never wider than it or than the live
 * session (`narrowRestored`). A snapshot mount with no mount at that
 * exact prefix here is not restored and is reported. `replaceCache` drops
 * the live cache once the gate has passed, ahead of the mounts'
 * loadState, so the snapshot's entries are all that is left: a
 * checkout onto a running workspace asks for it, a workspace built for
 * the state has nothing to drop. It sits behind the gate because the
 * callers used to clear before calling, and a refused checkout then
 * still sent every cached read back to an origin that may have moved.
 * Mirrors Python `apply_state_dict`.
 */
export async function applyStateDict(
  ws: Workspace,
  state: WorkspaceStateDict,
  options: { replaceCache?: boolean } = {},
): Promise<void> {
  const [sessions, seed] = await gateRestoredState(ws, state)
  if (options.replaceCache === true) await ws.cache.clear()
  for (const m of state.mounts) {
    // Exact-prefix lookup, mirroring Python: a snapshot prefix the new
    // workspace does not mount is skipped, never resolved to an
    // ancestor mount (which would load state into the wrong resource).
    // It runs before the override skip below so a mount that asks to be
    // handed back live is reported too: those are the remote and
    // config-backed mounts, exactly the ones a renamed prefix matters for.
    const mount = ws.registry.tryMountForPrefix(m.prefix)
    if (mount === null) {
      // Said out loud: a renamed or missing mount otherwise left no trace.
      console.warn(
        `Workspace.load: snapshot mount ${m.prefix} has no mount at that prefix in this ` +
          `workspace; its state was not restored`,
      )
      continue
    }
    // loadState runs for every mount, an overridden one included, so
    // disk content is written into the new root and redis content into
    // the new URL; a cred-only resource (the S3 family) implements it
    // as a no-op, which is why skipping the overridden ones here read
    // as harmless and was not. A redacted config is exactly what a
    // content resource behind a credential has, so the skip dropped
    // every byte a redis or disk mount carried while python restored
    // them. Mirrors the python loop, which has never skipped.
    // No cast, for the same reason as toStateDict above.
    await Promise.resolve(mount.resource.loadState(m.resource_state as RAMResourceState))
  }
  await restoreSessions(ws, state, sessions)
  // The env template is constructor state the rebuilt workspace was
  // never given: without it a session created after the load starts
  // bare while restored ones carry every workspace env entry.
  if (seed !== null) ws.sessionManager.restoreSeed(seed)
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

/**
 * The profile the target gives a restored session's table.
 *
 * The target's default for a table naming none, and for one naming
 * `default` on a target with no profile of that name (a source with an
 * implicit default stamps that name, and an ordinary snapshot must not
 * be refused over it); the manager's own compiled object in both cases,
 * so a table taken from the same document leaves the session on the
 * very objects the default session shares. Any other name is compiled
 * as `createSession` would compile it, and an unknown one is refused
 * with the same PolicyError, before anything lands. `checkCliVerbs` is
 * not run: a recorded rule naming a verb the target's CLIs lack
 * restricts nothing and is no reason to refuse a load. Mirrors the
 * Python `_target_profile`.
 */
function targetProfile(ws: Workspace, name: string | null): CompiledProfile {
  const effective =
    ws.defaultProfileName ?? (DEFAULT_PROFILE in ws.profiles ? DEFAULT_PROFILE : null)
  if (
    name === null ||
    name === effective ||
    (name === DEFAULT_PROFILE && !(DEFAULT_PROFILE in ws.profiles))
  ) {
    return ws.sessionManager.defaultProfile ?? compileProfile(null)
  }
  return ws.compiledProfile(name)
}

/**
 * Vet every session table and the env template before any of it lands.
 *
 * Three steps, and nothing durable lands in any of them. Each table's
 * profile name is resolved against the target's document
 * (`targetProfile`), so a name the target does not define refuses the
 * load before a mount, a session or the template has moved, the same
 * loud rule a redacted mount gets.
 *
 * Every table's session is then put under that profile, since the
 * profile is what the target's document says a session of that name
 * runs under and the table itself cannot carry a policy program. A
 * table whose id the target lacks gets its session created and narrowed
 * (`narrow`) — which also matters for the gate, because
 * `ScriptPolicy.preSession` reads `scriptOf(sessionId)` off the manager
 * and answers the default profile for an id it does not know. A session
 * already here is joined instead of stamped over (`narrowProfile`): it
 * keeps every restriction of its own, so a checkout still cannot widen
 * a live session, and it keeps a program the host installed with
 * `setSessionProfile`. The snapshot's default id names the live default
 * session here, since `adoptDefault` re-keys that session onto it later
 * and creating one under that id would have it deleted instead.
 *
 * Then every table and the template fire the `preSession` gate
 * (`gateRestoredVars`): a refusal that arrived once an earlier session
 * had already been overwritten left the workspace in a state no
 * snapshot describes, and one its close then persisted. A refusal
 * anywhere discards the sessions created here and puts the joined ones
 * back as they were (`narrowingOf`), so the store never sees a
 * half-made table.
 *
 * Every gate call names the id the table *lands* on, not the one the
 * snapshot recorded. A hook reads its program off the manager by
 * session id (`ScriptPolicy.preSession` -> `scriptOf`), and the manager
 * cannot answer for the snapshot's default id until `adoptDefault`
 * re-keys the live default onto it, so a checkout whose recorded
 * default id differs from the live one vetted that table under the
 * target's default program rather than the one the join had just
 * installed. The env template is gated the same way, since it lands in
 * that same session. Returns the parsed session tables and the
 * template, null when the snapshot carries none. Mirrors the Python
 * `_gate_restored_state`.
 */
async function gateRestoredState(
  ws: Workspace,
  state: WorkspaceStateDict,
): Promise<[Session[], Record<string, ShellVar> | null]> {
  const tables = state.sessions.map((s) => Session.fromJSON(s))
  const defaultSid = state.default_session_id ?? null
  const compiled = tables.map((fields): [Session, CompiledProfile] => [
    fields,
    targetProfile(ws, fields.profile),
  ])
  const live = new Set(ws.sessionManager.list().map((s) => s.sessionId))
  const created: string[] = []
  const joined = new Map<string, [Session, CompiledProfile]>()
  // Where each table lands, which is the id the gate has to name: a
  // policy hook reads its program off the manager by session id
  // (`scriptOf`), and the manager does not know the snapshot's default
  // id until `adoptDefault` re-keys the live default onto it, so gating
  // a remapped default table under the recorded id fell back to the
  // target's default program instead of the one the join just installed.
  const landings: [string, Record<string, ShellVar>][] = []
  let seed: Record<string, ShellVar> | null = null
  let vetted = false
  try {
    for (const [fields, profile] of compiled) {
      const sid = fields.sessionId
      if (sid !== defaultSid && !live.has(sid)) {
        created.push(sid)
        narrow(ws.sessionManager.create(sid), profile)
        landings.push([sid, fields.vars])
        continue
      }
      // A session already here keeps everything it restricts, so the
      // profile joins onto it instead of stamping over it
      // (`narrowProfile`); the snapshot's default id is the live
      // default session until `adoptDefault` re-keys it. The join runs
      // before the gate so a policy program the profile carries is in
      // force while the table is vetted, and is rolled back with the
      // created sessions below.
      const landing = live.has(sid) ? sid : ws.sessionManager.defaultId
      const session = ws.sessionManager.get(landing)
      if (!joined.has(landing)) joined.set(landing, [session, narrowingOf(session)])
      narrowProfile(session, profile)
      landings.push([landing, fields.vars])
    }
    for (const [landing, tableVars] of landings) {
      await gateRestoredVars(ws.registry.policies, landing, tableVars)
    }
    if (state.env !== undefined && Object.keys(state.env).length > 0) {
      seed = varsFromFields(state.env)
      // The template lands in the default session, whose id here is the
      // live one for the same reason.
      await gateRestoredVars(
        ws.registry.policies,
        defaultSid !== null && live.has(defaultSid) ? defaultSid : ws.defaultSessionId,
        seed,
      )
    }
    vetted = true
  } finally {
    if (!vetted) {
      for (const sid of created) ws.sessionManager.discard(sid)
      for (const [session, before] of joined.values()) narrow(session, before)
    }
  }
  return [tables, seed]
}

/**
 * Land the vetted tables: each on the session that carries its id,
 * never wider than that session already is.
 *
 * Every table's session exists by now: the gate created the missing
 * ones under the target's profile of the table's name, a checkout on a
 * running workspace finds the live one, and the snapshot's default id
 * is re-keyed onto the live default here. `narrowRestored` then joins
 * the table's narrowing with the session's (restrictions union, grants
 * intersect, the program stays the target's), and the scratch state the
 * table carries (cwd, variables, the host's standing answers) is the
 * snapshot's, matching the `replaceFromSnapshot` contract below.
 * Mirrors the Python `_restore_sessions`.
 */
async function restoreSessions(
  ws: Workspace,
  state: WorkspaceStateDict,
  tables: readonly Session[],
): Promise<void> {
  // The snapshot's default session identity wins over the live one,
  // and the discovery record's pointer follows it. A state without the
  // pointer (older commit metas) keeps the live default, mirroring the
  // Python None-guard.
  if (state.default_session_id != null) {
    await ws.adoptDefaultSession(state.default_session_id)
  }
  const restored: Session[] = []
  for (const fields of tables) {
    const session = ws.sessionManager.get(fields.sessionId)
    narrowRestored(session, fields)
    setCwd(session, fields.cwd)
    session.vars = fields.vars
    session.decisions = fields.decisions
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
