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

import { stripSlash } from '@struktoai/mirage-core'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DiskAccessor } from '../../accessor/disk.ts'
import { PathSpec } from '@struktoai/mirage-core'
import { spec, tmpRoot } from '../../test-utils.ts'
import { resolveGlob } from './glob.ts'

let root: string
let accessor: DiskAccessor
let cleanup: () => void

beforeEach(async () => {
  ;({ root, accessor, cleanup } = tmpRoot('mirage-core-disk-glob-'))
  await writeFile(join(root, 'a.json'), '')
  await writeFile(join(root, 'b.json'), '')
  await writeFile(join(root, 'c.txt'), '')
})
afterEach(() => {
  cleanup()
})

describe('core/disk/glob.resolveGlob', () => {
  it('expands a glob pattern into matching paths', async () => {
    const pattern = new PathSpec({
      resourcePath: stripSlash('/*.json'),
      virtual: '/*.json',
      directory: '/',
      pattern: '*.json',
      resolved: false,
    })
    const out = await resolveGlob(accessor, [pattern])
    const originals = out.map((p) => p.virtual).sort()
    expect(originals).toEqual(['/a.json', '/b.json'])
  })

  it('passes through already-resolved paths unchanged', async () => {
    const out = await resolveGlob(accessor, [spec('/c.txt')])
    expect(out.map((p) => p.virtual)).toEqual(['/c.txt'])
  })
})
