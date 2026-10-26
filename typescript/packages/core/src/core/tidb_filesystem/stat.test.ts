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

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TiDBFilesystemAccessor } from '../../accessor/tidb_filesystem.ts'
import {
  makeAccessor,
  serve,
  spec,
  type FakeDrive9,
} from '../../../tests/core/tidb_filesystem/drive9.ts'
import { FileType } from '../../types.ts'
import { exists } from './exists.ts'
import { readdir } from './readdir.ts'
import { stat } from './stat.ts'

let drive9: FakeDrive9
let accessor: TiDBFilesystemAccessor

beforeEach(async () => {
  drive9 = await serve()
  accessor = makeAccessor(drive9)
})

afterEach(async () => {
  await drive9.close()
})

const ENC = new TextEncoder()

describe('stat', () => {
  it('is one HEAD for a file', async () => {
    drive9.files.set('/root/a.txt', ENC.encode('hello'))
    const found = await stat(accessor, spec('/fs/a.txt'))
    expect([found.name, found.size, found.type]).toEqual(['a.txt', 5, FileType.FILE])
    expect(found.modified).not.toBeNull()
    expect(drive9.requests).toEqual([['HEAD', '/root/a.txt?']])
  })

  it('answers the mount root without a request', async () => {
    expect((await stat(accessor, spec('/fs/'))).type).toBe(FileType.DIRECTORY)
    expect(drive9.requests).toEqual([])
  })

  it('asks for the directory when the path ends in a slash', async () => {
    drive9.files.set('/root/both', ENC.encode('file'))
    drive9.dirs.add('/root/both')
    expect((await stat(accessor, spec('/fs/both'))).type).toBe(FileType.FILE)
    expect((await stat(accessor, spec('/fs/both/'))).type).toBe(FileType.DIRECTORY)
  })

  it('answers ENOTDIR for a file asked as a directory or one above', async () => {
    drive9.files.set('/root/a.txt', ENC.encode('hello'))
    await expect(stat(accessor, spec('/fs/a.txt/'))).rejects.toMatchObject({ code: 'ENOTDIR' })
    await expect(stat(accessor, spec('/fs/a.txt/x'))).rejects.toMatchObject({
      code: 'ENOTDIR',
      virtualPath: '/fs/a.txt/x',
    })
  })

  it('answers ENOENT for a missing path', async () => {
    await expect(stat(accessor, spec('/fs/nope'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('readdir', () => {
  it('is one sorted listing', async () => {
    drive9.files.set('/root/b.txt', ENC.encode('bb')).set('/root/a.txt', ENC.encode('a'))
    drive9.dirs.add('/root/sub')
    const rows = await readdir(accessor, spec('/fs/'))
    expect(rows.map((r) => [r.name, r.type, r.size])).toEqual([
      ['a.txt', FileType.FILE, 1],
      ['b.txt', FileType.FILE, 2],
      ['sub', FileType.DIRECTORY, null],
    ])
    expect(drive9.requests).toEqual([['GET', '/root?list']])
  })

  it('sorts rows by code point, as python does', async () => {
    drive9.files.set('/root/\u{1d538}', ENC.encode('a')).set('/root/\uff5a', ENC.encode('z'))
    const rows = await readdir(accessor, spec('/fs/'))
    expect(rows.map((r) => r.name)).toEqual(['\uff5a', '\u{1d538}'])
  })

  it('lists a name that is both once, as the directory', async () => {
    drive9.files.set('/root/both', ENC.encode('file'))
    drive9.dirs.add('/root/both')
    const rows = await readdir(accessor, spec('/fs/'))
    expect(rows.map((r) => [r.name, r.type])).toEqual([['both', FileType.DIRECTORY]])
  })

  it('tells an empty directory from a missing one and a file', async () => {
    drive9.dirs.add('/root/empty')
    drive9.files.set('/root/a.txt', ENC.encode('x'))
    expect(await readdir(accessor, spec('/fs/empty'))).toEqual([])
    await expect(readdir(accessor, spec('/fs/nope'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readdir(accessor, spec('/fs/a.txt'))).rejects.toMatchObject({ code: 'ENOTDIR' })
  })
})

describe('exists', () => {
  it('is one HEAD', async () => {
    drive9.files.set('/root/a', ENC.encode('a'))
    expect(await exists(accessor, spec('/fs/a'))).toBe(true)
    expect(await exists(accessor, spec('/fs/nope'))).toBe(false)
    expect(drive9.count('HEAD')).toBe(2)
  })
})
