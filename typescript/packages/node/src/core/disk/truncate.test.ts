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
import { spec, tmpRoot } from '../../../tests/test-utils.ts'
import { truncate } from './truncate.ts'

let root: string
let accessor: DiskAccessor
let cleanup: () => void

beforeEach(() => {
  ;({ root, accessor, cleanup } = tmpRoot('mirage-core-disk-truncate-'))
})
afterEach(() => {
  cleanup()
})

describe('core/disk/truncate', () => {
  it('truncates a file', async () => {
    await writeFile(join(root, 'x'), 'hello world')
    await truncate(accessor, spec('/x'), 5)
    expect(await readFile(join(root, 'x'), 'utf-8')).toBe('hello')
  })

  it('zero-fills when growing', async () => {
    await writeFile(join(root, 'x'), 'ab')
    await truncate(accessor, spec('/x'), 4)
    const data = await readFile(join(root, 'x'))
    expect(data.byteLength).toBe(4)
    expect(data[2]).toBe(0)
    expect(data[3]).toBe(0)
  })

  it('creates an empty file when source missing', async () => {
    await truncate(accessor, spec('/missing'), 3)
    const data = await readFile(join(root, 'missing'))
    expect(data.byteLength).toBe(3)
    expect(data[0]).toBe(0)
  })
})

it('no-create leaves a missing file absent', async () => {
  await truncate(accessor, spec('/missing'), 3, true)
  await expect(readFile(join(root, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' })
})
