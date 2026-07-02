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

function spec(path: string): PathSpec {
  return new PathSpec({
    virtual: path,
    directory: path,
    resolved: false,
    resourcePath: mountKey(path, ''),
  })
}

function opts(flags: Record<string, string | boolean | string[]>): CommandOpts {
  return {
    stdin: null,
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
      type: p.virtual === '/data' ? FileType.DIRECTORY : FileType.TEXT,
    }),
  )
const readdir = (p: PathSpec): Promise<string[]> =>
  Promise.resolve(p.virtual === '/data' ? ['/data/a.txt', '/data/bad.txt'] : [])

async function* good(): AsyncIterable<Uint8Array> {
  await Promise.resolve()
  yield ENC.encode('alice\n')
}
function stream(p: PathSpec): AsyncIterable<Uint8Array> {
  if (p.virtual === '/data/bad.txt') throw new Error('boom')
  return good()
}

async function decode(out: GrepOut): Promise<string> {
  if (out === null) return ''
  return DEC.decode(out instanceof Uint8Array ? out : await materialize(out))
}

async function runGrep(
  flags: Record<string, string | boolean | string[]>,
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
    expect(DEC.decode(io.stderr as Uint8Array)).toBe('grep: /data/bad.txt: boom\n')
    expect(io.exitCode).toBe(0)
  })

  it('grep -rl threads a stderr warning when a file read fails', async () => {
    const [out, io] = await runGrep({ r: true, args_l: true })
    expect(await decode(out)).toBe('/data/a.txt\n')
    expect(DEC.decode(io.stderr as Uint8Array)).toBe('grep: /data/bad.txt: boom\n')
  })

  it('grep on a single directory operand warns and exits 1', async () => {
    const [out, io] = await runGrep({})
    expect(await decode(out)).toBe('')
    expect(DEC.decode(io.stderr as Uint8Array)).toBe('grep: /data: Is a directory\n')
    expect(io.exitCode).toBe(1)
  })
})

describe('grepGeneric scopeCheck', () => {
  it('prepends a scope warning to stderr', async () => {
    const scopeCheck = (): Promise<string | null> => Promise.resolve('scanning 5 files under /data')
    const [out, io] = (await grepGeneric(
      'grep',
      [spec('/data')],
      ['alice'],
      opts({ r: true }),
      stat,
      readdir,
      stream,
      scopeCheck,
    )) as [GrepOut, IOResult]
    expect(await decode(out)).toBe('/data/a.txt:alice\n')
    expect(DEC.decode(io.stderr as Uint8Array)).toBe(
      'scanning 5 files under /data\ngrep: /data/bad.txt: boom\n',
    )
  })

  it('returns exit 1 with the message when scopeCheck throws', async () => {
    const scopeCheck = (): Promise<string | null> =>
      Promise.reject(new Error('scope too large: 99 files under /data'))
    const [out, io] = (await grepGeneric(
      'grep',
      [spec('/data')],
      ['alice'],
      opts({ r: true }),
      stat,
      readdir,
      stream,
      scopeCheck,
    )) as [GrepOut, IOResult]
    expect(out).toBeNull()
    expect(io.exitCode).toBe(1)
    expect(DEC.decode(io.stderr as Uint8Array)).toBe('scope too large: 99 files under /data')
  })
})
