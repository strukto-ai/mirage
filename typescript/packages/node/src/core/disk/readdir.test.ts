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

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DiskAccessor } from '../../accessor/disk.ts'
import { PathSpec, RAMIndexCacheStore, mountKey } from '@struktoai/mirage-core'
import { spec, tmpRoot } from '../../test-utils.ts'
import { readdir } from './readdir.ts'

let root: string
let accessor: DiskAccessor
let cleanup: () => void

beforeEach(() => {
  ;({ root, accessor, cleanup } = tmpRoot('mirage-core-disk-readdir-'))
})
afterEach(() => {
  cleanup()
})

describe('core/disk/readdir', () => {
  it('returns full virtual paths sorted', async () => {
    await writeFile(join(root, 'b'), '')
    await writeFile(join(root, 'a'), '')
    expect(await readdir(accessor, spec('/'))).toEqual(['/a', '/b'])
  })

  it('lists nested directory', async () => {
    await mkdir(join(root, 'sub'))
    await writeFile(join(root, 'sub', 'x'), '')
    expect(await readdir(accessor, spec('/sub'))).toEqual(['/sub/x'])
  })

  it('throws "not a directory" on missing path', async () => {
    await expect(readdir(accessor, spec('/missing'))).rejects.toMatchObject({ code: 'ENOTDIR' })
  })

  it('cache-hit entries stay clean under a prefixed mount', async () => {
    await writeFile(join(root, 'a.txt'), 'a')
    const index = new RAMIndexCacheStore({ ttl: 600 })
    const prefixed = new PathSpec({
      virtual: '/data/',
      directory: '/data/',
      resourcePath: mountKey('/data/', '/data'),
    })
    const cold = await readdir(accessor, prefixed, index)
    const warm = await readdir(accessor, prefixed, index)
    expect(cold).toEqual(['/data/a.txt'])
    expect(warm).toEqual(cold)
  })

  it('cache key ignores a trailing slash', async () => {
    await writeFile(join(root, 'a.txt'), 'a')
    const index = new RAMIndexCacheStore({ ttl: 600 })
    const slashed = new PathSpec({
      virtual: '/data/',
      directory: '/data/',
      resourcePath: mountKey('/data/', '/data'),
    })
    const bare = new PathSpec({
      virtual: '/data',
      directory: '/data',
      resourcePath: mountKey('/data', '/data'),
    })
    const first = await readdir(accessor, slashed, index)
    const second = await readdir(accessor, bare, index)
    expect(first).toEqual(['/data/a.txt'])
    expect(second).toEqual(first)
  })
})
