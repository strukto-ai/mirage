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
import { GitHubAccessor } from '../../../accessor/github.ts'
import type { GitHubTransport } from '../_client.ts'
import type { TreeEntry } from '../tree_entry.ts'
import { PathSpec } from '../../../types.ts'
import { size, entries } from './index.ts'

const TREE: Record<string, TreeEntry> = {
  docs: { path: 'docs', type: 'tree', sha: 's1', size: null },
  'docs/a.md': { path: 'docs/a.md', type: 'blob', sha: 's2', size: 100 },
  'docs/b.md': { path: 'docs/b.md', type: 'blob', sha: 's3', size: 50 },
  'readme.txt': { path: 'readme.txt', type: 'blob', sha: 's4', size: 7 },
}

function makeAccessor(): GitHubAccessor {
  return new GitHubAccessor({
    transport: {} as GitHubTransport,
    owner: 'o',
    repo: 'r',
    ref: 'main',
    defaultBranch: 'main',
    tree: TREE,
  })
}

describe('github core du', () => {
  it('sums sizes under a subtree', async () => {
    const total = await size(makeAccessor(), PathSpec.fromStrPath('/docs'))
    expect(total).toBe(150)
  })

  it('entries returns sorted entries plus the total', async () => {
    const [found, total] = await entries(makeAccessor(), PathSpec.fromStrPath('/docs'))
    expect(found).toEqual([
      ['/docs', 0],
      ['/docs/a.md', 100],
      ['/docs/b.md', 50],
    ])
    expect(total).toBe(150)
  })

  it('duEntries on the root covers everything', async () => {
    const [, total] = await entries(makeAccessor(), PathSpec.fromStrPath('/'))
    expect(total).toBe(157)
  })

  it('duEntries sorts paths by ASCII byte order, uppercase before lowercase', async () => {
    const tree: Record<string, TreeEntry> = {
      'apple.md': { path: 'apple.md', type: 'blob', sha: 't1', size: 1 },
      'Banana.md': { path: 'Banana.md', type: 'blob', sha: 't2', size: 2 },
      'CHERRY.md': { path: 'CHERRY.md', type: 'blob', sha: 't3', size: 3 },
    }
    const accessor = new GitHubAccessor({
      transport: {} as GitHubTransport,
      owner: 'o',
      repo: 'r',
      ref: 'main',
      defaultBranch: 'main',
      tree,
    })
    const [found] = await entries(accessor, PathSpec.fromStrPath('/'))
    expect(found.map((e: [string, number]) => e[0])).toEqual([
      '/Banana.md',
      '/CHERRY.md',
      '/apple.md',
    ])
  })
})
