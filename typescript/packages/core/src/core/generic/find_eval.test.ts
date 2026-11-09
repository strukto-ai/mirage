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
import { FileType, type FileStat } from '../../types.ts'
import { DIR_SIZE } from '../../utils/stat_view.ts'
import {
  bindTree,
  buildTree,
  displayPath,
  emitStartPath,
  evaluate,
  keep,
  treeHasAction,
  treeHasPrune,
  treeHasTime,
  unrespellRaw,
  verdict,
  withoutPrune,
} from './find_eval.ts'
import { type Effects, type FindEntry, type PredNode } from './types.ts'

function effects(): Effects {
  return { acted: false, pruned: false, deferred: [] }
}

function entry(over: Partial<FindEntry> = {}): FindEntry {
  return { key: '/data/a.txt', name: 'a.txt', kind: 'f', depth: 1, ...over }
}

// The keys every `-prune` in the tree holds pending.
describe('size', () => {
  it('needs a stat for anything but a directory', () => {
    const unsized = { name: 'a.txt', type: FileType.FILE, size: null } as FileStat
    expect(evaluate({ op: 'size', min: null, max: 0 }, entry(), effects())).toBe(false)
    expect(evaluate({ op: 'size', min: null, max: 0 }, entry({ stat: unsized }), effects())).toBe(
      true,
    )
    expect(
      evaluate({ op: 'size', min: DIR_SIZE, max: null }, entry({ kind: 'd' }), effects()),
    ).toBe(true)
  })
})

describe('empty', () => {
  it('empty node matches only isEmpty entries', () => {
    expect(evaluate({ op: 'empty' }, entry({ isEmpty: true }), effects())).toBe(true)
    expect(evaluate({ op: 'empty' }, entry({ isEmpty: false }), effects())).toBe(false)
    expect(evaluate({ op: 'empty' }, entry({}), effects())).toBe(false)
  })

  it('buildTree empty combines with type', () => {
    const tree = buildTree({ type: 'd', empty: true })
    expect(evaluate(tree, entry({ kind: 'd', isEmpty: true }), effects())).toBe(true)
    expect(evaluate(tree, entry({ kind: 'd', isEmpty: false }), effects())).toBe(false)
    expect(evaluate(tree, entry({ kind: 'f', isEmpty: true }), effects())).toBe(false)
  })
})

describe('evaluate', () => {
  it('name matches glob', () => {
    expect(evaluate({ op: 'name', pattern: '*.txt', icase: false }, entry(), effects())).toBe(true)
    expect(evaluate({ op: 'name', pattern: '*.md', icase: false }, entry(), effects())).toBe(false)
  })

  it('iname is case insensitive', () => {
    const e = entry({ name: 'A.TXT' })
    expect(evaluate({ op: 'name', pattern: '*.txt', icase: true }, e, effects())).toBe(true)
    expect(evaluate({ op: 'name', pattern: '*.txt', icase: false }, e, effects())).toBe(false)
  })

  it('path matches key', () => {
    const e = entry({ key: '/data/sub/x', name: 'x' })
    expect(evaluate({ op: 'path', pattern: '*/sub/*' }, e, effects())).toBe(true)
    expect(evaluate({ op: 'path', pattern: '*/other/*' }, e, effects())).toBe(false)
  })

  it('type matches kind', () => {
    expect(evaluate({ op: 'type', kind: 'f' }, entry({ kind: 'f' }), effects())).toBe(true)
    expect(evaluate({ op: 'type', kind: 'd' }, entry({ kind: 'f' }), effects())).toBe(false)
  })

  it('not negates', () => {
    expect(
      evaluate(
        { op: 'not', kid: { op: 'name', pattern: '*.txt', icase: false } },
        entry(),
        effects(),
      ),
    ).toBe(false)
    expect(
      evaluate(
        { op: 'not', kid: { op: 'name', pattern: '*.md', icase: false } },
        entry(),
        effects(),
      ),
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
    expect(evaluate(node, entry(), effects())).toBe(true)
  })

  it('or requires any', () => {
    const node = {
      op: 'or' as const,
      kids: [
        { op: 'name' as const, pattern: '*.md', icase: false },
        { op: 'name' as const, pattern: '*.txt', icase: false },
      ],
    }
    expect(evaluate(node, entry(), effects())).toBe(true)
  })

  it('true matches everything', () => {
    expect(evaluate({ op: 'true' }, entry(), effects())).toBe(true)
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
    expect(evaluate(buildTree({}), entry(), effects())).toBe(true)
  })

  it('name and type', () => {
    const tree = buildTree({ name: '*.txt', type: 'f' })
    expect(evaluate(tree, entry({ kind: 'f' }), effects())).toBe(true)
    expect(evaluate(tree, entry({ name: 'a.md', kind: 'f' }), effects())).toBe(false)
    expect(evaluate(tree, entry({ kind: 'd' }), effects())).toBe(false)
  })

  it('nameExclude is negated', () => {
    const tree = buildTree({ nameExclude: '*.txt' })
    expect(evaluate(tree, entry({ name: 'a.txt' }), effects())).toBe(false)
    expect(evaluate(tree, entry({ name: 'a.md' }), effects())).toBe(true)
  })

  it('orNames', () => {
    const tree = buildTree({ orNames: ['*.md', '*.txt'] })
    expect(evaluate(tree, entry({ name: 'a.txt' }), effects())).toBe(true)
    expect(evaluate(tree, entry({ name: 'a.rst' }), effects())).toBe(false)
  })

  it('iname', () => {
    const tree = buildTree({ iname: '*.txt' })
    expect(evaluate(tree, entry({ name: 'A.TXT' }), effects())).toBe(true)
  })
})

describe('bindTree', () => {
  it('matches -path against the display path (#396)', () => {
    const tree = bindTree({ op: 'path', pattern: '*data/sub*' }, '/data')
    expect(evaluate(tree, { key: '/sub', name: 'sub', kind: 'd', depth: 1 }, effects())).toBe(true)
    expect(evaluate(tree, { key: '/other', name: 'other', kind: 'd', depth: 1 }, effects())).toBe(
      false,
    )
    const exact = bindTree({ op: 'path', pattern: '/data/sub' }, '/data')
    expect(evaluate(exact, { key: '/sub', name: 'sub', kind: 'd', depth: 1 }, effects())).toBe(true)
  })

  // `find . -path ./skip` prints and matches `./skip`: the row is the
  // display path respelled under the operand as typed (#1147).
  it('matches -path against the row as typed', () => {
    const tree = bindTree({ op: 'path', pattern: './skip' }, '/w', '/w', '.')
    expect(evaluate(tree, entry({ key: '/skip', name: 'skip', kind: 'd' }), effects())).toBe(true)
    expect(evaluate(tree, entry({ key: '/skip/a', name: 'a' }), effects())).toBe(false)
    const absolute = bindTree({ op: 'path', pattern: './skip' }, '/w', '/w', '/w')
    expect(evaluate(absolute, entry({ key: '/skip', kind: 'd' }), effects())).toBe(false)
    const nested = bindTree({ op: 'path', pattern: 'sub/deep' }, '/data', '/data/sub', 'sub')
    expect(evaluate(nested, entry({ key: '/sub/deep', kind: 'd' }), effects())).toBe(true)
  })

  it('rewrites nested nodes', () => {
    const tree = bindTree({ op: 'and', kids: [{ op: 'path', pattern: '/data/*' }] }, '/data')
    expect(evaluate(tree, { key: '/x', name: 'x', kind: 'f', depth: 1 }, effects())).toBe(true)
    const shared: Parameters<typeof bindTree>[0] = {
      op: 'and',
      kids: [{ op: 'path', pattern: '*a*' }, { op: 'prune' }],
    }
    const first = bindTree(shared, '')
    expect(first).not.toBe(shared)
    expect(verdict(entry({ key: '/a', name: 'a', kind: 'd' }), first, null)).toEqual([true, true])
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
            kids: [{ op: 'path', pattern: './skip' }, { op: 'prune' }],
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
    expect(evaluate(tree, entry({ key: '/skip', kind: 'd' }), effects())).toBe(true)
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
            kids: [{ op: 'path', pattern: './skip' }, { op: 'prune' }],
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

  it('names the directories a prune reaches', () => {
    const tree = bindTree(
      {
        op: 'or',
        kids: [
          {
            op: 'and',
            kids: [{ op: 'name', pattern: 'skip', icase: false }, { op: 'prune' }],
          },
          { op: 'action', kind: 'print' },
        ],
      },
      '',
    )
    const dirs = new Set(['/', '/keep', '/skip', '/skip/inner'])
    const rows = ['/', '/keep', '/keep/f', '/skip', '/skip/inner', '/skip/inner/d', '/skipped']
    const answers = rows.map((r) =>
      verdict(
        entry({ key: r, name: r.split('/').pop() ?? '', kind: dirs.has(r) ? 'd' : 'f' }),
        tree,
        null,
      ),
    )
    expect(rows.filter((_, i) => answers[i]?.[0])).toEqual([
      '/',
      '/keep',
      '/keep/f',
      '/skip/inner',
      '/skip/inner/d',
      '/skipped',
    ])
    expect(rows.filter((_, i) => answers[i]?.[1])).toEqual(['/skip'])
    // A pruned file (an object store key that is also a directory prefix)
    // drops nothing.
    const fileTree = bindTree(
      {
        op: 'and',
        kids: [{ op: 'name', pattern: 'data', icase: false }, { op: 'prune' }],
      },
      '',
    )
    expect(verdict(entry({ key: '/data', name: 'data', kind: 'f' }), fileTree, null)).toEqual([
      true,
      false,
    ])
  })

  it('-mindepth prunes nothing above its level', () => {
    const tree = bindTree(
      {
        op: 'or',
        kids: [
          {
            op: 'and',
            kids: [{ op: 'name', pattern: 'skip', icase: false }, { op: 'prune' }],
          },
          { op: 'action', kind: 'print' },
        ],
      },
      '',
    )
    expect(verdict(entry({ key: '/skip', name: 'skip', kind: 'd', depth: 1 }), tree, 2)).toEqual([
      false,
      false,
    ])
  })

  it('withoutPrune and the tree probes', () => {
    const tree: Parameters<typeof withoutPrune>[0] = {
      op: 'or',
      kids: [
        {
          op: 'and',
          kids: [{ op: 'path', pattern: './skip' }, { op: 'prune' }],
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
        kids: [{ op: 'path', pattern: 'x' }, { op: 'prune' }],
      }),
    ).toBe(false)
    expect(
      treeHasTime({
        op: 'and',
        kids: [
          { op: 'path', pattern: 'x' },
          { op: 'not', kid: { op: 'mtime', lo: null, hi: 1 } },
        ],
      }),
    ).toBe(true)
    expect(treeHasTime(tree)).toBe(false)
  })
})

describe('time tests and -prune', () => {
  const gated = (): PredNode =>
    bindTree(
      {
        op: 'and',
        kids: [{ op: 'mtime', lo: 100, hi: null }, { op: 'prune' }],
      },
      '',
    )

  it('an mtime node answers from the entry and defers without one', () => {
    const node: PredNode = { op: 'mtime', lo: 100, hi: null }
    expect(evaluate(node, entry({ mtime: 150 }), effects())).toBe(true)
    expect(evaluate(node, entry({ mtime: 50 }), effects())).toBe(false)
    expect(evaluate(node, entry(), effects())).toBe(true)
    expect(evaluate({ op: 'mtime', lo: null, hi: 100 }, entry({ mtime: 150 }), effects())).toBe(
      false,
    )
  })

  it('a prune past an undecided time test counts', () => {
    const tree = gated()
    for (const key of ['/old', '/new']) {
      expect(verdict(entry({ key, name: key.slice(1), kind: 'd' }), tree, null)).toEqual([
        true,
        true,
      ])
    }
  })

  it('a prune before a time test fires whatever the time', () => {
    const tree = bindTree(
      {
        op: 'and',
        kids: [{ op: 'prune' }, { op: 'mtime', lo: 100, hi: null }],
      },
      '',
    )
    const old = entry({ key: '/old', name: 'old', kind: 'd', mtime: 50 })
    expect(verdict(old, tree, null)).toEqual([false, true])
  })

  it('a prune with a known mtime follows the test', () => {
    const tree = gated()
    const old = entry({ key: '/old', name: 'old', kind: 'd', mtime: 50 })
    const fresh = entry({ key: '/new', name: 'new', kind: 'd', mtime: 150 })
    expect(verdict(old, tree, null)).toEqual([false, false])
    expect(verdict(fresh, tree, null)).toEqual([true, true])
  })

  it('deferred tests stay with the branch that needs them', () => {
    // `( -mtime 1 -type f ) -o ( -type d -prune )`: the first arm fails on
    // -type f whatever the mtime, so the second arm prunes (GNU prunes every
    // directory here).
    const failedArm = (other: PredNode): PredNode =>
      bindTree(
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
            other,
          ],
        },
        '',
      )
    const dir = entry({ key: '/d', name: 'd', kind: 'd' })
    const typed = failedArm({ op: 'and', kids: [{ op: 'type', kind: 'd' }, { op: 'prune' }] })
    expect(verdict(dir, typed, null)).toEqual([true, true])
    // The same failed arm leaves nothing to wait on when the other arm
    // reaches no prune.
    const named = failedArm({
      op: 'and',
      kids: [{ op: 'name', pattern: 'skip', icase: false }, { op: 'prune' }],
    })
    expect(verdict(dir, named, null)).toEqual([false, false])
    // `( ! -mtime +N -type d ) -o -prune`: the failing factor's own test is
    // the one that may flip, so the prune counts.
    const negated = bindTree(
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
          { op: 'prune' },
        ],
      },
      '',
    )
    expect(verdict(dir, negated, null)).toEqual([true, true])
  })

  it('a time test steering past every prune still prunes', () => {
    // `-mtime 1 -o -prune`: without its mtime the directory takes the first
    // arm, but GNU prunes it when the test fails, so it counts.
    const tree = bindTree(
      {
        op: 'or',
        kids: [{ op: 'mtime', lo: 100, hi: null }, { op: 'prune' }],
      },
      '',
    )
    expect(verdict(entry({ key: '/d', name: 'd', kind: 'd' }), tree, null)).toEqual([true, true])
    // A file has nothing to prune, a known mtime decides at once, and a
    // tree without -prune has nothing to wait for.
    expect(verdict(entry({ key: '/f', name: 'f', kind: 'f' }), tree, null)).toEqual([true, false])
    const known = entry({ key: '/d', name: 'd', kind: 'd', mtime: 150 })
    expect(verdict(known, tree, null)).toEqual([true, false])
    const plain = bindTree(
      {
        op: 'or',
        kids: [
          { op: 'mtime', lo: 100, hi: null },
          { op: 'type', kind: 'd' },
        ],
      },
      '',
    )
    expect(verdict(entry({ key: '/d', name: 'd', kind: 'd' }), plain, null)).toEqual([true, false])
  })
})

describe('displayPath', () => {
  it('joins the prefix and the key with one slash', () => {
    expect(displayPath('', '/sub/x')).toBe('/sub/x')
    expect(displayPath('/data', '/sub/x')).toBe('/data/sub/x')
    expect(displayPath('/data', '/')).toBe('/data')
  })
})

describe('emitStartPath size on directories', () => {
  it('a directory start is DIR_SIZE bytes: +N below it keeps, -N below it drops', () => {
    const emit = (minSize: number | null, maxSize: number | null): string[] => {
      const results: string[] = []
      emitStartPath(results, '/data', 'data', {
        kind: 'd',
        isEmpty: null,
        exists: true,
        tree: { op: 'true' },
        maxDepth: null,
        minDepth: null,
        minSize,
        maxSize,
      })
      return results
    }
    expect(emit(5, null)).toEqual(['/data'])
    expect(emit(null, 5)).toEqual([])
    expect(emit(DIR_SIZE, DIR_SIZE)).toEqual(['/data'])
    expect(emit(DIR_SIZE + 1, null)).toEqual([])
  })
})

describe('unrespellRaw', () => {
  it('inverts respelling', () => {
    expect(unrespellRaw('./sub/x', '/data', '.')).toBe('/data/sub/x')
    expect(unrespellRaw('.', '/data', '.')).toBe('/data')
    expect(unrespellRaw('/data/x', '/data', '/data')).toBe('/data/x')
  })
})
