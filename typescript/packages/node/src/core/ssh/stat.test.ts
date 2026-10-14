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
import { ContentType, FileType, PathSpec } from '@struktoai/mirage-core/types'
import { RunAccessor, makeFakeAccessor, type RunAnswer } from './_test_utils.ts'
import { attrsToFileStat, stat, tree, treeCommand } from './stat.ts'

function spec(p: string): PathSpec {
  return PathSpec.fromStrPath(p)
}

describe('core/ssh/stat', () => {
  it('returns FileStat for an existing file', async () => {
    const accessor = makeFakeAccessor({
      files: new Map([['/a.txt', { data: new TextEncoder().encode('abc') }]]),
      dirs: new Map([['/', {}]]),
    })
    const s = await stat(accessor, spec('/a.txt'))
    expect(s.size).toBe(3)
    expect(s.name).toBe('a.txt')
  })

  it('returns DIRECTORY type for a directory', async () => {
    const accessor = makeFakeAccessor({
      files: new Map(),
      dirs: new Map([
        ['/', {}],
        ['/d', {}],
      ]),
    })
    const s = await stat(accessor, spec('/d'))
    expect(s.type).toBe(FileType.DIRECTORY)
    expect(s.size).toBeNull()
  })

  it('throws ENOENT for missing path', async () => {
    const accessor = makeFakeAccessor({
      files: new Map(),
      dirs: new Map([['/', {}]]),
    })
    await expect(stat(accessor, spec('/nope'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

const FILE_MODE = 0o100644
const DIR_MODE = 0o040755

describe('attrsToFileStat', () => {
  it('returns DIRECTORY type for a directory mode', () => {
    const s = attrsToFileStat('mydir', { mode: DIR_MODE, size: 0 })
    expect(s.type).toBe(FileType.DIRECTORY)
    expect(s.name).toBe('mydir')
    expect(s.size).toBeNull()
  })

  it.each([
    ['foo.json', ContentType.JSON],
    ['foo.txt', ContentType.TEXT],
    ['foo.bin', ContentType.BINARY],
    ['weird-name.parquet', ContentType.BINARY],
  ])('types %s by its name', (name, content) => {
    const s = attrsToFileStat(name, { mode: FILE_MODE, size: 7 })
    expect(s.name).toBe(name)
    expect(s.content).toBe(content)
  })

  it('formats modified as ISO 8601 and fingerprints by it', () => {
    const s = attrsToFileStat('foo.txt', { mode: FILE_MODE, mtime: 0 })
    expect(s.modified).toBe('1970-01-01T00:00:00Z')
    expect(s.fingerprint).toBe(s.modified)
    expect(attrsToFileStat('foo.txt', { mode: FILE_MODE, mtime: 1 }).fingerprint).not.toBe(
      s.fingerprint,
    )
    const d = attrsToFileStat('mydir', { mode: DIR_MODE, mtime: 0 })
    expect(d.fingerprint).toBe(d.modified)
  })

  it('leaves modified and fingerprint null when mtime is omitted', () => {
    const s = attrsToFileStat('foo.txt', { mode: FILE_MODE })
    expect(s.modified).toBeNull()
    expect(s.fingerprint).toBeNull()
    expect(attrsToFileStat('mydir', { mode: DIR_MODE }).fingerprint).toBeNull()
  })
})

const ENC = new TextEncoder()
const TOP = 'd 755 4096 1700000000.5 1700000001.0 1000 1000 \0'

function scope(vfsPath = ''): PathSpec {
  const virtual = vfsPath === '' ? '/s' : `/s/${vfsPath}`
  return new PathSpec({ virtual, directory: virtual, vfsPath, rawPath: virtual })
}

describe('treeCommand', () => {
  it('quotes the scope and the format', () => {
    expect(treeCommand('data/a b')).toBe(
      "env LC_ALL=C find -L 'data/a b' -printf '%y %m %s %T@ %A@ %U %G %P\\0'",
    )
  })
})

describe('tree', () => {
  it('renders each entry as stat does', async () => {
    const out =
      TOP +
      'f 644 5 1700000000.9 1700000002.0 1000 1000 a.txt\0' +
      'd 700 4096 1700000003.0 1700000003.0 1000 1000 sub\0' +
      'f 4600 0 1700000004.2 1700000004.0 1000 1000 sub/b b.md\0'
    const accessor = new RunAccessor('data', [0, ENC.encode(out), new Uint8Array()])
    const rows = await tree(accessor, scope('in'))
    expect(accessor.sent).toEqual([treeCommand('data/in')])
    expect([...(rows?.keys() ?? [])].sort()).toEqual(['a.txt', 'sub', 'sub/b b.md'])
    expect(rows?.get('a.txt')).toEqual(
      attrsToFileStat('a.txt', {
        mode: FILE_MODE,
        size: 5,
        atime: 1700000002,
        mtime: 1700000000,
        uid: 1000,
        gid: 1000,
      }),
    )
    expect(rows?.get('sub')?.type).toBe(FileType.DIRECTORY)
    expect(rows?.get('sub')?.size).toBeNull()
    expect(rows?.get('sub/b b.md')?.name).toBe('b b.md')
    expect(rows?.get('sub/b b.md')?.mode).toBe(0o4600)
  })

  it('has no rows for an empty directory', async () => {
    const rows = await tree(new RunAccessor('/', [0, ENC.encode(TOP), new Uint8Array()]), scope())
    expect(rows).toEqual(new Map())
  })

  const bytes = (text: string): Uint8Array => ENC.encode(text)
  it.each<[string, RunAnswer]>([
    ['a failed find', [1, bytes(TOP), new Uint8Array()]],
    ['stderr', [0, bytes(TOP), bytes("find: 'x': Permission denied\n")]],
    ['a broken link', [0, bytes(`${TOP}l 777 7 1.0 1.0 0 0 gone\0`), new Uint8Array()]],
    ['a fifo', [0, bytes(`${TOP}p 644 0 1.0 1.0 0 0 fifo\0`), new Uint8Array()]],
    ['a file at the scope', [0, bytes('f 644 5 1.0 1.0 0 0 \0'), new Uint8Array()]],
    ['a short record', [0, bytes(`${TOP}f 644 5 1.0\0`), new Uint8Array()]],
    ['no closing NUL', [0, bytes(TOP.slice(0, -1)), new Uint8Array()]],
    [
      'an sftp-only server',
      [1, bytes('This service allows sftp connections only.\n'), new Uint8Array()],
    ],
    ['a closed connection', new Error('closed')],
  ])('leaves the walk on %s', async (_name, answer) => {
    expect(await tree(new RunAccessor('/', answer), scope())).toBeNull()
  })
})
