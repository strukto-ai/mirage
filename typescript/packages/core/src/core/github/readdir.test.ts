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

import { describe, expect, it } from 'vitest'
import { GitHubAccessor } from '../../accessor/github.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { PathSpec } from '../../types.ts'
import { populateIndex } from './tree.ts'
import { readdir } from './readdir.ts'
import type { GitHubTransport } from './_client.ts'

const TREE = [
  { path: 'README.md', mode: '100644', type: 'blob', sha: 'eee', size: 50 },
  { path: 'src', mode: '040000', type: 'tree', sha: 'aaa' },
  { path: 'src/main.py', mode: '100644', type: 'blob', sha: 'bbb', size: 120 },
]

function accessorFor(probe: { trees: number }): GitHubAccessor {
  const transport = {
    get: () => {
      probe.trees += 1
      return Promise.resolve({ tree: TREE, truncated: false })
    },
  } as unknown as GitHubTransport
  return new GitHubAccessor({
    transport,
    owner: 'acme',
    repo: 'proj',
    ref: 'main',
    defaultBranch: 'main',
  })
}

async function seeded(): Promise<RAMIndexCacheStore> {
  const index = new RAMIndexCacheStore()
  await populateIndex(index, TREE)
  return index
}

function spec(p: string): PathSpec {
  return new PathSpec({ resourcePath: p.slice(1), virtual: p, directory: p })
}

describe('github readdir freshness', () => {
  // The index *is* the listing here, seeded once from the recursive tree,
  // so an expired one is a tree that aged out rather than a repository that
  // emptied: before the refill `ls` exited 0 with no output once the
  // day-long TTL lapsed, and reported the mount root missing after a write
  // invalidated it.
  it('refetches the tree when the listing expired', async () => {
    const index = await seeded()
    await index.invalidate()
    const probe = { trees: 0 }
    expect(await readdir(accessorFor(probe), spec('/'), index)).toEqual(['/README.md', '/src'])
    expect(probe.trees).toBe(1)
  })

  it('does not refetch on a real miss', async () => {
    const index = await seeded()
    const probe = { trees: 0 }
    await expect(readdir(accessorFor(probe), spec('/nope'), index)).rejects.toThrow()
    expect(probe.trees).toBe(0)
  })
})
