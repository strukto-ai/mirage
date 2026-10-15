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

import { describe, expect, it } from 'vitest'
import type { FileEntryWithStats } from 'ssh2'
import { type FileStat, PathSpec } from '@struktoai/mirage-core/types'
import { mountKey } from '@struktoai/mirage-core/utils/key_prefix'
import { type FakeSftp, makeFakeAccessor } from './_test_utils.ts'
import { readdir } from './readdir.ts'
import { stat } from './stat.ts'

function spec(p: string): PathSpec {
  return PathSpec.fromStrPath(p)
}

function paths(rows: readonly FileStat[], virtual: string): string[] {
  return rows.map((row) => `${virtual}/${row.name}`)
}

describe('core/ssh/readdir', () => {
  it('returns sorted virtual paths under a directory', async () => {
    const accessor = makeFakeAccessor({
      files: new Map([
        ['/data/b.txt', { data: new Uint8Array() }],
        ['/data/a.txt', { data: new Uint8Array() }],
      ]),
      dirs: new Map([
        ['/', {}],
        ['/data', {}],
      ]),
    })
    const out = await readdir(accessor, spec('/data'))
    expect(paths(out, '/data')).toEqual(['/data/a.txt', '/data/b.txt'])
  })

  it('throws ENOENT for a missing directory', async () => {
    const accessor = makeFakeAccessor({
      files: new Map(),
      dirs: new Map([['/', {}]]),
    })
    await expect(readdir(accessor, spec('/missing'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('throws ENOTDIR for an operand under a file', async () => {
    // SFTP 3 answers `/a.txt/x` with NO_SUCH_FILE exactly as it does a name
    // that is simply absent, so only the ancestor walk can tell GNU's "Not a
    // directory" from "No such file or directory".
    const accessor = makeFakeAccessor({
      files: new Map([['/a.txt', { data: new Uint8Array() }]]),
      dirs: new Map([['/', {}]]),
    })
    await expect(readdir(accessor, spec('/a.txt/x'))).rejects.toMatchObject({
      code: 'ENOTDIR',
    })
    await expect(readdir(accessor, spec('/nope/deeper'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('preserves the mount prefix in returned paths', async () => {
    const accessor = makeFakeAccessor({
      files: new Map([['/data/a.txt', { data: new Uint8Array() }]]),
      dirs: new Map([
        ['/', {}],
        ['/data', {}],
      ]),
    })
    const p = new PathSpec({
      virtual: '/mnt/ssh/data',
      directory: '/mnt/ssh/data',
      vfsPath: mountKey('/mnt/ssh/data', '/mnt/ssh'),
    })
    const out = await readdir(accessor, p)
    expect(paths(out, '/mnt/ssh/data')).toEqual(['/mnt/ssh/data/a.txt'])
  })
})

function dataState(): FakeSftp {
  return {
    files: new Map([['/data/a.txt', { data: new TextEncoder().encode('hello') }]]),
    dirs: new Map([
      ['/', {}],
      ['/data', {}],
      ['/data/docs', { mtime: 1700000000 }],
    ]),
  }
}

describe('core/ssh/readdir rows', () => {
  it('answers each row as stat does', async () => {
    const accessor = makeFakeAccessor(dataState())
    const rows = await readdir(accessor, spec('/data'))
    expect(rows.map((row) => [row.name, row.type, row.size])).toEqual([
      ['a.txt', 'file', 5],
      ['docs', 'directory', null],
    ])
    for (const row of rows) expect(row).toEqual(await stat(accessor, spec(`/data/${row.name}`)))
  })

  // An SFTP server may leave the time fields out of a readdir entry; ssh2
  // then carries no mtime, and the row still lists the entry.
  it('lists an entry whose attrs carry no mtime', async () => {
    const accessor = makeFakeAccessor({ files: new Map(), dirs: new Map([['/', {}]]) })
    const sftp = await accessor.sftp()
    const entry = { filename: 'x.txt', longname: '', attrs: { mode: 0o100644, size: 1 } }
    sftp.readdir = ((_path: string, cb: (err: undefined, list: FileEntryWithStats[]) => void) => {
      cb(undefined, [entry as unknown as FileEntryWithStats])
    }) as typeof sftp.readdir
    const rows = await readdir(accessor, spec('/'))
    expect(rows.map((row) => [row.name, row.size, row.modified])).toEqual([['x.txt', 1, null]])
  })
})
