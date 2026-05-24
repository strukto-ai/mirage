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

import type { Workspace as CoreWorkspace } from '@struktoai/mirage-core'

export type WorkspaceStateDict = Awaited<ReturnType<CoreWorkspace['toStateDict']>>

type AnyDict = Record<string, unknown>

export const META_PATH = '.mirage-meta.json'
export const CACHE_PREFIX = '.mirage-cache/'

export interface VersionMeta {
  version: number
  mounts: AnyDict[]
  cache: { limit: number; entries: AnyDict[] }
  fingerprints: unknown[]
  liveOnlyMounts: string[]
}

export interface TreeInputs {
  entries: Record<string, Uint8Array>
  meta: VersionMeta
}

function stripSlashes(p: string): string {
  return p.replace(/^\/+/, '').replace(/\/+$/, '')
}

function treePath(prefix: string, rel: string): string {
  const p = stripSlashes(prefix)
  const r = rel.replace(/^\/+/, '')
  return p === '' ? r : `${p}/${r}`
}

function relPath(prefix: string, tp: string): string {
  const p = stripSlashes(prefix)
  const rest = p === '' ? tp : tp.slice(p.length + 1)
  return `/${rest}`
}

function belongs(treePrefix: string, tp: string): boolean {
  if (treePrefix === '') return true
  return tp === treePrefix || tp.startsWith(`${treePrefix}/`)
}

function isReserved(tp: string): boolean {
  return tp === META_PATH || tp.startsWith(CACHE_PREFIX)
}

export function metaToBlob(meta: VersionMeta): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(meta))
}

export function blobToMeta(data: Uint8Array): VersionMeta {
  return JSON.parse(new TextDecoder().decode(data)) as VersionMeta
}

export function treeInputsFromState(state: WorkspaceStateDict): TreeInputs {
  const entries: Record<string, Uint8Array> = {}
  const mountsMeta: AnyDict[] = []
  for (const mount of state.mounts as unknown as AnyDict[]) {
    const prefix = mount.prefix as string
    const resourceState = { ...(mount.resourceState as AnyDict) }
    const files = (resourceState.files as Record<string, Uint8Array> | undefined) ?? {}
    delete resourceState.files
    for (const [rel, data] of Object.entries(files)) entries[treePath(prefix, rel)] = data
    mountsMeta.push({
      index: mount.index,
      prefix,
      mode: mount.mode,
      resourceClass: mount.resourceClass,
      resourceState,
    })
  }

  const cache = state.cache as unknown as { limit: number; entries: AnyDict[] }
  const cacheMeta: AnyDict[] = []
  cache.entries.forEach((entry, i) => {
    const ref = `${CACHE_PREFIX}${String(i)}`
    entries[ref] = entry.data as Uint8Array
    cacheMeta.push({
      key: entry.key,
      fingerprint: entry.fingerprint ?? null,
      ttl: entry.ttl ?? null,
      cachedAt: entry.cachedAt ?? 0,
      size: entry.size ?? 0,
      ref,
    })
  })

  const meta: VersionMeta = {
    version: state.version,
    mounts: mountsMeta,
    cache: { limit: cache.limit, entries: cacheMeta },
    fingerprints: (state.fingerprints as unknown[] | undefined) ?? [],
    liveOnlyMounts: state.liveOnlyMounts ?? [],
  }
  return { entries, meta }
}

export function toState(
  entries: Record<string, Uint8Array>,
  meta: VersionMeta,
): WorkspaceStateDict {
  const mounts: AnyDict[] = []
  for (const mount of meta.mounts) {
    const prefix = mount.prefix as string
    const treePrefix = stripSlashes(prefix)
    const resourceState = { ...(mount.resourceState as AnyDict) }
    const files: Record<string, Uint8Array> = {}
    for (const [tp, data] of Object.entries(entries)) {
      if (isReserved(tp)) continue
      if (belongs(treePrefix, tp)) files[relPath(prefix, tp)] = data
    }
    resourceState.files = files
    mounts.push({
      index: mount.index,
      prefix,
      mode: mount.mode,
      resourceClass: mount.resourceClass,
      resourceState,
    })
  }

  const cacheEntries: AnyDict[] = meta.cache.entries.map((c) => ({
    key: c.key,
    data: entries[c.ref as string],
    fingerprint: c.fingerprint ?? null,
    ttl: c.ttl ?? null,
    cachedAt: c.cachedAt ?? 0,
    size: c.size ?? 0,
  }))

  return {
    version: meta.version,
    mounts,
    cache: { limit: meta.cache.limit, entries: cacheEntries },
    history: [],
    fingerprints: meta.fingerprints,
    liveOnlyMounts: meta.liveOnlyMounts,
  } as unknown as WorkspaceStateDict
}
