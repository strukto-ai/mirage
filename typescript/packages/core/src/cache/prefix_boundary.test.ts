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

import { describe, expect, it } from 'vitest'
import { FileChangeKind, PathSpec } from '../types.ts'
import { mountKey, mountPrefixOf, stripMount, underPath } from '../utils/key_prefix.ts'
import { eventAt, virtualOf } from '../watch/events.ts'
import { RAMFileCacheStore } from './file/ram.ts'
import { IndexEntry } from './index/config.ts'
import { RAMIndexCacheStore } from './index/ram.ts'
import { CacheManager } from './manager.ts'

// Mount/child pairs where the child's name begins with the mount prefix's own
// characters. Naive `startsWith` arithmetic reads the child as already
// mount-absolute and skips the prefix, so every derived key lands one level
// too high -- and a cache eviction that hits no key is silent, which is why
// this class of bug survives until a test happens to name a directory badly.
const CASES: [string, string][] = [
  ['/d', 'day'],
  ['/d', 'd'],
  ['/data', 'database'],
  ['/a', 'ab'],
  ['/ab', 'abc'],
  ['/x', 'xyz/deep'],
]

function spec(mount: string, child: string): PathSpec {
  const virtual = `${mount}/${child}`
  return new PathSpec({ virtual, directory: virtual, vfsPath: child })
}

function stores(): [RAMFileCacheStore, RAMIndexCacheStore] {
  return [new RAMFileCacheStore(), new RAMIndexCacheStore({ ttl: 600 })]
}

function entry(): IndexEntry {
  return new IndexEntry({ id: '1', name: 'f', resourceType: 'file' })
}

describe.each(CASES)('mount %s holding %s', (mount, child) => {
  it('round-trips the mount prefix', () => {
    const virtual = `${mount}/${child}`
    expect(mountPrefixOf(virtual, child)).toBe(mount)
    expect(mountKey(virtual, mount)).toBe(child)
    expect(stripMount(virtual, mount)).toBe(`/${child}`)
  })

  it('counts the child as under its mount', () => {
    expect(underPath(`${mount}/${child}`, mount)).toBe(true)
  })

  it('lifts event helpers onto the mount', () => {
    const root = new PathSpec({ virtual: mount, directory: mount, vfsPath: '' })
    expect(virtualOf(root, child)).toBe(`${mount}/${child}`)
    const event = eventAt(root, child, FileChangeKind.CREATE)
    expect(event.path.virtual).toBe(`${mount}/${child}`)
    expect(event.path.vfsPath).toBe(child)
  })

  it('drops the real key on an unlink', async () => {
    const [cache, index] = stores()
    await index.setDir(`${mount}/${child}`, [['leaf.txt', entry()]])
    const manager = new CacheManager(cache, index, `${mount}/`, true)
    await manager.invalidateAfterUnlink(spec(mount, child))
    expect((await index.listDir(`${mount}/${child}`)).entries).toBeUndefined()
  })

  it('drops the parent listing at the real key on a write', async () => {
    const [cache, index] = stores()
    await index.setDir(`${mount}/${child}`, [['leaf.txt', entry()]])
    const manager = new CacheManager(cache, index, `${mount}/`, true)
    const virtual = `${mount}/${child}/leaf.txt`
    await manager.invalidateAfterWrite(
      new PathSpec({
        virtual,
        directory: `${mount}/${child}`,
        vfsPath: `${child}/leaf.txt`,
      }),
    )
    expect((await index.listDir(`${mount}/${child}`)).entries).toBeUndefined()
  })

  it('reaches nested listings on a subtree eviction', async () => {
    const [cache, index] = stores()
    await index.setDir(`${mount}/${child}/nested`, [['leaf.txt', entry()]])
    const manager = new CacheManager(cache, index, `${mount}/`, true)
    await manager.invalidateSubtree(spec(mount, child))
    expect((await index.listDir(`${mount}/${child}/nested`)).entries).toBeUndefined()
  })
})

describe('lookalike siblings', () => {
  it.each(CASES.filter(([mount, child]) => `/${child}` !== mount))(
    'a sibling spelled like %s/%s is not under the mount',
    (mount, child) => {
      expect(underPath(`/${child}`, mount)).toBe(false)
    },
  )
})
