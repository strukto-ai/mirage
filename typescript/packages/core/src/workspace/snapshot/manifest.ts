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

import { ResourceName } from '../../types.ts'
import { CacheKey, JobKey, MountKey, ResourceStateKey, StateKey } from './keys.ts'
import { BLOB_REF_KEY, isSafeBlobPath } from './utils.ts'

class BlobAllocator {
  readonly blobs: Record<string, Uint8Array> = {}
  private readonly counters = new Map<string, number>()

  alloc(category: string): string {
    const i = this.counters.get(category) ?? 0
    this.counters.set(category, i + 1)
    return `${category}/${String(i)}.bin`
  }
}

type AnyDict = Record<string, unknown>

function isDict(v: unknown): v is AnyDict {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Uint8Array)
}

export function splitManifestAndBlobs(state: AnyDict): [AnyDict, Record<string, Uint8Array>] {
  const a = new BlobAllocator()
  const cache = (state[StateKey.CACHE] as AnyDict | undefined) ?? {}
  const cacheEntries = (cache[CacheKey.ENTRIES] as AnyDict[] | undefined) ?? []
  const jobs = (state[StateKey.JOBS] as AnyDict[] | undefined) ?? []
  const mounts = (state[StateKey.MOUNTS] as AnyDict[] | undefined) ?? []

  const manifest: AnyDict = {
    [StateKey.VERSION]: state[StateKey.VERSION],
    [StateKey.MIRAGE_VERSION]: state[StateKey.MIRAGE_VERSION],
    [StateKey.DEFAULT_SESSION_ID]: state[StateKey.DEFAULT_SESSION_ID],
    [StateKey.DEFAULT_AGENT_ID]: state[StateKey.DEFAULT_AGENT_ID],
    [StateKey.CURRENT_AGENT_ID]: state[StateKey.CURRENT_AGENT_ID],
    [StateKey.SESSIONS]: state[StateKey.SESSIONS] ?? [],
    [StateKey.HISTORY]: historyToManifest(state[StateKey.HISTORY], a),
    [StateKey.MOUNTS]: [],
    [StateKey.CACHE]: {
      [CacheKey.LIMIT]: cache[CacheKey.LIMIT],
      [CacheKey.MAX_DRAIN_BYTES]: cache[CacheKey.MAX_DRAIN_BYTES],
      [CacheKey.ENTRIES]: [],
    },
    [StateKey.JOBS]: [],
    [StateKey.FINGERPRINTS]: state[StateKey.FINGERPRINTS] ?? [],
    [StateKey.LIVE_ONLY_MOUNTS]: state[StateKey.LIVE_ONLY_MOUNTS] ?? [],
    [StateKey.SYMLINKS]: state[StateKey.SYMLINKS] ?? {},
  }

  for (const m of mounts) {
    ;(manifest[StateKey.MOUNTS] as AnyDict[]).push(mountToManifest(m, a))
  }

  for (const entry of cacheEntries) {
    const e = { ...entry }
    const data = e[CacheKey.DATA]
    if (data instanceof Uint8Array) {
      const tarPath = 'cache/blobs/' + a.alloc('_cache')
      a.blobs[tarPath] = data
      e[CacheKey.DATA] = { [BLOB_REF_KEY]: tarPath }
    }
    ;((manifest[StateKey.CACHE] as AnyDict)[CacheKey.ENTRIES] as AnyDict[]).push(e)
  }

  for (const job of jobs) {
    const j = { ...job }
    for (const f of [JobKey.STDOUT, JobKey.STDERR] as const) {
      const data = j[f]
      if (data instanceof Uint8Array && data.byteLength > 0) {
        const tarPath = 'jobs/blobs/' + a.alloc('_jobs')
        a.blobs[tarPath] = data
        j[f] = { [BLOB_REF_KEY]: tarPath }
      } else if (data instanceof Uint8Array) {
        j[f] = ''
      }
    }
    ;(manifest[StateKey.JOBS] as AnyDict[]).push(j)
  }

  return [manifest, a.blobs]
}

function mountToManifest(mount: AnyDict, a: BlobAllocator): AnyDict {
  const idx = mount[MountKey.INDEX] as number
  const ps = { ...(mount[MountKey.RESOURCE_STATE] as AnyDict) }
  const ptype = ps[ResourceStateKey.TYPE] as string
  const files = (ps[ResourceStateKey.FILES] as Record<string, Uint8Array> | undefined) ?? {}
  if (ptype === ResourceName.RAM) {
    ps[ResourceStateKey.FILES] = stashBlobs(
      files,
      a,
      `_ram${String(idx)}`,
      `mounts/${String(idx)}/files`,
    )
  } else if (ptype === ResourceName.DISK) {
    const newFiles: Record<string, AnyDict> = {}
    for (const [rel, data] of Object.entries(files)) {
      const tarPath = `mounts/${String(idx)}/files/${rel}`
      a.blobs[tarPath] = data
      newFiles[rel] = { [BLOB_REF_KEY]: tarPath }
    }
    ps[ResourceStateKey.FILES] = newFiles
  } else if (ptype === ResourceName.REDIS) {
    ps[ResourceStateKey.FILES] = stashBlobs(
      files,
      a,
      `_redis${String(idx)}`,
      `mounts/${String(idx)}/data`,
    )
  }
  const out: AnyDict = {}
  for (const [k, v] of Object.entries(mount)) {
    if (k !== MountKey.RESOURCE_STATE) out[k] = v
  }
  out[MountKey.RESOURCE_STATE] = ps
  return out
}

function stashBlobs(
  files: Record<string, Uint8Array>,
  a: BlobAllocator,
  category: string,
  tarDir: string,
): Record<string, AnyDict> {
  const out: Record<string, AnyDict> = {}
  for (const [k, data] of Object.entries(files)) {
    const slot = a.alloc(category).split('/').pop() ?? ''
    const tarPath = `${tarDir}/${slot}`
    a.blobs[tarPath] = data
    out[k] = { [BLOB_REF_KEY]: tarPath }
  }
  return out
}

function historyToManifest(records: unknown, a: BlobAllocator): unknown {
  if (records === null || records === undefined) return null
  if (!Array.isArray(records)) return records
  const out: AnyDict[] = []
  for (const r of records as AnyDict[]) {
    const rd: AnyDict = { ...r }
    for (const f of ['stdout', 'stdin', 'stderr'] as const) {
      const data = rd[f]
      if (data instanceof Uint8Array && data.byteLength > 0) {
        const tarPath = 'history/blobs/' + a.alloc('_history')
        a.blobs[tarPath] = data
        rd[f] = { [BLOB_REF_KEY]: tarPath }
      } else if (data instanceof Uint8Array) {
        rd[f] = ''
      }
    }
    if ('tree' in rd) rd.tree = nodeToManifest(rd.tree, a)
    out.push(rd)
  }
  return out
}

function nodeToManifest(node: unknown, a: BlobAllocator): unknown {
  if (!isDict(node)) return node
  const out: AnyDict = { ...node }
  const data = out.stderr
  if (data instanceof Uint8Array && data.byteLength > 0) {
    const tarPath = 'history/blobs/' + a.alloc('_history')
    a.blobs[tarPath] = data
    out.stderr = { [BLOB_REF_KEY]: tarPath }
  } else if (data instanceof Uint8Array) {
    out.stderr = ''
  }
  if (Array.isArray(out.children)) {
    out.children = (out.children as unknown[]).map((c) => nodeToManifest(c, a))
  }
  return out
}

export function resolveManifest(
  manifest: unknown,
  blobReader: (path: string) => Uint8Array,
): unknown {
  return resolveNode(manifest, blobReader)
}

function resolveNode(node: unknown, blobReader: (path: string) => Uint8Array): unknown {
  if (isDict(node)) {
    const keys = Object.keys(node)
    if (keys.length === 1 && keys[0] === BLOB_REF_KEY) {
      const path = node[BLOB_REF_KEY]
      if (!isSafeBlobPath(path)) throw new Error(`Unsafe blob path in manifest: ${String(path)}`)
      return blobReader(path)
    }
    const out: AnyDict = {}
    for (const [k, v] of Object.entries(node)) out[k] = resolveNode(v, blobReader)
    return out
  }
  if (Array.isArray(node)) return (node as unknown[]).map((v) => resolveNode(v, blobReader))
  return node
}
