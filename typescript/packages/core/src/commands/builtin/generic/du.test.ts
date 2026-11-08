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
  du,
  duGeneric,
  excluded,
  excludedStart,
  inodeCount,
  newestUnder,
  parseFlags,
  rollup,
  toVirtual,
} from './du.ts'
import { IOResult, materialize } from '../../../io/types.ts'
import { MountMode, PathSpec } from '../../../types.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { Workspace } from '../../../workspace/workspace/workspace.ts'
import { enoent } from '../../../errors/fs.ts'
import type { Context } from '../../config.ts'
import type { MountView } from '../../../view/types.ts'
import { rstripSlash } from '../../../utils/slash.ts'

const DEC = new TextDecoder()

function spec(virtual: string, vfsPath: string, rawPath?: string): PathSpec {
  return new PathSpec({
    virtual,
    directory: virtual,
    vfsPath,
    ...(rawPath === undefined ? {} : { rawPath }),
  })
}

function ctx(flags: Record<string, string | boolean> = {}): Context {
  return {
    stdin: null,
    flags,
    cwd: PathSpec.fromStrPath('/'),
  } as unknown as Context
}

function flags(over: Partial<DuFlags> = {}): DuFlags {
  return {
    s: false,
    a: false,
    h: false,
    blockSize: null,
    c: false,
    S: false,
    maxDepth: null,
    ...over,
  }
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

describe('du', () => {
  it('reads a driver error on the content probe as missing', async () => {
    const boom = () => {
      throw new Error('Graph API error 404 (itemNotFound)')
    }
    const parsed = parseFlags(ctx({ total: true }))
    if (parsed instanceof IOResult) throw new Error('refused')
    const [out, io] = await duGeneric(
      parsed,
      [spec('/data/nosuch', 'nosuch')],
      ctx({ total: true }),
      (targets) => Promise.resolve(targets),
      (p) => Promise.reject(enoent(p.virtual)),
      boom as unknown as ComputeSize,
      boom as unknown as ComputeEntries,
    )
    expect(DEC.decode(await materialize(out))).toBe('0\ttotal\n')
    expect(DEC.decode(await io.materializeStderr())).toBe(
      "du: cannot access '/data/nosuch': No such file or directory\n",
    )
    expect(io.exitCode).toBe(1)
  })

  it.each([
    [
      ['/dir: stopped after 1 files (walk_limit); narrow the path'],
      1,
      'du: /dir: stopped after 1 files (walk_limit); narrow the path\n',
    ],
    [[], 0, ''],
  ])('says where a walk was cut short and exits 1 (%j)', async (stopped, code, err) => {
    const [size, entries] = backend({ '/dir/a.txt': 2 })
    const out = await du([spec('/dir', 'dir')], flags(), size, entries, [], () => stopped)
    expect(DEC.decode(out.stdout)).toBe('2\t/dir\n')
    expect(out.exitCode).toBe(code)
    expect(DEC.decode(out.stderr)).toBe(err)
  })

  it('reports what it measured unless it only summed', async () => {
    const [size, entries] = backend({ '/dir/a.txt': 2, '/dir/s/b': 3 })
    const paths = [spec('/m/dir', 'dir')]
    const out = await du(paths, flags(), size, entries, [], undefined, null, undefined, () => [
      '/m/dir/e',
    ])
    expect(out.records?.map((r) => [r.path.virtual, r.run, r.size ?? null])).toEqual([
      ['/m/dir', 0, null],
      ['/m/dir/a.txt', 0, 2],
      ['/m/dir/s/b', 0, 3],
      ['/m/dir/e', 0, null],
    ])
    expect((await du(paths, flags({ s: true }), size, entries)).records).toBeNull()
  })

  it('rolls up under a root mount', () => {
    const entries: [string, number][] = [
      ['/a.txt', 2],
      ['/sub/b.txt', 3],
    ]
    expect(rollup(entries, '/', { all: false, maxDepth: null })).toEqual([['/sub', 3]])
    expect(toVirtual([['/dir/a.txt', 1]], spec('/dir', 'dir'))).toEqual([['/dir/a.txt', 1]])
  })

  // An --exclude pattern matches the path as du prints it, or the
  // part after any slash, with `*` crossing slashes and case kept (pinned on
  // debian:stable-slim). Mirrors test_du.py.
  it('excludes a path a pattern matches whole or after a slash', () => {
    expect(excluded(['b'], 'd/x/b')).toBe(true)
    expect(excluded(['x/b'], 'd/x/b')).toBe(true)
    expect(excluded(['d*b'], 'd/x/b')).toBe(true)
    expect(excluded(['x'], 'd/x/b')).toBe(false)
    expect(excluded(['B'], 'd/x/b')).toBe(false)
    expect(excluded([], 'd')).toBe(false)
  })

  it('starts no mount under an excluded directory', () => {
    const operand = spec('/a', 'a')
    expect(excludedStart(['skip'], operand, spec('/a/skip/inner', ''))).toBe(true)
    expect(excludedStart(['inner'], operand, spec('/a/skip/inner', ''))).toBe(true)
    expect(excludedStart(['skip'], operand, spec('/a/keep/in', ''))).toBe(false)
    expect(excludedStart(['a'], operand, spec('/a/keep/in', ''))).toBe(false)
    expect(excludedStart([], operand, spec('/a/skip/inner', ''))).toBe(false)
    expect(excludedStart(['./sub'], spec('/data', 'data', '.'), spec('/data/sub/m', ''))).toBe(true)
    expect(excludedStart(['sub'], spec('/', ''), spec('/sub/m', ''))).toBe(true)
  })

  it('keeps the stamp nanoseconds in a time format', async () => {
    const [size, entries] = backend({ '/dir/f': 1 })
    const parsed = parseFlags({ ...ctx({ time: true }), env: { TIME_STYLE: '+%s.%N' } })
    if (parsed instanceof IOResult) throw new Error('du refused --time')
    const out = await du(
      [spec('/dir', 'dir')],
      parsed,
      size,
      entries,
      [],
      undefined,
      null,
      undefined,
      undefined,
      undefined,
      undefined,
      () => new Map([['/dir/f', '1970-01-01T00:00:01.123456789+00:00']]),
    )
    expect(DEC.decode(out.stdout)).toBe('1\t1.123456789\t/dir\n')
  })

  it('compares a threshold past 2^53 exactly', async () => {
    const [size, entries] = backend({ '/dir/f': 9007199254740992 })
    const parsed = parseFlags(ctx({ threshold: '9007199254740993' }))
    if (parsed instanceof IOResult) throw new Error('du refused the threshold')
    const out = await du([spec('/dir', 'dir')], parsed, size, entries)
    expect(DEC.decode(out.stdout)).toBe('')
  })

  it('counts each directory under --inodes, and under -S its own files', () => {
    const leaves: [string, number][] = [
      ['/d/a', 1],
      ['/d/x/b', 1],
      ['/d/x/bb', 1],
    ]
    const dirs = ['/d/x/z']
    expect(rollup(leaves, '/d', { all: false, maxDepth: null, dirs, inodes: true })).toEqual([
      ['/d/x/z', 1],
      ['/d/x', 4],
    ])
    expect(
      rollup(leaves, '/d', { all: false, maxDepth: null, dirs, separateDirs: true, inodes: true }),
    ).toEqual([
      ['/d/x/z', 1],
      ['/d/x', 3],
    ])
    expect(inodeCount(leaves, '/d', dirs)).toBe(6)
  })

  it('shows a directory the newest time in its tree', () => {
    const late = '2024-03-04T05:06:07.5'
    const newest = newestUnder(
      new Map([
        ['/d', '2023-01-01T00:00:00'],
        ['/d/x/b', late],
        ['/d/a', '2024-01-02T03:04:05'],
        ['/e/f', '2030-01-01T00:00:00'],
      ]),
      '/d',
    )
    expect([newest.get('/d')?.[1], newest.get('/d/x')?.[1]]).toEqual([late, late])
    expect(newest.has('/e/f')).toBe(false)
  })
})

function mountsView(descendants: string[]): MountView {
  const visible = descendants.filter((d) => !d.endsWith('/hidden'))
  return {
    descendants: (p: string) => descendants.filter((d) => d.startsWith(rstripSlash(p) + '/')),
    visibleDescendants: (p: string) => visible.filter((d) => d.startsWith(rstripSlash(p) + '/')),
    isRoot: () => false,
    rootOf: () => '/',
    answers: () => false,
    searchable: () => null,
  }
}

// Pinned against GNU coreutils 9.7 on debian:stable-slim (du
// --apparent-size -B1 over a tmpfs mounted inside the operand): a file
// shadowed by a mount appears nowhere and counts nowhere. The parent
// mount's own rows are GNU's `du -x` report; the descendant mount's
// block is appended by the executor fan-out.
describe('du descendant mounts', () => {
  const TREE = { '/top.txt': 10, '/inner/leftover.txt': 1000 }

  it.each<[Record<string, number>, Partial<DuFlags>, string]>([
    [TREE, {}, '10\t/base\n'],
    [TREE, { a: true }, '10\t/base/top.txt\n10\t/base\n'],
    [TREE, { s: true }, '10\t/base\n'],
    [{ '/inner/leftover.txt': 1000 }, {}, '0\t/base\n'],
  ])('excludes the shadowed rows and bytes of %j under %j', async (tree, over, expected) => {
    const [size, entries] = backend(tree)
    const out = await du(
      [spec('/base', '')],
      flags(over),
      size,
      entries,
      [],
      undefined,
      mountsView(['/base/inner']),
    )
    expect(DEC.decode(out.stdout)).toBe(expected)
  })

  it('still counts shadowed keys without a mount view', async () => {
    // The opt-in is the mechanism: a caller that offers no view cannot
    // know where the boundaries are, so the backend's keys all count.
    const [size, entries] = backend(TREE)
    const out = await du([spec('/base', '')], flags(), size, entries)
    expect(DEC.decode(out.stdout)).toBe('1000\t/base/inner\n1010\t/base\n')
  })
})

// mirage-rs reads --max-depth as strtoimax at base 0 and checks it against -s
// and -a before any operand, each refusal du's usage error, exit 1. Mirrors
// test_du.py.
describe('du parseFlags', () => {
  const read = (flags: Record<string, string | boolean>) =>
    parseFlags({ stdin: null, flags, cwd: PathSpec.fromStrPath('/') } as Context)
  const hint = "\nTry 'du --help' for more information.\n"

  it.each([
    [{ max_depth: '0x10' }, 16],
    [{ max_depth: '010' }, 8],
    [{ max_depth: '-1' }, -1],
  ])('reads %j as depth %s', (flags, depth) => {
    const parsed = read(flags)
    if (parsed instanceof IOResult) throw new Error('du refused a depth')
    expect(parsed.maxDepth).toBe(depth)
  })

  it('warns that -s is --max-depth=0', () => {
    const parsed = read({ summarize: true, max_depth: '0' })
    if (parsed instanceof IOResult) throw new Error('du refused -s -d 0')
    expect(parsed.warning).toBe('du: warning: summarizing is the same as using --max-depth=0')
  })

  it.each([
    [{ max_depth: '09' }, "du: invalid maximum depth '09'"],
    [{ max_depth: ' 1' }, "du: invalid maximum depth ' 1'"],
    [{ summarize: true, all: true }, 'du: cannot both summarize and show all entries'],
    [{ summarize: true, max_depth: '2' }, 'du: warning: summarizing conflicts with --max-depth=2'],
  ])('refuses %j', (flags, line) => {
    const parsed = read(flags)
    if (!(parsed instanceof IOResult)) throw new Error('du read a refused line')
    expect([parsed.exitCode, new TextDecoder().decode(parsed.stderr as Uint8Array)]).toEqual([
      1,
      line + hint,
    ])
  })
})

it.each([
  ['-b', '6'],
  ['--bytes', '6'],
  ['--apparent-size', '6'],
  ['-k', '1'],
  ['-m', '1'],
  ['-B1', '6'],
  ['--block-size=K', '1K'],
  ['-BKB', '1kB'],
  ['-BKiB', '1KiB'],
  ['-b -k', '1'],
  ['-k -b', '6'],
  ['-k -b -k', '1'],
  ['-bkb', '6'],
  ['-B1 -h -B1024', '1'],
  ['-k --human-readable', '6'],
  ['--summarize --bytes', '6'],
  ['--dereference --no-dereference --bytes', '6'],
])('du GNU units and long aliases %s', async (options, expected) => {
  const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
  try {
    await ws.shell('printf abcdef > /data/f')
    const result = await ws.shell(`du ${options} /data/f`)
    expect(result.exitCode).toBe(0)
    expect(DEC.decode(result.stderr)).toBe('')
    expect(DEC.decode(result.stdout)).toBe(`${expected}\t/data/f\n`)
  } finally {
    await ws.close()
  }
})

it('du rounds rows after summing', async () => {
  const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
  try {
    await ws.shell('mkdir /data/d; printf a > /data/d/a; printf b > /data/d/b')
    const result = await ws.shell('du --all --total -B4 /data/d')
    expect(result.exitCode).toBe(0)
    expect(DEC.decode(result.stdout)).toBe('1\t/data/d/a\n1\t/data/d/b\n1\t/data/d\n1\ttotal\n')
    for (const [size, count] of [
      [0, 0],
      [1024, 1],
      [1025, 2],
    ] satisfies [number, number][]) {
      await ws.shell(size ? `printf '%${String(size)}s' x > /data/f` : ': > /data/f')
      const row = await ws.shell('du -k /data/f')
      expect(DEC.decode(row.stdout)).toBe(`${String(count)}\t/data/f\n`)
    }
  } finally {
    await ws.close()
  }
})

it('du orders human units and validates each block size', async () => {
  const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
  try {
    await ws.shell("printf '%1025s' x > /data/f")
    for (const [options, expected] of [
      ['-k -h', '1.1K'],
      ['-h -k', '2'],
      ['-B0x10', '65'],
      ['-B010', '129'],
    ] satisfies [string, string][]) {
      const result = await ws.shell(`du ${options} /data/f`)
      expect(result.exitCode).toBe(0)
      expect(DEC.decode(result.stdout)).toBe(`${expected}\t/data/f\n`)
    }
    const refused = await ws.shell('du -B0 -b /data/f')
    expect(refused.exitCode).toBe(1)
    expect(DEC.decode(refused.stderr)).toBe("du: invalid -B argument '0'\n")
  } finally {
    await ws.close()
  }
})

it('du long link aliases keep last option order', async () => {
  const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
  try {
    await ws.shell('printf abcdef > /data/target; ln -s /data/target /data/link')
    for (const [options, expected] of [
      ['--no-dereference --dereference', '6'],
      ['--dereference --no-dereference', '12'],
      ['-L --no-dereference --dereference', '6'],
    ] satisfies [string, string][]) {
      const result = await ws.shell(`du --bytes ${options} /data/link`)
      expect(result.exitCode).toBe(0)
      expect(DEC.decode(result.stdout)).toBe(`${expected}\t/data/link\n`)
    }
  } finally {
    await ws.close()
  }
})

it.each([
  ['3', '6004799503160662'],
  ['18014398509481983', '2'],
])('du large byte totals keep exact units %s', async (unit, expected) => {
  const total = 18014398509481984
  const [size, entries] = backend({ '/dir/f': total })
  const parsed = parseFlags(ctx({ block_size: unit, all: true, total: true }))
  if (parsed instanceof IOResult) throw new Error('du refused a block size')
  const out = await du([spec('/dir', 'dir')], parsed, size, entries)
  expect(DEC.decode(out.stdout)).toBe(
    `${expected}\t/dir/f\n${expected}\t/dir\n${expected}\ttotal\n`,
  )
  expect(DEC.decode(out.stderr)).toBe('')
  expect(out.exitCode).toBe(0)
  expect(out.records?.map((record) => record.size ?? null)).toEqual([null, total])
})

it('du leaves no time of an earlier operand in a later one', async () => {
  const ws = new Workspace({ '/d': new RAMVFS() }, { mode: MountMode.WRITE })
  try {
    await ws.shell(
      "printf x > /d/skip; touch -d '2030-01-01' /d/skip; printf y > /d/keep; touch -d '2020-01-01' /d/keep",
    )
    const result = await ws.shell('cd /; du --time --time-style=+%Y --exclude=/d/skip d/skip /d')
    const rows = DEC.decode(result.stdout).trimEnd().split('\n')
    expect(rows[0]?.split('\t').slice(1)).toEqual(['2030', 'd/skip'])
    expect(rows.at(-1)?.endsWith('\t/d')).toBe(true)
    expect(rows.at(-1)).not.toContain('2030')
  } finally {
    await ws.close()
  }
})
