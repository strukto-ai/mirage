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

import { mountKey } from '../../../utils/key_prefix.ts'
import { noMount } from '../../../errors/fs.ts'
import { describe, expect, it } from 'vitest'
import { materialize, type IOResult } from '../../../io/types.ts'
import { FileStat, FileType, PathSpec } from '../../../types.ts'
import type { CommandOpts } from '../../config.ts'
import { grepGeneric, labelled } from './grep.ts'
import { prependStderr } from '../utils/output.ts'
import { yieldBytes } from '../../../io/stream.ts'

type GrepOut = Uint8Array | AsyncIterable<Uint8Array> | null

const ENC = new TextEncoder()
const DEC = new TextDecoder()

function spec(path: string): PathSpec {
  return new PathSpec({
    virtual: path,
    directory: path,
    resolved: false,
    vfsPath: mountKey(path, ''),
  })
}

function opts(flags: Record<string, string | boolean | number | string[]>): CommandOpts {
  return {
    stdin: null,
    flags,
    cwd: '/',
    vfs: null,
  } as unknown as CommandOpts
}

const stat = (p: PathSpec): Promise<FileStat> =>
  Promise.resolve(
    new FileStat({
      name: p.virtual.split('/').pop() ?? '',
      type: p.virtual === '/data' ? FileType.DIRECTORY : FileType.FILE,
    }),
  )
const readdir = (p: PathSpec): Promise<string[]> =>
  Promise.resolve(p.virtual === '/data' ? ['/data/a.txt', '/data/bad.txt'] : [])

async function* good(): AsyncIterable<Uint8Array> {
  await Promise.resolve()
  yield ENC.encode('alice\n')
}
function stream(p: PathSpec): AsyncIterable<Uint8Array> {
  if (p.virtual === '/data/bad.txt') throw Object.assign(new Error('boom'), { code: 'EACCES' })
  // A real backend cannot read a directory, so neither does the fake: a
  // stream that served bytes here would let a -l test pass on the harness
  // rather than on the code.
  if (p.virtual === '/data') throw new Error('EISDIR')
  return good()
}

async function decode(out: GrepOut): Promise<string> {
  if (out === null) return ''
  return DEC.decode(out instanceof Uint8Array ? out : await materialize(out))
}

async function runGrep(
  flags: Record<string, string | boolean | number | string[]>,
  paths: PathSpec[] = [spec('/data')],
): Promise<[GrepOut, IOResult]> {
  const result = await grepGeneric('grep', paths, ['alice'], opts(flags), stat, readdir, stream)
  const [out, io] = result as [GrepOut, IOResult]
  return [out === null ? null : await materialize(out), io]
}

describe('grepGeneric recursive warnings', () => {
  it('grep -r threads a stderr warning when a file read fails', async () => {
    const [out, io] = await runGrep({ r: true })
    expect(await decode(out)).toBe('/data/a.txt:alice\n')
    expect(io.stderr).not.toBeUndefined()
    expect(DEC.decode(io.stderr as Uint8Array)).toBe('grep: /data/bad.txt: Permission denied\n')
    expect(io.exitCode).toBe(2)
  })

  it('grep -rl threads a stderr warning when a file read fails', async () => {
    const [out, io] = await runGrep({ r: true, args_l: true })
    expect(await decode(out)).toBe('/data/a.txt\n')
    expect(DEC.decode(io.stderr as Uint8Array)).toBe('grep: /data/bad.txt: Permission denied\n')
  })
})

describe('grepGeneric operand errors', () => {
  it('grep -rq skips errors after its first match', async () => {
    const [out, io] = await runGrep({ r: true, q: true })
    expect(await decode(out)).toBe('')
    expect(await decode(io.stderr)).toBe('')
    expect(io.exitCode).toBe(0)
  })

  it('grep -rq lets a match outrank an earlier failed operand', async () => {
    const [, io] = await runGrep({ r: true, q: true }, [spec('/data/bad.txt'), spec('/data')])
    expect(DEC.decode(io.stderr as Uint8Array)).toBe('grep: /data/bad.txt: Permission denied\n')
    expect(io.exitCode).toBe(0)
  })
})

describe('grepGeneric excluded entries', () => {
  it('keeps walking when an excluded entry fails stat', async () => {
    const probe = (p: PathSpec): Promise<FileStat> => {
      if (p.virtual === '/data/0ghost')
        return Promise.reject(Object.assign(new Error('gone'), { code: 'ENOENT' }))
      return stat(p)
    }
    const listing = (p: PathSpec): Promise<string[]> =>
      Promise.resolve(p.virtual === '/data' ? ['/data/0ghost', '/data/a.txt'] : [])
    const [out, io] = (await grepGeneric(
      'grep',
      [spec('/data')],
      ['alice'],
      opts({ r: true, exclude_dir: ['0ghost'] }),
      probe,
      listing,
      stream,
    )) as [GrepOut, IOResult]
    expect(await decode(out)).toBe('/data/a.txt:alice\n')
    expect(DEC.decode(io.stderr as Uint8Array)).toBe(
      'grep: /data/0ghost: No such file or directory\n',
    )
    expect(io.exitCode).toBe(2)
  })
})

describe('labelled', () => {
  it.each([
    [{ r: true }, { r: true, H: true }],
    [
      { r: true, h: true },
      { r: true, h: true },
    ],
    [
      { H: true, h: true },
      { H: true, h: true },
    ],
    [
      { h: true, H: true },
      { h: true, H: true },
    ],
  ])('asks for filenames only when the line did not decide: %j', (flags, expected) => {
    const out = labelled(opts(flags))
    expect(out.flags).toEqual(expected)
    expect(Object.keys(out.flags)).toEqual(Object.keys(expected))
  })
})

describe('grepGeneric failures that are not filesystem errors', () => {
  const broken = (): AsyncIterable<Uint8Array> => {
    throw new Error('token expired')
  }
  async function scanned(
    paths: PathSpec[],
    flags: Record<string, string | boolean | number | string[]>,
  ): Promise<string> {
    const [out] = (await grepGeneric(
      'grep',
      paths,
      ['alice'],
      opts(flags),
      stat,
      readdir,
      broken,
    )) as [GrepOut, IOResult]
    return decode(out)
  }

  it.each([false, true])(
    'propagate out of a recursive walk (suppressed=%s)',
    async (noMessages) => {
      await expect(scanned([spec('/data')], { r: true, no_messages: noMessages })).rejects.toThrow(
        'token expired',
      )
    },
  )

  it.each([false, true])(
    'propagate out of a single-file read (suppressed=%s)',
    async (noMessages) => {
      await expect(scanned([spec('/data/a.txt')], { no_messages: noMessages })).rejects.toThrow(
        'token expired',
      )
    },
  )
})

describe('grepGeneric no messages', () => {
  it.each<[string[], Record<string, boolean>, string, number]>([
    [['/missing'], {}, '', 2],
    [['/data'], {}, '', 2],
    [['/data/bad.txt'], {}, '', 2],
    [['/missing', '/data/a.txt'], {}, '/data/a.txt:alice\n', 2],
    [['/missing', '/data/a.txt'], { q: true }, '', 0],
    [['/data'], { r: true }, '/data/a.txt:alice\n', 2],
  ])('suppresses diagnostics for %j, preserving status', async (paths, flags, expected, status) => {
    const probe = (p: PathSpec): Promise<FileStat> =>
      p.virtual === '/missing'
        ? Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }))
        : stat(p)
    const [out, io] = (await grepGeneric(
      'grep',
      paths.map(spec),
      ['alice'],
      opts({ no_messages: true, ...flags }),
      probe,
      readdir,
      stream,
    )) as [GrepOut, IOResult]
    expect(await decode(out)).toBe(expected)
    expect(await io.stderrStr()).toBe('')
    expect(io.exitCode).toBe(status)
  })

  it.each([false, true])(
    'handles errors while draining a single file (suppressed=%s)',
    async (noMessages) => {
      async function* unreadable(p: PathSpec): AsyncIterable<Uint8Array> {
        await Promise.resolve()
        if (p.virtual === '/data/bad.txt')
          throw Object.assign(new Error('denied'), { code: 'EACCES' })
        yield* good()
      }
      const [out, io] = (await grepGeneric(
        'grep',
        [spec('/data/bad.txt')],
        ['alice'],
        opts({ no_messages: noMessages }),
        stat,
        readdir,
        unreadable,
      )) as [GrepOut, IOResult]
      expect(await decode(out)).toBe('')
      expect(await io.stderrStr()).toBe(
        noMessages ? '' : 'grep: /data/bad.txt: Permission denied\n',
      )
      expect(io.exitCode).toBe(2)
    },
  )
})

it.each([['/data/a.txt'], ['/data/a.txt', '/data/b.txt'], ['/data']])(
  'grep -s propagates decoding failures while draining %j',
  async (...paths) => {
    const error = new SyntaxError('invalid backend JSON')
    async function* broken(): AsyncIterable<Uint8Array> {
      await Promise.resolve()
      yield ENC.encode('alice\n')
      throw error
    }
    const [out] = (await grepGeneric(
      'grep',
      paths.map(spec),
      ['alice'],
      opts({ no_messages: true, r: true }),
      stat,
      readdir,
      broken,
    )) as [GrepOut, IOResult]
    await expect(decode(out)).rejects.toBe(error)
  },
)

it.each(['stat', 'readdir', 'read'] as const)(
  'grep -s limits missing-mount handling to probes (%s)',
  async (phase) => {
    const error = noMount('/data')
    const probe = (p: PathSpec): Promise<FileStat> =>
      phase === 'stat' ? Promise.reject(error) : stat(p)
    const listing = (p: PathSpec): Promise<string[]> =>
      phase === 'readdir' ? Promise.reject(error) : readdir(p)
    async function* broken(): AsyncIterable<Uint8Array> {
      await Promise.resolve()
      yield ENC.encode('alice\n')
      throw error
    }
    const [out, io] = (await grepGeneric(
      'grep',
      [spec('/data')],
      ['alice'],
      opts({ no_messages: true, r: true }),
      probe,
      listing,
      broken,
    )) as [GrepOut, IOResult]
    if (phase === 'read') {
      await expect(decode(out)).rejects.toBe(error)
    } else {
      expect(await decode(out)).toBe('')
      expect(io.exitCode).toBe(2)
      expect(await io.stderrStr()).toBe('')
    }
  },
)

describe('grepGeneric streaming results', () => {
  it.each<[string[], Record<string, boolean>]>([
    [['/data/a.txt'], {}],
    [['/data/a.txt', '/data/b.txt'], {}],
    [['/data'], { r: true }],
  ])('publishes status before yielding and on early close for %j', async (paths, flags) => {
    for (const missing of [false, true]) {
      const closed: string[] = []
      async function* read(p: PathSpec): AsyncIterable<Uint8Array> {
        try {
          yield* yieldBytes(ENC.encode('alice\nalice\n'))
        } finally {
          closed.push(p.virtual)
        }
      }
      const probe = (p: PathSpec): Promise<FileStat> =>
        p.virtual === '/missing'
          ? Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }))
          : stat(p)
      const [out, io] = (await grepGeneric(
        'grep',
        [...(missing ? ['/missing'] : []), ...paths].map(spec),
        ['alice'],
        opts(flags),
        probe,
        readdir,
        read,
      )) as [AsyncIterable<Uint8Array>, IOResult]
      const iterator = out[Symbol.asyncIterator]()
      const expected = missing ? 2 : 0
      expect((await iterator.next()).done).toBe(false)
      expect(io.exitCode).toBe(expected)
      await iterator.return?.()
      expect(io.exitCode).toBe(expected)
      expect(closed).toEqual(['/data/a.txt'])
      expect(await io.stderrStr()).toBe(
        missing ? 'grep: /missing: No such file or directory\n' : '',
      )
    }
  })

  it.each([false, true])(
    'retains a binary notice before a read failure (suppressed=%s)',
    async (noMessages) => {
      async function* read(): AsyncIterable<Uint8Array> {
        yield* yieldBytes(new Uint8Array([...ENC.encode('alice'), 255, 10]))
        throw Object.assign(new Error('denied'), { code: 'EACCES' })
      }
      const [out, io] = (await grepGeneric(
        'grep',
        [spec('/data/a.txt')],
        ['alice'],
        { ...opts({ no_messages: noMessages }), env: { LC_ALL: 'C.UTF-8' } },
        stat,
        readdir,
        read,
      )) as [GrepOut, IOResult]
      expect(await decode(out)).toBe('')
      expect(io.exitCode).toBe(2)
      expect(await io.stderrStr()).toBe(
        'grep: /data/a.txt: binary file matches\n' +
          (noMessages ? '' : 'grep: /data/a.txt: Permission denied\n'),
      )
    },
  )

  it('preserves diagnostics added by a wrapper before drain', async () => {
    const [out, io] = (await grepGeneric(
      'grep',
      [spec('/data/bad.txt'), spec('/data/a.txt')],
      ['*alice'],
      opts({ E: true }),
      stat,
      readdir,
      stream,
    )) as [GrepOut, IOResult]
    await prependStderr(io, ['backend: scan fallback'])
    expect(await decode(out)).toBe('/data/a.txt:alice\n')
    expect(io.exitCode).toBe(2)
    expect(await io.stderrStr()).toBe(
      'backend: scan fallback\ngrep: warning: * at start of expression\ngrep: /data/bad.txt: Permission denied\n',
    )
  })
})

it('settles late binary detection after a match', async () => {
  async function* read(): AsyncIterable<Uint8Array> {
    yield* yieldBytes(ENC.encode('alice\n'))
    yield* yieldBytes(new Uint8Array([0]))
  }
  const [out, io] = (await grepGeneric(
    'grep',
    [spec('/data/a.txt')],
    ['alice'],
    opts({ args_I: true }),
    stat,
    readdir,
    read,
  )) as [AsyncIterable<Uint8Array>, IOResult]
  const iterator = out[Symbol.asyncIterator]()
  expect(await iterator.next()).toEqual({ done: false, value: ENC.encode('alice\n') })
  expect(io.exitCode).toBe(0)
  expect(await iterator.next()).toEqual({ done: true, value: undefined })
  expect(io.exitCode).toBe(1)
})

it('flushes a binary notice on early close', async () => {
  async function* read(): AsyncIterable<Uint8Array> {
    yield* yieldBytes(new Uint8Array([...ENC.encode('alice'), 255, 10]))
    yield* yieldBytes(ENC.encode('alice\n'))
  }
  const [out, io] = (await grepGeneric(
    'grep',
    [spec('/data/a.txt')],
    ['alice'],
    { ...opts({}), env: { LC_ALL: 'C.UTF-8' } },
    stat,
    readdir,
    read,
  )) as [AsyncIterable<Uint8Array>, IOResult]
  const iterator = out[Symbol.asyncIterator]()
  expect(await iterator.next()).toEqual({ done: false, value: ENC.encode('alice\n') })
  await iterator.return?.()
  expect(io.exitCode).toBe(0)
  expect(await io.stderrStr()).toBe('grep: /data/a.txt: binary file matches\n')
})
