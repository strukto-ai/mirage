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

// Test-only in-memory driver shared by the kit's colocated tests; the
// python twin is tests/core/object_store/conftest.py.

import { Accessor } from '../../accessor/base.ts'
import { PathSpec } from '../../types.ts'
import { stripSlash } from '../../utils/slash.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import type {
  ChildEntry,
  FindHints,
  ObjectStoreConnection,
  ObjectStoreDriver,
  ObjectMeta,
  TreeEntry,
} from './driver.ts'

export const MODIFIED = '2026-01-01T00:00:00Z'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

export class FakeAccessor extends Accessor {
  readonly keyPrefix: string

  constructor(keyPrefix = '') {
    super()
    this.keyPrefix = keyPrefix
  }
}

/** A map-of-bytes object store; keys ending "/" are dir markers. */
export class FakeStore {
  readonly objects = new Map<string, Uint8Array>()
  connects = 0
  readonly puts: [string, Uint8Array][] = []
  readonly deletes: string[] = []

  constructor(objects: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(objects)) {
      this.objects.set(key, ENC.encode(value))
    }
  }

  under(pfx: string): string[] {
    return [...this.objects.keys()].filter((k) => k.startsWith(pfx)).sort(compareCodePoints)
  }

  text(key: string): string | null {
    const data = this.objects.get(key)
    return data === undefined ? null : DEC.decode(data)
  }

  contents(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [key, value] of this.objects) out[key] = DEC.decode(value)
    return out
  }
}

export function spec(mountPath: string): PathSpec {
  const key = stripSlash(mountPath)
  return new PathSpec({
    virtual: key !== '' ? `/mnt${mountPath}` : '/mnt',
    directory: '/mnt/',
    vfsPath: key,
  })
}

function escapeRegExp(raw: string): string {
  return raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function makeDriver(
  store: FakeStore,
  findNarrowing = false,
): ObjectStoreDriver<FakeAccessor, FakeStore> {
  function keyPrefixOf(accessor: FakeAccessor): string {
    return accessor.keyPrefix
  }

  function connect(_accessor: FakeAccessor): Promise<ObjectStoreConnection<FakeStore>> {
    store.connects += 1
    return Promise.resolve({ conn: store, close: () => Promise.resolve() })
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async function* listChildren(conn: FakeStore, pfx: string): AsyncIterable<ChildEntry> {
    for (const key of conn.under(pfx)) {
      if (key === pfx) {
        yield { key, kind: 'marker' }
        continue
      }
      const relative = key.slice(pfx.length).replace(/\/+$/, '')
      const slash = relative.indexOf('/')
      if (slash === -1 && !key.endsWith('/')) {
        yield {
          key,
          kind: 'f',
          size: conn.objects.get(key)?.byteLength ?? 0,
          modified: MODIFIED,
        }
      } else {
        yield { key: pfx + (slash !== -1 ? relative.slice(0, slash) : relative), kind: 'd' }
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async function* listTree(conn: FakeStore, pfx: string): AsyncIterable<TreeEntry> {
    for (const key of conn.under(pfx)) {
      yield { key, size: conn.objects.get(key)?.byteLength ?? 0 }
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async function* listSubtree(conn: FakeStore, stem: string): AsyncIterable<TreeEntry> {
    for (const key of conn.under('')) {
      if (stem === '' || key === stem || key.startsWith(`${stem}/`)) {
        yield { key, size: conn.objects.get(key)?.byteLength ?? 0 }
      }
    }
  }

  function head(conn: FakeStore, key: string): Promise<ObjectMeta | null> {
    const data = conn.objects.get(key)
    if (data === undefined) return Promise.resolve(null)
    return Promise.resolve({
      size: data.byteLength,
      modified: MODIFIED,
      fingerprint: `fp-${key}`,
      revision: `rev-${key}`,
      extra: { etag: `fp-${key}` },
    })
  }

  function get(conn: FakeStore, key: string): Promise<Uint8Array | null> {
    return Promise.resolve(conn.objects.get(key) ?? null)
  }

  function put(conn: FakeStore, key: string, data: Uint8Array): Promise<void> {
    conn.objects.set(key, data)
    conn.puts.push([key, data])
    return Promise.resolve()
  }

  function deleteFile(conn: FakeStore, key: string): Promise<void> {
    conn.objects.delete(key)
    conn.deletes.push(key)
    return Promise.resolve()
  }

  function deletePrefix(conn: FakeStore, pfx: string): Promise<void> {
    for (const key of conn.under(pfx)) {
      conn.objects.delete(key)
      conn.deletes.push(key)
    }
    return Promise.resolve()
  }

  function moveFile(conn: FakeStore, srcKey: string, dstKey: string): Promise<boolean> {
    const data = conn.objects.get(srcKey)
    if (data === undefined) return Promise.resolve(false)
    conn.objects.delete(srcKey)
    conn.objects.set(dstKey, data)
    return Promise.resolve(true)
  }

  function movePrefix(conn: FakeStore, srcPfx: string, dstPfx: string): Promise<boolean> {
    const keys = conn.under(srcPfx)
    if (keys.length === 0) return Promise.resolve(false)
    for (const key of keys) {
      const data = conn.objects.get(key)
      if (data === undefined) continue
      conn.objects.delete(key)
      conn.objects.set(dstPfx + key.slice(srcPfx.length), data)
    }
    return Promise.resolve(true)
  }

  function copyFile(conn: FakeStore, srcKey: string, dstKey: string): Promise<boolean> {
    const data = conn.objects.get(srcKey)
    if (data === undefined) return Promise.resolve(false)
    conn.objects.set(dstKey, data)
    return Promise.resolve(true)
  }

  function probePrefix(conn: FakeStore, pfx: string): Promise<boolean> {
    return Promise.resolve(conn.under(pfx).length > 0)
  }

  function isNotFound(_err: unknown): boolean {
    // The fake never throws store errors, so nothing classifies as absent.
    return false
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async function* narrowed(conn: FakeStore, pfx: string, rx: RegExp): AsyncIterable<TreeEntry> {
    for (const key of conn.under(pfx)) {
      if (rx.test(key)) yield { key, size: conn.objects.get(key)?.byteLength ?? 0 }
    }
  }

  function findTree(
    conn: FakeStore,
    pfx: string,
    hints: FindHints,
  ): [AsyncIterable<TreeEntry>, boolean] {
    if (!(hints.pushdown && hints.name !== null)) return [listTree(conn, pfx), false]
    const rx = new RegExp(`^${escapeRegExp(pfx)}(.*/)?${hints.name.replaceAll('*', '[^/]*')}$`)
    return [narrowed(conn, pfx, rx), true]
  }

  return {
    vfs: 'fake',
    scopeError: 5000,
    keyPrefixOf,
    connect,
    listChildren,
    listTree,
    listSubtree,
    head,
    get,
    put,
    deleteFile,
    deletePrefix,
    moveFile,
    movePrefix,
    copyFile,
    probePrefix,
    isNotFound,
    ...(findNarrowing ? { findTree } : {}),
  }
}

export class FakeManager {
  readonly writes: string[] = []
  readonly unlinks: string[] = []
  readonly subtrees: string[] = []

  invalidateAfterWrite(path: string | PathSpec): Promise<void> {
    this.writes.push(typeof path === 'string' ? path : path.mountPath)
    return Promise.resolve()
  }

  invalidateAfterUnlink(path: string | PathSpec): Promise<void> {
    this.unlinks.push(typeof path === 'string' ? path : path.mountPath)
    return Promise.resolve()
  }

  invalidateSubtree(path: string | PathSpec): Promise<void> {
    this.subtrees.push(typeof path === 'string' ? path : path.mountPath)
    return Promise.resolve()
  }

  cachedBytes(_path: PathSpec): Promise<Uint8Array | null> {
    return Promise.resolve(null)
  }

  cachedSize(_path: PathSpec): Promise<number | null> {
    return Promise.resolve(null)
  }
}

export async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (err) {
    return (err as { code?: string }).code ?? 'no-code'
  }
  return 'no-throw'
}
