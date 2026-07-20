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

// Mirror of python/tests/commands/builtin/box/test_rg_search.py.

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./narrow.ts', () => ({ narrowScope: vi.fn() }))
vi.mock('../generic/rg.ts', () => ({ rgGeneric: vi.fn() }))

import { BoxAccessor } from '../../../accessor/box.ts'
import type { BoxTokenManager } from '../../../core/box/_client.ts'
import { IOResult } from '../../../io/types.ts'
import type { Resource } from '../../../resource/base.ts'
import { PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { rgGeneric } from '../generic/rg.ts'
import { narrowScope } from './narrow.ts'
import { BOX_RG, keepVisible } from './rg.ts'

const STUB_TM = {} as BoxTokenManager
const narrow = vi.mocked(narrowScope)
const generic = vi.mocked(rgGeneric)

function makeAccessor(): BoxAccessor {
  return new BoxAccessor({ tokenManager: STUB_TM, contentSearch: true })
}

function scope(): PathSpec {
  return new PathSpec({ virtual: '/data', directory: '/data', resourcePath: '' })
}

function spec(virtual: string): PathSpec {
  return new PathSpec({
    virtual,
    directory: '',
    resourcePath: virtual.replace(/^\/data\//, ''),
    resolved: true,
  })
}

async function runRg(flags: Record<string, string | boolean | string[]>): Promise<CommandFnResult> {
  const cmd = BOX_RG[0]
  if (cmd === undefined) throw new Error('rg not registered')
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

describe('keepVisible', () => {
  it('drops dotfiles below the scope', () => {
    const kept = keepVisible(
      [spec('/data/.env'), spec('/data/.git/config'), spec('/data/a.txt')],
      [scope()],
      false,
    )
    expect(kept.map((p) => p.virtual)).toEqual(['/data/a.txt'])
  })

  it('keeps everything under --hidden', () => {
    const paths = [spec('/data/.env'), spec('/data/a.txt')]
    expect(keepVisible(paths, [scope()], true)).toEqual(paths)
  })

  it('ignores dots in the scope itself', () => {
    const hiddenScope = new PathSpec({
      virtual: '/data/.cfg',
      directory: '/data/.cfg',
      resourcePath: '.cfg',
    })
    const kept = keepVisible([spec('/data/.cfg/a.txt')], [hiddenScope], false)
    expect(kept.map((p) => p.virtual)).toEqual(['/data/.cfg/a.txt'])
  })
})

describe('box rg push-down', () => {
  it('allows narrowing for a plain rg', async () => {
    await runRg({})
    const opts = narrow.mock.calls[0]?.[3]
    expect(opts?.recursive).toBe(true)
    expect(opts?.exactFileSet).toBe(false)
  })

  it('forces the full walk for -v, --type, and --glob', async () => {
    await runRg({ v: true })
    expect(narrow.mock.calls[0]?.[3]?.exactFileSet).toBe(true)
    await runRg({ type: 'py' })
    expect(narrow.mock.calls[1]?.[3]?.exactFileSet).toBe(true)
    await runRg({ glob: '*.py' })
    expect(narrow.mock.calls[2]?.[3]?.exactFileSet).toBe(true)
  })

  it('forces filename labels for a narrowed run', async () => {
    narrow.mockResolvedValue({ resolved: [spec('/data/a.txt')], usedSearch: true })
    await runRg({})
    expect(generic.mock.calls[0]?.[2]?.flags.H).toBe(true)
  })

  it('keeps -I suppression instead of forcing labels', async () => {
    narrow.mockResolvedValue({ resolved: [spec('/data/a.txt')], usedSearch: true })
    await runRg({ args_I: true })
    expect('H' in (generic.mock.calls[0]?.[2]?.flags ?? {})).toBe(false)
  })

  it('leaves flags alone on the walk fallback', async () => {
    narrow.mockResolvedValue({ resolved: [scope()], usedSearch: false })
    await runRg({})
    expect('H' in (generic.mock.calls[0]?.[2]?.flags ?? {})).toBe(false)
  })

  it('prunes hidden candidates', async () => {
    narrow.mockResolvedValue({
      resolved: [spec('/data/.env'), spec('/data/a.txt')],
      usedSearch: true,
    })
    await runRg({})
    expect((generic.mock.calls[0]?.[0] ?? []).map((p) => p.virtual)).toEqual(['/data/a.txt'])
  })

  it('exits 1 when every narrowed candidate is hidden', async () => {
    narrow.mockResolvedValue({ resolved: [spec('/data/.env')], usedSearch: true })
    const result = await runRg({})
    expect(result).not.toBeNull()
    const [out, io] = result as [Uint8Array, IOResult]
    expect(out).toEqual(new Uint8Array())
    expect(io.exitCode).toBe(1)
    expect(generic).not.toHaveBeenCalled()
  })
})
