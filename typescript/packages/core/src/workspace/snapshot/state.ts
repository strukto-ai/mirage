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

import type { CacheEntry } from '../../cache/file/entry.ts'
import type { RAMFileCacheStore } from '../../cache/file/ram.ts'
import type { Resource } from '../../resource/base.ts'
import type { RAMResourceState } from '../../resource/ram/ram.ts'
import { resourceStateRequiresOverride } from '../../resource/secrets.ts'
import { ConsistencyPolicy, ResourceName, type MountMode } from '../../types.ts'
import type { MountArgs } from './config.ts'
import { CacheKey, MountKey, ResourceStateKey, StateKey } from './keys.ts'
import { FORMAT_VERSION, normMountPrefix } from './utils.ts'

type AnyDict = Record<string, unknown>

const MIRAGE_VERSION = 'unknown'

interface WorkspaceLike {
  readonly observer: { readonly prefix: string } | null
  readonly cache: RAMFileCacheStore
  readonly records: unknown
  listMounts(): { prefix: string; mode: MountMode; resource: Resource }[]
  snapshotSessions(): AnyDict[]
  snapshotDefaultSessionId(): string
  snapshotDefaultAgentId(): string
  snapshotCurrentAgentId(): string
  snapshotCacheMaxDrainBytes(): number | null
  snapshotHistory(): AnyDict[] | null
  snapshotJobs(): AnyDict[]
}

export function toStateDict(ws: WorkspaceLike): AnyDict {
  const autoPrefixes = new Set(['/dev/'])
  if (ws.observer !== null) autoPrefixes.add(normMountPrefix(ws.observer.prefix))

  const mountsState: AnyDict[] = []
  let idx = 0
  for (const m of ws.listMounts()) {
    if (autoPrefixes.has(m.prefix)) continue
    const resource = m.resource as { getState?: () => RAMResourceState; kind: string }
    const resState = resource.getState !== undefined ? resource.getState() : null
    mountsState.push({
      [MountKey.INDEX]: idx,
      [MountKey.PREFIX]: m.prefix,
      [MountKey.MODE]: m.mode,
      [MountKey.CONSISTENCY]: ConsistencyPolicy.LAZY,
      [MountKey.RESOURCE_CLASS]: resource.kind,
      [MountKey.RESOURCE_STATE]: resState,
    })
    idx += 1
  }

  const cache = ws.cache
  const cacheEntries: AnyDict[] = cache.snapshotEntries().map(({ key, entry }) => ({
    [CacheKey.KEY]: key,
    [CacheKey.DATA]: cache.store.files.get(key) ?? new Uint8Array(0),
    [CacheKey.FINGERPRINT]: entry.fingerprint,
    [CacheKey.TTL]: entry.ttl,
    [CacheKey.CACHED_AT]: entry.cachedAt,
    [CacheKey.SIZE]: entry.size,
  }))

  return {
    [StateKey.VERSION]: FORMAT_VERSION,
    [StateKey.MIRAGE_VERSION]: MIRAGE_VERSION,
    [StateKey.MOUNTS]: mountsState,
    [StateKey.SESSIONS]: ws.snapshotSessions(),
    [StateKey.DEFAULT_SESSION_ID]: ws.snapshotDefaultSessionId(),
    [StateKey.DEFAULT_AGENT_ID]: ws.snapshotDefaultAgentId(),
    [StateKey.CURRENT_AGENT_ID]: ws.snapshotCurrentAgentId(),
    [StateKey.CACHE]: {
      [CacheKey.LIMIT]: cache.cacheLimit,
      [CacheKey.MAX_DRAIN_BYTES]: ws.snapshotCacheMaxDrainBytes(),
      [CacheKey.ENTRIES]: cacheEntries,
    },
    [StateKey.HISTORY]: ws.snapshotHistory(),
    [StateKey.JOBS]: ws.snapshotJobs(),
  }
}

export function buildMountArgs(
  state: AnyDict,
  resources?: Record<string, Resource> | null,
  constructRam: () => Resource = () => {
    throw new Error('RAM constructor not provided')
  },
): MountArgs {
  const savedVersion = state[StateKey.VERSION] as number | undefined
  if (savedVersion !== undefined && savedVersion < FORMAT_VERSION) {
    throw new Error(
      `snapshot format v${String(savedVersion)} not supported (loader expects v${String(FORMAT_VERSION)})`,
    )
  }
  const overrides: Record<string, Resource> = {}
  for (const [k, v] of Object.entries(resources ?? {})) overrides[normMountPrefix(k)] = v

  const mounts = (state[StateKey.MOUNTS] as AnyDict[] | undefined) ?? []
  const missing: string[] = []
  for (const m of mounts) {
    const resState = (m[MountKey.RESOURCE_STATE] as AnyDict | undefined) ?? {}
    if (
      resourceStateRequiresOverride(resState) &&
      !(normMountPrefix(m[MountKey.PREFIX] as string) in overrides)
    ) {
      missing.push(m[MountKey.PREFIX] as string)
    }
  }
  if (missing.length > 0) {
    throw new Error(`Workspace.load: resources= must include overrides for: ${missing.join(', ')}`)
  }

  const mountArgs: Record<string, [Resource, MountMode]> = {}
  for (const m of mounts) {
    const prefix = normMountPrefix(m[MountKey.PREFIX] as string)
    const resource = prefix in overrides ? overrides[prefix] : constructResource(m, constructRam)
    if (resource === undefined) continue
    mountArgs[m[MountKey.PREFIX] as string] = [resource, m[MountKey.MODE] as MountMode]
  }

  return {
    mountArgs,
    consistency: ConsistencyPolicy.LAZY,
    defaultSessionId: (state[StateKey.DEFAULT_SESSION_ID] as string | undefined) ?? 'default',
    defaultAgentId: (state[StateKey.DEFAULT_AGENT_ID] as string | undefined) ?? 'default',
  }
}

function constructResource(mount: AnyDict, constructRam: () => Resource): Resource | undefined {
  const ps = (mount[MountKey.RESOURCE_STATE] as AnyDict | undefined) ?? {}
  const ptype = ps[ResourceStateKey.TYPE] as string
  if (ptype === ResourceName.RAM) return constructRam()
  return undefined
}

export interface ApplyStateCallbacks {
  loadMountState: (prefix: string, state: AnyDict) => void
  loadCacheEntry: (key: string, data: Uint8Array, entry: CacheEntry) => void
  restoreSession: (sessionData: AnyDict) => void
  restoreHistory: (records: AnyDict[]) => void
  restoreJob: (jobData: AnyDict) => void
  setCurrentAgentId: (id: string) => void
  setCacheMaxDrainBytes: (n: number | null) => void
}
