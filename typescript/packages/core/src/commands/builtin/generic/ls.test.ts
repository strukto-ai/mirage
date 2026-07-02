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
import type { CommandOpts } from '../../config.ts'
import { lsGeneric } from './ls.ts'

const DEC = new TextDecoder()

const MODIFIED: Record<string, string> = {
  'apple.txt': '2026-01-03T00:00:00Z',
  'Banana.txt': '2026-01-01T00:00:00Z',
  'CHERRY.txt': '2026-01-02T00:00:00Z',
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

function opts(flags: Record<string, string | boolean | string[]>): CommandOpts {
  return {
    stdin: null,
    flags,
    filetypeFns: null,
    cwd: '/',
    resource: null,
  } as unknown as CommandOpts
}

const stat = (p: PathSpec): Promise<FileStat> => {
  const name = key(p).split('/').pop() ?? ''
  return Promise.resolve(
    new FileStat({
      name,
      type: key(p) === '/' ? FileType.DIRECTORY : FileType.TEXT,
      modified: MODIFIED[name] ?? null,
    }),
  )
}

const readdir = (p: PathSpec): Promise<string[]> => {
  if (key(p) === '/') return Promise.resolve(['/apple.txt', '/Banana.txt', '/CHERRY.txt'])
  return Promise.resolve([])
}

async function run(flags: Record<string, string | boolean | string[]>): Promise<string[]> {
  const result = await lsGeneric([spec('/')], opts(flags), readdir, stat)
  if (result === null) return []
  const [out] = result
  return DEC.decode(out as Uint8Array)
    .replace(/\n$/, '')
    .split('\n')
}

describe('lsGeneric', () => {
  it('sorts names by ASCII byte order, uppercase before lowercase', async () => {
    expect(await run({})).toEqual(['Banana.txt', 'CHERRY.txt', 'apple.txt'])
  })

  it('-r reverses the ASCII order', async () => {
    expect(await run({ r: true })).toEqual(['apple.txt', 'CHERRY.txt', 'Banana.txt'])
  })

  it('-t sorts newest first by codepoint comparison of modified', async () => {
    expect(await run({ t: true })).toEqual(['apple.txt', 'CHERRY.txt', 'Banana.txt'])
  })

  it('-tr sorts oldest first', async () => {
    expect(await run({ t: true, r: true })).toEqual(['Banana.txt', 'CHERRY.txt', 'apple.txt'])
  })
})
