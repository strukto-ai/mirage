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

// Mirror of python/tests/core/ram/test_rm.py.

import { describe, expect, it } from 'vitest'
import { RAMAccessor } from '../../accessor/ram.ts'
import { runWithCacheManager } from '../../cache/context.ts'
import { RAMFileCacheStore } from '../../cache/file/ram.ts'
import { IndexEntry } from '../../cache/index/config.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { CacheManager } from '../../cache/manager.ts'
import { RAMStore } from '../../vfs/ram/store.ts'
import { PathSpec } from '../../types.ts'
import { rmR } from './rm.ts'

const ENC = new TextEncoder()

async function seeded(): Promise<[RAMAccessor, RAMFileCacheStore, RAMIndexCacheStore]> {
  const store = new RAMStore()
  store.dirs.add('/a')
  store.dirs.add('/a/b')
  store.files.set('/a/b/f.txt', ENC.encode('hi\n'))
  const cache = new RAMFileCacheStore()
  const index = new RAMIndexCacheStore({ ttl: 600 })
  await cache.set('/data/a/b/f.txt', ENC.encode('hi\n'))
  const entry = new IndexEntry({ id: '1', name: 'f.txt', resourceType: 'file' })
  await index.setDir('/data/a', [['b', entry]])
  await index.setDir('/data/a/b', [['f.txt', entry]])
  return [new RAMAccessor(store), cache, index]
}

describe('ram rmR cache invalidation', () => {
  it('evicts listings and bodies inside the removed subtree', async () => {
    // A recursive remove takes directories the caller never named, and
    // their listings were cached independently: evicting only the target
    // and its parent leaves `/data/a/b` answering for a directory the
    // backend no longer has.
    const [accessor, cache, index] = await seeded()
    const manager = new CacheManager(cache, index, '/data/', true)
    await runWithCacheManager(manager, () => rmR(accessor, PathSpec.fromStrPath('/a')))
    expect((await index.listDir('/data/a/b')).entries).toBeUndefined()
    expect(await cache.exists('/data/a/b/f.txt')).toBe(false)
    expect((await index.listDir('/data/a')).entries).toBeUndefined()
  })
})
