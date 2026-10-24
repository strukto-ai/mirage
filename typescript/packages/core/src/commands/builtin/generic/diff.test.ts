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
import { diffGeneric, quoteHeaderName, switchWords } from './diff.ts'
import { FileStat, FileType, PathSpec } from '../../../types.ts'
import type { Context } from '../../config.ts'
import type { DispatchFn } from '../../../runtime/types.ts'
import { Files } from '../../../workspace/files.ts'
import { UsageError } from '../../errors.ts'
import { PipeClosed } from '../../../io/errors.ts'
import { CommandTimeoutError } from '../../../errors/types.ts'
import { IOResult, materialize } from '../../../io/types.ts'
import type { DiffComputer, PairOutcome } from '../../../rs/diff_types.ts'
import { DiffPool } from '../../../rs/diff_pool.ts'
import { eacces } from '../../../errors/fs.ts'

const ENC = new TextEncoder()

function operand(raw: string, virtual: string): PathSpec {
  return new PathSpec({ virtual, directory: virtual, vfsPath: virtual.slice(3), rawPath: raw })
}

const DASH = operand('-', '/d/-')
const DEV_STDIN = new PathSpec({ virtual: '/dev/stdin', directory: '/dev', vfsPath: 'stdin' })
const DIRS: Record<string, string[]> = { '/d/sub': ['x'], '/d/sub2': ['x', 'y'] }

function statFiles(modified: string): Files {
  const dispatch: DispatchFn = (op, path) => {
    if (op !== 'stat') return Promise.reject(new Error(`unexpected ${op}`))
    const stat = new FileStat({ name: path.virtual, type: FileType.FILE, modified })
    return Promise.resolve([stat, new IOResult()])
  }
  return new Files(dispatch, null, null, { ledger: false })
}

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
    const ctx = { flags: {}, stdin: ENC.encode('abc') } as unknown as Context
    const [out, io] = await diffGeneric([DASH, DEV_STDIN], ctx, unread, readdir, stat)
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
  it('C-quotes a header name the way GNU diff does', () => {
    expect(quoteHeaderName('plain/é\x7f')).toBe('plain/é\x7f')
    expect(quoteHeaderName('sp ace')).toBe('"sp ace"')
    expect(quoteHeaderName('t\tq"b\\')).toBe('"t\\tq\\"b\\\\"')
    expect(quoteHeaderName('c\x01')).toBe('"c\\001"')
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
    const vfs = statFiles('2021-06-15T12:00:00Z')
    const ctx = { flags: { u: true }, stdin: new Uint8Array(), vfs } as unknown as Context
    const [out] = await diffGeneric(
      [operand('a', '/d/a'), operand('b', '/d/b')],
      ctx,
      read,
      readdir,
      backend,
    )
    expect(new TextDecoder().decode(await materialize(out)).split('\n')[0]).toBe(
      '--- a\t2021-06-15 12:00:00.000000000 +0000',
    )
  })

  it('reads in the TZ zone with every digit of the stamp', async () => {
    const read = async function* (): AsyncIterable<Uint8Array> {
      await Promise.resolve()
      yield ENC.encode('x\n')
    }
    const backend = (p: PathSpec): Promise<FileStat> =>
      p.virtual === '/d/gone'
        ? Promise.reject(Object.assign(new Error(p.virtual), { code: 'ENOENT' }))
        : Promise.resolve(new FileStat({ name: p.virtual, type: FileType.FILE }))
    const ctx = {
      flags: { u: true, new_file: true },
      stdin: new Uint8Array(),
      vfs: statFiles('2026-03-04T05:06:07.123456789Z'),
      env: { TZ: 'Asia/Hong_Kong' },
    } as unknown as Context
    const [out] = await diffGeneric(
      [operand('a', '/d/a'), operand('gone', '/d/gone')],
      ctx,
      read,
      readdir,
      backend,
    )
    expect(
      new TextDecoder()
        .decode(await materialize(out))
        .split('\n')
        .slice(0, 2),
    ).toEqual([
      '--- a\t2026-03-04 13:06:07.123456789 +0800',
      '+++ gone\t1970-01-01 08:00:00.000000000 +0800',
    ])
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
    const ctx = { flags: { u: true }, stdin: new Uint8Array() } as unknown as Context
    const [out, io] = await diffGeneric(pair, ctx, read, readdir, statOf)
    expect(io.exitCode).toBe(1)
    expect(
      new TextDecoder()
        .decode(await materialize(out))
        .split('\n')
        .slice(0, 2),
    ).toEqual([
      '--- "a b"\t2026-01-02 03:04:05.000000000 +0000',
      '+++ c\t2026-01-02 03:04:05.000000000 +0000',
    ])
    const gone = {
      flags: { u: true, new_file: true },
      stdin: new Uint8Array(),
    } as unknown as Context
    const [absent] = await diffGeneric(
      [operand('c', '/d/c'), operand('gone', '/d/gone')],
      gone,
      read,
      readdir,
      statOf,
    )
    expect(new TextDecoder().decode(await materialize(absent)).split('\n')[1]).toBe(
      '+++ gone\t1970-01-01 00:00:00.000000000 +0000',
    )
  })
})

it('reports a read failing mid-stream as trouble and closes its input', async () => {
  const closed: string[] = []
  async function* read(p: PathSpec): AsyncIterable<Uint8Array> {
    try {
      yield ENC.encode('x\n')
      await Promise.resolve()
      if (p.virtual === '/d/a') throw eacces(p)
      yield ENC.encode('y\n')
    } finally {
      closed.push(p.virtual)
    }
  }
  const pool = new DiffPool()
  const ctx: Context = { flags: {}, stdin: null, cwd: PathSpec.fromStrPath('/'), diff: pool }
  try {
    const failed = [operand('a', '/d/a'), operand('b', '/d/b')]
    const [out, io] = await diffGeneric(failed, ctx, read, readdir, stat)
    expect([out, io.exitCode]).toEqual([null, 2])
    expect(new TextDecoder().decode(await materialize(io.stderr))).toBe(
      'diff: a: Permission denied\n',
    )
    expect(closed).toEqual(['/d/a'])
    const same = [operand('b', '/d/b'), operand('c', '/d/c')]
    const [, again] = await diffGeneric(same, ctx, read, readdir, stat)
    expect(again.exitCode).toBe(0)
    expect(closed).toEqual(['/d/a', '/d/b', '/d/c'])
  } finally {
    await pool.close()
  }
})

it.each([
  new CommandTimeoutError('diff', 1),
  new PipeClosed(),
  new UsageError('diff: scope refused', 1),
  new DOMException('execute aborted', 'AbortError'),
])('preserves host control failures raised by filesystem work, %s', async (failure) => {
  const unread = (_path: PathSpec): AsyncIterable<Uint8Array> => {
    throw new Error('unexpected input read')
  }
  const ctx: Context = { flags: { recursive: true }, stdin: null, cwd: PathSpec.fromStrPath('/') }
  await expect(
    diffGeneric([operand('a', '/d/a'), operand('b', '/d/b')], ctx, unread, readdir, () =>
      Promise.reject(failure),
    ),
  ).rejects.toBe(failure)
})

describe('diff with many output chunks', () => {
  const output = Array.from({ length: 200_000 }, (_, i) => ENC.encode(i < 100_000 ? '<' : '>'))
  const expected = '<'.repeat(100_000) + '>'.repeat(100_000)
  const unread = (_path: PathSpec): AsyncIterable<Uint8Array> => {
    throw new Error('unexpected input read')
  }
  const directories = new Set(['/d/a', '/d/b', '/d/a/sub', '/d/b/sub'])
  const directoryStat = (path: PathSpec): Promise<FileStat> =>
    Promise.resolve(
      new FileStat({
        name: path.virtual,
        type: directories.has(path.virtual) ? FileType.DIRECTORY : FileType.FILE,
      }),
    )
  const children = (path: PathSpec): Promise<string[]> =>
    Promise.resolve(path.virtual.endsWith('/sub') ? ['x'] : ['sub'])

  it.each<PairOutcome>(['equal', 'different'])(
    'preserves %s output through nested directories',
    async (outcome) => {
      const computer: DiffComputer = {
        compare: () =>
          Promise.resolve({ outcome, status: outcome === 'equal' ? 0 : 1, output, stderr: [] }),
      }
      const ctx: Context = {
        flags: { recursive: true },
        argv: ['-r', 'a', 'b'],
        stdin: null,
        cwd: PathSpec.fromStrPath('/'),
        diff: computer,
      }
      const [out, io] = await diffGeneric(
        [operand('a', '/d/a'), operand('b', '/d/b')],
        ctx,
        unread,
        children,
        directoryStat,
      )
      expect(io.exitCode).toBe(outcome === 'equal' ? 0 : 1)
      expect(new TextDecoder().decode(await materialize(io.stderr))).toBe('')
      const header = outcome === 'different' ? 'diff -r a/sub/x b/sub/x\n' : ''
      expect(new TextDecoder().decode(await materialize(out))).toBe(header + expected)
    },
  )

  it.each([false, true])('preserves diagnostics with recursive=%s', async (recursive) => {
    const computer: DiffComputer = {
      compare: () =>
        Promise.resolve({ outcome: 'different', status: 2, output: [], stderr: output }),
    }
    const ctx: Context = {
      flags: { recursive },
      stdin: null,
      cwd: PathSpec.fromStrPath('/'),
      diff: computer,
    }
    const [out, io] = await diffGeneric(
      [operand('a', '/d/a'), operand('b', '/d/b')],
      ctx,
      unread,
      children,
      recursive ? directoryStat : stat,
    )
    expect(io.exitCode).toBe(2)
    expect(new TextDecoder().decode(await materialize(io.stderr))).toBe(expected)
    expect(new TextDecoder().decode(await materialize(out))).toBe(
      recursive ? 'diff a/sub/x b/sub/x\n' : '',
    )
  })
})
