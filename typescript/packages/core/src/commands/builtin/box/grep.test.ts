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

// Mirror of python/tests/commands/builtin/box/test_grep_search.py.

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./narrow.ts', () => ({ narrowScope: vi.fn() }))
vi.mock('../generic/grep.ts', () => ({ grepGeneric: vi.fn() }))

import { BoxAccessor } from '../../../accessor/box.ts'
import type { BoxTokenManager } from '../../../core/box/_client.ts'
import { IOResult } from '../../../io/types.ts'
import type { Resource } from '../../../resource/base.ts'
import { PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { grepGeneric } from '../generic/grep.ts'
import { BOX_GREP } from './grep.ts'
import { narrowScope } from './narrow.ts'

const STUB_TM = {} as BoxTokenManager
const narrow = vi.mocked(narrowScope)
const generic = vi.mocked(grepGeneric)

function makeAccessor(): BoxAccessor {
  return new BoxAccessor({ tokenManager: STUB_TM, contentSearch: true })
}

function scope(): PathSpec {
  return new PathSpec({ virtual: '/data', directory: '/data', resourcePath: '' })
}

async function runGrep(
  flags: Record<string, string | boolean | string[]>,
): Promise<CommandFnResult> {
  const cmd = BOX_GREP[0]
  if (cmd === undefined) throw new Error('grep not registered')
  const opts: CommandOpts = {
    stdin: null,
    flags,
    filetypeFns: null,
    cwd: '/',
    resource: null as unknown as Resource,
  }
  return cmd.fn(makeAccessor(), [scope()], ['needle'], opts)
}

beforeEach(() => {
  narrow.mockReset()
  generic.mockReset()
  narrow.mockResolvedValue({ resolved: [], usedSearch: false })
  generic.mockResolvedValue([new Uint8Array(), new IOResult()])
})

describe('box grep push-down', () => {
  it('allows narrowing for a plain recursive grep', async () => {
    await runGrep({ r: true })
    const opts = narrow.mock.calls[0]?.[3]
    expect(opts?.recursive).toBe(true)
    expect(opts?.exactFileSet).toBe(false)
    expect(opts?.fixedString).toBe(false)
  })

  it('forces the full walk for -v', async () => {
    await runGrep({ r: true, v: true })
    expect(narrow.mock.calls[0]?.[3]?.exactFileSet).toBe(true)
  })

  it('forces the full walk for -c', async () => {
    await runGrep({ r: true, c: true })
    expect(narrow.mock.calls[0]?.[3]?.exactFileSet).toBe(true)
  })

  it('hands narrowed files to the generic grep', async () => {
    const hits = [
      new PathSpec({
        virtual: '/data/a.txt',
        directory: '',
        resourcePath: 'a.txt',
        resolved: true,
      }),
    ]
    narrow.mockResolvedValue({ resolved: hits, usedSearch: true })
    await runGrep({ r: true })
    expect(generic.mock.calls[0]?.[1]).toEqual(hits)
  })

  it('exits 1 without reading when the narrowed set is empty', async () => {
    narrow.mockResolvedValue({ resolved: [], usedSearch: true })
    const result = await runGrep({ r: true })
    expect(result).not.toBeNull()
    const [out, io] = result as [Uint8Array, IOResult]
    expect(out).toEqual(new Uint8Array())
    expect(io.exitCode).toBe(1)
    expect(generic).not.toHaveBeenCalled()
  })
})
