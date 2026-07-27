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

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DiskAccessor } from '../../accessor/disk.ts'
import { spec, tmpRoot } from '../../test-utils.ts'
import { appendBytes } from './append.ts'
import { writeBytes } from './write.ts'

let root: string
let accessor: DiskAccessor
let cleanup: () => void

beforeEach(() => {
  ;({ root, accessor, cleanup } = tmpRoot('mirage-core-disk-append-'))
})
afterEach(() => {
  cleanup()
})

describe('core/disk/append', () => {
  it('appends to an existing file', async () => {
    await writeBytes(accessor, spec('/x'), new TextEncoder().encode('A'))
    await appendBytes(accessor, spec('/x'), new TextEncoder().encode('B'))
    expect(await readFile(join(root, 'x'), 'utf-8')).toBe('AB')
  })

  it('creates the file if missing', async () => {
    await appendBytes(accessor, spec('/new'), new TextEncoder().encode('hi'))
    expect(await readFile(join(root, 'new'), 'utf-8')).toBe('hi')
  })

  it('does not create parent dirs', async () => {
    // `>>` is not `mkdir -p`: GNU reports ENOENT on a missing parent.
    await expect(
      appendBytes(accessor, spec('/d/x'), new TextEncoder().encode('z')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reports the virtual path, never the host path', async () => {
    try {
      await appendBytes(accessor, spec('/d/x'), new TextEncoder().encode('z'))
      expect.unreachable()
    } catch (err) {
      expect((err as Error).message).not.toContain(root)
      expect((err as { virtualPath?: string }).virtualPath).toBe('/d/x')
    }
  })
})
