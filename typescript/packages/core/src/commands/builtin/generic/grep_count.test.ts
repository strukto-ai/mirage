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
import { materialize, type IOResult } from '../../../io/types.ts'
import { FileStat, FileType, PathSpec } from '../../../types.ts'
import type { CommandOpts } from '../../config.ts'
import { grepGeneric } from './grep.ts'

type GrepOut = Uint8Array | AsyncIterable<Uint8Array> | null

const ENC = new TextEncoder()
const DEC = new TextDecoder()

const FILES: Record<string, string> = {
  '/a.txt': 'hello\nworld\n',
  '/b.txt': 'world\n',
  '/d/a.txt': 'hello\n',
}

function spec(path: string): PathSpec {
  return new PathSpec({
    virtual: path,
    directory: path,
    resolved: true,
    resourcePath: mountKey(path, ''),
  })
}

function opts(
  flags: Record<string, string | boolean | string[]>,
  stdin: Uint8Array | null = null,
): CommandOpts {
  return {
    stdin,
    flags,
    filetypeFns: null,
    cwd: '/',
    resource: null,
  } as unknown as CommandOpts
}

const stat = (p: PathSpec): Promise<FileStat> =>
  Promise.resolve(
    new FileStat({
      name: p.virtual.split('/').pop() ?? '',
      type: p.virtual in FILES ? FileType.TEXT : FileType.DIRECTORY,
    }),
  )
const readdir = (p: PathSpec): Promise<string[]> =>
  Promise.resolve(p.virtual.replace(/\/+$/, '') === '/d' ? ['/d/a.txt'] : [])

async function* fileStream(p: PathSpec): AsyncIterable<Uint8Array> {
  await Promise.resolve()
  yield ENC.encode(FILES[p.virtual] ?? '')
}

async function decode(out: GrepOut): Promise<string> {
  if (out === null) return ''
  return DEC.decode(out instanceof Uint8Array ? out : await materialize(out))
}

async function runGrep(
  paths: PathSpec[],
  pattern: string,
  flags: Record<string, string | boolean | string[]>,
  stdin: Uint8Array | null = null,
): Promise<[string, IOResult]> {
  const [out, io] = (await grepGeneric(
    'grep',
    paths,
    [pattern],
    opts(flags, stdin),
    stat,
    readdir,
    fileStream,
  )) as [GrepOut, IOResult]
  return [await decode(out), io]
}

describe('grepGeneric count-only exit codes', () => {
  it('grep -c prints 0 and exits 1 on a single file with no match', async () => {
    const [out, io] = await runGrep([spec('/a.txt')], 'zzz', { c: true })
    expect(out.trim()).toBe('0')
    expect(io.exitCode).toBe(1)
  })

  it('grep -c exits 0 on a single file with matches', async () => {
    const [out, io] = await runGrep([spec('/a.txt')], 'hello', { c: true })
    expect(out.trim()).toBe('1')
    expect(io.exitCode).toBe(0)
  })

  it('grep -c on stdin prints 0 and exits 1 with no match', async () => {
    const [out, io] = await runGrep([], 'zzz', { c: true }, ENC.encode('hello\nworld\n'))
    expect(out.trim()).toBe('0')
    expect(io.exitCode).toBe(1)
  })

  it('grep -c on multiple files exits 1 when all counts are zero', async () => {
    const [out, io] = await runGrep([spec('/a.txt'), spec('/b.txt')], 'zzz', { c: true })
    expect(out.trim().split('\n')).toEqual(['/a.txt:0', '/b.txt:0'])
    expect(io.exitCode).toBe(1)
  })

  it('grep -c on multiple files exits 0 when any count is nonzero', async () => {
    const [out, io] = await runGrep([spec('/a.txt'), spec('/b.txt')], 'hello', { c: true })
    expect(out.trim().split('\n')).toEqual(['/a.txt:1', '/b.txt:0'])
    expect(io.exitCode).toBe(0)
  })

  it('grep -rc exits 1 when no file in the tree matches', async () => {
    const [out, io] = await runGrep([spec('/d')], 'zzz', { r: true, c: true })
    expect(out.trim().split('\n')).toEqual(['/d/a.txt:0'])
    expect(io.exitCode).toBe(1)
  })
})
