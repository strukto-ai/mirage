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
import { describe, expect, it } from 'vitest'
import { FileStat, FileType, PathSpec } from '../../../types.ts'
import { rstripSlash } from '../../../utils/slash.ts'
import { materialize, type ByteSource } from '../../../io/types.ts'
import type { CommandFn, CommandOpts } from '../../config.ts'
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
    resourcePath: mountKey(path, ''),
  })
}

function opts(
  flags: Record<string, string | boolean | string[]>,
  filetypeFns: Record<string, CommandFn> | null = null,
): CommandOpts {
  return {
    stdin: null,
    flags,
    filetypeFns,
    cwd: '/',
    resource: null,
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
      type: FOLDERS.has(k) ? FileType.DIRECTORY : FileType.TEXT,
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
  flags: Record<string, string | boolean | string[]>,
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
