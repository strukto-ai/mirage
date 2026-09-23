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
import { PathSpec, type WalkEntry } from '../../types.ts'
import { IncompleteWalkError } from '../../watch/errors.ts'
import type { GitHubTransport } from './client.ts'
import type { TreeEntry } from './tree_entry.ts'
import { GitHubWalk } from './watch.ts'

interface TreeItem {
  path: string
  type: string
  sha: string
  size?: number
}

function transport(tree: TreeItem[], truncated = false): GitHubTransport {
  return {
    get: () => Promise.resolve({ tree, truncated }),
    request: () => Promise.resolve({}),
  }
}

function accessor(tree: TreeItem[], stale: Record<string, TreeEntry>, truncated = false) {
  return new GitHubAccessor({
    transport: transport(tree, truncated),
    owner: 'acme',
    repo: 'proj',
    ref: 'main',
    defaultBranch: 'main',
    tree: stale,
  })
}

function root(): PathSpec {
  return new PathSpec({ virtual: '/gh', directory: '/gh', vfsPath: '' })
}

async function collect(walk: GitHubWalk, at: PathSpec): Promise<WalkEntry[]> {
  const out: WalkEntry[] = []
  for await (const entry of walk.walk(at)) out.push(entry)
  return out
}

const STALE: Record<string, TreeEntry> = {
  'a.txt': { path: 'a.txt', type: 'blob', sha: 'sha-a', size: 3 },
}

describe('GitHubWalk', () => {
  it('refreshes the accessor tree from the pull', async () => {
    // find, du and grep's scope counter read accessor.tree directly, so a
    // pull that fetched a newer tree and dropped it left them reporting
    // the repository as it stood when the mount was built.
    const acc = accessor(
      [
        { path: 'a.txt', type: 'blob', sha: 'sha-a', size: 3 },
        { path: 'b.txt', type: 'blob', sha: 'sha-b', size: 3 },
      ],
      STALE,
    )
    await collect(new GitHubWalk(acc), root())
    expect(Object.keys(acc.tree).sort()).toEqual(['a.txt', 'b.txt'])
    expect(acc.tree['b.txt']?.sha).toBe('sha-b')
  })

  it('does not adopt a truncated tree', async () => {
    // A partial tree would make find report the missing half as deleted.
    const acc = accessor([], STALE, true)
    await expect(collect(new GitHubWalk(acc), root())).rejects.toThrow(IncompleteWalkError)
    expect(Object.keys(acc.tree)).toEqual(['a.txt'])
  })

  it('reports blobs with their sha as the fingerprint', async () => {
    const acc = accessor([{ path: 'a.txt', type: 'blob', sha: 'sha-a', size: 3 }], STALE)
    const entries = await collect(new GitHubWalk(acc), root())
    expect(entries.map((e) => [e.virtual, e.fingerprint])).toEqual([['/gh/a.txt', 'sha-a']])
  })
})
