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

import { DU_BUILDER } from './du.ts'
import { describe, expect, it } from 'vitest'
import { materialize } from '../../../../io/types.ts'
import { FileStat, FileType, PathSpec } from '../../../../types.ts'
import { eacces, enoent } from '../../../../utils/errors.ts'
import { runWithAdmission } from '../../../../context/session_context.ts'
import type { Accessor } from '../../../../accessor/base.ts'
import type { EntryGate } from '../../../../types.ts'
import type { CommandIO } from '../adapter.ts'

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

async function runDu(
  paths: PathSpec[],
  flags: Record<string, string | boolean | number | string[]> = {},
  cwd = '/',
): Promise<string[]> {
  const result = await DU_BUILDER.fn(OPS, ACCESSOR, paths, [], {
    stdin: null,
    flags,
    filetypeFns: null,
    cwd,
  })
  if (result === null) return []
  const [out] = result
  const buf =
    out === null
      ? new Uint8Array()
      : out instanceof Uint8Array
        ? out
        : await materialize(out as AsyncIterable<Uint8Array>)
  const text = DEC.decode(buf)
  return text === '' ? [] : text.trimEnd().split('\n')
}

describe('du walk fallback (no native du op)', () => {
  it('sums a directory tree recursively, one line per directory', async () => {
    expect(await runDu([PathSpec.fromStrPath('/db')])).toEqual(['2\t/db/sub', '5\t/db'])
  })

  it('returns a single file size', async () => {
    expect(await runDu([PathSpec.fromStrPath('/db/a.txt')])).toEqual(['3\t/db/a.txt'])
  })

  it('-a lists every file, then every directory, then the operand', async () => {
    expect(await runDu([PathSpec.fromStrPath('/db')], { a: true })).toEqual([
      '3\t/db/a.txt',
      '2\t/db/sub/b.txt',
      '2\t/db/sub',
      '5\t/db',
    ])
  })

  it('stops the walk and exits 1 once the entry budget is spent', async () => {
    const bounded: CommandIO = { ...OPS, maxDuEntries: 1 }
    const result = await DU_BUILDER.fn(bounded, ACCESSOR, [PathSpec.fromStrPath('/db')], [], {
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

  it('-c appends a grand total across operands', async () => {
    const lines = await runDu(
      [PathSpec.fromStrPath('/db/a.txt'), PathSpec.fromStrPath('/db/sub')],
      { c: true },
    )
    expect(lines).toEqual(['3\t/db/a.txt', '2\t/db/sub', '5\ttotal'])
  })

  it('reports an unreadable operand and exits 1, like GNU', async () => {
    const result = await DU_BUILDER.fn(
      OPS,
      ACCESSOR,
      [PathSpec.fromStrPath('/nope'), PathSpec.fromStrPath('/db')],
      [],
      { stdin: null, flags: {}, filetypeFns: null, cwd: '/' },
    )
    expect(result).not.toBeNull()
    const [out, io] = result as [Uint8Array, { exitCode: number; stderr: Uint8Array | null }]
    expect(DEC.decode(out)).toBe('2\t/db/sub\n5\t/db\n')
    expect(io.exitCode).toBe(1)
    expect(DEC.decode(io.stderr ?? new Uint8Array())).toBe(
      "du: cannot access '/nope': No such file or directory\n",
    )
  })

  it('measures the working directory when no operand is given', async () => {
    expect(await runDu([], {}, '/db')).toEqual(['2\t/db/sub', '5\t/db'])
  })

  it('-d is another spelling of --max-depth', async () => {
    expect(await runDu([PathSpec.fromStrPath('/db')], { max_depth: '0' })).toEqual(['5\t/db'])
    expect(await runDu([PathSpec.fromStrPath('/db')], { max_depth: '0' })).toEqual(['5\t/db'])
  })

  it('rejects -s with -a before doing any work', async () => {
    await expect(runDu([PathSpec.fromStrPath('/db')], { s: true, a: true })).rejects.toThrow(
      /cannot both summarize/,
    )
  })

  it('a backend failure propagates instead of reading as a missing operand', async () => {
    const failing: CommandIO = {
      ...OPS,
      stat: () => Promise.reject(new Error('403 Forbidden')),
    }
    await expect(
      DU_BUILDER.fn(failing, ACCESSOR, [PathSpec.fromStrPath('/db')], [], {
        stdin: null,
        flags: {},
        filetypeFns: null,
        cwd: '/',
      }),
    ).rejects.toThrow('403 Forbidden')
  })

  // GNU prints a count below one unit with no suffix at all, so -h and
  // the plain form agree on this tree. The scaling and rounding rules
  // are pinned against GNU in utils/utils.test.ts; here -h only has to
  // reach the formatter.
  it('-h renders human-readable sizes', async () => {
    expect(await runDu([PathSpec.fromStrPath('/db')], { h: true })).toEqual([
      '2\t/db/sub',
      '5\t/db',
    ])
  })
})

// A gate that scopes the line but refuses nothing, which is what a `du`
// run under any path rule looks like: `pathRulesActive()` is true, so the
// builder sets the native du op aside and walks through the guarded
// readdir instead (adapter.ts's `withRuleGuard` doc states that trade).
const SCOPED_GATE: EntryGate = {
  scoped: true,
  granted: [],
  check: () => undefined,
}

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
    DU_BUILDER.fn(ops, ACCESSOR, paths, [], {
      stdin: null,
      flags: {},
      filetypeFns: null,
      cwd: '/',
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
    // A subtree that sums to nothing prints no line of its own: no leaf
    // points at it, which is the one place mirage's du diverges from GNU.
    expect(DEC.decode(out)).toBe('3\t/db\n')
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
    expect(DEC.decode(out)).toBe('3\t/db\n')
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
