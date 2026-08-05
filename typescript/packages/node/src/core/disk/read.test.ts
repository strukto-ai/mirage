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

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DiskAccessor } from '../../accessor/disk.ts'
import { spec, tmpRoot } from '../../test-utils.ts'
import { read, readRange } from './read.ts'

let root: string
let accessor: DiskAccessor
let cleanup: () => void

beforeEach(() => {
  ;({ root, accessor, cleanup } = tmpRoot('mirage-core-disk-read-'))
})
afterEach(() => {
  cleanup()
})

describe('core/disk/read', () => {
  it('returns file bytes', async () => {
    await writeFile(join(root, 'a.txt'), 'hello')
    const data = await read(accessor, spec('/a.txt'))
    expect(new TextDecoder().decode(data)).toBe('hello')
  })

  it('throws "file not found" on ENOENT', async () => {
    await expect(read(accessor, spec('/missing'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('core/disk/readRange', () => {
  it('returns a bounded window', async () => {
    await writeFile(join(root, 'a.txt'), '0123456789')
    const data = await readRange(accessor, spec('/a.txt'), undefined, 2, 4)
    expect(new TextDecoder().decode(data)).toBe('2345')
  })

  it('runs to the end of the file without a size', async () => {
    await writeFile(join(root, 'a.txt'), '0123456789')
    const data = await readRange(accessor, spec('/a.txt'), undefined, 7, null)
    expect(new TextDecoder().decode(data)).toBe('789')
  })

  it('stops at the end when the window runs past it', async () => {
    await writeFile(join(root, 'a.txt'), '0123456789')
    const data = await readRange(accessor, spec('/a.txt'), undefined, 8, 99)
    expect(new TextDecoder().decode(data)).toBe('89')
  })

  it('is empty from past the end', async () => {
    await writeFile(join(root, 'a.txt'), '0123456789')
    const data = await readRange(accessor, spec('/a.txt'), undefined, 99, 4)
    expect(data.byteLength).toBe(0)
  })

  it('throws "file not found" on ENOENT', async () => {
    await expect(readRange(accessor, spec('/missing'), undefined, 0, 4)).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})
