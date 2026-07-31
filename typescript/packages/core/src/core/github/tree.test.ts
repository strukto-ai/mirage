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
import { fetchDirTree, fetchTree, type GitHubTransport } from './_client.ts'

const ITEMS = [
  { path: 'extern', mode: '160000', type: 'commit', sha: 'ccc' },
  { path: 'main.py', mode: '100644', type: 'blob', sha: 'bbb', size: 7 },
  { path: 'src', mode: '040000', type: 'tree', sha: 'aaa' },
]

function transport(): GitHubTransport {
  return {
    get: () => Promise.resolve({ tree: ITEMS, truncated: false }),
  } as unknown as GitHubTransport
}

describe('github tree fetch', () => {
  it('excludes submodule gitlinks from the recursive tree', async () => {
    const { tree, truncated } = await fetchTree(transport(), 'acme', 'proj', 'main')
    expect(truncated).toBe(false)
    expect(tree.map((e) => e.path)).toEqual(['main.py', 'src'])
  })

  it('excludes submodule gitlinks from per-directory trees', async () => {
    const entries = await fetchDirTree(transport(), 'acme', 'proj', 'sha1')
    expect(entries.map((e) => e.path)).toEqual(['main.py', 'src'])
  })
})
