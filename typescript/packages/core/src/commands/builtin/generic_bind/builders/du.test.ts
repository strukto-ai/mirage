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

import { BUILDER } from './du.ts'
import { describe, expect, it } from 'vitest'
import { runWithMountGate } from '../../../../context/session_context.ts'
import { materialize } from '../../../../io/types.ts'
import { DirListing, FileStat, FileType, MountMode, PathSpec } from '../../../../types.ts'
import { eacces, enoent, enotsup, walkDeclined } from '../../../../errors/fs.ts'
import type { Accessor } from '../../../../accessor/base.ts'
import type { CommandFnResult, Context } from '../../../config.ts'
import type { NamespaceLinks } from '../../../../view/types.ts'
import { answeringFiles } from '../../../../test-utils.ts'
import { BaseVFS } from '../../../../vfs/base.ts'
import type { Handed } from '../../../../vfs/types.ts'
import { RAMVFS } from '../../../../vfs/ram/ram.ts'
import { Workspace } from '../../../../workspace/workspace/workspace.ts'

const DEC = new TextDecoder()

const TREE: Record<string, { dir: boolean; size?: number; children?: string[] }> = {
  '/db': { dir: true, children: ['/db/a.txt', '/db/sub'] },
  '/db/a.txt': { dir: false, size: 3 },
  '/db/sub': { dir: true, children: ['/db/sub/b.txt'] },
  '/db/sub/b.txt': { dir: false, size: 2 },
}

// A mount the dispatcher answers for: its listing, its stat, its subtree
// read where it has one, and its walk_limit (-1 for none).
interface Table {
  readdir: (p: PathSpec) => Promise<string[]>
  stat: (p: PathSpec) => Promise<FileStat>
  readTree?: (p: PathSpec) => Promise<Map<string, FileStat> | null>
  walkLimit?: number
}

const STOPPED_AT_2 = 'du: /db: stopped after 2 files (walk_limit); narrow the path\n'

// A mount with no subtree read, so the builder must walk.
const OPS: Table = {
  readdir: (p) => Promise.resolve(TREE[p.virtual]?.children ?? []),
  stat: (p) => {
    const node = TREE[p.virtual]
    // A stamped FsError, as every real backend raises: the builder tells a
    // missing operand from a backend failure by the code, not the message.
    if (node === undefined) return Promise.reject(enoent(p.virtual))
    return Promise.resolve(
      new FileStat({
        name: p.virtual,
        type: node.dir ? FileType.DIRECTORY : FileType.FILE,
        size: node.size ?? null,
      }),
    )
  },
}

const ACCESSOR = {} as Accessor

// Run du on `table`, mounted at `/`, its links `links`.
async function du(
  table: Table,
  paths: PathSpec[],
  ctx: Partial<Context> = {},
  links: NamespaceLinks | null = null,
): Promise<CommandFnResult> {
  const vfs = answeringFiles(
    {
      readdir: (p) => table.readdir(p),
      stat: (p) => table.stat(p),
      ...(table.readTree === undefined ? {} : { read_tree: (p) => table.readTree?.(p) }),
    },
    {},
    [
      {
        prefix: '/',
        kind: 'fake',
        mode: MountMode.WRITE,
        walkLimit: table.walkLimit ?? -1,
        calls: new Set(table.readTree === undefined ? [] : ['read_tree']),
      },
    ],
    links,
  )
  return runWithMountGate('/', MountMode.WRITE, async () =>
    BUILDER.fn(ACCESSOR, paths, [], {
      stdin: null,
      flags: {},
      cwd: PathSpec.fromStrPath('/'),
      ...ctx,
      vfs,
    }),
  )
}

describe('du walk fallback (no native du op)', () => {
  // Mirrors test_a_walk_past_the_limit_reports_partial_output_and_exits_one.
  it('reports partial output past the limit and exits 1', async () => {
    const [out, io] = await runScoped({ ...OPS, walkLimit: 2 }, [PathSpec.fromStrPath('/db')])
    expect([DEC.decode(out), io.exitCode, DEC.decode(io.stderr ?? new Uint8Array())]).toEqual([
      '0\t/db/sub\n3\t/db\n',
      1,
      STOPPED_AT_2,
    ])
  })

  // Mirrors test_each_operand_walks_under_its_own_limit.
  it('walks each operand under its own limit', async () => {
    const [out, io] = await runScoped({ ...OPS, walkLimit: 2 }, [
      PathSpec.fromStrPath('/db'),
      PathSpec.fromStrPath('/db/sub'),
    ])
    expect([DEC.decode(out), io.exitCode, DEC.decode(io.stderr ?? new Uint8Array())]).toEqual([
      '0\t/db/sub\n3\t/db\n2\t/db/sub\n',
      1,
      STOPPED_AT_2,
    ])
  })

  it('a backend failure propagates instead of reading as a missing operand', async () => {
    const failing: Table = {
      ...OPS,
      stat: () => Promise.reject(new Error('403 Forbidden')),
    }
    await expect(du(failing, [PathSpec.fromStrPath('/db')])).rejects.toThrow('403 Forbidden')
  })
})

const THROTTLED = Object.assign(new Error('Box GET /folders/9/items -> 429'), {
  status: 429,
})

// A readTree the dispatcher declines, as it does when a path rule or a
// hide reaches below the operand: the builder walks instead.
const NATIVE: Table = {
  ...OPS,
  readTree: (p) => Promise.reject(walkDeclined('ram', 'read_tree', p)),
} as Table

// The tree OPS walks, answered in one call.
const TREED: Table = {
  ...OPS,
  readTree: () =>
    Promise.resolve(
      new Map([
        ['a.txt', new FileStat({ name: 'a.txt', type: FileType.FILE, size: 3 })],
        ['sub', new FileStat({ name: 'sub', type: FileType.DIRECTORY })],
        ['sub/b.txt', new FileStat({ name: 'b.txt', type: FileType.FILE, size: 2 })],
      ]),
    ),
} as Table

async function runScoped(
  ops: Table,
  paths: PathSpec[],
): Promise<[Uint8Array, { exitCode: number; stderr: Uint8Array | null }]> {
  const result = await du(ops, paths)
  return result as [Uint8Array, { exitCode: number; stderr: Uint8Array | null }]
}

describe('du walk fallback under a path rule', () => {
  it('walks when the dispatcher declines readTree', async () => {
    const [out] = await runScoped(NATIVE, [PathSpec.fromStrPath('/db')])
    expect(DEC.decode(out)).toBe('2\t/db/sub\n5\t/db\n')
  })

  // A tree read in one call is still a walk of every entry in it. Mirrors
  // test_a_tree_answer_counts_against_the_limit.
  it('counts a tree answer against the limit', async () => {
    const [out, io] = await runScoped({ ...TREED, walkLimit: 2 } as Table, [
      PathSpec.fromStrPath('/db'),
    ])
    expect([DEC.decode(out), io.exitCode, DEC.decode(io.stderr ?? new Uint8Array())]).toEqual([
      '0\t/db/sub\n3\t/db\n',
      1,
      STOPPED_AT_2,
    ])
  })

  // Mirrors test_a_walk_of_the_root_names_the_root_where_it_stops.
  it('names the root where a walk of it stops', async () => {
    const rooted: Table = {
      ...TREED,
      walkLimit: 2,
      stat: (p) =>
        p.virtual === '/'
          ? Promise.resolve(new FileStat({ name: '/', type: FileType.DIRECTORY }))
          : OPS.stat(p),
    } as Table
    const [out, io] = await runScoped(rooted, [PathSpec.fromStrPath('/')])
    expect([DEC.decode(out), io.exitCode, DEC.decode(io.stderr ?? new Uint8Array())]).toEqual([
      '0\t/sub\n3\t/\n',
      1,
      STOPPED_AT_2.replace('/db:', '/:'),
    ])
  })

  it("does not walk a backend's own refusal", async () => {
    const refusing: Table = {
      ...OPS,
      readTree: (p) => Promise.reject(enotsup('ram', 'read_tree', p)),
    } as Table
    await expect(runScoped(refusing, [PathSpec.fromStrPath('/db')])).rejects.toMatchObject({
      code: 'ENOTSUP',
    })
  })

  it('propagates a throttled listing rather than reporting an undersized total', async () => {
    const throttled: Table = {
      ...NATIVE,
      readdir: (p) =>
        p.virtual === '/db/sub'
          ? Promise.reject(THROTTLED)
          : Promise.resolve(TREE[p.virtual]?.children ?? []),
    }
    await expect(runScoped(throttled, [PathSpec.fromStrPath('/db')])).rejects.toMatchObject({
      status: 429,
    })
  })

  it('propagates a throttled stat below the operand too', async () => {
    const throttled: Table = {
      ...NATIVE,
      stat: (p) => (p.virtual === '/db/a.txt' ? Promise.reject(THROTTLED) : OPS.stat(p)),
    }
    await expect(runScoped(throttled, [PathSpec.fromStrPath('/db')])).rejects.toMatchObject({
      status: 429,
    })
  })

  it('still counts an entry that went away mid-walk as zero', async () => {
    const vanished: Table = {
      ...NATIVE,
      stat: (p) =>
        p.virtual === '/db/sub/b.txt' ? Promise.reject(enoent(p.virtual)) : OPS.stat(p),
    }
    const [out, io] = await runScoped(vanished, [PathSpec.fromStrPath('/db')])
    // A subtree that sums to nothing still prints its own 0 line, as GNU
    // prints one for every directory it walked.
    expect(DEC.decode(out)).toBe('0\t/db/sub\n3\t/db\n')
    expect(io.exitCode).toBe(0)
  })

  it('still skips a refused directory and names it, as GNU does', async () => {
    const refused: Table = {
      ...NATIVE,
      readdir: (p) =>
        p.virtual === '/db/sub'
          ? Promise.reject(eacces(p.virtual))
          : Promise.resolve(TREE[p.virtual]?.children ?? []),
    }
    const [out, io] = await runScoped(refused, [PathSpec.fromStrPath('/db')])
    expect(DEC.decode(out)).toBe('0\t/db/sub\n3\t/db\n')
    expect(io.exitCode).toBe(1)
    expect(DEC.decode(io.stderr ?? new Uint8Array())).toBe(
      "du: cannot read directory '/db/sub': Permission denied\n",
    )
  })

  // The refusal can arrive from `stat` rather than from `readdir`: a rule
  // that denies the path outright refuses before the walk ever learns the
  // entry is a directory. Skipping it silently made the subtree vanish
  // from the total with du still exiting 0, which is the one answer a
  // caller cannot tell from a genuinely small tree.
  it('names a descendant whose stat is refused, and exits 1', async () => {
    const refused: Table = {
      ...NATIVE,
      stat: (p) => (p.virtual === '/db/sub' ? Promise.reject(eacces(p.virtual)) : OPS.stat(p)),
    }
    const [out, io] = await runScoped(refused, [PathSpec.fromStrPath('/db')])
    expect(DEC.decode(out)).toBe('3\t/db\n')
    expect(io.exitCode).toBe(1)
    expect(DEC.decode(io.stderr ?? new Uint8Array())).toBe(
      "du: cannot read directory '/db/sub': Permission denied\n",
    )
  })
})

describe('du rows for directories no file points at', () => {
  // /db/sealed lists as refused and /db/walled refuses its stat, the two
  // calls a rule or the host can shut.
  const sealed: Record<string, string[]> = {
    '/db': ['/db/a.txt', '/db/empty', '/db/sealed', '/db/walled'],
    '/db/empty': [],
    '/db/sealed': [],
  }
  const ops: Table = {
    ...OPS,
    readdir: (p) =>
      p.virtual === '/db/sealed'
        ? Promise.reject(eacces(p.virtual))
        : Promise.resolve(sealed[p.virtual] ?? []),
    stat: (p) => {
      if (p.virtual === '/db/walled') return Promise.reject(eacces(p.virtual))
      if (p.virtual in sealed)
        return Promise.resolve(new FileStat({ name: p.virtual, type: FileType.DIRECTORY }))
      if (p.virtual === '/db/a.txt')
        return Promise.resolve(new FileStat({ name: p.virtual, type: FileType.FILE, size: 3 }))
      return Promise.reject(enoent(p.virtual))
    },
  }
  const notes =
    "du: cannot read directory '/db/sealed': Permission denied\n" +
    "du: cannot read directory '/db/walled': Permission denied\n"

  async function run(flags: Record<string, boolean>): Promise<[string, number, string]> {
    const result = await du(ops, [PathSpec.fromStrPath('/db')], { flags })
    if (result === null) throw new Error('no result')
    const [out, io] = result
    const bytes =
      out === null
        ? new Uint8Array()
        : out instanceof Uint8Array
          ? out
          : await materialize(out as AsyncIterable<Uint8Array>)
    return [DEC.decode(bytes), io.exitCode, DEC.decode(io.stderr as Uint8Array)]
  }

  it('prints an empty and a refused directory, GNU-style, and names the refusals', async () => {
    expect(await run({})).toEqual(['0\t/db/empty\n0\t/db/sealed\n3\t/db\n', 1, notes])
    expect(await run({ a: true })).toEqual([
      '3\t/db/a.txt\n0\t/db/empty\n0\t/db/sealed\n3\t/db\n',
      1,
      notes,
    ])
  })
})

// /db/private refuses its listing, though its file answers a stat by name, the
// way a directory without read permission does.
const UNLISTED: Table = {
  ...OPS,
  readdir: (p) =>
    p.virtual === '/db/private'
      ? Promise.reject(eacces(p.virtual))
      : Promise.resolve(p.virtual === '/db' ? ['/db/link', '/db/private'] : []),
  stat: (p) =>
    Promise.resolve(
      p.virtual === '/db/link'
        ? new FileStat({ name: 'link', type: FileType.SYMLINK, size: 9 })
        : new FileStat({ name: p.virtual, type: FileType.DIRECTORY }),
    ),
}

// A link table holding /db/link, which leads to /db/private/f.
const ONE_LINK = {
  follow: (path: string) => (path === '/db/link' ? '/db/private/f' : path),
  linkStatAt: () => null,
  linkStatsBelow: () => [],
  symlinkTargets: () => new Map<string, string>(),
} as unknown as NamespaceLinks

// The stat the dispatcher answers past the walk: what the link leads to.
const LINKED: Table = {
  ...UNLISTED,
  stat: (p) =>
    p.virtual === '/db/private/f'
      ? Promise.resolve(new FileStat({ name: 'f', type: FileType.FILE, size: 6 }))
      : UNLISTED.stat(p),
}

// A link into the operand's tree is left to the file's own name, but a
// directory the walk may not list hides that name, and GNU then counts the
// file under the link (coreutils 9.7).
describe('du -L through a directory it may not list', () => {
  it('counts a link whose file only it reaches', async () => {
    const result = await du(
      LINKED,
      [PathSpec.fromStrPath('/db')],
      { flags: { a: true, L: true } },
      ONE_LINK,
    )
    const [out, io] = result as [Uint8Array, { exitCode: number; stderr: Uint8Array | null }]
    expect(DEC.decode(out)).toBe('6\t/db/link\n0\t/db/private\n6\t/db\n')
    expect([io.exitCode, DEC.decode(io.stderr ?? new Uint8Array())]).toEqual([
      1,
      "du: cannot read directory '/db/private': Permission denied\n",
    ])
  })
})

// A RAM mount held to two files, with no tree read, whose listing stops at
// a walk's limit. Twin of Python's CutRAM.
class CutRAM extends RAMVFS {
  constructor() {
    super({ walkLimit: 2 })
  }
}
// RAMVFS narrows readdir to a plain array, so the cut listing goes on the
// prototype.
Object.defineProperties(CutRAM.prototype, {
  readTree: { value: (BaseVFS.prototype as unknown as Record<string, unknown>).readTree },
  readdir: {
    value: async function (this: CutRAM, path: PathSpec, handed?: Handed) {
      const rows = await RAMVFS.prototype.readdir.call(this, path)
      const limit = handed?.limit
      if (limit === undefined || rows.length < limit) return rows
      return new DirListing({ entries: rows.slice(0, limit), partial: true })
    },
  },
})

// Twin of test_du_x_counts_a_file_listed_past_the_mounts_below.
it('du -x counts a file listed past the mounts below', async () => {
  const vfs = new CutRAM()
  for (const dir of ['/d', '/d/m1', '/d/m2', '/d/m3']) vfs.store.dirs.add(dir)
  vfs.store.files.set('/d/z', new TextEncoder().encode('zz'))
  const ws = new Workspace({
    '/ram': vfs,
    '/ram/d/m1': new RAMVFS(),
    '/ram/d/m2': new RAMVFS(),
    '/ram/d/m3': new RAMVFS(),
  })
  try {
    const out = await ws.shell('du -x -a /ram/d')
    expect(DEC.decode(out.stdout)).toBe('2\t/ram/d/z\n2\t/ram/d\n')
  } finally {
    await ws.close()
  }
})
