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
  type ComputeEntries,
  type ComputeSize,
  type DuFlags,
  duGeneric,
  parseDepth,
  parseDuFlags,
  rollup,
  runDu,
  toVirtual,
} from './du.ts'
import { PathSpec } from '../../../types.ts'
import type { CommandOpts } from '../../config.ts'
import type { UsageError } from '../../errors.ts'

const DEC = new TextDecoder()

function spec(virtual: string, resourcePath: string, rawPath?: string): PathSpec {
  return new PathSpec({
    virtual,
    directory: virtual,
    resourcePath,
    ...(rawPath === undefined ? {} : { rawPath }),
  })
}

function opts(flags: Record<string, string | boolean> = {}): CommandOpts {
  return {
    stdin: null,
    flags,
    filetypeFns: null,
    cwd: '/',
    resource: {} as never,
  } as unknown as CommandOpts
}

function flags(over: Partial<DuFlags> = {}): DuFlags {
  return { s: false, a: false, h: false, c: false, maxDepth: null, ...over }
}

/** Build (computeSize, computeEntries) over a mount-relative in-memory tree. */
function backend(tree: Record<string, number>): [ComputeSize, ComputeEntries] {
  const under = (p: PathSpec): [string, number][] => {
    const base = p.mountPath.replace(/\/$/, '')
    return Object.entries(tree)
      .filter(([path]) => path === base || path.startsWith(base + '/'))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  }
  return [
    (p) => Promise.resolve(under(p).reduce((acc, [, size]) => acc + size, 0)),
    (p) => {
      const found = under(p)
      return Promise.resolve([found, found.reduce((acc, [, size]) => acc + size, 0)])
    },
  ]
}

describe('duGeneric', () => {
  it('reports a single file size', async () => {
    const [size, entries] = backend({ '/f.txt': 5 })
    const out = await duGeneric([spec('/f.txt', 'f.txt')], flags(), size, entries)
    expect(DEC.decode(out.stdout)).toBe('5\t/f.txt\n')
    expect(out.exitCode).toBe(0)
  })

  it('prints a file operand once under -a', async () => {
    const [size, entries] = backend({ '/f.txt': 5 })
    const out = await duGeneric([spec('/f.txt', 'f.txt')], flags({ a: true }), size, entries)
    expect(DEC.decode(out.stdout)).toBe('5\t/f.txt\n')
  })

  it('prints only the operand for a directory of files', async () => {
    const [size, entries] = backend({ '/dir/a.txt': 2, '/dir/b.txt': 3 })
    const out = await duGeneric([spec('/dir', 'dir')], flags(), size, entries)
    expect(DEC.decode(out.stdout)).toBe('5\t/dir\n')
  })

  it('gives every subdirectory its own line', async () => {
    const [size, entries] = backend({
      '/dir/a.txt': 3,
      '/dir/sub/b.txt': 2,
      '/dir/sub/deep/c.txt': 1,
    })
    const out = await duGeneric([spec('/dir', 'dir')], flags(), size, entries)
    expect(DEC.decode(out.stdout)).toBe('1\t/dir/sub/deep\n3\t/dir/sub\n6\t/dir\n')
  })

  it('lists files then directories post-order under -a', async () => {
    const [size, entries] = backend({
      '/dir/a.txt': 3,
      '/dir/sub/b.txt': 2,
      '/dir/sub/deep/c.txt': 1,
    })
    const out = await duGeneric([spec('/dir', 'dir')], flags({ a: true }), size, entries)
    expect(DEC.decode(out.stdout)).toBe(
      '3\t/dir/a.txt\n2\t/dir/sub/b.txt\n1\t/dir/sub/deep/c.txt\n1\t/dir/sub/deep\n3\t/dir/sub\n6\t/dir\n',
    )
  })

  it('lists every file under -a', async () => {
    const [size, entries] = backend({ '/dir/a.txt': 2, '/dir/b.txt': 3 })
    const out = await duGeneric([spec('/dir', 'dir')], flags({ a: true }), size, entries)
    expect(DEC.decode(out.stdout)).toBe('2\t/dir/a.txt\n3\t/dir/b.txt\n5\t/dir\n')
  })

  it('carries the mount prefix on -a entries', async () => {
    const [size, entries] = backend({ '/notes.txt': 4 })
    const out = await duGeneric([spec('/slack', '')], flags({ a: true }), size, entries)
    expect(DEC.decode(out.stdout)).toBe('4\t/slack/notes.txt\n4\t/slack\n')
  })

  it('distinguishes the same name under two mounts', async () => {
    const [size, entries] = backend({ '/notes.txt': 4 })
    const first = await duGeneric([spec('/m1', '')], flags({ a: true }), size, entries)
    const second = await duGeneric([spec('/m2', '')], flags({ a: true }), size, entries)
    expect(DEC.decode(first.stdout)).toBe('4\t/m1/notes.txt\n4\t/m1\n')
    expect(DEC.decode(second.stdout)).toBe('4\t/m2/notes.txt\n4\t/m2\n')
  })

  it('respells entries as the operand was typed', async () => {
    const [size, entries] = backend({ '/dir/a.txt': 2 })
    const out = await duGeneric([spec('/dir', 'dir', 'dir')], flags({ a: true }), size, entries)
    expect(DEC.decode(out.stdout)).toBe('2\tdir/a.txt\n2\tdir\n')
  })

  it('summarises to one line under -s', async () => {
    const [size, entries] = backend({ '/dir/a.txt': 2, '/dir/sub/b.txt': 3 })
    const out = await duGeneric([spec('/dir', 'dir')], flags({ s: true }), size, entries)
    expect(DEC.decode(out.stdout)).toBe('5\t/dir\n')
  })

  it('drops everything below the operand at --max-depth=0', async () => {
    const [size, entries] = backend({ '/dir/a.txt': 2, '/dir/sub/b.txt': 3 })
    const out = await duGeneric(
      [spec('/dir', 'dir')],
      flags({ a: true, maxDepth: 0 }),
      size,
      entries,
    )
    expect(DEC.decode(out.stdout)).toBe('5\t/dir\n')
  })

  it('keeps direct children at --max-depth=1', async () => {
    const [size, entries] = backend({ '/dir/a.txt': 2, '/dir/sub/b.txt': 3 })
    const out = await duGeneric(
      [spec('/dir', 'dir')],
      flags({ a: true, maxDepth: 1 }),
      size,
      entries,
    )
    expect(DEC.decode(out.stdout)).toBe('2\t/dir/a.txt\n3\t/dir/sub\n5\t/dir\n')
  })

  it('prints only the operand for a negative depth', async () => {
    const [size, entries] = backend({ '/dir/a.txt': 2, '/dir/sub/b.txt': 3 })
    const out = await duGeneric([spec('/dir', 'dir')], flags({ maxDepth: -1 }), size, entries)
    expect(DEC.decode(out.stdout)).toBe('5\t/dir\n')
    expect(out.exitCode).toBe(0)
  })

  it('appends a grand total under -c', async () => {
    const [size, entries] = backend({ '/dir/a.txt': 2, '/dir/b.txt': 3 })
    const out = await duGeneric([spec('/dir', 'dir')], flags({ c: true }), size, entries)
    expect(DEC.decode(out.stdout).trimEnd().split('\n').at(-1)).toBe('5\ttotal')
  })

  it('renders human-readable sizes under -h', async () => {
    const [size, entries] = backend({ '/dir/a.txt': 4096 })
    const out = await duGeneric([spec('/dir', 'dir')], flags({ h: true }), size, entries)
    expect(DEC.decode(out.stdout).split('\t')[0]?.endsWith('K')).toBe(true)
  })

  it('renders multiple operands in order', async () => {
    const [size, entries] = backend({ '/a.txt': 2, '/b.txt': 3 })
    const out = await duGeneric(
      [spec('/a.txt', 'a.txt'), spec('/b.txt', 'b.txt')],
      flags(),
      size,
      entries,
    )
    expect(DEC.decode(out.stdout)).toBe('2\t/a.txt\n3\t/b.txt\n')
  })

  it('still reports a total when the backend has no entries op', async () => {
    const [size] = backend({ '/dir/a.txt': 2 })
    const out = await duGeneric([spec('/dir', 'dir')], flags({ a: true }), size, undefined)
    expect(DEC.decode(out.stdout)).toBe('2\t/dir\n')
  })

  it('reports a missing operand and exits 1', async () => {
    const [size, entries] = backend({ '/dir/a.txt': 2 })
    const out = await duGeneric([spec('/dir', 'dir')], flags(), size, entries, ['nosuch'])
    expect(DEC.decode(out.stdout)).toBe('2\t/dir\n')
    expect(DEC.decode(out.stderr)).toBe("du: cannot access 'nosuch': No such file or directory\n")
    expect(out.exitCode).toBe(1)
  })

  it('reads a driver error on the content probe as missing', async () => {
    const boom = () => {
      throw new Error('Graph API error 404 (itemNotFound)')
    }
    const out = await runDu(
      [spec('/data/nosuch', 'nosuch')],
      opts({ c: true }),
      (targets) => Promise.resolve(targets),
      () => Promise.reject(new Error('ENOENT')),
      boom as unknown as ComputeSize,
      boom as unknown as ComputeEntries,
    )
    expect(DEC.decode(out.stdout)).toBe('0\ttotal\n')
    expect(DEC.decode(out.stderr)).toBe(
      "du: cannot access '/data/nosuch': No such file or directory\n",
    )
    expect(out.exitCode).toBe(1)
  })

  it('still prints a total under -c when every operand is missing', async () => {
    const [size, entries] = backend({})
    const out = await duGeneric([], flags({ c: true }), size, entries, ['nosuch'])
    expect(DEC.decode(out.stdout)).toBe('0\ttotal\n')
    expect(out.exitCode).toBe(1)
  })

  it('reports a truncated walk and exits 1', async () => {
    const [size, entries] = backend({ '/dir/a.txt': 2 })
    const out = await duGeneric([spec('/dir', 'dir')], flags(), size, entries, [], () => true)
    expect(DEC.decode(out.stdout)).toBe('2\t/dir\n')
    expect(out.exitCode).toBe(1)
    expect(DEC.decode(out.stderr)).toContain('incomplete')
  })

  it('is silent and exits 0 when the walk completed', async () => {
    const [size, entries] = backend({ '/dir/a.txt': 2 })
    const out = await duGeneric([spec('/dir', 'dir')], flags(), size, entries, [], () => false)
    expect(out.stderr.length).toBe(0)
    expect(out.exitCode).toBe(0)
  })
})

describe('parseDuFlags', () => {
  it('rejects -s with -a', () => {
    expect(() => parseDuFlags(opts({ s: true, a: true }))).toThrow(
      /cannot both summarize and show all entries/,
    )
  })

  it('exits 1 on a usage error, like GNU du', () => {
    try {
      parseDuFlags(opts({ s: true, a: true }))
      expect.unreachable()
    } catch (err) {
      expect((err as UsageError).exitCode).toBe(1)
    }
  })

  it('rejects -s with --max-depth', () => {
    expect(() => parseDuFlags(opts({ s: true, max_depth: '1' }))).toThrow(
      /summarizing conflicts with --max-depth=1/,
    )
  })

  it('rejects a non-numeric depth', () => {
    expect(() => parseDuFlags(opts({ max_depth: '1x' }))).toThrow(/invalid maximum depth '1x'/)
  })

  it('reports a bad depth before the conflict, like GNU', () => {
    expect(() => parseDuFlags(opts({ s: true, a: true, max_depth: 'abc' }))).toThrow(
      /invalid maximum depth/,
    )
  })

  it('accepts a negative depth', () => {
    expect(parseDuFlags(opts({ max_depth: '-1' })).maxDepth).toBe(-1)
  })

  it('reads -d as another spelling of --max-depth', () => {
    expect(parseDuFlags(opts({ d: '2' })).maxDepth).toBe(2)
  })
})

describe('parseDepth', () => {
  // Pinned against debian coreutils: C strtoul base 0, no whitespace.
  const CASES: [string, number | null][] = [
    ['0', 0],
    ['2', 2],
    ['8', 8],
    ['+2', 2],
    ['-1', -1],
    ['-0', 0],
    ['010', 8],
    ['00', 0],
    ['0x2', 2],
    ['0X3', 3],
    ['09', null],
    ['0xz', null],
    ['1x', null],
    ['abc', null],
    ['1_0', null],
    ['١٢', null],
    [' 1 ', null],
  ]
  for (const [text, expected] of CASES) {
    it(`reads ${JSON.stringify(text)} as ${String(expected)}`, () => {
      expect(parseDepth(text)).toBe(expected)
    })
  }
})

describe('rollup', () => {
  it('orders children before parents', () => {
    const entries: [string, number][] = [
      ['/d/a.txt', 3],
      ['/d/sub/b.txt', 2],
      ['/d/sub/deep/c.txt', 1],
    ]
    expect(rollup(entries, '/d', { all: true, maxDepth: null })).toEqual([
      ['/d/a.txt', 3],
      ['/d/sub/b.txt', 2],
      ['/d/sub/deep/c.txt', 1],
      ['/d/sub/deep', 1],
      ['/d/sub', 3],
    ])
  })

  it('keeps only directories without -a', () => {
    const entries: [string, number][] = [
      ['/d/a.txt', 3],
      ['/d/sub/b.txt', 2],
    ]
    expect(rollup(entries, '/d', { all: false, maxDepth: null })).toEqual([['/d/sub', 2]])
  })

  it('rolls directory totals up recursively', () => {
    const entries: [string, number][] = [
      ['/d/sub/b.txt', 2],
      ['/d/sub/deep/c.txt', 1],
    ]
    const rows = new Map(rollup(entries, '/d', { all: false, maxDepth: null }))
    expect(rows.get('/d/sub')).toBe(3)
    expect(rows.get('/d/sub/deep')).toBe(1)
  })

  it('keeps the sum over a directory marker under -a', () => {
    const entries: [string, number][] = [
      ['/d/sub/deep/c.txt', 5],
      ['/d/sub/deep', 0],
    ]
    const rows = new Map(rollup(entries, '/d', { all: true, maxDepth: null }))
    expect(rows.get('/d/sub/deep')).toBe(5)
  })

  it('handles a root mount', () => {
    const entries: [string, number][] = [
      ['/a.txt', 2],
      ['/sub/b.txt', 3],
    ]
    expect(rollup(entries, '/', { all: false, maxDepth: null })).toEqual([['/sub', 3]])
  })
})

describe('toVirtual', () => {
  it('prepends the mount prefix', () => {
    expect(
      toVirtual([['/channels/general.jsonl', 7]], spec('/slack/channels', 'channels')),
    ).toEqual([['/slack/channels/general.jsonl', 7]])
  })

  it('is a no-op at the root mount', () => {
    expect(toVirtual([['/dir/a.txt', 1]], spec('/dir', 'dir'))).toEqual([['/dir/a.txt', 1]])
  })
})
