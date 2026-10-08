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
  rollup,
  toVirtual,
} from './du.ts'
import { FileStat, FileType, PathSpec } from '../../../types.ts'
import { enoent } from '../../../errors/fs.ts'
import type { CommandOpts } from '../../config.ts'
import type { LinkView, MountView } from '../../../view/types.ts'
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

function opts(flags: Record<string, string | boolean> = {}): CommandOpts {
  return {
    stdin: null,
    flags,
    cwd: '/',
    vfs: {} as never,
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

describe('du', () => {
  it('reads a driver error on the content probe as missing', async () => {
    const boom = () => {
      throw new Error('Graph API error 404 (itemNotFound)')
    }
    const [out, io] = await duGeneric(
      [spec('/data/nosuch', 'nosuch')],
      opts({ c: true }),
      (targets) => Promise.resolve(targets),
      (p) => Promise.reject(enoent(p.virtual)),
      boom as unknown as ComputeSize,
      boom as unknown as ComputeEntries,
    )
    expect(DEC.decode(out)).toBe('0\ttotal\n')
    expect(DEC.decode(await io.materializeStderr())).toBe(
      "du: cannot access '/data/nosuch': No such file or directory\n",
    )
    expect(io.exitCode).toBe(1)
  })

  it.each([
    [true, 1],
    [false, 0],
  ])('warns and exits 1 only when the walk was cut (%s)', async (cut, code) => {
    const [size, entries] = backend({ '/dir/a.txt': 2 })
    const out = await du([spec('/dir', 'dir')], flags(), size, entries, [], () => cut)
    expect(DEC.decode(out.stdout)).toBe('2\t/dir\n')
    expect(out.exitCode).toBe(code)
    expect(DEC.decode(out.stderr).includes('incomplete')).toBe(cut)
  })

  it('reports what it measured unless it only summed', async () => {
    const [size, entries] = backend({ '/dir/a.txt': 2, '/dir/s/b': 3 })
    const paths = [spec('/m/dir', 'dir')]
    const out = await du(
      paths,
      flags(),
      size,
      entries,
      [],
      undefined,
      null,
      null,
      undefined,
      () => ['/m/dir/e'],
    )
    expect(out.runs).toEqual([
      {
        leaves: [
          ['/m/dir/a.txt', 2],
          ['/m/dir/s/b', 3],
        ],
        directories: ['/m/dir/e'],
      },
    ])
    expect((await du(paths, flags({ s: true }), size, entries)).runs).toBeNull()
  })

  it('rolls up under a root mount', () => {
    const entries: [string, number][] = [
      ['/a.txt', 2],
      ['/sub/b.txt', 3],
    ]
    expect(rollup(entries, '/', { all: false, maxDepth: null })).toEqual([['/sub', 3]])
    expect(toVirtual([['/dir/a.txt', 1]], spec('/dir', 'dir'))).toEqual([['/dir/a.txt', 1]])
  })
})

function mountsView(descendants: string[]): MountView {
  const visible = descendants.filter((d) => !d.endsWith('/hidden'))
  return {
    descendants: (p: string) => descendants.filter((d) => d.startsWith(rstripSlash(p) + '/')),
    visibleDescendants: (p: string) => visible.filter((d) => d.startsWith(rstripSlash(p) + '/')),
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
        .filter((k) => k.startsWith(rstripSlash(p) + '/'))
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
      null,
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

  it('drops a namespace link below the boundary', async () => {
    // A link below the boundary belongs to the child's run.
    const [size, entries] = backend({ '/top.txt': 10 })
    const out = await du(
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
})
