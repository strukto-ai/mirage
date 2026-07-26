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

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DiskAccessor } from '../../accessor/disk.ts'
import { spec, tmpRoot } from '../../test-utils.ts'
import { copy } from './copy.ts'

let root: string
let accessor: DiskAccessor
let cleanup: () => void

beforeEach(() => {
  ;({ root, accessor, cleanup } = tmpRoot('mirage-core-disk-copy-'))
})
afterEach(() => {
  cleanup()
})

describe('core/disk/copy', () => {
  it('duplicates a file', async () => {
    await writeFile(join(root, 'src'), 'CP')
    await copy(accessor, spec('/src'), spec('/dst'))
    expect(await readFile(join(root, 'dst'), 'utf-8')).toBe('CP')
  })
  it('does not create parent directories for the destination', async () => {
    // cp is not `mkdir -p`: GNU reports ENOENT on the destination.
    await writeFile(join(root, 'src'), 'X')
    await expect(copy(accessor, spec('/src'), spec('/a/b/dst'))).rejects.toMatchObject({
      code: 'ENOENT',
      // copyFile answers ENOENT for a missing source too, so the failure has
      // to be attributed to the destination rather than assumed to be src.
      virtualPath: '/a/b/dst',
    })
  })

  it('blames the source when it is the missing operand', async () => {
    await expect(copy(accessor, spec('/nope'), spec('/dst'))).rejects.toMatchObject({
      code: 'ENOENT',
      virtualPath: '/nope',
    })
  })

  it('never leaks the host path for either operand', async () => {
    await writeFile(join(root, 'src'), 'X')
    const cases: { src: string; dst: string }[] = [
      { src: '/src', dst: '/a/b/dst' },
      { src: '/nope', dst: '/dst' },
    ]
    for (const { src, dst } of cases) {
      try {
        await copy(accessor, spec(src), spec(dst))
        expect.unreachable()
      } catch (err) {
        expect((err as Error).message).not.toContain(root)
      }
    }
  })
  it('throws on missing source', async () => {
    await expect(copy(accessor, spec('/missing'), spec('/x'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})
