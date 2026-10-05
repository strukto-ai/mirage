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

import { BUILDER, WalkBudget } from './du.ts'
import { describe, expect, it } from 'vitest'
import { materialize } from '../../../../io/types.ts'
import { FileStat, FileType, PathSpec } from '../../../../types.ts'
import { eacces, enoent } from '../../../../utils/errors.ts'
import { runWithAdmission } from '../../../../context/session_context.ts'
import type { Accessor } from '../../../../accessor/base.ts'
import type { EntryGate } from '../../../../types.ts'
import { scopedIo, type CommandIO } from '../adapter.ts'
import type { MountView, NamespaceView } from '../../../../ops/types.ts'

const DEC = new TextDecoder()

const TREE: Record<string, { dir: boolean; size?: number; children?: string[] }> = {
  '/db': { dir: true, children: ['/db/a.txt', '/db/sub'] },
  '/db/a.txt': { dir: false, size: 3 },
  '/db/sub': { dir: true, children: ['/db/sub/b.txt'] },
  '/db/sub/b.txt': { dir: false, size: 2 },
}

// A CommandIO with no native du op, so the builder must use the walk fallback.
// eslint-disable-next-line @typescript-eslint/require-await
async function* emptyStream(): AsyncIterable<Uint8Array> {
  yield* []
}

const OPS: CommandIO = {
  readdir: (_a, p) => Promise.resolve(TREE[p.virtual]?.children ?? []),
  readBytes: () => Promise.resolve(new Uint8Array()),
  readStream: () => emptyStream(),
  stat: (_a, p) => {
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
  isMounted: () => true,
}

const ACCESSOR = {} as Accessor

describe('du walk fallback (no native du op)', () => {
  it('stops the walk and exits 1 once the entry budget is spent', async () => {
    const bounded: CommandIO = { ...OPS, maxDuEntries: 1 }
    const result = await BUILDER.fn(bounded, ACCESSOR, [PathSpec.fromStrPath('/db')], [], {
      stdin: null,
      flags: {},
      filetypeFns: null,
      cwd: '/',
    })
    expect(result).not.toBeNull()
    const [, io] = result as [unknown, { exitCode: number; stderr: Uint8Array | null }]
    expect(io.exitCode).toBe(1)
    expect(DEC.decode(io.stderr ?? new Uint8Array())).toContain('incomplete')
  })

  it('a backend failure propagates instead of reading as a missing operand', async () => {
    const failing: CommandIO = {
      ...OPS,
      stat: () => Promise.reject(new Error('403 Forbidden')),
    }
    await expect(
      BUILDER.fn(failing, ACCESSOR, [PathSpec.fromStrPath('/db')], [], {
        stdin: null,
        flags: {},
        filetypeFns: null,
        cwd: '/',
      }),
    ).rejects.toThrow('403 Forbidden')
  })
})

// A gate that scopes the line but refuses nothing, which is what a `du`
// run under any path rule looks like: the gate is scoped, so `scopedIo`
// sets the native du op aside and the builder walks through the guarded
// readdir instead.
const SCOPED_GATE: EntryGate = {
  scoped: true,
  scopes: () => true,
  granted: [],
  check: () => undefined,
  refuses: () => false,
}

// The command's view as admission builds it for a scoped gate.
const SCOPED_VIEW: NamespaceView = { scoped: () => true }

const THROTTLED = Object.assign(new Error('Box GET /folders/9/items -> 429'), {
  status: 429,
})

// A native du op that would answer instantly, and wrongly: any total
// coming from here proves the walk was skipped.
const NATIVE: CommandIO = {
  ...OPS,
  du: {
    size: () => Promise.resolve(999),
    entries: () => Promise.resolve([[['/native', 999]] as [string, number][], 999]),
  },
} as CommandIO

async function runScoped(
  ops: CommandIO,
  paths: PathSpec[],
): Promise<[Uint8Array, { exitCode: number; stderr: Uint8Array | null }]> {
  const result = await runWithAdmission(SCOPED_GATE, async () =>
    BUILDER.fn(scopedIo(ops, SCOPED_VIEW, paths, ''), ACCESSOR, paths, [], {
      stdin: null,
      flags: {},
      filetypeFns: null,
      cwd: '/',
      ns: SCOPED_VIEW,
    }),
  )
  return result as [Uint8Array, { exitCode: number; stderr: Uint8Array | null }]
}

describe('du walk fallback under a path rule', () => {
  it('sets the native du op aside, so every entry passes the gate', async () => {
    const [out] = await runScoped(NATIVE, [PathSpec.fromStrPath('/db')])
    expect(DEC.decode(out)).toBe('2\t/db/sub\n5\t/db\n')
  })

  it('propagates a throttled listing rather than reporting an undersized total', async () => {
    const throttled: CommandIO = {
      ...NATIVE,
      readdir: (_a, p) =>
        p.virtual === '/db/sub'
          ? Promise.reject(THROTTLED)
          : Promise.resolve(TREE[p.virtual]?.children ?? []),
    }
    await expect(runScoped(throttled, [PathSpec.fromStrPath('/db')])).rejects.toMatchObject({
      status: 429,
    })
  })

  it('propagates a throttled stat below the operand too', async () => {
    const throttled: CommandIO = {
      ...NATIVE,
      stat: (a, p, i) =>
        p.virtual === '/db/a.txt' ? Promise.reject(THROTTLED) : OPS.stat(a, p, i),
    }
    await expect(runScoped(throttled, [PathSpec.fromStrPath('/db')])).rejects.toMatchObject({
      status: 429,
    })
  })

  it('still counts an entry that went away mid-walk as zero', async () => {
    const vanished: CommandIO = {
      ...NATIVE,
      stat: (a, p, i) =>
        p.virtual === '/db/sub/b.txt' ? Promise.reject(enoent(p.virtual)) : OPS.stat(a, p, i),
    }
    const [out, io] = await runScoped(vanished, [PathSpec.fromStrPath('/db')])
    // A subtree that sums to nothing still prints its own 0 line, as GNU
    // prints one for every directory it walked.
    expect(DEC.decode(out)).toBe('0\t/db/sub\n3\t/db\n')
    expect(io.exitCode).toBe(0)
  })

  it('still skips a refused directory and names it, as GNU does', async () => {
    const refused: CommandIO = {
      ...NATIVE,
      readdir: (_a, p) =>
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
    const refused: CommandIO = {
      ...NATIVE,
      stat: (a, p, i) =>
        p.virtual === '/db/sub' ? Promise.reject(eacces(p.virtual)) : OPS.stat(a, p, i),
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
  // doors a rule or the host can shut.
  const sealed: Record<string, string[]> = {
    '/db': ['/db/a.txt', '/db/empty', '/db/sealed', '/db/walled'],
    '/db/empty': [],
    '/db/sealed': [],
  }
  const ops: CommandIO = {
    ...OPS,
    readdir: (_a, p) =>
      p.virtual === '/db/sealed'
        ? Promise.reject(eacces(p.virtual))
        : Promise.resolve(sealed[p.virtual] ?? []),
    stat: (_a, p) => {
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
    const result = await BUILDER.fn(ops, ACCESSOR, [PathSpec.fromStrPath('/db')], [], {
      stdin: null,
      flags,
      filetypeFns: null,
      cwd: '/',
    })
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

describe('WalkBudget', () => {
  it('stops once spent', () => {
    const budget = new WalkBudget(2)
    expect([0, 1, 2].map(() => budget.spend('/d'))).toEqual([true, true, false])
    expect(budget.hit).toBe(true)
    const unbounded = new WalkBudget(null)
    expect(Array.from({ length: 100 }, () => unbounded.spend('/d')).every(Boolean)).toBe(true)
    expect(unbounded.hit).toBe(false)
  })

  it('with no cap of its own charges each mount its own', () => {
    const ownerOf = (p: string): string => (p.startsWith('/a/b') ? '/a/b/' : '/a/')
    const caps = new Map<string, number | null>([
      ['/a/', null],
      ['/a/b/', 1],
    ])
    const mounts: MountView = {
      descendants: () => [],
      visibleDescendants: () => [],
      isRoot: (p) => caps.has(p.replace(/\/?$/, '/')),
      rootOf: ownerOf,
      maxDuEntries: (p) => caps.get(ownerOf(p)) ?? null,
    }
    const budget = new WalkBudget(null, mounts)
    expect(Array.from({ length: 100 }, () => budget.spend('/a')).every(Boolean)).toBe(true)
    expect([0, 1].map(() => budget.spend('/a/b'))).toEqual([true, false])
    expect(budget.hit).toBe(true)
  })
})
