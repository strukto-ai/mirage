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

import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runWithCacheManager } from '@struktoai/mirage-core/cache/context'
import type { PathSpec } from '@struktoai/mirage-core/types'
import type { DiskAccessor } from '../../accessor/disk.ts'
import { spec, tmpRoot } from '../../test-utils.ts'
import { rename } from './rename.ts'

class FakeManager {
  writes: string[] = []
  unlinks: string[] = []
  subtrees: string[] = []

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

let root: string
let accessor: DiskAccessor
let cleanup: () => void

beforeEach(() => {
  ;({ root, accessor, cleanup } = tmpRoot('mirage-core-disk-rename-'))
})
afterEach(() => {
  cleanup()
})

describe('core/disk/rename', () => {
  it('moves a file', async () => {
    await writeFile(join(root, 'a'), 'A')
    await rename(accessor, spec('/a'), spec('/b'))
    await expect(access(join(root, 'a'))).rejects.toThrow()
    expect(await readFile(join(root, 'b'), 'utf-8')).toBe('A')
  })
  it('throws on missing source', async () => {
    await expect(rename(accessor, spec('/missing'), spec('/x'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
  it('evicts both identities so a replaced empty dir loses its listing', async () => {
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'src', 'f.txt'), 'x')
    await mkdir(join(root, 'dst'))
    const manager = new FakeManager()
    await runWithCacheManager(manager, async () => {
      await rename(accessor, spec('/src'), spec('/dst'))
    })
    expect(manager.subtrees).toEqual(['/src', '/dst'])
    expect(manager.writes).toEqual([])
    expect(await readFile(join(root, 'dst', 'f.txt'), 'utf-8')).toBe('x')
  })
})
