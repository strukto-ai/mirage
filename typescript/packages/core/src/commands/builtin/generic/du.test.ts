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
  separateTotal,
  toVirtual,
} from './du.ts'
import { FileStat, FileType, PathSpec } from '../../../types.ts'
import { enoent } from '../../../utils/errors.ts'
import type { CommandOpts } from '../../config.ts'
import type { UsageError } from '../../errors.ts'
import type { LinkView, MountView, StatPath } from '../../../ops/types.ts'

const DEC = new TextDecoder()

function spec(virtual: string, resourcePath: string, rawPath?: string): PathSpec {
  return new PathSpec({
    virtual,
    directory: virtual,
    resourcePath,
    ...(rawPath === undefined ? {} : { rawPath }),
  })
}

function opts(flags: Record<string, string | boolean> = {}, statPath?: StatPath): CommandOpts {
  return {
    stdin: null,
    flags,
    filetypeFns: null,
    cwd: '/',
    resource: {} as never,
    statPath,
  } as unknown as CommandOpts
}

function flags(over: Partial<DuFlags> = {}): DuFlags {
  return { s: false, a: false, h: false, c: false, S: false, maxDepth: null, ...over }
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

  it('excludes subdirectory sizes under -S', async () => {
    const [size, entries] = backend({
      '/dir/a.txt': 3,
      '/dir/sub/b.txt': 2,
      '/dir/sub/deep/c.txt': 1,
    })
    const out = await duGeneric([spec('/dir', 'dir')], flags({ S: true }), size, entries)
    expect(DEC.decode(out.stdout)).toBe('1\t/dir/sub/deep\n2\t/dir/sub\n3\t/dir\n')
  })

  it('summarises only direct files under -Ss', async () => {
    const [size, entries] = backend({
      '/dir/a.txt': 3,
      '/dir/sub/b.txt': 2,
      '/dir/sub/deep/c.txt': 1,
    })
    const out = await duGeneric([spec('/dir', 'dir')], flags({ s: true, S: true }), size, entries)
    expect(DEC.decode(out.stdout)).toBe('3\t/dir\n')
  })

  it('lists files under -Sa with separate directory totals', async () => {
    const [size, entries] = backend({
      '/dir/a.txt': 3,
      '/dir/sub/b.txt': 2,
      '/dir/sub/deep/c.txt': 1,
    })
    const out = await duGeneric([spec('/dir', 'dir')], flags({ a: true, S: true }), size, entries)
    expect(DEC.decode(out.stdout)).toBe(
      '3\t/dir/a.txt\n2\t/dir/sub/b.txt\n1\t/dir/sub/deep/c.txt\n1\t/dir/sub/deep\n2\t/dir/sub\n3\t/dir\n',
    )
  })

  it('keeps the -c grand total recursive under -S', async () => {
    const [size, entries] = backend({
      '/dir/a.txt': 3,
      '/dir/sub/b.txt': 2,
      '/dir/sub/deep/c.txt': 1,
    })
    const out = await duGeneric([spec('/dir', 'dir')], flags({ c: true, S: true }), size, entries)
    expect(DEC.decode(out.stdout)).toBe('1\t/dir/sub/deep\n2\t/dir/sub\n3\t/dir\n6\ttotal\n')
  })

  it('keeps the -c grand total recursive under -Ss', async () => {
    const [size, entries] = backend({
      '/dir/a.txt': 3,
      '/dir/sub/b.txt': 2,
      '/dir/sub/deep/c.txt': 1,
    })
    const out = await duGeneric(
      [spec('/dir', 'dir')],
      flags({ s: true, c: true, S: true }),
      size,
      entries,
    )
    expect(DEC.decode(out.stdout)).toBe('3\t/dir\n6\ttotal\n')
  })

  it('keeps a file operand in the total under -S', async () => {
    const [size, entries] = backend({ '/f.txt': 7 })
    const out = await duGeneric(
      [spec('/f.txt', 'f.txt')],
      flags({ c: true, S: true }),
      size,
      entries,
    )
    expect(DEC.decode(out.stdout)).toBe('7\t/f.txt\n7\ttotal\n')
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

  // A backend offering only the cheaper `size` used to degrade du to one
  // operand line with no directory rows and an inert `-a`. `CommandIO.du`
  // now pairs both halves, so that shape is unreachable (#645): with a
  // native du wired, `-a` always reaches the per-file breakdown.
  it('lists files under -a whenever a native du is wired', async () => {
    const [size, entries] = backend({ '/dir/a.txt': 2 })
    const out = await duGeneric([spec('/dir', 'dir')], flags({ a: true }), size, entries)
    expect(DEC.decode(out.stdout)).toBe('2\t/dir/a.txt\n2\t/dir\n')
  })

  it('reports a missing operand and exits 1', async () => {
    const [size, entries] = backend({ '/dir/a.txt': 2 })
    const out = await duGeneric([spec('/dir', 'dir')], flags(), size, entries, ['nosuch'])
    expect(DEC.decode(out.stdout)).toBe('2\t/dir\n')
    expect(DEC.decode(out.stderr)).toBe("du: cannot access 'nosuch': No such file or directory\n")
    expect(out.exitCode).toBe(1)
  })

  it('warns but succeeds for -s with --max-depth=0', async () => {
    const [size, entries] = backend({ '/dir/a.txt': 2 })
    const parsed = parseDuFlags(opts({ s: true, max_depth: '0' }))
    const out = await duGeneric([spec('/dir', 'dir')], parsed, size, entries)
    expect(DEC.decode(out.stdout)).toBe('2\t/dir\n')
    expect(DEC.decode(out.stderr)).toBe(
      'du: warning: summarizing is the same as using --max-depth=0\n',
    )
    expect(out.exitCode).toBe(0)
  })

  it('still rejects -s with a nonzero --max-depth', () => {
    expect(() => parseDuFlags(opts({ s: true, max_depth: '1' }))).toThrow(
      /summarizing conflicts with --max-depth=1/,
    )
  })

  it('reads a driver error on the content probe as missing', async () => {
    const boom = () => {
      throw new Error('Graph API error 404 (itemNotFound)')
    }
    const out = await runDu(
      [spec('/data/nosuch', 'nosuch')],
      opts({ c: true }),
      (targets) => Promise.resolve(targets),
      (p) => Promise.reject(enoent(p.virtual)),
      boom as unknown as ComputeSize,
      boom as unknown as ComputeEntries,
    )
    expect(DEC.decode(out.stdout)).toBe('0\ttotal\n')
    expect(DEC.decode(out.stderr)).toBe(
      "du: cannot access '/data/nosuch': No such file or directory\n",
    )
    expect(out.exitCode).toBe(1)
  })

  it('treats a namespace-only directory as present, not missing', async () => {
    // The parent backend holds nothing at the operand and cannot: the
    // content lives in the descendant mount's own resource. Only the
    // dispatcher-backed probe knows the path is a directory.
    const [size, entries] = backend({})
    const out = await runDu(
      [spec('/empty', 'empty')],
      opts({}, () => Promise.resolve(new FileStat({ name: 'empty', type: FileType.DIRECTORY }))),
      (targets) => Promise.resolve(targets),
      (p) => Promise.reject(enoent(p.virtual)),
      size,
      entries,
    )
    expect(DEC.decode(out.stdout)).toBe('0\t/empty\n')
    expect(DEC.decode(out.stderr)).toBe('')
    expect(out.exitCode).toBe(0)
  })

  it('still reports missing when the probe answers null', async () => {
    const [size, entries] = backend({})
    const out = await runDu(
      [spec('/nope', 'nope')],
      opts({}, () => Promise.resolve(null)),
      (targets) => Promise.resolve(targets),
      (p) => Promise.reject(enoent(p.virtual)),
      size,
      entries,
    )
    expect(DEC.decode(out.stdout)).toBe('')
    expect(DEC.decode(out.stderr)).toBe("du: cannot access '/nope': No such file or directory\n")
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

function mountsView(descendants: string[]): MountView {
  return {
    descendants: (p: string) =>
      descendants.filter((d) => d.startsWith(p.replace(/\/+$/, '') + '/')),
    isRoot: () => false,
    rootOf: () => '/',
  }
}

function linksView(links: Record<string, string>): LinkView {
  const statOf = (path: string): FileStat =>
    new FileStat({
      name: path.split('/').pop() ?? '',
      type: FileType.SYMLINK,
      size: links[path]?.length ?? 0,
    })
  return {
    statAt: (p: string) => (p in links ? statOf(p) : null),
    children: () => [],
    subtree: (p: string) =>
      Object.keys(links)
        .sort()
        .filter((k) => k.startsWith(p.replace(/\/+$/, '') + '/'))
        .map((k): [string, FileStat] => [k, statOf(k)]),
    resolve: (p: string) => links[p] ?? p,
    exists: () => Promise.resolve(false),
    targetStat: () => Promise.resolve(null),
  }
}

// Pinned against GNU coreutils 9.7 on debian:stable-slim (du
// --apparent-size -B1 over a tmpfs mounted inside the operand): a file
// shadowed by a mount appears nowhere and counts nowhere. The parent
// mount's own rows are GNU's `du -x` report; the descendant mount's
// block is appended by the executor fan-out.
describe('duGeneric descendant mounts', () => {
  const TREE = { '/top.txt': 10, '/inner/leftover.txt': 1000 }

  it('excludes shadowed rows and bytes', async () => {
    const [size, entries] = backend(TREE)
    const out = await duGeneric(
      [spec('/base', '')],
      flags(),
      size,
      entries,
      [],
      undefined,
      null,
      mountsView(['/base/inner']),
    )
    expect(DEC.decode(out.stdout)).toBe('10\t/base\n')
  })

  it('excludes shadowed leaves under -a', async () => {
    const [size, entries] = backend(TREE)
    const out = await duGeneric(
      [spec('/base', '')],
      flags({ a: true }),
      size,
      entries,
      [],
      undefined,
      null,
      mountsView(['/base/inner']),
    )
    expect(DEC.decode(out.stdout)).toBe('10\t/base/top.txt\n10\t/base\n')
  })

  it('excludes shadowed bytes under -s', async () => {
    const [size, entries] = backend(TREE)
    const out = await duGeneric(
      [spec('/base', '')],
      flags({ s: true }),
      size,
      entries,
      [],
      undefined,
      null,
      mountsView(['/base/inner']),
    )
    expect(DEC.decode(out.stdout)).toBe('10\t/base\n')
  })

  it('still counts shadowed keys without a mount view', async () => {
    // The opt-in is the mechanism: a caller that offers no view cannot
    // know where the boundaries are, so the backend's keys all count.
    const [size, entries] = backend(TREE)
    const out = await duGeneric([spec('/base', '')], flags(), size, entries)
    expect(DEC.decode(out.stdout)).toBe('1000\t/base/inner\n1010\t/base\n')
  })

  it('drops a namespace link below the boundary', async () => {
    // A link below the boundary belongs to the child's run.
    const [size, entries] = backend({ '/top.txt': 10 })
    const out = await duGeneric(
      [spec('/base', '')],
      flags(),
      size,
      entries,
      [],
      undefined,
      linksView({ '/base/inner/lnk': '12345', '/base/kept': '123' }),
      mountsView(['/base/inner']),
    )
    expect(DEC.decode(out.stdout)).toBe('13\t/base\n')
  })

  it('reports zero when every key is shadowed', async () => {
    // Never a computeSize fallback that would count the shadowed bytes.
    const [size, entries] = backend({ '/inner/leftover.txt': 1000 })
    const out = await duGeneric(
      [spec('/base', '')],
      flags(),
      size,
      entries,
      [],
      undefined,
      null,
      mountsView(['/base/inner']),
    )
    expect(DEC.decode(out.stdout)).toBe('0\t/base\n')
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
    expect(parseDuFlags(opts({ max_depth: '2' })).maxDepth).toBe(2)
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

  it('separateDirs counts only direct files', () => {
    const entries: [string, number][] = [
      ['/d/a.txt', 3],
      ['/d/sub/b.txt', 2],
      ['/d/sub/deep/c.txt', 1],
    ]
    const rows = new Map(rollup(entries, '/d', { all: false, maxDepth: null, separateDirs: true }))
    expect(rows.get('/d/sub/deep')).toBe(1)
    expect(rows.get('/d/sub')).toBe(2)
    expect(rows.has('/d/a.txt')).toBe(false)
  })

  it('separateDirs keeps empty ancestor directories at size 0', () => {
    const entries: [string, number][] = [['/d/sub/deep/c.txt', 4]]
    const rows = new Map(rollup(entries, '/d', { all: false, maxDepth: null, separateDirs: true }))
    expect(rows.get('/d/sub/deep')).toBe(4)
    expect(rows.get('/d/sub')).toBe(0)
  })

  it('separateTotal sums only direct children', () => {
    const entries: [string, number][] = [
      ['/d/a.txt', 3],
      ['/d/sub/b.txt', 2],
      ['/d/sub/deep/c.txt', 1],
    ]
    expect(separateTotal(entries, '/d')).toBe(3)
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
