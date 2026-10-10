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

import { mountKey } from '../../utils/key_prefix.ts'
import { describe, expect, it } from 'vitest'
import { PathSpec } from '../../types.ts'
import type { TreeEntry } from './tree_entry.ts'
import {
  countScopeFiles,
  scopeBlobs,
  scopeRelativeKey,
  searchSafe,
  unsearchableKeys,
} from './pushdown.ts'

const TREE: Record<string, TreeEntry> = {
  docs: { path: 'docs', type: 'tree', sha: 's1', size: null },
  'docs/a.md': { path: 'docs/a.md', type: 'blob', sha: 's2', size: 100 },
  'docs/b.md': { path: 'docs/b.md', type: 'blob', sha: 's3', size: 50 },
  src: { path: 'src', type: 'tree', sha: 's4', size: null },
  'src/main.py': { path: 'src/main.py', type: 'blob', sha: 's5', size: 10 },
  'readme.txt': { path: 'readme.txt', type: 'blob', sha: 's6', size: 7 },
}

describe('scopeRelativeKey', () => {
  it('strips the mount prefix', () => {
    const p = new PathSpec({
      virtual: '/github/src',
      directory: '/github',
      vfsPath: mountKey('/github/src', '/github'),
    })
    expect(scopeRelativeKey(p)).toBe('/src')
  })

  it('returns / for the mount root', () => {
    const p = new PathSpec({
      virtual: '/github',
      directory: '/',
      vfsPath: mountKey('/github', '/github'),
    })
    expect(scopeRelativeKey(p)).toBe('/')
  })

  it('passes through unprefixed paths', () => {
    const p = new PathSpec({ vfsPath: 'src', virtual: '/src', directory: '/' })
    expect(scopeRelativeKey(p)).toBe('/src')
  })
})

describe('countScopeFiles', () => {
  it('counts all files at the repo root', () => {
    expect(countScopeFiles(TREE, '/')).toBe(4)
  })

  it('counts files under a subdirectory only', () => {
    expect(countScopeFiles(TREE, '/docs')).toBe(2)
    expect(countScopeFiles(TREE, '/src')).toBe(1)
  })

  it('counts a single file key', () => {
    expect(countScopeFiles(TREE, '/readme.txt')).toBe(1)
  })

  it('returns zero for unknown scopes', () => {
    expect(countScopeFiles(TREE, '/missing')).toBe(0)
  })
})

describe('scopeBlobs', () => {
  it('lists the files at or below a key, in tree order', () => {
    // The root key is every file, a file key is itself, and a sibling that
    // shares the spelling (docsx/) is outside.
    const tree = { ...TREE, 'docsx/c.md': { path: 'docsx/c.md', type: 'blob', sha: 's7', size: 1 } }
    expect(scopeBlobs(tree, '/').map(([p]) => p)).toEqual([
      'docs/a.md',
      'docs/b.md',
      'src/main.py',
      'readme.txt',
      'docsx/c.md',
    ])
    expect(scopeBlobs(tree, '/docs').map(([p]) => p)).toEqual(['docs/a.md', 'docs/b.md'])
    expect(scopeBlobs(tree, '/readme.txt').map(([p]) => p)).toEqual(['readme.txt'])
    expect(scopeBlobs(tree, '/nope')).toEqual([])
  })
})

// Twin of the search_safe table in python/tests/core/github/test_pushdown.py,
// measured against api.github.com on 2026-09-25: a `name:` word is a
// qualifier, a quote starts a phrase, a word-leading `-` negates and `NOT` is
// an operator, each narrowing the answer; lowercase `not` and `OR` are plain
// terms. Word characters are ASCII, the rule both hosts apply, so the \x1c,
// U+FEFF and non-ASCII rows are the ones that would split them.
describe('searchSafe', () => {
  it.each([
    'foo path:docs',
    'say "hi"',
    'foo -bar',
    '-foo',
    'foo NOT bar',
    'NOT',
    'a\tNOT\tb',
    '   ',
    '\t',
    'a\x1c-b',
    'a\ufeff-b',
    'x(-y',
    '\u00e9-b',
    '\u00e9NOT x',
    '\u00e9',
  ])('refuses %j', (query) => {
    expect(searchSafe(query)).toBe(false)
  })

  it.each(['foo', 'foo bar', 'foo-bar', 'not', 'OR', 'NOTE', 'NOTHING x', 'a_NOT'])(
    'accepts %j',
    (query) => {
      expect(searchSafe(query)).toBe(true)
    },
  )
})

describe('unsearchableKeys', () => {
  it('lists what code search never indexes', () => {
    const limit = 384 * 1024
    const blob = (path: string, size: number | null): TreeEntry => ({
      path,
      type: 'blob',
      sha: path,
      size,
    })
    const tree: Record<string, TreeEntry> = {
      src: { path: 'src', type: 'tree', sha: 't', size: null },
      'src/big.bin': blob('src/big.bin', limit),
      'src/edge.py': blob('src/edge.py', limit - 1),
      'src/none.py': blob('src/none.py', null),
      'docs/big.md': blob('docs/big.md', limit + 1),
      'srcx/big.bin': blob('srcx/big.bin', limit),
    }
    // srcx/ shares src's spelling but is not under it.
    expect(unsearchableKeys(tree, '/src')).toEqual(['src/big.bin', 'src/none.py'])
    expect(unsearchableKeys(tree, '/')).toEqual([
      'docs/big.md',
      'src/big.bin',
      'src/none.py',
      'srcx/big.bin',
    ])
  })
})
