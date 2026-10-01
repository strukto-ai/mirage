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

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeMockAccessor, spec } from '../../test-utils.ts'
import { mkdir } from './mkdir.ts'
import { read } from './read.ts'
import { writeBytes } from './write.ts'
import { runWithCacheManager, type CacheInvalidator } from '@struktoai/mirage-core/cache/context'
import type { WriteReceipt } from '@struktoai/mirage-core/cache/types'

let accessor: ReturnType<typeof makeMockAccessor>
beforeEach(() => {
  accessor = makeMockAccessor()
})
afterEach(() => undefined)

describe('opfs/write.writeBytes', () => {
  it('writes bytes and is readable back', async () => {
    await writeBytes(accessor, spec('/x'), new TextEncoder().encode('hi'))
    expect(new TextDecoder().decode(await read(accessor, spec('/x')))).toBe('hi')
  })
  it('does not create parent directories', async () => {
    // A write is not `mkdir -p`: GNU reports ENOENT on a missing parent
    // rather than building the chain. OPFS creates per segment, so this
    // has to be refused explicitly rather than inherited from the kernel.
    await expect(
      writeBytes(accessor, spec('/a/b/c'), new TextEncoder().encode('deep')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('writes into an existing directory', async () => {
    await mkdir(accessor, spec('/a'), true)
    await writeBytes(accessor, spec('/a/c'), new TextEncoder().encode('deep'))
    expect(new TextDecoder().decode(await read(accessor, spec('/a/c')))).toBe('deep')
  })

  it('a parent that is a plain file is ENOTDIR', async () => {
    await writeBytes(accessor, spec('/plain'), new TextEncoder().encode('y'))
    await expect(
      writeBytes(accessor, spec('/plain/c'), new TextEncoder().encode('deep')),
    ).rejects.toMatchObject({ code: 'ENOTDIR' })
  })

  it('a target that is a directory is EISDIR', async () => {
    await mkdir(accessor, spec('/a'), true)
    await expect(
      writeBytes(accessor, spec('/a'), new TextEncoder().encode('x')),
    ).rejects.toMatchObject({ code: 'EISDIR' })
  })
})

function recorder(): [CacheInvalidator, [string, string, WriteReceipt | null, number | null][], string[]] {
  const settled: [string, string, WriteReceipt | null, number | null][] = []
  const writes: string[] = []
  const manager: CacheInvalidator = {
    generation: 5,
    settleAfterWrite(path, data, receipt, started) {
      settled.push([path.virtual, new TextDecoder().decode(data), receipt, started])
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

describe('opfs/write.writeBytes settles', () => {
  it('settles its bytes without a receipt', async () => {
    const [manager, settled, writes] = recorder()
    await runWithCacheManager(manager, () =>
      writeBytes(accessor, spec('/x'), new TextEncoder().encode('hi')),
    )
    expect(settled).toEqual([['/x', 'hi', null, 5]])
    expect(writes).toEqual([])
  })
})
