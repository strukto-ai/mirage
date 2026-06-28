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
import { spec, tmpRoot } from '../../test-utils.ts'
import { find } from './find.ts'

let root: string
let accessor: DiskAccessor
let cleanup: () => void

beforeEach(async () => {
  ;({ root, accessor, cleanup } = tmpRoot('mirage-core-disk-find-'))
  await mkdir(join(root, 'sub'))
  await writeFile(join(root, 'a.json'), '')
  await writeFile(join(root, 'b.txt'), '')
  await writeFile(join(root, 'sub', 'c.json'), '')
})
afterEach(() => {
  cleanup()
})

describe('core/disk/find', () => {
  it('returns all entries when no filters', async () => {
    const out = await find(accessor, spec('/'))
    expect(out).toEqual(['/', '/a.json', '/b.txt', '/sub', '/sub/c.json'])
  })

  it('filters by name pattern (*.json)', async () => {
    const out = await find(accessor, spec('/'), { name: '*.json' })
    expect(out).toEqual(['/a.json', '/sub/c.json'])
  })

  it('filters by type "f" (files only)', async () => {
    const out = await find(accessor, spec('/'), { type: 'f' })
    expect(out).toEqual(['/a.json', '/b.txt', '/sub/c.json'])
  })

  it('filters by type "d" (directories only)', async () => {
    const out = await find(accessor, spec('/'), { type: 'd' })
    expect(out).toEqual(['/', '/sub'])
  })

  it('respects maxDepth', async () => {
    const out = await find(accessor, spec('/'), { maxDepth: 1, type: 'f' })
    expect(out).toEqual(['/a.json', '/b.txt'])
  })

  it('returns empty for missing root', async () => {
    expect(await find(accessor, spec('/missing'))).toEqual([])
  })
})
