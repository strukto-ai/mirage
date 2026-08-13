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

// Mirror of python/tests/commands/builtin/github/test_narrow.py. The Python
// suite drives grep/rg end-to-end against a mock GitHub API; here we test the
// shared pieces directly: narrowScope (code-search push-down on subdirs and
// regex-extracted literals, gated on -w).

import { describe, expect, it } from 'vitest'
import { GitHubAccessor } from '../../../accessor/github.ts'
import type { GitHubTransport } from '../../../core/github/_client.ts'
import type { TreeEntry } from '../../../core/github/tree_entry.ts'
import { PathSpec } from '../../../types.ts'
import { narrowScope } from './narrow.ts'

// 150 blobs under src/ so the scope clears SCOPE_WARN (100) and search kicks in.
function bigTree(): Record<string, TreeEntry> {
  const tree: Record<string, TreeEntry> = {
    src: { path: 'src', type: 'tree', sha: 'd', size: null },
  }
  for (let i = 0; i < 150; i += 1) {
    const p = `src/f${String(i)}.py`
    tree[p] = { path: p, type: 'blob', sha: `s${String(i)}`, size: 10 }
  }
  return tree
}

interface SearchCall {
  q: string
}

function makeAccessor(searchHits: string[], calls: SearchCall[]): GitHubAccessor {
  const transport: GitHubTransport = {
    get(path: string, params?: Record<string, string>): Promise<unknown> {
      if (path === '/search/code') {
        calls.push({ q: params?.q ?? '' })
        return Promise.resolve({ items: searchHits.map((p) => ({ path: p, sha: 'x' })) })
      }
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
    tree: bigTree(),
  })
}

function subdir(): PathSpec {
  return new PathSpec({
    virtual: '/src',
    directory: '/src',
    resourcePath: 'src',
    resolved: false,
  })
}

describe('narrowScope', () => {
  it('narrows a large recursive scope via code search on a literal', async () => {
    const calls: SearchCall[] = []
    const acc = makeAccessor(['src/f1.py', 'src/f2.py'], calls)
    const res = await narrowScope(acc, [subdir()], 'import', false, true, true)
    expect(res.usedSearch).toBe(true)
    expect(res.fileCount).toBe(2)
    expect(res.resolved.map((p) => p.virtual).sort()).toEqual(['/src/f1.py', '/src/f2.py'])
    expect(calls[0]?.q).toContain('import')
    expect(calls[0]?.q).toContain('path:src')
  })

  it('skips search for a regex even under -w', async () => {
    // A regex narrows on an extracted literal, so the searched term is only
    // part of the match: a whole-word search for `import` never returns a file
    // whose only token is `importos`.
    const calls: SearchCall[] = []
    const acc = makeAccessor(['src/f3.py'], calls)
    const res = await narrowScope(acc, [subdir()], 'import.*os', false, true, true)
    expect(res.usedSearch).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('does not search a non-recursive scope', async () => {
    const calls: SearchCall[] = []
    const acc = makeAccessor(['src/f1.py'], calls)
    const res = await narrowScope(acc, [subdir()], 'import', false, false, true)
    expect(res.usedSearch).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('does not search a regex with no provable literal', async () => {
    const calls: SearchCall[] = []
    const acc = makeAccessor(['src/f1.py'], calls)
    const res = await narrowScope(acc, [subdir()], 'foo|bar', false, true, true)
    expect(res.usedSearch).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('skips search without -w', async () => {
    // Code search matches whole words while grep matches substrings, so a
    // bare literal would narrow to a strict subset and silently drop files
    // that contain it only inside a longer word.
    const calls: SearchCall[] = []
    const acc = makeAccessor(['src/f1.py'], calls)
    const res = await narrowScope(acc, [subdir()], 'import', false, true, false)
    expect(res.usedSearch).toBe(false)
    expect(calls).toHaveLength(0)
  })
})
