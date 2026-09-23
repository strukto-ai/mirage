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
import { grepGeneric, labelled } from './grep.ts'

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
    filetypeFns: null,
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
): Promise<[GrepOut, IOResult]> {
  const result = await grepGeneric(
    'grep',
    [spec('/data')],
    ['alice'],
    opts(flags),
    stat,
    readdir,
    stream,
  )
  return result as [GrepOut, IOResult]
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

  it('grep on a single directory operand warns and exits 2', async () => {
    const [out, io] = await runGrep({})
    expect(await decode(out)).toBe('')
    expect(DEC.decode(io.stderr as Uint8Array)).toBe('grep: /data: Is a directory\n')
    expect(io.exitCode).toBe(2)
  })
})

describe('grepGeneric operand errors', () => {
  // The directory holds a match, so a walk would put a filename on stdout.
  it('grep -l names a directory operand without walking it', async () => {
    const [out, io] = await runGrep({ args_l: true })
    expect(await decode(out)).toBe('')
    expect(DEC.decode(io.stderr as Uint8Array)).toBe('grep: /data: Is a directory\n')
    expect(io.exitCode).toBe(2)
  })

  it('grep -q reports a failed operand as 2 when nothing matched', async () => {
    const [, io] = await runGrep({ q: true })
    expect(DEC.decode(io.stderr as Uint8Array)).toBe('grep: /data: Is a directory\n')
    expect(io.exitCode).toBe(2)
  })

  it('grep -rq lets a match outrank a failed operand', async () => {
    const [, io] = await runGrep({ r: true, q: true })
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

  it('propagate out of a recursive walk instead of becoming a warning', async () => {
    await expect(scanned([spec('/data')], { r: true })).rejects.toThrow('token expired')
  })

  it('propagate out of a single-file read', async () => {
    await expect(scanned([spec('/data/a.txt')], {})).rejects.toThrow('token expired')
  })
})
