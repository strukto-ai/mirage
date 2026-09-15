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

import { afterEach, describe, expect, it, vi } from 'vitest'

import { Mem0Accessor } from '../../../accessor/mem0.ts'
import type { ByteSource, IOResult } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import type { CommandOpts } from '../../config.ts'
import { MEM0_SEARCH } from './search.ts'

const DECODER = new TextDecoder()

async function runSearch(texts: string[]): Promise<[ByteSource | null, IOResult]> {
  const cmd = MEM0_SEARCH[0]
  if (cmd === undefined) throw new Error('search not registered')
  const opts: CommandOpts = { stdin: null, flags: {}, filetypeFns: null, cwd: '/' }
  const accessor = new Mem0Accessor({ apiKey: 'key', userId: 'alex' })
  const scope = new PathSpec({ virtual: '/memories', directory: '/memories', resourcePath: '' })
  const result = await cmd.fn(accessor, [scope], texts, opts)
  if (result === null) throw new Error('search returned no result')
  return result
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('mem0 search', () => {
  it('refuses a missing query instead of searching for nothing', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const [out, io] = await runSearch([])
    expect(out).toBeNull()
    expect(io.exitCode).toBe(2)
    expect(DECODER.decode(io.stderr as Uint8Array)).toBe('search: query is required\n')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses an empty query the same way', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const [out, io] = await runSearch([''])
    expect(out).toBeNull()
    expect(io.exitCode).toBe(2)
    expect(DECODER.decode(io.stderr as Uint8Array)).toBe('search: query is required\n')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
