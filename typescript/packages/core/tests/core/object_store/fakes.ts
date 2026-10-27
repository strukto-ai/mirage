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

import { Accessor } from '../../../src/accessor/base.ts'
import { unnamedFsError } from '../../../src/errors/fs.ts'
import { PathSpec } from '../../../src/types.ts'
import { rstripSlash, stripSlash } from '../../../src/utils/slash.ts'
import { compareCodePoints } from '../../../src/utils/sort.ts'
import type {
  ChildEntry,
  ObjectStoreConnection,
  ObjectStoreDriver,
  ObjectMeta,
  TreeEntry,
} from '../../../src/core/object_store/driver.ts'

export const MODIFIED = '2026-01-01T00:00:00Z'

// The token fields the fake store reports for one key, shared by `head`
// and `put` so the two cannot answer different tokens for the same
// object. `head` adds `modified` on top; a put response carries no
// mtime, so `put` returns this as it stands.
function fakeMeta(key: string, data: Uint8Array): ObjectMeta {
  return {
    size: data.byteLength,
    fingerprint: `fp-${key}`,
    revision: `rev-${key}`,
    extra: { etag: `fp-${key}` },
  }
}

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
  // Keys and prefixes the store refuses (403), as a scoped grant does.
  readonly refused = new Set<string>()

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

function keyPrefixOf(accessor: FakeAccessor): string {
  return accessor.keyPrefix
}

// eslint-disable-next-line @typescript-eslint/require-await
async function* listChildren(conn: FakeStore, pfx: string): AsyncIterable<ChildEntry> {
  for (const key of conn.under(pfx)) {
    if (key === pfx) {
      yield { key, kind: 'marker' }
      continue
    }
    const relative = rstripSlash(key.slice(pfx.length))
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
async function* listSubtree(conn: FakeStore, stem: string): AsyncIterable<TreeEntry> {
  for (const key of conn.under('')) {
    if (stem === '' || key === stem || key.startsWith(`${stem}/`)) {
      yield { key, size: conn.objects.get(key)?.byteLength ?? 0 }
    }
  }
}

function head(conn: FakeStore, key: string): Promise<ObjectMeta | null> {
  if (conn.refused.has(key)) return Promise.reject(unnamedFsError('EACCES', `refused '${key}'`))
  const data = conn.objects.get(key)
  if (data === undefined) return Promise.resolve(null)
  return Promise.resolve({ ...fakeMeta(key, data), modified: MODIFIED })
}

function get(conn: FakeStore, key: string): Promise<Uint8Array | null> {
  return Promise.resolve(conn.objects.get(key) ?? null)
}

function put(conn: FakeStore, key: string, data: Uint8Array): Promise<ObjectMeta | null> {
  conn.objects.set(key, data)
  conn.puts.push([key, data])
  return Promise.resolve(fakeMeta(key, data))
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
  if (conn.refused.has(pfx)) return Promise.reject(unnamedFsError('EACCES', `refused '${pfx}'`))
  return Promise.resolve(conn.under(pfx).length > 0)
}

function isNotFound(_err: unknown): boolean {
  // The fake never throws store errors, so nothing classifies as absent.
  return false
}

export function makeDriver(store: FakeStore): ObjectStoreDriver<FakeAccessor, FakeStore> {
  function connect(_accessor: FakeAccessor): Promise<ObjectStoreConnection<FakeStore>> {
    store.connects += 1
    return Promise.resolve({ conn: store, close: () => Promise.resolve() })
  }

  return {
    vfs: 'fake',
    scopeError: 5000,
    keyPrefixOf,
    connect,
    listChildren,
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
