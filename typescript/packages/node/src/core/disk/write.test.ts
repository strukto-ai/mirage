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

import { readFile, symlink, writeFile, readdir, chmod, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DiskAccessor } from '../../accessor/disk.ts'
import { spec, tmpRoot } from '../../test-utils.ts'
import { write, writeStream } from './write.ts'

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
    await write(accessor, spec('/x.txt'), new TextEncoder().encode('hi'))
    const out = await readFile(join(root, 'x.txt'), 'utf-8')
    expect(out).toBe('hi')
  })

  it('never writes through a host symlink out of the root', async () => {
    const { root: outside, cleanup: cleanupOutside } = tmpRoot('mirage-core-disk-write-out-')
    try {
      await writeFile(join(outside, 'target.txt'), 'original')
      await symlink(join(outside, 'target.txt'), join(root, 'link'))
      await expect(
        write(accessor, spec('/link'), new TextEncoder().encode('pwned')),
      ).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readFile(join(outside, 'target.txt'), 'utf8')).toBe('original')
    } finally {
      cleanupOutside()
    }
  })

  it('does not create parent directories', async () => {
    // A write is not `mkdir -p`: GNU reports ENOENT on a missing parent.
    await expect(
      write(accessor, spec('/a/b/c.txt'), new TextEncoder().encode('deep')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('a parent that is a plain file is ENOTDIR', async () => {
    await writeFile(join(root, 'plain'), 'y')
    await expect(
      write(accessor, spec('/plain/c.txt'), new TextEncoder().encode('deep')),
    ).rejects.toMatchObject({ code: 'ENOTDIR' })
  })
})

describe('streamed disk output', () => {
  it.each([false, true])(
    'preserves input failures and cleans staged output (atomic=%s)',
    async (atomic) => {
      const target = join(root, 'file')
      await writeFile(target, 'original')
      const error = new Error('read failed')
      let closed = false
      async function* source(): AsyncGenerator<Uint8Array> {
        await Promise.resolve()
        try {
          yield new TextEncoder().encode('partial')
          throw error
        } finally {
          closed = true
        }
      }
      await expect(
        writeStream(accessor, spec('/file'), source(), false, undefined, atomic),
      ).rejects.toBe(error)
      expect(closed).toBe(true)
      expect(await readFile(target, 'utf8')).toBe(atomic ? 'original' : 'partial')
      expect(await readdir(root)).toEqual(['file'])
    },
  )

  it('stages a replacement before overwriting its input and keeps mode', async () => {
    const target = join(root, 'file')
    await writeFile(target, 'old')
    await chmod(target, 0o640)
    async function* source(): AsyncGenerator<Uint8Array> {
      await Promise.resolve()
      yield await readFile(target)
      yield new TextEncoder().encode('new')
    }
    await writeStream(accessor, spec('/file'), source(), false, undefined, true)
    expect(await readFile(target, 'utf8')).toBe('oldnew')
    expect((await stat(target)).mode & 0o777).toBe(0o640)
    await writeStream(accessor, spec('/file'), new TextEncoder().encode('!'), true)
    expect(await readFile(target, 'utf8')).toBe('oldnew!')
  })
})
