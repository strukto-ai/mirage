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

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../generic/find.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof findModule>()),
  findGeneric: vi.fn(),
}))

import { GitHubAccessor } from '../../../accessor/github.ts'
import { RAMIndexCacheStore } from '../../../cache/index/ram.ts'
import type { GitHubTransport } from '../../../core/github/client.ts'
import { populateIndex } from '../../../core/github/tree.ts'
import type { TreeEntry } from '../../../core/github/tree_entry.ts'
import { IOResult } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import type { CommandOpts } from '../../config.ts'
import { findGeneric } from '../generic/find.ts'
import type * as findModule from '../generic/find.ts'
import { GITHUB_FIND } from './find.ts'

const generic = vi.mocked(findGeneric)

const TREE: Record<string, TreeEntry> = {
  src: { path: 'src', type: 'tree', sha: 'd', size: null },
  'src/a.py': { path: 'src/a.py', type: 'blob', sha: 'a', size: 1 },
  'src/b.py': { path: 'src/b.py', type: 'blob', sha: 'b', size: 1 },
  'src/c.txt': { path: 'src/c.txt', type: 'blob', sha: 'c', size: 1 },
}

function makeAccessor(): GitHubAccessor {
  const transport: GitHubTransport = {
    get(path: string): Promise<unknown> {
      throw new Error(`unexpected transport call: ${path}`)
    },
    request(method: string, path: string): Promise<unknown> {
      throw new Error(`unexpected transport call: ${method} ${path}`)
    },
    requestWithResponse(method: string, path: string): Promise<never> {
      throw new Error(`unexpected transport call: ${method} ${path}`)
    },
  }
  return new GitHubAccessor({
    transport,
    owner: 'o',
    repo: 'r',
    ref: 'main',
    defaultBranch: 'main',
    tree: TREE,
  })
}

beforeEach(() => {
  generic.mockReset()
  generic.mockResolvedValue([new Uint8Array(), new IOResult()])
})

describe('github find', () => {
  it('resolves a pattern operand itself before the generic walk', async () => {
    // The dispatcher hands the pattern over whole, as python's does, so
    // the wrapper resolves it through the shared adapter the way the
    // python twin does; a pattern reaching the walk unresolved names no
    // file at all.
    const cmd = GITHUB_FIND[0]
    if (cmd === undefined) throw new Error('find not registered')
    const pattern = new PathSpec({
      virtual: '/src/*.py',
      directory: '/src/',
      vfsPath: 'src/*.py',
      pattern: '*.py',
      resolved: false,
      rawPath: '/src/*.py',
    })
    // github lists through the index, which the mount seeds from the tree.
    const index = new RAMIndexCacheStore()
    await populateIndex(index, TREE, '')
    const opts: CommandOpts = { stdin: null, flags: {}, filetypeFns: null, cwd: '/', index }
    await cmd.fn(makeAccessor(), [pattern], [], opts)
    const seen = generic.mock.calls[0]?.[0] ?? []
    expect(seen.map((p) => p.virtual)).toEqual(['/src/a.py', '/src/b.py'])
  })
})
