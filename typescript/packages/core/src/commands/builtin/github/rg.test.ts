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

// Mirror of the narrowed-run tests in
// python/tests/commands/builtin/github/test_rg_search.py, at the seam
// between narrowScope and the generic scan.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RgModule from '../generic/rg.ts'

vi.mock('./pushdown.ts', async () => {
  const actual = await vi.importActual<typeof PushdownModule>('./pushdown.ts')
  return { ...actual, narrowScope: vi.fn() }
})
vi.mock('../generic/rg.ts', async () => {
  const actual = await vi.importActual<typeof RgModule>('../generic/rg.ts')
  return { ...actual, rgGeneric: vi.fn() }
})

import { GitHubAccessor } from '../../../accessor/github.ts'
import type { GitHubTransport } from '../../../core/github/client.ts'
import { IOResult } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { rgGeneric } from '../generic/rg.ts'
import type * as PushdownModule from './pushdown.ts'
import { narrowScope } from './pushdown.ts'
import { GITHUB_RG } from './rg.ts'

const narrow = vi.mocked(narrowScope)
const generic = vi.mocked(rgGeneric)

function makeAccessor(): GitHubAccessor {
  const transport: GitHubTransport = {
    get(path: string): Promise<unknown> {
      throw new Error(`unexpected transport call: ${path}`)
    },
    requestWithResponse(method: string, path: string): Promise<never> {
      throw new Error(`unexpected transport call: ${method} ${path}`)
    },
    request(method: string, path: string): Promise<unknown> {
      throw new Error(`unexpected transport call: ${method} ${path}`)
    },
  }
  return new GitHubAccessor({
    transport,
    owner: 'o',
    repo: 'r',
    ref: 'main',
    defaultBranch: 'main',
    tree: {},
  })
}

function scope(): PathSpec {
  return new PathSpec({ virtual: '/src', directory: '/src', vfsPath: 'src' })
}

function spec(virtual: string): PathSpec {
  return new PathSpec({
    virtual,
    directory: '',
    vfsPath: virtual.replace(/^\//, ''),
    resolved: true,
  })
}

async function runRg(
  flags: Record<string, string | boolean | number | string[]>,
): Promise<CommandFnResult> {
  const cmd = GITHUB_RG[0]
  if (cmd === undefined) throw new Error('rg not registered')
  const opts: CommandOpts = { stdin: null, flags, filetypeFns: null, cwd: '/' }
  return cmd.fn(makeAccessor(), [scope()], ['needle'], opts)
}

async function exactFileSet(flags: CommandOpts['flags']): Promise<unknown> {
  const cmd = GITHUB_RG[0]
  if (cmd === undefined) throw new Error('rg not registered')
  const root = new PathSpec({ virtual: '/', directory: '/', vfsPath: '' })
  const opts: CommandOpts = { stdin: null, flags, filetypeFns: null, cwd: '/', index: null }
  await cmd.fn(makeAccessor(), [root], ['import'], opts)
  return narrow.mock.calls[0]?.[7]
}

beforeEach(() => {
  narrow.mockReset()
  generic.mockReset()
  narrow.mockResolvedValue({ resolved: [scope()], fileCount: 3, usedSearch: false })
  generic.mockResolvedValue([new Uint8Array(), new IOResult()])
})

describe('github rg push-down', () => {
  it('forces filename labels for a narrowed run', async () => {
    // A walk labels every file it finds; one narrowed candidate arrives as
    // a lone explicit operand, which the generic scan would print bare.
    narrow.mockResolvedValue({ resolved: [spec('/src/a.py')], fileCount: 1, usedSearch: true })
    await runRg({ word_regexp: true })
    expect(generic.mock.calls[0]?.[2]?.flags.with_filename).toBe(true)
  })

  it('keeps -I suppression instead of forcing labels', async () => {
    narrow.mockResolvedValue({ resolved: [spec('/src/a.py')], fileCount: 1, usedSearch: true })
    await runRg({ word_regexp: true, no_filename: true })
    expect('with_filename' in (generic.mock.calls[0]?.[2]?.flags ?? {})).toBe(false)
  })

  it('leaves flags alone on the walk fallback', async () => {
    await runRg({ word_regexp: true })
    expect('with_filename' in (generic.mock.calls[0]?.[2]?.flags ?? {})).toBe(false)
  })

  it('prunes hidden candidates', async () => {
    narrow.mockResolvedValue({
      resolved: [spec('/src/.env'), spec('/src/.github/ci.yml'), spec('/src/a.py')],
      fileCount: 3,
      usedSearch: true,
    })
    await runRg({ word_regexp: true })
    expect((generic.mock.calls[0]?.[0] ?? []).map((p) => p.virtual)).toEqual(['/src/a.py'])
  })

  it('keeps hidden candidates under --hidden', async () => {
    narrow.mockResolvedValue({
      resolved: [spec('/src/.env'), spec('/src/a.py')],
      fileCount: 2,
      usedSearch: true,
    })
    await runRg({ word_regexp: true, hidden: true })
    expect((generic.mock.calls[0]?.[0] ?? []).map((p) => p.virtual)).toEqual([
      '/src/.env',
      '/src/a.py',
    ])
  })

  it('exits 1 when every narrowed candidate is hidden', async () => {
    narrow.mockResolvedValue({ resolved: [spec('/src/.env')], fileCount: 1, usedSearch: true })
    const result = await runRg({ word_regexp: true })
    expect(result).not.toBeNull()
    const [out, io] = result as [Uint8Array, IOResult]
    expect(out).toEqual(new Uint8Array())
    expect(io.exitCode).toBe(1)
    expect(generic).not.toHaveBeenCalled()
  })

  it('hands the generic the candidates the walk would search', async () => {
    narrow.mockResolvedValue({ resolved: [spec('/src/a.py')], fileCount: 1, usedSearch: true })
    await runRg({ word_regexp: true, type: ['py'] })
    expect((generic.mock.calls[0]?.[0] ?? []).map((p) => p.virtual)).toEqual(['/src/a.py'])
  })

  it('answers no match when the walk would search nothing', async () => {
    narrow.mockResolvedValue({ resolved: [spec('/src/a.py')], fileCount: 1, usedSearch: true })
    const result = await runRg({ word_regexp: true, type: ['md'] })
    expect(generic).not.toHaveBeenCalled()
    const [out, io] = result as [Uint8Array, IOResult]
    expect(out).toEqual(new Uint8Array())
    expect(io.exitCode).toBe(1)
  })

  it.each<[string, CommandOpts['flags']]>([
    ['-v', { word_regexp: true, invert_match: true }],
    ['--files-without-match', { word_regexp: true, files_without_match: true }],
    ['-f', { word_regexp: true, file: ['/docs/patterns.txt'] }],
  ])('treats %s as needing every file', async (_flag, flags) => {
    expect(await exactFileSet(flags)).toBe(true)
  })

  it('still narrows a plain -w search', async () => {
    expect(await exactFileSet({ word_regexp: true })).toBe(false)
  })
})
