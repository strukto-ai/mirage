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

import type { Operator } from 'opendal'
import { onTestFinished, vi } from 'vitest'
import type { HfAccessor } from '../../accessor/hf.ts'
import { FakeHub, serveHub } from '../hf_hub/_test_util.ts'

// Nothing listens here, so an accessor built without a FakeHub fails loudly
// instead of reaching huggingface.co.
export const DEAD_ENDPOINT = 'http://127.0.0.1:9'

export interface FakeHfOperator {
  /** Bucket-absolute key to content; the very Map a FakeHub serves. */
  files: Map<string, Buffer>
  /** The operator root key_prefix becomes, '' or '/pfx/'. */
  root: string
  /** Per-key listing mtime overrides; stat and listings report none else. */
  modified: Map<string, string>
  /** When set, read and reader append here and reject. */
  reach: string[] | null
  statCalls: number
  read: (key: string, options?: { offset?: bigint; size?: bigint }) => Promise<Buffer>
  reader: (key: string) => Promise<{ read: (buf: Buffer) => Promise<bigint> }>
  stat: (key: string) => Promise<FakeMetadata>
  list: (path: string, options?: { recursive?: boolean }) => Promise<FakeEntry[]>
  write: (key: string, data: Buffer | string) => Promise<FakeMetadata>
  delete: (key: string) => Promise<void>
  createDir: (key: string) => Promise<void>
}

interface FakeMetadata {
  isDirectory: () => boolean
  isFile: () => boolean
  contentLength: bigint | null
  etag: string | null
  lastModified: string | null
}

interface FakeEntry {
  path: () => string
  name: () => string
  metadata: () => FakeMetadata
}

function notFound(op: string, key: string): Error {
  return new Error(`NotFound (permanent) at ${op}, context: { service: hf, path: ${key} }`)
}

const DIR_METADATA: FakeMetadata = {
  isDirectory: () => true,
  isFile: () => false,
  contentLength: 0n,
  etag: null,
  lastModified: null,
}

/**
 * The opendal hf operator over a bucket, the way the binding behaves.
 *
 * Twin of python/tests/fixtures/hf_buckets_opendal.py. `files` is keyed
 * bucket-absolute and may be the Map a FakeHub serves; `root` is added to
 * keys going in and stripped from listed paths coming out. Metadata carries
 * no etag and no mtime, because live opendal reports neither for a bucket
 * (node 0.49.4, probed 2026-09-25).
 */
export function fakeHfOperator(initial: Record<string, string | Buffer> = {}): FakeHfOperator {
  const files = new Map<string, Buffer>()
  for (const [key, value] of Object.entries(initial)) {
    files.set(key, Buffer.isBuffer(value) ? value : Buffer.from(value))
  }
  const fake: FakeHfOperator = {
    files,
    root: '',
    modified: new Map(),
    reach: null,
    statCalls: 0,
    read: (key, options) => {
      refuse('read')
      const data = files.get(full(key))
      if (data === undefined) return Promise.reject(notFound('read', key))
      const offset = Number(options?.offset ?? 0n)
      const size = options?.size !== undefined ? Number(options.size) : data.byteLength - offset
      return Promise.resolve(data.subarray(offset, offset + size))
    },
    reader: (key) => {
      refuse('reader')
      const data = files.get(full(key))
      if (data === undefined) return Promise.reject(notFound('read', key))
      let pos = 0
      return Promise.resolve({
        read: (buf: Buffer) => {
          const n = Math.min(buf.byteLength, data.byteLength - pos)
          data.copy(buf, 0, pos, pos + n)
          pos += n
          return Promise.resolve(BigInt(n))
        },
      })
    },
    stat: (key) => {
      fake.statCalls += 1
      if (key.endsWith('/') || key === '') {
        const dirKey = key === '' ? '' : key.slice(0, -1)
        if (hasDir(dirKey)) return Promise.resolve(DIR_METADATA)
        return Promise.reject(notFound('stat', key))
      }
      const data = files.get(full(key))
      if (data !== undefined) return Promise.resolve(fileMetadata(full(key), data))
      if (hasDir(key)) return Promise.resolve(DIR_METADATA)
      return Promise.reject(notFound('stat', key))
    },
    list: (path, options) => {
      const pfx = path === '/' ? '' : path
      const absPfx = full(pfx)
      // The Hub answers a missing subpath with 200 and an empty array, and
      // the tree API lists children only -- nothing stands for the
      // directory itself. Probed against the fake hub through opendal
      // 0.47.1: list('never/') and list('a.txt/') both resolve to [] where
      // this fake used to reject, which would have made the readdir tests
      // pass without ever reaching the empty-listing branch.
      const recursive = options?.recursive === true
      const seen = new Map<string, FakeEntry>()
      for (const [absKey, data] of files.entries()) {
        if (!absKey.startsWith(absPfx)) continue
        const key = rel(absKey)
        const rest = key.slice(pfx.length)
        if (rest === '') continue
        const slash = rest.indexOf('/')
        if (recursive) {
          seen.set(key, {
            path: () => key,
            name: () => key.split('/').pop() ?? key,
            metadata: () => fileMetadata(absKey, data),
          })
          let dirRel = rest
          while (dirRel.includes('/')) {
            dirRel = dirRel.slice(0, dirRel.lastIndexOf('/'))
            const dirPath = `${pfx}${dirRel}/`
            const dirName = dirRel.split('/').pop() ?? dirRel
            seen.set(dirPath, {
              path: () => dirPath,
              name: () => dirName,
              metadata: () => DIR_METADATA,
            })
          }
        } else if (slash === -1) {
          seen.set(key, {
            path: () => key,
            name: () => rest,
            metadata: () => fileMetadata(absKey, data),
          })
        } else {
          const dirRel = rest.slice(0, slash)
          const dirPath = `${pfx}${dirRel}/`
          seen.set(dirPath, {
            path: () => dirPath,
            name: () => dirRel,
            metadata: () => DIR_METADATA,
          })
        }
      }
      return Promise.resolve([...seen.values()])
    },
    write: (key, data) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
      files.set(full(key), buf)
      return Promise.resolve(fileMetadata(full(key), buf))
    },
    delete: (key) => {
      files.delete(full(key))
      fake.modified.delete(full(key))
      return Promise.resolve()
    },
    createDir: (_key) => Promise.resolve(),
  }
  function stem(): string {
    return fake.root.replace(/^\/+|\/+$/g, '')
  }
  function full(key: string): string {
    const bare = key.replace(/^\/+/, '')
    return stem() === '' ? bare : `${stem()}/${bare}`
  }
  function rel(absKey: string): string {
    return stem() === '' ? absKey : absKey.slice(stem().length + 1)
  }
  function hasDir(dirKey: string): boolean {
    const pfx = dirKey === '' ? '' : dirKey.endsWith('/') ? dirKey : `${dirKey}/`
    if (pfx === '') return true
    const abs = full(pfx)
    return [...files.keys()].some((k) => k.startsWith(abs))
  }
  function refuse(name: string): void {
    if (fake.reach === null) return
    fake.reach.push(name)
    throw new Error(`stray opendal ${name}`)
  }
  function fileMetadata(absKey: string, data: Buffer): FakeMetadata {
    return {
      isDirectory: () => false,
      isFile: () => true,
      contentLength: BigInt(data.byteLength),
      etag: null,
      lastModified: fake.modified.get(absKey) ?? null,
    }
  }
  return fake
}

/**
 * Install `fake` as the accessor's operator and serve its Map over HTTP.
 *
 * The bucket core reads and stats over the Hub wire and lists and writes
 * through opendal, so one store sits behind both: a FakeHub serves the
 * fake's own Map under ('buckets', repo id), and the accessor's endpoint is
 * pointed at it. The fake takes the accessor's operator root. The hub is
 * closed when the calling test finishes.
 */
export async function installFakeOperator(
  accessor: HfAccessor,
  fake: FakeHfOperator,
): Promise<FakeHub> {
  fake.root = accessor.operatorOptions().root ?? ''
  vi.spyOn(accessor, 'operator').mockResolvedValue(fake as unknown as Operator)
  const hub = new FakeHub()
  hub.repos.set(`buckets|${accessor.repoId}`, fake.files)
  await serveHub(hub)
  ;(accessor.config as { endpoint?: string }).endpoint = hub.url
  onTestFinished(() => hub.close())
  return hub
}
