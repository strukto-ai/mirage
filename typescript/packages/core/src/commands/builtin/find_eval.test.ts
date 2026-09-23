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
  bindTree,
  buildTree,
  computeNonemptyDirs,
  dropPruned,
  evalPredicate,
  type FindEntry,
  keep,
  pendingPrunes,
  type PredNode,
  prunedKeys,
  settlePrunes,
  treeHasAction,
  treeHasPrune,
  treeHasType,
  displayPath,
  emitStartPath,
  unrespellRaw,
  withoutPrune,
} from './find_eval.ts'

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

describe('bindTree', () => {
  it('matches -path against the display path (#396)', () => {
    const tree = bindTree({ op: 'path', pattern: '*data/sub*' }, '/data')
    expect(evalPredicate(tree, { key: '/sub', name: 'sub', kind: 'd', depth: 1 })).toBe(true)
    expect(evalPredicate(tree, { key: '/other', name: 'other', kind: 'd', depth: 1 })).toBe(false)
    const exact = bindTree({ op: 'path', pattern: '/data/sub' }, '/data')
    expect(evalPredicate(exact, { key: '/sub', name: 'sub', kind: 'd', depth: 1 })).toBe(true)
  })

  // `find . -path ./skip` prints and matches `./skip`: the row is the
  // display path respelled under the operand as typed (#1147).
  it('matches -path against the row as typed', () => {
    const tree = bindTree({ op: 'path', pattern: './skip' }, '/w', '/w', '.')
    expect(evalPredicate(tree, entry({ key: '/skip', name: 'skip', kind: 'd' }))).toBe(true)
    expect(evalPredicate(tree, entry({ key: '/skip/a', name: 'a' }))).toBe(false)
    const absolute = bindTree({ op: 'path', pattern: './skip' }, '/w', '/w', '/w')
    expect(evalPredicate(absolute, entry({ key: '/skip', kind: 'd' }))).toBe(false)
    const nested = bindTree({ op: 'path', pattern: 'sub/deep' }, '/data', '/data/sub', 'sub')
    expect(evalPredicate(nested, entry({ key: '/sub/deep', kind: 'd' }))).toBe(true)
  })

  it('rewrites nested nodes and copies every ledger', () => {
    const tree = bindTree({ op: 'and', kids: [{ op: 'path', pattern: '/data/*' }] }, '/data')
    expect(evalPredicate(tree, { key: '/x', name: 'x', kind: 'f', depth: 1 })).toBe(true)
    const shared: Parameters<typeof bindTree>[0] = {
      op: 'and',
      kids: [
        { op: 'path', pattern: '*a*' },
        { op: 'prune', pruned: [], pending: [] },
      ],
    }
    const first = bindTree(shared, '')
    const second = bindTree(shared, '')
    expect(first).not.toBe(shared)
    keep(entry({ key: '/a', name: 'a', kind: 'd' }), first, null)
    expect(prunedKeys(first)).toEqual(['/a'])
    expect(prunedKeys(second)).toEqual([])
    expect(prunedKeys(shared)).toEqual([])
  })
})

describe('actions and -prune', () => {
  // `-path ./skip -prune -o -type f -print` holds for ./skip yet never
  // reaches the print, so the directory is not a row.
  it('keep reports only the entries an action reached', () => {
    const tree = bindTree(
      {
        op: 'or',
        kids: [
          {
            op: 'and',
            kids: [
              { op: 'path', pattern: './skip' },
              { op: 'prune', pruned: [], pending: [] },
            ],
          },
          {
            op: 'and',
            kids: [
              { op: 'type', kind: 'f' },
              { op: 'action', kind: 'print' },
            ],
          },
        ],
      },
      '/w',
      '/w',
      '.',
    )
    expect(evalPredicate(tree, entry({ key: '/skip', kind: 'd' }))).toBe(true)
    expect(keep(entry({ key: '/skip', name: 'skip', kind: 'd' }), tree, null)).toBe(false)
    expect(keep(entry({ key: '/keep/f', name: 'f' }), tree, null)).toBe(true)
    expect(keep(entry({ key: '/keep', name: 'keep', kind: 'd' }), tree, null)).toBe(false)
    // Without an action the rows are what the whole expression holds for.
    const plain = bindTree(
      {
        op: 'or',
        kids: [
          {
            op: 'and',
            kids: [
              { op: 'path', pattern: './skip' },
              { op: 'prune', pruned: [], pending: [] },
            ],
          },
          { op: 'type', kind: 'f' },
        ],
      },
      '/w',
      '/w',
      '.',
    )
    expect(keep(entry({ key: '/skip', name: 'skip', kind: 'd' }), plain, null)).toBe(true)
  })

  it('records pruned directories and dropPruned keeps the directory itself', () => {
    const tree = bindTree(
      {
        op: 'or',
        kids: [
          {
            op: 'and',
            kids: [
              { op: 'name', pattern: 'skip', icase: false },
              { op: 'prune', pruned: [], pending: [] },
            ],
          },
          { op: 'action', kind: 'print' },
        ],
      },
      '',
    )
    const dirs = new Set(['/', '/keep', '/skip', '/skip/inner'])
    const rows = ['/', '/keep', '/keep/f', '/skip', '/skip/inner', '/skip/inner/d', '/skipped']
    const kept = rows.filter((r) =>
      keep(
        entry({ key: r, name: r.split('/').pop() ?? '', kind: dirs.has(r) ? 'd' : 'f' }),
        tree,
        null,
      ),
    )
    expect(kept).toEqual(['/', '/keep', '/keep/f', '/skip/inner', '/skip/inner/d', '/skipped'])
    expect(prunedKeys(tree)).toEqual(['/skip'])
    expect(dropPruned(kept, tree)).toEqual(['/', '/keep', '/keep/f', '/skipped'])
    // A pruned file (an object store key that is also a directory prefix)
    // drops nothing.
    const fileTree = bindTree(
      {
        op: 'and',
        kids: [
          { op: 'name', pattern: 'data', icase: false },
          { op: 'prune', pruned: [], pending: [] },
        ],
      },
      '',
    )
    keep(entry({ key: '/data', name: 'data', kind: 'f' }), fileTree, null)
    expect(prunedKeys(fileTree)).toEqual([])
    // Rows under a mount prefix compare as display paths.
    const under = bindTree({ op: 'prune', pruned: [], pending: [] }, '/m')
    keep(entry({ key: '/skip', name: 'skip', kind: 'd' }), under, null)
    expect(dropPruned(['/m/skip', '/m/skip/a', '/m/other'], under, '/m')).toEqual([
      '/m/skip',
      '/m/other',
    ])
    // The pruned root itself stays, though every row starts with its stem.
    const root = bindTree({ op: 'prune', pruned: [], pending: [] }, '')
    keep(entry({ key: '/', name: '', kind: 'd', depth: 0 }), root, null)
    expect(dropPruned(['/', '/a', '/a/b'], root)).toEqual(['/'])
  })

  it('-mindepth prunes nothing above its level', () => {
    const tree = bindTree(
      {
        op: 'or',
        kids: [
          {
            op: 'and',
            kids: [
              { op: 'name', pattern: 'skip', icase: false },
              { op: 'prune', pruned: [], pending: [] },
            ],
          },
          { op: 'action', kind: 'print' },
        ],
      },
      '',
    )
    expect(keep(entry({ key: '/skip', name: 'skip', kind: 'd', depth: 1 }), tree, 2)).toBe(false)
    expect(prunedKeys(tree)).toEqual([])
  })

  it('withoutPrune and the tree probes', () => {
    const tree: Parameters<typeof withoutPrune>[0] = {
      op: 'or',
      kids: [
        {
          op: 'and',
          kids: [
            { op: 'path', pattern: './skip' },
            { op: 'prune', pruned: [], pending: [] },
          ],
        },
        { op: 'not', kid: { op: 'action', kind: 'print' } },
      ],
    }
    expect(treeHasPrune(tree)).toBe(true)
    expect(treeHasAction(tree)).toBe(true)
    expect(withoutPrune(tree)).toEqual({
      op: 'or',
      kids: [
        { op: 'and', kids: [{ op: 'path', pattern: './skip' }, { op: 'true' }] },
        { op: 'not', kid: { op: 'action', kind: 'print' } },
      ],
    })
    expect(treeHasPrune(withoutPrune(tree))).toBe(false)
    expect(
      treeHasAction({
        op: 'or',
        kids: [
          { op: 'path', pattern: 'x' },
          { op: 'prune', pruned: [], pending: [] },
        ],
      }),
    ).toBe(false)
  })
})

describe('time tests and -prune', () => {
  const gated = (): PredNode =>
    bindTree(
      {
        op: 'and',
        kids: [
          { op: 'mtime', lo: 100, hi: null },
          { op: 'prune', pruned: [], pending: [] },
        ],
      },
      '',
    )

  it('an mtime node answers from the entry and defers without one', () => {
    const node: PredNode = { op: 'mtime', lo: 100, hi: null }
    expect(evalPredicate(node, entry({ mtime: 150 }))).toBe(true)
    expect(evalPredicate(node, entry({ mtime: 50 }))).toBe(false)
    expect(evalPredicate(node, entry())).toBe(true)
    expect(evalPredicate({ op: 'mtime', lo: null, hi: 100 }, entry({ mtime: 150 }))).toBe(false)
  })

  it('a prune past an undecided time test is pending until settled', () => {
    const tree = gated()
    for (const key of ['/old', '/new']) {
      expect(keep(entry({ key, name: key.slice(1), kind: 'd' }), tree, null)).toBe(true)
    }
    // Pending counts as pruned until the caller learns the mtimes.
    expect(prunedKeys(tree)).toEqual(['/old', '/new'])
    expect(pendingPrunes(tree).map((p) => p.entry.key)).toEqual(['/old', '/new'])
    const rows = ['/old', '/old/f', '/new', '/new/g']
    expect(dropPruned(rows, tree)).toEqual(['/old', '/new'])
    // A key the map does not name stays pending.
    settlePrunes(tree, new Map([['/old', 50]]))
    expect(prunedKeys(tree)).toEqual(['/new'])
    expect(pendingPrunes(tree).map((p) => p.entry.key)).toEqual(['/new'])
    settlePrunes(tree, new Map([['/new', 150]]))
    expect(prunedKeys(tree)).toEqual(['/new'])
    expect(pendingPrunes(tree)).toEqual([])
    expect(dropPruned(rows, tree)).toEqual(['/old', '/old/f', '/new'])
    // bindTree hands out a fresh pending ledger too.
    const bound = bindTree(
      {
        op: 'prune',
        pruned: ['/x'],
        pending: [{ entry: entry({ key: '/y', kind: 'd' }) }],
      },
      '',
    )
    expect(bound).toEqual({ op: 'prune', pruned: [], pending: [] })
  })

  it('a prune before a time test is firm', () => {
    const tree = bindTree(
      {
        op: 'and',
        kids: [
          { op: 'prune', pruned: [], pending: [] },
          { op: 'mtime', lo: 100, hi: null },
        ],
      },
      '',
    )
    expect(keep(entry({ key: '/old', name: 'old', kind: 'd' }), tree, null)).toBe(true)
    expect(prunedKeys(tree)).toEqual(['/old'])
    expect(pendingPrunes(tree)).toEqual([])
  })

  it('a prune with a known mtime needs no settling', () => {
    const tree = gated()
    expect(keep(entry({ key: '/old', name: 'old', kind: 'd', mtime: 50 }), tree, null)).toBe(false)
    expect(keep(entry({ key: '/new', name: 'new', kind: 'd', mtime: 150 }), tree, null)).toBe(true)
    expect(prunedKeys(tree)).toEqual(['/new'])
    expect(pendingPrunes(tree)).toEqual([])
  })

  it('settling needs every deferred test to hold', () => {
    const two = (): PredNode =>
      bindTree(
        {
          op: 'and',
          kids: [
            { op: 'mtime', lo: 100, hi: null },
            { op: 'mtime', lo: null, hi: 200 },
            { op: 'prune', pruned: [], pending: [] },
          ],
        },
        '',
      )
    let tree = two()
    keep(entry({ key: '/d', name: 'd', kind: 'd' }), tree, null)
    expect(pendingPrunes(tree).map((p) => p.entry.key)).toEqual(['/d'])
    settlePrunes(tree, new Map([['/d', 250]]))
    expect(prunedKeys(tree)).toEqual([])
    tree = two()
    keep(entry({ key: '/d', name: 'd', kind: 'd' }), tree, null)
    settlePrunes(tree, new Map([['/d', 150]]))
    expect(prunedKeys(tree)).toEqual(['/d'])
    // A directory without a reported mtime never passes a time test.
    tree = gated()
    keep(entry({ key: '/d', name: 'd', kind: 'd' }), tree, null)
    settlePrunes(tree, new Map([['/d', null]]))
    expect(prunedKeys(tree)).toEqual([])
  })

  it('deferred tests stay with the branch that needs them', () => {
    // `( -mtime 1 -type f ) -o ( -type d -prune )`: the first arm fails on
    // -type f whatever the mtime, so the prune on the second is firm and no
    // stat is owed (GNU prunes every directory here).
    let tree = bindTree(
      {
        op: 'or',
        kids: [
          {
            op: 'and',
            kids: [
              { op: 'mtime', lo: 100, hi: null },
              { op: 'type', kind: 'f' },
            ],
          },
          {
            op: 'and',
            kids: [
              { op: 'type', kind: 'd' },
              { op: 'prune', pruned: [], pending: [] },
            ],
          },
        ],
      },
      '',
    )
    expect(keep(entry({ key: '/d', name: 'd', kind: 'd' }), tree, null)).toBe(true)
    expect(pendingPrunes(tree)).toEqual([])
    expect(prunedKeys(tree)).toEqual(['/d'])
    // `( ! -mtime +N -type d ) -o -prune`: the failing factor's own test is
    // the one that may flip, so the prune waits on it.
    const negated = (): PredNode =>
      bindTree(
        {
          op: 'or',
          kids: [
            {
              op: 'and',
              kids: [
                { op: 'not', kid: { op: 'mtime', lo: null, hi: 100 } },
                { op: 'type', kind: 'd' },
              ],
            },
            { op: 'prune', pruned: [], pending: [] },
          ],
        },
        '',
      )
    tree = negated()
    expect(keep(entry({ key: '/d', name: 'd', kind: 'd' }), tree, null)).toBe(true)
    expect(pendingPrunes(tree).map((p) => p.entry.key)).toEqual(['/d'])
    settlePrunes(tree, new Map([['/d', 150]]))
    expect(prunedKeys(tree)).toEqual([])
    tree = negated()
    keep(entry({ key: '/d', name: 'd', kind: 'd' }), tree, null)
    settlePrunes(tree, new Map([['/d', 50]]))
    expect(prunedKeys(tree)).toEqual(['/d'])
  })

  it('a time test steering past every prune leaves the directory pending', () => {
    // `-mtime 1 -o -prune`: without its mtime the directory takes the first
    // arm, but GNU prunes it when the test fails, so it waits.
    const either = (): PredNode =>
      bindTree(
        {
          op: 'or',
          kids: [
            { op: 'mtime', lo: 100, hi: null },
            { op: 'prune', pruned: [], pending: [] },
          ],
        },
        '',
      )
    let tree = either()
    expect(keep(entry({ key: '/d', name: 'd', kind: 'd' }), tree, null)).toBe(true)
    expect(pendingPrunes(tree).map((p) => p.entry.key)).toEqual(['/d'])
    expect(prunedKeys(tree)).toEqual(['/d'])
    settlePrunes(tree, new Map([['/d', 150]]))
    expect(prunedKeys(tree)).toEqual([])
    tree = either()
    keep(entry({ key: '/d', name: 'd', kind: 'd' }), tree, null)
    settlePrunes(tree, new Map([['/d', 50]]))
    expect(prunedKeys(tree)).toEqual(['/d'])
    // A file has nothing to prune, a known mtime decides at once, and a
    // tree without -prune has nothing to wait for.
    tree = either()
    expect(keep(entry({ key: '/f', name: 'f', kind: 'f' }), tree, null)).toBe(true)
    expect(keep(entry({ key: '/d', name: 'd', kind: 'd', mtime: 150 }), tree, null)).toBe(true)
    expect(pendingPrunes(tree)).toEqual([])
    tree = bindTree(
      {
        op: 'or',
        kids: [
          { op: 'mtime', lo: 100, hi: null },
          { op: 'type', kind: 'd' },
        ],
      },
      '',
    )
    expect(keep(entry({ key: '/d', name: 'd', kind: 'd' }), tree, null)).toBe(true)
    expect(pendingPrunes(tree)).toEqual([])
  })

  it('settling evaluates the expression again', () => {
    // `( -mtime 1 -o -type d ) -prune`: a directory failing the time test
    // still reaches the prune through -type d, as GNU's does.
    const either = (): PredNode =>
      bindTree(
        {
          op: 'and',
          kids: [
            {
              op: 'or',
              kids: [
                { op: 'mtime', lo: 100, hi: null },
                { op: 'type', kind: 'd' },
              ],
            },
            { op: 'prune', pruned: [], pending: [] },
          ],
        },
        '',
      )
    let tree = either()
    expect(keep(entry({ key: '/d', name: 'd', kind: 'd' }), tree, null)).toBe(true)
    expect(pendingPrunes(tree).map((p) => p.entry.key)).toEqual(['/d'])
    settlePrunes(tree, new Map([['/d', 50]]))
    expect(pendingPrunes(tree)).toEqual([])
    expect(prunedKeys(tree)).toEqual(['/d'])
    // Without a reported mtime every time test is false; the prune is still
    // reached here, and not past a bare test.
    tree = either()
    keep(entry({ key: '/d', name: 'd', kind: 'd' }), tree, null)
    settlePrunes(tree, new Map([['/d', null]]))
    expect(prunedKeys(tree)).toEqual(['/d'])
    // An action reached again while settling changes nothing: the rows were
    // decided at the walk.
    tree = bindTree(
      {
        op: 'and',
        kids: [
          { op: 'mtime', lo: 100, hi: null },
          { op: 'prune', pruned: [], pending: [] },
          { op: 'action', kind: 'print' },
        ],
      },
      '',
    )
    expect(keep(entry({ key: '/d', name: 'd', kind: 'd' }), tree, null)).toBe(true)
    settlePrunes(tree, new Map([['/d', 150]]))
    expect(prunedKeys(tree)).toEqual(['/d'])
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

describe('unrespellRaw', () => {
  it('inverts respelling', () => {
    expect(unrespellRaw('./sub/x', '/data', '.')).toBe('/data/sub/x')
    expect(unrespellRaw('.', '/data', '.')).toBe('/data')
    expect(unrespellRaw('/data/x', '/data', '/data')).toBe('/data/x')
  })
})
