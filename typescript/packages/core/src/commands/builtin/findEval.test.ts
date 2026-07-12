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
import {
  buildTree,
  computeNonemptyDirs,
  evalPredicate,
  type FindEntry,
  keep,
  treeHasType,
  displayPath,
  emitStartPath,
  prefixPathNodes,
} from './findEval.ts'

function entry(over: Partial<FindEntry> = {}): FindEntry {
  return { key: '/data/a.txt', name: 'a.txt', kind: 'f', depth: 1, ...over }
}

describe('empty', () => {
  it('empty node matches only isEmpty entries', () => {
    expect(evalPredicate({ op: 'empty' }, entry({ isEmpty: true }))).toBe(true)
    expect(evalPredicate({ op: 'empty' }, entry({ isEmpty: false }))).toBe(false)
    expect(evalPredicate({ op: 'empty' }, entry({}))).toBe(false)
  })

  it('buildTree empty combines with type', () => {
    const tree = buildTree({ type: 'd', empty: true })
    expect(evalPredicate(tree, entry({ kind: 'd', isEmpty: true }))).toBe(true)
    expect(evalPredicate(tree, entry({ kind: 'd', isEmpty: false }))).toBe(false)
    expect(evalPredicate(tree, entry({ kind: 'f', isEmpty: true }))).toBe(false)
  })

  it('computeNonemptyDirs', () => {
    const keys = ['/data', '/data/a.txt', '/data/sub', '/data/sub/x', '/data/emptydir']
    const ne = computeNonemptyDirs(keys)
    expect(ne.has('/data')).toBe(true)
    expect(ne.has('/data/sub')).toBe(true)
    expect(ne.has('/data/emptydir')).toBe(false)
  })
})

describe('evalPredicate', () => {
  it('name matches glob', () => {
    expect(evalPredicate({ op: 'name', pattern: '*.txt', icase: false }, entry())).toBe(true)
    expect(evalPredicate({ op: 'name', pattern: '*.md', icase: false }, entry())).toBe(false)
  })

  it('iname is case insensitive', () => {
    const e = entry({ name: 'A.TXT' })
    expect(evalPredicate({ op: 'name', pattern: '*.txt', icase: true }, e)).toBe(true)
    expect(evalPredicate({ op: 'name', pattern: '*.txt', icase: false }, e)).toBe(false)
  })

  it('path matches key', () => {
    const e = entry({ key: '/data/sub/x', name: 'x' })
    expect(evalPredicate({ op: 'path', pattern: '*/sub/*' }, e)).toBe(true)
    expect(evalPredicate({ op: 'path', pattern: '*/other/*' }, e)).toBe(false)
  })

  it('type matches kind', () => {
    expect(evalPredicate({ op: 'type', kind: 'f' }, entry({ kind: 'f' }))).toBe(true)
    expect(evalPredicate({ op: 'type', kind: 'd' }, entry({ kind: 'f' }))).toBe(false)
  })

  it('not negates', () => {
    expect(
      evalPredicate({ op: 'not', kid: { op: 'name', pattern: '*.txt', icase: false } }, entry()),
    ).toBe(false)
    expect(
      evalPredicate({ op: 'not', kid: { op: 'name', pattern: '*.md', icase: false } }, entry()),
    ).toBe(true)
  })

  it('and requires all', () => {
    const node = {
      op: 'and' as const,
      kids: [
        { op: 'name' as const, pattern: '*.txt', icase: false },
        { op: 'type' as const, kind: 'f' as const },
      ],
    }
    expect(evalPredicate(node, entry())).toBe(true)
  })

  it('or requires any', () => {
    const node = {
      op: 'or' as const,
      kids: [
        { op: 'name' as const, pattern: '*.md', icase: false },
        { op: 'name' as const, pattern: '*.txt', icase: false },
      ],
    }
    expect(evalPredicate(node, entry())).toBe(true)
  })

  it('true matches everything', () => {
    expect(evalPredicate({ op: 'true' }, entry())).toBe(true)
  })
})

describe('keep', () => {
  it('applies minDepth', () => {
    const e = entry({ depth: 1 })
    expect(keep(e, { op: 'true' }, null)).toBe(true)
    expect(keep(e, { op: 'true' }, 1)).toBe(true)
    expect(keep(e, { op: 'true' }, 2)).toBe(false)
  })
})

describe('buildTree', () => {
  it('empty options is true', () => {
    expect(evalPredicate(buildTree({}), entry())).toBe(true)
  })

  it('name and type', () => {
    const tree = buildTree({ name: '*.txt', type: 'f' })
    expect(evalPredicate(tree, entry({ kind: 'f' }))).toBe(true)
    expect(evalPredicate(tree, entry({ name: 'a.md', kind: 'f' }))).toBe(false)
    expect(evalPredicate(tree, entry({ kind: 'd' }))).toBe(false)
  })

  it('nameExclude is negated', () => {
    const tree = buildTree({ nameExclude: '*.txt' })
    expect(evalPredicate(tree, entry({ name: 'a.txt' }))).toBe(false)
    expect(evalPredicate(tree, entry({ name: 'a.md' }))).toBe(true)
  })

  it('orNames', () => {
    const tree = buildTree({ orNames: ['*.md', '*.txt'] })
    expect(evalPredicate(tree, entry({ name: 'a.txt' }))).toBe(true)
    expect(evalPredicate(tree, entry({ name: 'a.rst' }))).toBe(false)
  })

  it('iname', () => {
    const tree = buildTree({ iname: '*.txt' })
    expect(evalPredicate(tree, entry({ name: 'A.TXT' }))).toBe(true)
  })

  it('treeHasType', () => {
    expect(treeHasType({ op: 'type', kind: 'f' })).toBe(true)
    expect(treeHasType({ op: 'name', pattern: 'x', icase: false })).toBe(false)
    expect(
      treeHasType({
        op: 'and',
        kids: [
          { op: 'name', pattern: 'x', icase: false },
          { op: 'type', kind: 'd' },
        ],
      }),
    ).toBe(true)
    expect(treeHasType({ op: 'not', kid: { op: 'type', kind: 'f' } })).toBe(true)
    expect(treeHasType({ op: 'true' })).toBe(false)
  })
})

describe('prefixPathNodes', () => {
  it('matches -path against the display path (#396)', () => {
    const tree = prefixPathNodes({ op: 'path', pattern: '*data/sub*' }, '/data')
    expect(evalPredicate(tree, { key: '/sub', name: 'sub', kind: 'd', depth: 1 })).toBe(true)
    expect(evalPredicate(tree, { key: '/other', name: 'other', kind: 'd', depth: 1 })).toBe(false)
    const exact = prefixPathNodes({ op: 'path', pattern: '/data/sub' }, '/data')
    expect(evalPredicate(exact, { key: '/sub', name: 'sub', kind: 'd', depth: 1 })).toBe(true)
  })

  it('rewrites nested nodes and leaves root mounts untouched', () => {
    const tree = prefixPathNodes({ op: 'and', kids: [{ op: 'path', pattern: '/data/*' }] }, '/data')
    expect(evalPredicate(tree, { key: '/x', name: 'x', kind: 'f', depth: 1 })).toBe(true)
    const same: Parameters<typeof prefixPathNodes>[0] = { op: 'path', pattern: '*a*' }
    expect(prefixPathNodes(same, '')).toBe(same)
  })
})

describe('displayPath', () => {
  it('joins like applyMountPrefix', () => {
    expect(displayPath('', '/sub/x')).toBe('/sub/x')
    expect(displayPath('/data', '/sub/x')).toBe('/data/sub/x')
    expect(displayPath('/data', '/')).toBe('/data')
  })
})

describe('emitStartPath size on directories', () => {
  it('directory start contributes size 0: +N excludes, -N keeps (#318)', () => {
    const results: string[] = []
    emitStartPath(results, '/data', 'data', {
      kind: 'd',
      isEmpty: null,
      exists: true,
      tree: { op: 'true' },
      maxDepth: null,
      minDepth: null,
      minSize: 5,
      maxSize: null,
    })
    expect(results).toEqual([])
    emitStartPath(results, '/data', 'data', {
      kind: 'd',
      isEmpty: null,
      exists: true,
      tree: { op: 'true' },
      maxDepth: null,
      minDepth: null,
      minSize: null,
      maxSize: 5,
    })
    expect(results).toEqual(['/data'])
  })
})
