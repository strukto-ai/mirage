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

import { trees } from '../../test-utils.ts'
import { closed, closedByDefault, hasRules, readsArgs, scopesPaths } from './reads.ts'

// Mirrors python/tests/policy/match/test_reads.py.

describe('reads', () => {
  it('hasRules is a profile stating a tree', () => {
    expect(hasRules(null)).toBe(false)
    expect(hasRules({ trees: [] })).toBe(false)
    expect(hasRules(trees({ rm: 'deny' }))).toBe(true)
  })

  it('readsArgs only where a node reads past the name', () => {
    const rules = trees(
      {
        '*': 'allow',
        rm: 'deny',
        git: { push: { '--force': 'deny' } },
      },
      { '/repo': { ls: 'deny' } },
    )
    expect(readsArgs(rules, 'git')).toBe(true)
    expect(readsArgs(rules, 'ls')).toBe(true)
    expect(readsArgs(rules, 'rm')).toBe(false)
    expect(readsArgs(rules, 'echo')).toBe(false)
    expect(readsArgs(null, 'rm')).toBe(false)
  })

  it("scopesPaths is a folder's tree that speaks for the command", () => {
    const rules = trees({ rm: 'deny' }, { '/repo': { ls: 'deny' } })
    expect(scopesPaths(rules, 'ls')).toBe(true)
    expect(scopesPaths(rules, 'rm')).toBe(false)
    expect(scopesPaths(rules, 'echo')).toBe(false)
    expect(scopesPaths(null, 'cat')).toBe(false)
  })

  it('closed is a top-level root that denies and names nothing', () => {
    expect(closed(trees({ '*': 'deny' }))).toBe(true)
    expect(closedByDefault(trees({ '*': 'deny' }))).toBe(true)
    const listed = trees({ '*': 'deny', ls: 'allow' })
    expect(closed(listed)).toBe(false)
    expect(closedByDefault(listed)).toBe(true)
    expect(closedByDefault(trees(null, { '/a': { '*': 'deny' } }))).toBe(false)
    expect(closed(null)).toBe(false)
  })
})
