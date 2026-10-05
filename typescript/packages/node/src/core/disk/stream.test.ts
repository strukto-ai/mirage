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
import { readStream } from './stream.ts'

let root: string
let accessor: DiskAccessor
let cleanup: () => void

beforeEach(() => {
  ;({ root, accessor, cleanup } = tmpRoot('mirage-core-disk-stream-'))
})
afterEach(() => {
  cleanup()
})

describe('core/disk/stream', () => {
  it('yields all bytes', async () => {
    await writeFile(join(root, 'x'), 'hello stream')
    const chunks: Uint8Array[] = []
    for await (const c of readStream(accessor, spec('/x'))) chunks.push(c)
    const total = chunks.reduce((acc, c) => acc + c.byteLength, 0)
    expect(total).toBe('hello stream'.length)
    const decoded = chunks.map((c) => new TextDecoder().decode(c)).join('')
    expect(decoded).toBe('hello stream')
  })

  it('throws "file not found" on missing', async () => {
    const it = readStream(accessor, spec('/missing'))
    await expect(it[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

// A path under a plain file is ENOTDIR on the real filesystem, stamped with
// the virtual path: Node's own message names the host path, which must never
// reach a diagnostic. Mirrors the disk tests in python/tests/core/disk.
describe('core/disk/stream under a plain file', () => {
  it('is ENOTDIR against the virtual path', async () => {
    await writeFile(join(root, 'a.txt'), 'a')
    const err: unknown = await (async () => {
      for await (const chunk of readStream(accessor, spec('/a.txt/x'))) void chunk
    })().then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toMatchObject({ code: 'ENOTDIR', virtualPath: '/a.txt/x' })
    expect((err as Error).message).not.toContain(root)
  })
})
