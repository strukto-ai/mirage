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

import { readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DiskAccessor } from '../../accessor/disk.ts'
import { spec, tmpRoot } from '../../test-utils.ts'
import { writeBytes } from './write.ts'
import { runWithCacheManager, type CacheInvalidator } from '@struktoai/mirage-core/cache/context'
import type { WriteReceipt } from '@struktoai/mirage-core/cache/types'

let root: string
let accessor: DiskAccessor
let cleanup: () => void

beforeEach(() => {
  ;({ root, accessor, cleanup } = tmpRoot('mirage-core-disk-write-'))
})
afterEach(() => {
  cleanup()
})

describe('core/disk/write', () => {
  it('writes bytes to disk', async () => {
    await writeBytes(accessor, spec('/x.txt'), new TextEncoder().encode('hi'))
    const out = await readFile(join(root, 'x.txt'), 'utf-8')
    expect(out).toBe('hi')
  })

  it('never writes through a host symlink out of the root', async () => {
    const { root: outside, cleanup: cleanupOutside } = tmpRoot('mirage-core-disk-write-out-')
    try {
      await writeFile(join(outside, 'target.txt'), 'original')
      await symlink(join(outside, 'target.txt'), join(root, 'link'))
      await expect(
        writeBytes(accessor, spec('/link'), new TextEncoder().encode('pwned')),
      ).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readFile(join(outside, 'target.txt'), 'utf8')).toBe('original')
    } finally {
      cleanupOutside()
    }
  })

  it('does not create parent directories', async () => {
    // A write is not `mkdir -p`: GNU reports ENOENT on a missing parent.
    await expect(
      writeBytes(accessor, spec('/a/b/c.txt'), new TextEncoder().encode('deep')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('a parent that is a plain file is ENOTDIR', async () => {
    await writeFile(join(root, 'plain'), 'y')
    await expect(
      writeBytes(accessor, spec('/plain/c.txt'), new TextEncoder().encode('deep')),
    ).rejects.toMatchObject({ code: 'ENOTDIR' })
  })
})

function recorder(): [
  CacheInvalidator,
  [string, string, WriteReceipt | null, number | null][],
  string[],
] {
  const settled: [string, string, WriteReceipt | null, number | null][] = []
  const writes: string[] = []
  const manager: CacheInvalidator = {
    generation: 5,
    settleAfterWrite(path, data, receipt, generation) {
      settled.push([path.virtual, new TextDecoder().decode(data), receipt, generation])
      return Promise.resolve()
    },
    invalidateAfterWrite(path) {
      writes.push(typeof path === 'string' ? path : path.virtual)
      return Promise.resolve()
    },
    invalidateAfterUnlink: () => Promise.resolve(),
    invalidateSubtree: () => Promise.resolve(),
    invalidateAncestors: () => Promise.resolve(),
    cachedBytes: () => Promise.resolve(null),
    readThrough: (_path, fetch) => fetch(),
    cachedSize: () => Promise.resolve(null),
    listingTrusted: () => false,
    probedStat: () => null,
  }
  return [manager, settled, writes]
}

describe('core/disk/write settles', () => {
  it('settles its bytes without a receipt', async () => {
    const [manager, settled, writes] = recorder()
    await runWithCacheManager(manager, () =>
      writeBytes(accessor, spec('/x.txt'), new TextEncoder().encode('hi')),
    )
    expect(settled).toEqual([['/x.txt', 'hi', null, 5]])
    expect(writes).toEqual([])
  })
})
