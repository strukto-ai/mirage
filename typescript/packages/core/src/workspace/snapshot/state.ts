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
import { HISTORY_PREFIX } from '../../resource/history/history.ts'
import { resourceStateRequiresOverride } from '../../resource/secrets.ts'
import { Job, JobStatus } from '../../shell/job_table.ts'
import { ConsistencyPolicy, MountMode } from '../../types.ts'
import { VERSION } from '../../version.ts'
import type { NodeMeta } from '../mount/namespace.ts'
import type { Workspace } from '../workspace.ts'
import type { MountArgs } from './config.ts'
import { captureFingerprints, liveOnlyMountPrefixes } from './drift.ts'
import type {
  CacheEntrySnapshot,
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
  const mounts = [...ws.registry.allMounts()].filter((m) => !skip.has(m.prefix))
  const mountSnapshots: MountSnapshot[] = []
  for (let i = 0; i < mounts.length; i++) {
    const m = mounts[i]
    if (m === undefined) continue
    const resource = m.resource as unknown as {
      kind: string
      getState: () => ResourceState | Promise<ResourceState>
    }
    const state = await Promise.resolve(resource.getState())
    mountSnapshots.push({
      index: i,
      prefix: m.prefix,
      mode: m.mode,
      consistency: ConsistencyPolicy.LAZY,
      resource_class: resource.kind,
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
  const sessions: SessionSnapshot[] = ws.sessionManager.list().map((s) => ({
    session_id: s.sessionId,
    cwd: s.cwd,
    env: s.env,
  }))
  const jobs: JobSnapshot[] = ws.jobTable
    .listJobs()
    .filter((j) => j.status !== JobStatus.RUNNING)
    .map((j) => ({
      id: j.id,
      command: j.command,
      cwd: j.cwd,
      status: j.status,
      stdout: j.stdout,
      stderr: j.stderr,
      exit_code: j.exitCode,
      created_at: j.createdAt,
      agent: j.agent,
      session_id: j.sessionId,
    }))
  const historyEvents = (await ws.observer.events()).filter(
    (e) => e.type === EVENT_COMMAND || e.type === EVENT_CLEAR || e.type === EVENT_DELETE,
  )
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
  }
}

export function buildMountArgs(
  state: WorkspaceStateDict,
  overrides: Record<string, Resource> = {},
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
  const missing = state.mounts
    .filter(
      (m) =>
        normalized[normMountPrefix(m.prefix)] === undefined &&
        resourceStateRequiresOverride(m.resource_state),
    )
    .map((m) => m.prefix)
  if (missing.length > 0) {
    throw new Error(
      `Workspace.load: resources= must include overrides for: ${missing.join(', ')}. ` +
        `These mounts were saved with redacted creds or transient connection state ` +
        `and need fresh resources.`,
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
  return {
    mountArgs,
    consistency: ConsistencyPolicy.LAZY,
    defaultSessionId: state.default_session_id,
    defaultAgentId: state.default_agent_id,
  }
}

export async function applyStateDict(ws: Workspace, state: WorkspaceStateDict): Promise<void> {
  for (const m of state.mounts) {
    if (resourceStateRequiresOverride(m.resource_state)) continue
    const mount = ws.registry.mountFor(m.prefix)
    if (mount === null) continue
    const resource = mount.resource as unknown as {
      loadState: (state: ResourceState) => void | Promise<void>
    }
    await Promise.resolve(resource.loadState(m.resource_state as RAMResourceState))
  }
  restoreSessions(ws, state)
  // current_agent_id is not restored separately: TS models a single
  // readonly agentId, set to default_agent_id at construction (== current).
  restoreCache(ws, state)
  await restoreHistory(ws, state)
  restoreJobs(ws, state)
  restoreNodes(ws, state)
}

function restoreNodes(ws: Workspace, state: WorkspaceStateDict): void {
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
  ws.namespace.replaceNodes(entries)
}

function restoreSessions(ws: Workspace, state: WorkspaceStateDict): void {
  for (const s of state.sessions) {
    const exists = ws.sessionManager.list().some((x) => x.sessionId === s.session_id)
    const session = exists
      ? ws.sessionManager.get(s.session_id)
      : ws.sessionManager.create(s.session_id)
    session.cwd = s.cwd
    session.env = s.env
  }
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
        stdout: j.stdout,
        stderr: j.stderr,
        exitCode: j.exit_code,
      }),
    )
  }
}
