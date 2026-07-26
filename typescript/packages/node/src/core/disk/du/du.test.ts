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
import type { DiskAccessor } from '../../../accessor/disk.ts'
import { spec, tmpRoot } from '../../../test-utils.ts'
import { size, entries } from './index.ts'

let root: string
let accessor: DiskAccessor
let cleanup: () => void

beforeEach(() => {
  ;({ root, accessor, cleanup } = tmpRoot('mirage-core-disk-du-'))
})
afterEach(() => {
  cleanup()
})

describe('core/disk/du', () => {
  it('returns total bytes under a directory', async () => {
    await mkdir(join(root, 'd'))
    await writeFile(join(root, 'd', 'a'), Buffer.from([1, 2, 3]))
    await writeFile(join(root, 'd', 'b'), Buffer.from([4, 5]))
    expect(await size(accessor, spec('/d'))).toBe(5)
  })

  it('returns 0 for missing path', async () => {
    expect(await size(accessor, spec('/missing'))).toBe(0)
  })

  it('returns the file size for a single file', async () => {
    await writeFile(join(root, 'x'), Buffer.from([1, 2, 3]))
    expect(await size(accessor, spec('/x'))).toBe(3)
  })
})

describe('core/disk/du.duEntries', () => {
  it('returns sorted entries with sizes and total', async () => {
    await writeFile(join(root, 'b'), Buffer.from([1, 2]))
    await writeFile(join(root, 'a'), Buffer.from([3]))
    const [found, total] = await entries(accessor, spec('/'))
    expect(found.map((e: [string, number]) => e[0])).toEqual(['/a', '/b'])
    expect(total).toBe(3)
  })
})
