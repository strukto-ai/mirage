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
import { describe, expect, it, vi } from 'vitest'
import { FileStat, FileType, PathSpec } from '../../../types.ts'
import { rstripSlash } from '../../../utils/slash.ts'
import { materialize, type ByteSource } from '../../../io/types.ts'
import type { CommandFn, CommandOpts } from '../../config.ts'
import * as helpers from '../../../shell/helpers.ts'
import { rgGeneric } from './rg.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

const FOLDERS = new Set(['/', '/d1', '/d2'])

const FILES: Record<string, string> = {
  '/d1/a.txt': 'hello a\n',
  '/d1/data.parquet': 'hello parquet\n',
  '/d2/b.txt': 'hello b\n',
  '/top1.txt': 'hello one\n',
  '/top2.txt': 'hello two\n',
}

function key(p: PathSpec): string {
  return rstripSlash(p.virtual) || '/'
}

function spec(path: string): PathSpec {
  return new PathSpec({
    virtual: path,
    directory: path,
    resolved: false,
    vfsPath: mountKey(path, ''),
  })
}

function opts(
  flags: Record<string, string | boolean | number | string[]>,
  filetypeFns: Record<string, CommandFn> | null = null,
): CommandOpts {
  return {
    stdin: null,
    flags,
    filetypeFns,
    cwd: '/',
    vfs: null,
  } as unknown as CommandOpts
}

const stat = (p: PathSpec): Promise<FileStat> => {
  const k = key(p)
  if (!FOLDERS.has(k) && FILES[k] === undefined) {
    return Promise.reject(new Error(`ENOENT: ${k}`))
  }
  return Promise.resolve(
    new FileStat({
      name: k.split('/').pop() ?? '',
      type: FOLDERS.has(k) ? FileType.DIRECTORY : FileType.FILE,
    }),
  )
}

const readdir = (p: PathSpec): Promise<string[]> => {
  const k = key(p)
  if (k === '/') return Promise.resolve(['/d1', '/d2', '/top1.txt', '/top2.txt'])
  if (k === '/d1') return Promise.resolve(['/d1/a.txt', '/d1/data.parquet'])
  if (k === '/d2') return Promise.resolve(['/d2/b.txt'])
  return Promise.reject(new Error(`ENOTDIR: ${k}`))
}

async function* stream(p: PathSpec): AsyncIterable<Uint8Array> {
  await Promise.resolve()
  const content = FILES[key(p)]
  if (content === undefined) throw new Error(`ENOENT: ${p.virtual}`)
  yield ENC.encode(content)
}

async function run(
  paths: string[],
  flags: Record<string, string | boolean | number | string[]>,
  filetypeFns: Record<string, CommandFn> | null = null,
): Promise<string> {
  const [out] = (await rgGeneric(
    paths.map(spec),
    ['hello'],
    opts(flags, filetypeFns),
    stat,
    readdir,
    stream,
  )) as [ByteSource, unknown]
  return DEC.decode(await materialize(out))
}

const fakeFiletypeFn = (() => {
  throw new Error('not called')
}) as unknown as CommandFn

describe('rgGeneric multi-path dispatch', () => {
  it('searches every directory argument', async () => {
    expect(await run(['/d1', '/d2'], {})).toBe('/d1/a.txt:hello a\n/d2/b.txt:hello b\n')
  })

  it('lists every file argument with -l', async () => {
    expect(await run(['/top1.txt', '/top2.txt'], { args_l: true })).toBe('/top1.txt\n/top2.txt\n')
  })

  it('searches every directory argument in the filetype walk', async () => {
    expect(await run(['/d1', '/d2'], {}, { parquet: fakeFiletypeFn })).toBe(
      '/d1/a.txt:hello a\n/d2/b.txt:hello b\n',
    )
  })
})

describe('rgGeneric columnar skip', () => {
  it('skips columnar files in the recursive walk', async () => {
    expect(await run(['/d1'], {})).toBe('/d1/a.txt:hello a\n')
  })

  it('skips columnar files in the filetype folder walk', async () => {
    expect(await run(['/d1'], {}, { parquet: fakeFiletypeFn })).toBe('/d1/a.txt:hello a\n')
  })
})

describe('rgGeneric -H/-I filename labels', () => {
  it('-H -m1 stops reading a remote file after the requested match', async () => {
    const firstChunk = ENC.encode('hello one\n')
    async function* limitedStream(_path: PathSpec): AsyncIterable<Uint8Array> {
      yield await Promise.resolve(firstChunk)
      throw new Error('read past the requested match')
    }
    const result = await rgGeneric(
      [spec('/top1.txt')],
      ['hello'],
      opts({ H: true, m: 1 }),
      stat,
      readdir,
      limitedStream,
    )
    if (result === null) throw new Error('rg returned no result')
    const [out, io] = result
    expect(DEC.decode(await materialize(out))).toBe('/top1.txt:hello one\n')
    expect(io.exitCode).toBe(0)
  })

  it('-H labels a single file like ripgrep --with-filename', async () => {
    expect(await run(['/top1.txt'], { H: true })).toBe('/top1.txt:hello one\n')
  })

  it('-H labels a single-file count', async () => {
    expect(await run(['/top1.txt'], { H: true, c: true })).toBe('/top1.txt:1\n')
  })

  it('-I suppresses multi-file labels like ripgrep --no-filename', async () => {
    expect(await run(['/top1.txt', '/top2.txt'], { args_I: true })).toBe('hello one\nhello two\n')
  })
})

async function* endlessAfterFirstMatch(): AsyncIterable<Uint8Array> {
  await Promise.resolve()
  yield ENC.encode('hello\n')
  throw new Error('the probe read past the first selected line')
}

async function runStdin(
  stdin: ByteSource,
  flags: Record<string, string | boolean | number | string[]>,
): Promise<[string, number]> {
  const [out, io] = (await rgGeneric(
    [],
    ['hello'],
    { ...opts(flags), stdin },
    stat,
    readdir,
    stream,
  )) as [ByteSource, { exitCode: number }]
  return [DEC.decode(await materialize(out)), io.exitCode]
}

describe('rgGeneric --files-without-match on stdin', () => {
  it('stops at the first selected line instead of buffering the stream', async () => {
    // A stdin that never ends must not be materialized whole.
    expect(await runStdin(endlessAfterFirstMatch(), { files_without_match: true })).toEqual(['', 1])
  })

  it('names a matchless stdin <stdin>', async () => {
    expect(await runStdin(ENC.encode('x\ny\n'), { files_without_match: true })).toEqual([
      '<stdin>\n',
      0,
    ])
  })

  it('lists nothing under -m0, matched input or not', async () => {
    // ripgrep 14.1.1: `printf 'x\n' | rg --files-without-match -m0 hello`
    // prints nothing and exits 1.
    for (const data of ['x\n', 'hello\n']) {
      expect(await runStdin(ENC.encode(data), { files_without_match: true, m: '0' })).toEqual([
        '',
        1,
      ])
    }
  })
})

it.each([
  [[], false],
  [['/top1.txt'], false],
  [['/top1.txt'], true],
  [['/top1.txt', '/top2.txt'], false],
] as const)('cancels streaming matches for paths=%j, -H=%s', async (paths, withFilename) => {
  const controller = new AbortController()
  const data = ENC.encode('hello '.repeat(100000) + '\n')
  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false
  async function* source(): AsyncIterable<Uint8Array> {
    try {
      yield await Promise.resolve(data)
      throw new Error('read beyond the matching line')
    } finally {
      closed = true
    }
  }
  const original = helpers.byteOffset
  const offset = vi.spyOn(helpers, 'byteOffset').mockImplementation((text, index) => {
    timer ??= setTimeout(() => {
      controller.abort()
    }, 0)
    return original(text, index)
  })
  async function scan(): Promise<void> {
    const result = await rgGeneric(
      paths.map(spec),
      ['hello'],
      {
        ...opts({ o: true, byte_offset: true, H: withFilename }),
        stdin: paths.length === 0 ? source() : null,
        signal: controller.signal,
      },
      stat,
      readdir,
      source,
    )
    if (result === null) throw new Error('rg returned no result')
    await materialize(result[0])
  }
  try {
    await expect(scan()).rejects.toMatchObject({ name: 'AbortError' })
    expect(offset.mock.calls.length).toBeGreaterThan(0)
    expect(offset.mock.calls.length).toBeLessThan(100000)
    expect(closed).toBe(true)
  } finally {
    clearTimeout(timer)
    offset.mockRestore()
  }
})
