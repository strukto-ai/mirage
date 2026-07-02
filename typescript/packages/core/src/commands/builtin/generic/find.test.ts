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

import { stripSlash } from '../../../utils/slash.ts'
import { describe, expect, it } from 'vitest'
import type { IOResult } from '../../../io/types.ts'
import type { FindOptions } from '../../../resource/base.ts'
import { PathSpec } from '../../../types.ts'
import type { CommandOpts } from '../../config.ts'
import { findGeneric } from './find.ts'

const DEC = new TextDecoder()

function makeOpts(): CommandOpts {
  return { stdin: null, flags: {}, filetypeFns: null, cwd: '/' } as unknown as CommandOpts
}

function enoent(p: string): Error {
  const e = new Error(`ENOENT: ${p}`) as Error & { code: string }
  e.code = 'ENOENT'
  return e
}

function spec(p: string): PathSpec {
  return new PathSpec({ resourcePath: stripSlash(p), virtual: p, directory: p, resolved: false })
}

function fakeFind(root: PathSpec, _options: FindOptions): Promise<string[]> {
  if (root.virtual === '/missing') return Promise.reject(enoent(root.virtual))
  if (root.virtual === '/limited') return Promise.reject(new Error('rate limited'))
  return Promise.resolve(['/found.txt'])
}

describe('generic command find', () => {
  it('skips roots whose find raises ENOENT', async () => {
    const result = await findGeneric([spec('/missing'), spec('/')], [], makeOpts(), fakeFind)
    expect(result).not.toBeNull()
    expect(DEC.decode(result?.[0] as Uint8Array)).toBe('/found.txt\n')
  })

  it('propagates non-ENOENT errors', async () => {
    await expect(findGeneric([spec('/limited')], [], makeOpts(), fakeFind)).rejects.toThrow(
      'rate limited',
    )
  })

  it.each([
    ['maxdepth', 'abc', '-maxdepth'],
    ['mindepth', 'xx', '-mindepth'],
    ['size', '', '-size'],
    ['size', 'abc', '-size'],
    ['mtime', 'abc', '-mtime'],
  ])('exits 1 with clean stderr for invalid %s=%s', async (flag, value, label) => {
    const opts = {
      stdin: null,
      flags: { [flag]: value },
      filetypeFns: null,
      cwd: '/',
    } as unknown as CommandOpts
    const result = await findGeneric([spec('/')], [], opts, fakeFind)
    expect(result).not.toBeNull()
    const [out, io] = result as [Uint8Array | null, IOResult]
    expect(out).toBeNull()
    expect(io.exitCode).toBe(1)
    expect(DEC.decode(io.stderr as Uint8Array)).toBe(
      `find: invalid argument '${value}' to '${label}'\n`,
    )
  })
})
