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

// Twin of test_an_answer_that_depends_on_every_file_is_never_narrowed in
// python/tests/commands/builtin/github/test_pushdown.py: a narrowing holds only
// files that match the searched literal, so the flags whose answer depends on
// the files that do not reach narrowScope as an exact file set.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as PushdownModule from './pushdown.ts'
import type * as GenericModule from '../generic/grep.ts'

vi.mock('./pushdown.ts', async () => {
  const actual = await vi.importActual<typeof PushdownModule>('./pushdown.ts')
  return { ...actual, narrowScope: vi.fn() }
})
vi.mock('../generic/grep.ts', async () => {
  const actual = await vi.importActual<typeof GenericModule>('../generic/grep.ts')
  return { ...actual, grepGeneric: vi.fn() }
})

import { GitHubAccessor } from '../../../accessor/github.ts'
import type { GitHubTransport } from '../../../core/github/client.ts'
import { IOResult } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import type { CommandOpts } from '../../config.ts'
import { grepGeneric } from '../generic/grep.ts'
import { GITHUB_GREP } from './grep.ts'
import { narrowScope } from './pushdown.ts'

const narrow = vi.mocked(narrowScope)

function makeAccessor(): GitHubAccessor {
  const transport: GitHubTransport = {
    get(path: string): Promise<unknown> {
      throw new Error(`unexpected transport call: ${path}`)
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
  })
}

async function exactFileSet(flags: CommandOpts['flags']): Promise<unknown> {
  const cmd = GITHUB_GREP[0]
  if (cmd === undefined) throw new Error('grep not registered')
  const root = new PathSpec({ virtual: '/', directory: '/', vfsPath: '' })
  const opts: CommandOpts = { stdin: null, flags, cwd: '/', index: null }
  await cmd.fn(makeAccessor(), [root], ['import'], opts)
  return narrow.mock.calls[0]?.[7]
}

beforeEach(() => {
  narrow.mockReset()
  narrow.mockResolvedValue({ resolved: [], fileCount: 0, usedSearch: false })
  vi.mocked(grepGeneric).mockResolvedValue([new Uint8Array(), new IOResult()])
})

describe('github grep push-down', () => {
  it.each<[string, CommandOpts['flags']]>([
    ['-L', { r: true, w: true, files_without_match: true }],
    ['-f', { r: true, w: true, file: ['/docs/patterns.txt'] }],
    ['-v', { r: true, w: true, v: true }],
  ])('treats %s as needing every file', async (_flag, flags) => {
    expect(await exactFileSet(flags)).toBe(true)
  })

  it('still narrows a plain -w search', async () => {
    expect(await exactFileSet({ r: true, w: true })).toBe(false)
  })
})
