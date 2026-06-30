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
// regex-extracted literals) and filesOnlyShortcircuit (the -l short-circuit
// that returns the narrowed file list without reading any blobs).

import { describe, expect, it } from 'vitest'
import { GitHubAccessor } from '../../../accessor/github.ts'
import type { GitHubTransport } from '../../../core/github/_client.ts'
import type { TreeEntry } from '../../../core/github/tree_entry.ts'
import { PathSpec } from '../../../types.ts'
import { filesOnlyShortcircuit, narrowScope } from './narrow.ts'

const DEC = new TextDecoder()

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
  return new PathSpec({ original: '/src', directory: '/src', prefix: '', resolved: false })
}

describe('narrowScope', () => {
  it('narrows a large recursive scope via code search on a literal', async () => {
    const calls: SearchCall[] = []
    const acc = makeAccessor(['src/f1.py', 'src/f2.py'], calls)
    const res = await narrowScope(acc, [subdir()], 'import', false, true)
    expect(res.usedSearch).toBe(true)
    expect(res.fileCount).toBe(2)
    expect(res.resolved.map((p) => p.original).sort()).toEqual(['/src/f1.py', '/src/f2.py'])
    expect(calls[0]?.q).toContain('import')
    expect(calls[0]?.q).toContain('path:src')
  })

  it('narrows a regex scope on the extracted required literal', async () => {
    const calls: SearchCall[] = []
    const acc = makeAccessor(['src/f3.py'], calls)
    const res = await narrowScope(acc, [subdir()], 'import.*os', false, true)
    expect(res.usedSearch).toBe(true)
    // "import" is the required literal pushed down; the regex stays exact since
    // the caller still scans it over the narrowed files.
    expect(calls[0]?.q).toContain('import')
    expect(calls[0]?.q).not.toContain('.*')
  })

  it('does not search a non-recursive scope', async () => {
    const calls: SearchCall[] = []
    const acc = makeAccessor(['src/f1.py'], calls)
    const res = await narrowScope(acc, [subdir()], 'import', false, false)
    expect(res.usedSearch).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('does not search a regex with no provable literal', async () => {
    const calls: SearchCall[] = []
    const acc = makeAccessor(['src/f1.py'], calls)
    const res = await narrowScope(acc, [subdir()], 'foo|bar', false, true)
    expect(res.usedSearch).toBe(false)
    expect(calls).toHaveLength(0)
  })
})

function spec(path: string): PathSpec {
  return new PathSpec({ original: path, directory: '', prefix: '', resolved: true })
}

describe('filesOnlyShortcircuit', () => {
  const resolved = [spec('/src/main.py'), spec('/src/utils.py')]
  const scope = subdir()

  it('emits the sorted narrowed list for a literal -l with no reads', () => {
    const out = filesOnlyShortcircuit({ args_l: true }, 'import', resolved, scope)
    expect(out).not.toBeNull()
    const [bytes, io] = out as [Uint8Array, { exitCode: number }]
    expect(io.exitCode).toBe(0)
    expect(DEC.decode(bytes)).toContain('main.py')
  })

  it('returns null without -l', () => {
    expect(filesOnlyShortcircuit({}, 'import', resolved, scope)).toBeNull()
  })

  it('returns null for a non-literal pattern', () => {
    expect(filesOnlyShortcircuit({ args_l: true }, 'foo|bar', resolved, scope)).toBeNull()
    expect(filesOnlyShortcircuit({ args_l: true }, 'imp.*rt', resolved, scope)).toBeNull()
  })

  it('returns null when a match-altering flag is present', () => {
    for (const flag of ['i', 'w', 'v', 'c', 'o']) {
      expect(
        filesOnlyShortcircuit({ args_l: true, [flag]: true }, 'import', resolved, scope),
      ).toBeNull()
    }
  })

  it('applies a path predicate (rg --type/--glob/hidden)', () => {
    const out = filesOnlyShortcircuit({ args_l: true }, 'import', resolved, scope, (p) =>
      p.endsWith('main.py'),
    )
    const [bytes] = out as [Uint8Array, { exitCode: number }]
    const body = DEC.decode(bytes)
    expect(body).toContain('main.py')
    expect(body).not.toContain('utils.py')
  })

  it('exits 1 when the predicate drops every file', () => {
    const out = filesOnlyShortcircuit({ args_l: true }, 'import', resolved, scope, () => false)
    const [bytes, io] = out as [Uint8Array, { exitCode: number }]
    expect(io.exitCode).toBe(1)
    expect(DEC.decode(bytes)).toBe('')
  })
})
