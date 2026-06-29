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
import { PathSpec } from '../../types.ts'
import type { TreeEntry } from './tree_entry.ts'
import { countScopeFiles, isRepoRoot, scopeRelativeKey, shouldUseSearch } from './scope.ts'

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
    const p = new PathSpec({ original: '/github/src', directory: '/github', prefix: '/github' })
    expect(scopeRelativeKey(p)).toBe('/src')
  })

  it('returns / for the mount root', () => {
    const p = new PathSpec({ original: '/github', directory: '/', prefix: '/github' })
    expect(scopeRelativeKey(p)).toBe('/')
  })

  it('passes through unprefixed paths', () => {
    const p = new PathSpec({ original: '/src', directory: '/' })
    expect(scopeRelativeKey(p)).toBe('/src')
  })
})

describe('isRepoRoot', () => {
  it('detects root keys', () => {
    expect(isRepoRoot('/')).toBe(true)
    expect(isRepoRoot('')).toBe(true)
    expect(isRepoRoot('/src')).toBe(false)
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

describe('shouldUseSearch', () => {
  it('requires recursive and default branch (literal check moved to caller)', () => {
    expect(shouldUseSearch(true, true)).toBe(true)
    expect(shouldUseSearch(false, true)).toBe(false)
    expect(shouldUseSearch(true, false)).toBe(false)
  })
})
