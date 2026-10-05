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
// diff's stdin operands and as-typed names, pinned on GNU diffutils 3.10.
// Mirrors python/tests/commands/builtin/generic/test_diff.py.

import { describe, expect, it } from 'vitest'
import { cEscape, diffGeneric, switchWords } from './diff.ts'
import { FileStat, FileType, PathSpec } from '../../../types.ts'
import type { CommandOpts } from '../../config.ts'

const ENC = new TextEncoder()

function operand(raw: string, virtual: string): PathSpec {
  return new PathSpec({ virtual, directory: virtual, vfsPath: virtual.slice(3), rawPath: raw })
}

const DASH = operand('-', '/d/-')
const DEV_STDIN = new PathSpec({ virtual: '/dev/stdin', directory: '/dev', vfsPath: 'stdin' })
const DIRS: Record<string, string[]> = { '/d/sub': ['x'], '/d/sub2': ['x', 'y'] }

function readdir(p: PathSpec): Promise<string[]> {
  return Promise.resolve(DIRS[p.virtual] ?? [])
}

function stat(p: PathSpec): Promise<FileStat> {
  const type = p.virtual in DIRS ? FileType.DIRECTORY : FileType.FILE
  return Promise.resolve(new FileStat({ name: p.virtual.split('/').pop() ?? '', type }))
}

describe('diffGeneric with stdin', () => {
  it('takes two stdin operands as one file', async () => {
    const unread = (p: PathSpec): AsyncIterable<Uint8Array> => {
      throw new Error(`read ${p.virtual}`)
    }
    const opts = { flags: {}, stdin: ENC.encode('abc') } as unknown as CommandOpts
    const [out, io] = await diffGeneric([DASH, DEV_STDIN], opts, unread, readdir, stat)
    expect([out, io.exitCode]).toEqual([null, 0])
  })

  it('keeps the option words as typed for the header', () => {
    expect(switchWords(['-ru', '--exclude', '.git', 'a', 'b', '-x*.log'])).toEqual([
      '-ru',
      '--exclude',
      '.git',
      '-x*.log',
    ])
    expect(switchWords(['--exclude=.git', '-r', 'a', '--', '-b'])).toEqual([
      '--exclude=.git',
      '-r',
      '--',
    ])
    expect(switchWords(['-rx', 'pat', '-U', '1', 'a', 'b'])).toEqual(['-rx', 'pat', '-U', '1'])
  })
})

describe('diff headers', () => {
  it('C-quotes a header name the way diffutils does', () => {
    expect(cEscape('plain/é\x7f')).toBe('plain/é\x7f')
    expect(cEscape('sp ace')).toBe('"sp ace"')
    expect(cEscape('t\tq"b\\')).toBe('"t\\tq\\"b\\\\"')
    expect(cEscape('c\x01')).toBe('"c\\001"')
  })

  it('reads the time the namespace keeps', async () => {
    const read = async function* (p: PathSpec): AsyncIterable<Uint8Array> {
      await Promise.resolve()
      yield ENC.encode(p.virtual === '/d/a' ? 'x\n' : 'y\n')
    }
    const backend = (p: PathSpec): Promise<FileStat> =>
      Promise.resolve(
        new FileStat({ name: p.virtual, type: FileType.FILE, modified: '2026-10-05T00:00:00Z' }),
      )
    const statPath = (virtual: string): Promise<FileStat | null> =>
      Promise.resolve(
        new FileStat({ name: virtual, type: FileType.FILE, modified: '2021-06-15T12:00:00Z' }),
      )
    const opts = { flags: { u: true }, stdin: new Uint8Array(), statPath } as unknown as CommandOpts
    const [out] = await diffGeneric(
      [operand('a', '/d/a'), operand('b', '/d/b')],
      opts,
      read,
      readdir,
      backend,
    )
    expect(new TextDecoder().decode(out as Uint8Array).split('\n')[0]).toBe(
      '--- a\t2021-06-15 12:00:00.000000000 +0000',
    )
  })

  it('carries each side mtime in a unified header', async () => {
    const files: Record<string, string> = { '/d/a b': 'x\ny\n', '/d/c': 'x\nz\n' }
    const read = async function* (p: PathSpec): AsyncIterable<Uint8Array> {
      await Promise.resolve()
      yield ENC.encode(files[p.virtual] ?? '')
    }
    const statOf = (p: PathSpec): Promise<FileStat> => {
      if (!(p.virtual in files))
        return Promise.reject(Object.assign(new Error(p.virtual), { code: 'ENOENT' }))
      return Promise.resolve(
        new FileStat({ name: p.virtual, type: FileType.FILE, modified: '2026-01-02T03:04:05Z' }),
      )
    }
    const pair = [operand('a b', '/d/a b'), operand('c', '/d/c')]
    const opts = { flags: { u: true }, stdin: new Uint8Array() } as unknown as CommandOpts
    const [out, io] = await diffGeneric(pair, opts, read, readdir, statOf)
    expect(io.exitCode).toBe(1)
    expect(
      new TextDecoder()
        .decode(out as Uint8Array)
        .split('\n')
        .slice(0, 2),
    ).toEqual([
      '--- "a b"\t2026-01-02 03:04:05.000000000 +0000',
      '+++ c\t2026-01-02 03:04:05.000000000 +0000',
    ])
    const gone = {
      flags: { u: true, new_file: true },
      stdin: new Uint8Array(),
    } as unknown as CommandOpts
    const [absent] = await diffGeneric(
      [operand('c', '/d/c'), operand('gone', '/d/gone')],
      gone,
      read,
      readdir,
      statOf,
    )
    expect(new TextDecoder().decode(absent as Uint8Array).split('\n')[1]).toBe(
      '+++ gone\t1970-01-01 00:00:00.000000000 +0000',
    )
  })
})
