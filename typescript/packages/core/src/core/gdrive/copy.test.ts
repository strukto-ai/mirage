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

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as DriveModule from '../google/drive.ts'

vi.mock('../google/drive.ts', async () => {
  const actual = await vi.importActual<typeof DriveModule>('../google/drive.ts')
  const { driveModuleMock } = await import('./_test_util.ts')
  return driveModuleMock(actual)
})

import { runWithCacheManager } from '../../cache/context.ts'
import { RAMFileCacheStore } from '../../cache/file/ram.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { CacheManager } from '../../cache/manager.ts'
import { PathSpec } from '../../types.ts'
import type { FakeDrive } from './_test_util.ts'
import { makeGDriveAccessor, resetFakeDrive } from './_test_util.ts'
import { copy } from './copy.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()
let fake: FakeDrive
const accessor = makeGDriveAccessor()

beforeEach(() => {
  fake = resetFakeDrive()
})

function spec(virtual: string): PathSpec {
  return PathSpec.fromStrPath(virtual)
}

describe('gdrive copy', () => {
  it('copies a file', async () => {
    fake.add('src.txt', 'root', undefined, ENC.encode('data'))
    await copy(accessor, spec('/src.txt'), spec('/dst.txt'))
    expect(DEC.decode(fake.find('dst.txt')?.content)).toBe('data')
    expect(fake.find('src.txt')).not.toBeNull()
  })

  it('overwrites an existing file', async () => {
    fake.add('src.txt', 'root', undefined, ENC.encode('new'))
    fake.add('dst.txt', 'root', undefined, ENC.encode('old'))
    await copy(accessor, spec('/src.txt'), spec('/dst.txt'))
    expect(DEC.decode(fake.find('dst.txt')?.content)).toBe('new')
    expect(fake.items.size).toBe(2)
  })

  it('file onto dir raises EISDIR', async () => {
    fake.add('src.txt', 'root', undefined, ENC.encode('x'))
    fake.folder('d')
    await expect(copy(accessor, spec('/src.txt'), spec('/d'))).rejects.toMatchObject({
      code: 'EISDIR',
    })
  })

  it('copies a tree into a missing dir', async () => {
    const src = fake.folder('src')
    const sub = fake.folder('sub', src)
    fake.add('f.txt', sub, undefined, ENC.encode('deep'))
    fake.add('top.txt', src, undefined, ENC.encode('top'))
    await copy(accessor, spec('/src'), spec('/dst'))
    expect(fake.find('dst')).not.toBeNull()
    for (const name of ['sub', 'f.txt', 'top.txt']) {
      const copies = [...fake.items.values()].filter((i) => i.name === name)
      expect(copies).toHaveLength(2)
    }
  })

  it('merges into an existing dir', async () => {
    const src = fake.folder('src')
    fake.add('f.txt', src, undefined, ENC.encode('x'))
    const dst = fake.folder('dst')
    fake.add('keep.txt', dst, undefined, ENC.encode('k'))
    await copy(accessor, spec('/src'), spec('/dst'))
    const children = [...fake.items.values()].filter((i) => i.parents.includes(dst))
    expect(new Set(children.map((i) => i.name))).toEqual(new Set(['keep.txt', 'f.txt']))
  })

  it('dir onto file raises ENOTDIR', async () => {
    fake.folder('src')
    fake.add('f.txt', 'root', undefined, ENC.encode('x'))
    await expect(copy(accessor, spec('/src'), spec('/f.txt'))).rejects.toMatchObject({
      code: 'ENOTDIR',
    })
  })

  it('missing src raises ENOENT', async () => {
    await expect(copy(accessor, spec('/missing.txt'), spec('/dst.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  async function merge(cache: RAMFileCacheStore): Promise<void> {
    await cache.set('/dst/f.txt', ENC.encode('old'))
    const manager = new CacheManager(cache, new RAMIndexCacheStore({ ttl: 600 }), '/', true)
    await runWithCacheManager(manager, () => copy(accessor, spec('/src'), spec('/dst')))
  }

  it("a merge evicts a replaced child's cached bytes", async () => {
    // Merging into an existing folder lands children the caller never named,
    // and their bytes were cached under their own keys: evicting only the
    // folder left `cat /dst/f.txt` serving the old file. A read during the
    // merge refills the child, so the eviction must follow the copy.
    const src = fake.folder('src')
    fake.add('f.txt', src, undefined, ENC.encode('new'))
    const dst = fake.folder('dst')
    fake.add('f.txt', dst, undefined, ENC.encode('old'))
    const cache = new RAMFileCacheStore()
    const copyFile = fake.copyFile.bind(fake)
    vi.spyOn(fake, 'copyFile').mockImplementation(async (...args) => {
      const copied = await copyFile(...args)
      await cache.set('/dst/f.txt', ENC.encode('old'))
      return copied
    })
    await merge(cache)
    expect(await cache.exists('/dst/f.txt')).toBe(false)
  })

  it('a merge that fails evicts too', async () => {
    // A merge that fails partway may have landed some children already.
    const src = fake.folder('src')
    fake.add('f.txt', src, undefined, ENC.encode('new'))
    fake.folder('dst')
    vi.spyOn(fake, 'copyFile').mockRejectedValue(new Error('copy failed'))
    const cache = new RAMFileCacheStore()
    await expect(merge(cache)).rejects.toThrow('copy failed')
    expect(await cache.exists('/dst/f.txt')).toBe(false)
  })
})
