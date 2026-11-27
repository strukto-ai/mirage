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

import { execFileSync } from 'node:child_process'
import { mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdir, open, symlink, writeFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { recordingScope } from '@struktoai/mirage-core/observe/context'
import { PathSpec } from '@struktoai/mirage-core/types'
import type { DiskAccessor } from '../../accessor/disk.ts'
import { spec, tmpRoot } from '../../../tests/test-utils.ts'
import { read, readMany } from './read.ts'
import type * as DiskUtils from './utils.ts'

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

describe('core/disk/read window', () => {
  it('returns a bounded window', async () => {
    await writeFile(join(root, 'a.txt'), '0123456789')
    const data = await read(accessor, spec('/a.txt'), 2, 4)
    expect(new TextDecoder().decode(data)).toBe('2345')
  })

  it('runs to the end of the file without a size', async () => {
    await writeFile(join(root, 'a.txt'), '0123456789')
    const data = await read(accessor, spec('/a.txt'), 7, null)
    expect(new TextDecoder().decode(data)).toBe('789')
  })

  it('stops at the end when the window runs past it', async () => {
    await writeFile(join(root, 'a.txt'), '0123456789')
    const data = await read(accessor, spec('/a.txt'), 8, 99)
    expect(new TextDecoder().decode(data)).toBe('89')
  })

  it('is empty from past the end', async () => {
    await writeFile(join(root, 'a.txt'), '0123456789')
    const data = await read(accessor, spec('/a.txt'), 99, 4)
    expect(data.byteLength).toBe(0)
  })

  it('throws "file not found" on ENOENT', async () => {
    await expect(read(accessor, spec('/missing'), 0, 4)).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})

// A key named like its mount: neither `m/k.txt` nor `/m/k.txt` is virtual.
describe('core/disk/read window record path', () => {
  const path = new PathSpec({ virtual: '/m/m/k.txt', vfsPath: 'm/k.txt', directory: '/m/m/' })

  beforeEach(async () => {
    await mkdir(join(root, 'm'))
    await writeFile(join(root, 'm', 'k.txt'), '0123456789')
  })

  it('a sized window records the virtual path', async () => {
    const [data, records] = await recordingScope(() => read(accessor, path, 0, 1))
    expect(new TextDecoder().decode(data)).toBe('0')
    expect(records.map((r) => r.path)).toEqual(['/m/m/k.txt'])
  })

  it('a rest-of-file window records the virtual path', async () => {
    const [data, records] = await recordingScope(() => read(accessor, path, 0, null))
    expect(new TextDecoder().decode(data)).toBe('0123456789')
    expect(records.map((r) => r.path)).toEqual(['/m/m/k.txt'])
  })
})

// A path under a plain file is ENOTDIR on the real filesystem, stamped with
// the virtual path: Node's own message names the host path, which must never
// reach a diagnostic. Mirrors the disk tests in python/tests/core/disk.
describe('core/disk/read under a plain file', () => {
  it('is ENOTDIR against the virtual path', async () => {
    await writeFile(join(root, 'a.txt'), 'a')
    const err: unknown = await read(accessor, spec('/a.txt/x')).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toMatchObject({ code: 'ENOTDIR', virtualPath: '/a.txt/x' })
    expect((err as Error).message).not.toContain(root)
  })
})

describe('core/disk/readMany', () => {
  it('answers only the files their own reads would', async () => {
    // Each file is checked as its own read checks it, so a link, a folder
    // reached through one, a name spelled unlike its entry, a directory, a
    // FIFO (whose open would wait for a writer) and a file gone or longer
    // than the limit are left for that read; the rest are recorded once each,
    // as their own reads record them, a file named twice too.
    await mkdir(join(root, 'a', 'sub'), { recursive: true })
    await mkdir(join(root, 'b'))
    await writeFile(join(root, 'a', 'x'), 'x\n')
    await writeFile(join(root, 'a', 'y'), 'y\n')
    await writeFile(join(root, 'a', 'long'), 'z'.repeat(9))
    await writeFile(join(root, 'b', 'c'), 'c\n')
    await symlink(join(root, 'a', 'x'), join(root, 'a', 'link'))
    await symlink(join(root, 'a'), join(root, 'linked'))
    execFileSync('mkfifo', [join(root, 'a', 'pipe')])
    const keys = [
      '/a/x',
      '/a/link',
      '/linked/y',
      '/a/X',
      '/a/sub',
      '/a/pipe',
      '/a/gone',
      '/a/long',
      '/gone/x',
      '/a/y',
      '/b/c',
      '/a/x',
    ]
    const [got, records] = await recordingScope(() => readMany(accessor, keys.map(spec), 8))
    const enc = new TextEncoder()
    expect(got).toEqual(
      new Map([
        ['/a/x', enc.encode('x\n')],
        ['/a/y', enc.encode('y\n')],
        ['/b/c', enc.encode('c\n')],
      ]),
    )
    expect(records.map((r) => [r.path, r.bytes, r.complete])).toEqual([
      ['/a/x', 2, true],
      ['/a/y', 2, true],
      ['/b/c', 2, true],
    ])
  })

  it('keeps the files that fit its room', async () => {
    // A file that would take the batch past its room is left out before it
    // is read, and a smaller one after it still fits.
    for (const [name, size] of [
      ['f', 16],
      ['g', 16],
      ['h', 4],
    ] as const) {
      await writeFile(join(root, name), 'x'.repeat(size))
    }
    const files = ['/f', '/g', '/h'].map(spec)
    expect([...(await readMany(accessor, files, 64, 20)).keys()]).toEqual(['/f', '/h'])
    expect((await readMany(accessor, files, 64, -1)).size).toBe(0)
    expect((await readMany(accessor, files, 64)).size).toBe(3)
  })

  it('reads on past a short read', async () => {
    // A read may answer fewer bytes than it was asked for before the end of
    // the file, so the batch reads again from where it stopped until a read
    // answers none.
    await writeFile(join(root, 'f'), '0123456789')
    const probe = await open(join(root, 'f'))
    const proto = Object.getPrototypeOf(probe) as FileHandle
    await probe.close()
    type Read = (
      this: FileHandle,
      buf: Buffer,
      offset: number,
      length: number,
      position: number,
    ) => Promise<{ bytesRead: number; buffer: Buffer }>
    const real = Reflect.get(proto, 'read') as Read
    const short: Read = function (buf, offset, length, position) {
      return real.call(this, buf, offset, Math.min(length, 3), position)
    }
    const reads = vi.spyOn(proto, 'read').mockImplementation(short as unknown as FileHandle['read'])
    try {
      const got = await readMany(accessor, [spec('/f')], 64)
      expect(new TextDecoder().decode(got.get('/f'))).toBe('0123456789')
      expect(reads.mock.calls.length).toBeGreaterThan(1)
    } finally {
      reads.mockRestore()
    }
  })

  it('proves a leaf is no link where the open cannot refuse one', async () => {
    // Without O_NOFOLLOW (Windows) the open would follow a link at the leaf,
    // so the batch looks at the name first and keeps a file only when the
    // open reached the very file it saw.
    await mkdir(join(root, 'a'))
    await writeFile(join(root, 'a', 'x'), 'x\n')
    await symlink(join(root, 'a', 'x'), join(root, 'a', 'link'))
    vi.resetModules()
    vi.doMock('node:fs/promises', async (importOriginal) => {
      const real = await importOriginal<typeof FsPromises>()
      const constants: Record<string, number> = { ...real.constants }
      delete constants.O_NOFOLLOW
      return { ...real, constants }
    })
    try {
      const fresh = await import('./read.ts')
      const got = await fresh.readMany(accessor, ['/a/x', '/a/link'].map(spec), 8)
      expect([...got.keys()]).toEqual(['/a/x'])
    } finally {
      vi.doUnmock('node:fs/promises')
      vi.resetModules()
    }
  })

  it('refuses a folder swapped for a link mid-batch', async () => {
    // The batch proves /a once, so a file opened after /a was swapped for a
    // link to a folder outside the mount would come from outside; once each
    // file is open the folder's path must still name the directory proven,
    // so /a/y is left for its own read, which refuses the link.
    await mkdir(join(root, 'a'))
    await writeFile(join(root, 'a', 'x'), 'x\n')
    await writeFile(join(root, 'a', 'y'), 'y\n')
    const elsewhere = mkdtempSync(join(tmpdir(), 'mirage-disk-outside-'))
    writeFileSync(join(elsewhere, 'y'), 'outside\n')
    vi.resetModules()
    vi.doMock('./utils.ts', async (importOriginal) => {
      const real = await importOriginal<typeof DiskUtils>()
      let swapped = false
      return {
        ...real,
        exactName: async (...args: Parameters<typeof real.exactName>) => {
          const exact = await real.exactName(...args)
          if (!swapped) {
            swapped = true
            renameSync(join(root, 'a'), join(root, '..', `${basename(root)}-moved`))
            symlinkSync(elsewhere, join(root, 'a'))
          }
          return exact
        },
      }
    })
    try {
      const fresh = await import('./read.ts')
      const got = await fresh.readMany(accessor, ['/a/x', '/a/y'].map(spec), 8)
      expect(got.has('/a/y')).toBe(false)
      expect([...got.values()].map((b) => new TextDecoder().decode(b))).not.toContain('outside\n')
    } finally {
      vi.doUnmock('./utils.ts')
      vi.resetModules()
      rmSync(elsewhere, { recursive: true, force: true })
      rmSync(join(root, '..', `${basename(root)}-moved`), { recursive: true, force: true })
    }
  })
})
