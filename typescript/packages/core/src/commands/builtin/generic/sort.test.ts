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
import { describe, expect, it, vi } from 'vitest'

import { ByteSpool } from '../../../io/spool.ts'
import { IOResult, materialize } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import { unreadableStdin } from '../../../shell/descriptors.ts'
import { enoent } from '../../../errors/fs.ts'
import type { Context } from '../../config.ts'
import { parseFlags, SORT_RUN_BYTES, sortGeneric, type SortFlags } from './sort.ts'

const DEC = new TextDecoder()

/** What sort's options decide, which these flags must not refuse. */
function parsed(flags: Context['flags']): SortFlags {
  const result = parseFlags(flags, [])
  if (result instanceof IOResult) throw new Error(DEC.decode(result.stderr as Uint8Array))
  return result
}

async function stderrOf(flags: Context['flags']): Promise<[string, number]> {
  const ctx = {
    stdin: new TextEncoder().encode('b\na\n'),
    flags,
    cwd: PathSpec.fromStrPath('/'),
    vfs: { kind: 'ram' } as never,
  } as Context
  const result = await sortGeneric([], ctx, () => {
    throw new Error('paths are empty; the source is stdin')
  })
  if (result === null) throw new Error('sort returned no result')
  const io = result[1]
  // stderr is null on a run that was not refused, which the prefix cases
  // below are.
  return [DEC.decode((io.stderr ?? new Uint8Array()) as Uint8Array), io.exitCode]
}

// GNU's word-choice refusal names the refused word quoted, so a byte
// outside 0x20-0x7e comes back escaped rather than interpolated
// raw. Every row measured against GNU coreutils 9.7 under `LC_ALL=C` with a
// raw `bytes` argv (`sort --check=<w>`). Mirrors test_sort.py.
describe('sort quotes the word --check refuses', () => {
  it.each([
    ['xé', 'x\\303\\251'],
    ['x\r', 'x\\r'],
    ['qu1et', 'qu1et'],
  ])('escapes %j in the --check clause', async (value, escaped) => {
    const [stderr] = await stderrOf({ check: value })
    expect(stderr.split('\n')[0]).toBe(`sort: invalid argument '${escaped}' for '--check'`)
  })
})

describe('sort --check resolves an unambiguous prefix', () => {
  // `sort --check=q`, `=s` and `=d` all exit 0 on sorted input (measured,
  // coreutils 9.7). The stdin here is NOT sorted, so the canonical word is
  // observable: the ('quiet', 'silent') value stays silent while
  // diagnose-first names the first disorder. Mirrors test_sort.py.
  it.each(['q'])('resolves --check=%s to the quiet value', async (value) => {
    const [stderr, code] = await stderrOf({ check: value })
    expect(stderr).toBe('')
    expect(code).toBe(1)
  })

  it.each(['d'])('resolves --check=%s to diagnose-first', async (value) => {
    const [stderr, code] = await stderrOf({ check: value })
    expect(stderr).toContain('disorder')
    expect(code).toBe(1)
  })
})

type Source = Uint8Array | Error

function spec(virtual: string, rawPath?: string): PathSpec {
  return new PathSpec({
    virtual,
    directory: virtual.slice(0, virtual.lastIndexOf('/') + 1),
    vfsPath: virtual,
    ...(rawPath === undefined ? {} : { rawPath }),
  })
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

interface Run {
  paths?: PathSpec[]
  files?: Record<string, Source>
  flags?: Context['flags']
  stdin?: Context['stdin']
}

async function run(r: Run): Promise<[string, string, number]> {
  const ctx = {
    stdin: r.stdin ?? null,
    flags: r.flags ?? {},
    cwd: PathSpec.fromStrPath('/'),
    vfs: { kind: 'ram' } as never,
  } as Context
  const files = r.files ?? {}
  async function* stream(path: PathSpec): AsyncIterable<Uint8Array> {
    await Promise.resolve()
    const source = files[path.virtual]
    if (source === undefined) throw new Error(`unexpected read of ${path.virtual}`)
    if (source instanceof Error) throw source
    yield source
  }
  const result = await sortGeneric(r.paths ?? [], ctx, stream)
  if (result === null) throw new Error('sort returned no result')
  const [out, io] = result
  const stdout = out === null ? '' : DEC.decode(await materialize(out))
  const stderr = io.stderr === null ? '' : DEC.decode(await materialize(io.stderr))
  return [stdout, stderr, io.exitCode]
}

// Every expectation below was measured against GNU coreutils 9.7 on
// debian:stable-slim under LC_ALL=C. Mirrors test_sort.py.
describe('sort names the step an input failed at', () => {
  it('names the input as typed, quoted when it needs it', async () => {
    const [, stderr] = await run({
      paths: [spec('/data/no such.txt', 'no such.txt')],
      files: { '/data/no such.txt': enoent('/data/no such.txt') },
    })
    expect(stderr).toBe("sort: cannot read: 'no such.txt': No such file or directory\n")
  })

  it('stops at the first input that fails its access check', async () => {
    const [, stderr] = await run({
      paths: [spec('/data/m1'), spec('/data/m2')],
      files: { '/data/m1': enoent('/data/m1') },
    })
    expect(stderr).toBe('sort: cannot read: /data/m1: No such file or directory\n')
  })

  it.each([
    [{}, 'stat failed'],
    [{ merge: true }, 'read failed'],
  ])('fails a closed stdin where GNU first touches it (%j)', async (flags, verb) => {
    const [, stderr, code] = await run({ flags, stdin: unreadableStdin() })
    expect(stderr).toBe(`sort: ${verb}: -: Bad file descriptor\n`)
    expect(code).toBe(2)
  })
})

describe('sort -c and -C', () => {
  it.each([
    [{ c: true }, 'c'],
    [{ check: 'quiet' }, 'C'],
  ])('refuses an output by the mode letter (%j)', async (flags, mode) => {
    const [, stderr, code] = await run({
      stdin: bytes('b\na\n'),
      flags: { ...flags, output: [PathSpec.fromStrPath('/data/out.txt')] },
    })
    expect(stderr).toBe(`sort: options '-${mode}o' are incompatible\n`)
    expect(code).toBe(2)
  })

  it('lets a second operand outrank the output and names the mode', async () => {
    const [, stderr, code] = await run({
      paths: [spec('/data/a'), spec('/data/b')],
      flags: { C: true, output: [PathSpec.fromStrPath('/data/out.txt')] },
    })
    expect(stderr).toBe("sort: extra operand '/data/b' not allowed with -C\n")
    expect(code).toBe(2)
  })

  it.each([
    { c: true, C: true },
    { check: 'silent', c: true },
  ])('refuses to mix the two modes (%j)', async (flags) => {
    const [, stderr, code] = await run({ stdin: bytes('a\n'), flags })
    expect(stderr).toBe("sort: options '-cC' are incompatible\n")
    expect(code).toBe(2)
  })

  it('accepts one mode asked for twice', () => {
    expect(parsed({ C: true, check: 'quiet' }).checkQuiet).toBe(true)
    expect(parsed({ c: true, check: 'diagnose-first' }).check).toBe(true)
  })

  // A bare --check is -c, and --check= names the empty word, which is a
  // prefix of both modes (coreutils 9.7: ambiguous, exit 1). Mirrors
  // test_sort.py.
  it('reads a bare --check as -c and --check= as an ambiguous word', async () => {
    const bare = parsed({ check: true })
    expect([bare.check, bare.checkQuiet]).toEqual([true, false])
    const [, stderr, code] = await run({ stdin: bytes('a\n'), flags: { check: '' } })
    expect(stderr.split('\n')[0]).toBe("sort: ambiguous argument '' for '--check'")
    expect(code).toBe(1)
  })
})

describe('sort -o', () => {
  it('refuses two outputs unless they name one file', async () => {
    const [, stderr, code] = await run({
      stdin: bytes('a\n'),
      flags: { output: [PathSpec.fromStrPath('/data/p1'), PathSpec.fromStrPath('/data/p2')] },
    })
    expect(stderr).toBe('sort: multiple output files specified\n')
    expect(code).toBe(2)
    expect(
      parsed({ output: [PathSpec.fromStrPath('/data/p1'), PathSpec.fromStrPath('/data/p1')] })
        .output?.virtual,
    ).toBe('/data/p1')
    const [, typed] = await run({
      stdin: bytes('a\n'),
      flags: { output: [spec('/data/o', './o'), spec('/data/o', 'o')] },
    })
    expect(typed).toBe('sort: multiple output files specified\n')
  })

  it('refuses the first bad option on the line', async () => {
    const [, first] = await run({
      stdin: bytes('a\n'),
      flags: { output: [PathSpec.fromStrPath('/p1'), PathSpec.fromStrPath('/p2')], key: ['0'] },
    })
    expect(first).toBe('sort: multiple output files specified\n')
    const [, key] = await run({
      stdin: bytes('a\n'),
      flags: { key: ['0'], output: [PathSpec.fromStrPath('/p1'), PathSpec.fromStrPath('/p2')] },
    })
    expect(key).toContain('invalid field specification')
    const [, modes] = await run({
      stdin: bytes('a\n'),
      flags: {
        c: true,
        C: true,
        output: [PathSpec.fromStrPath('/p1'), PathSpec.fromStrPath('/p2')],
      },
    })
    expect(modes).toBe("sort: options '-cC' are incompatible\n")
  })
})

// GNU checks the orderings after its option loop and before -c's operand
// checks and any input. Measured against GNU coreutils 9.7 under LC_ALL=C.
// Mirrors test_sort.py.
describe('sort refuses incompatible orderings where GNU does', () => {
  const MIXED = { numeric_sort: true, general_numeric_sort: true }

  it.each([
    [{ key: ['0'] }, "sort: field number is zero: invalid field specification '0'\n"],
    [{ c: true, C: true }, "sort: options '-cC' are incompatible\n"],
  ])('lets the option loop outrank them (%j)', async (flags, refusal) => {
    const [, stderr, code] = await run({ stdin: bytes('a\n'), flags: { ...MIXED, ...flags } })
    expect(stderr).toBe(refusal)
    expect(code).toBe(2)
  })

  it.each([
    [['/data/a', '/data/b'], { c: true }],
    [['/data/missing'], {}],
  ])('outranks the operands %j', async (paths, flags) => {
    const [, stderr, code] = await run({
      paths: paths.map((path) => spec(path)),
      files: { '/data/missing': enoent('/data/missing') },
      flags: { ...MIXED, ...flags },
    })
    expect(stderr).toBe("sort: options '-gn' are incompatible\n")
    expect(code).toBe(2)
  })
})

describe('sort inputs', () => {
  it('merges without reordering a run under -m', async () => {
    const [single] = await run({
      paths: [spec('/data/in.txt')],
      files: { '/data/in.txt': bytes('b\na\n') },
      flags: { merge: true },
    })
    expect(single).toBe('b\na\n')
    const [two] = await run({
      paths: [spec('/data/s1'), spec('/data/s2')],
      files: { '/data/s1': bytes('c\na\n'), '/data/s2': bytes('b\n') },
      flags: { merge: true },
    })
    expect(two).toBe('b\nc\na\n')
  })
})

describe('sort past one run', () => {
  it('spills sorted runs and merges them in order', async () => {
    // Each record counts its length plus 64 against a run, so this is two.
    const count = Math.ceil(SORT_RUN_BYTES / 64) + 1000
    const values = Array.from({ length: count }, (_, i) => (i * 7919) % count)
    const [out, , code] = await run({
      paths: [spec('/data/in.txt')],
      files: { '/data/in.txt': bytes(values.join('\n')) },
      flags: { numeric_sort: true },
    })
    expect(code).toBe(0)
    expect(out).toBe(Array.from({ length: count }, (_, i) => `${String(i)}\n`).join(''))
  })
})

describe('sort records', () => {
  it('ends each input at its last record', async () => {
    expect(
      await run({
        paths: [spec('/data/a'), spec('/data/b')],
        files: { '/data/a': bytes('c'), '/data/b': bytes('b\na') },
      }),
    ).toEqual(['a\nb\nc\n', '', 0])
    expect(
      await run({
        paths: [spec('/data/a')],
        files: { '/data/a': bytes('b\na') },
        flags: { merge: true },
      }),
    ).toEqual(['b\na\n', '', 0])
  })

  it('hands back bytes that are not UTF-8 unchanged', async () => {
    const ctx = {
      stdin: Uint8Array.of(0xff, 10, 98, 10, 0xc3, 0xa9, 10),
      flags: {},
      cwd: PathSpec.fromStrPath('/'),
      vfs: { kind: 'ram' } as never,
    } as Context
    const result = await sortGeneric([], ctx, () => {
      throw new Error('paths are empty; the source is stdin')
    })
    if (result === null) throw new Error('sort returned no result')
    expect(await materialize(result[0] ?? new Uint8Array())).toEqual(
      Uint8Array.of(98, 10, 0xc3, 0xa9, 10, 0xff, 10),
    )
  })

  it('names the disordered record under -c', async () => {
    expect(
      await run({
        paths: [spec('/data/a')],
        files: { '/data/a': bytes('a\nc\nb\n') },
        flags: { c: true },
      }),
    ).toEqual(['', 'sort: /data/a:3: disorder: b\n', 1])
  })
})

it('preserves input order for equal keys across multiple merge levels', async () => {
  const paths = Array.from({ length: 40 }, (_, i) => PathSpec.fromStrPath(`/input${String(i)}`))
  const files = Object.fromEntries(
    paths.map((p, i) => [p.virtual, new TextEncoder().encode(`a ${String(i)}\nb ${String(i)}\n`)]),
  )
  const expected = ['a', 'b']
    .flatMap((key) => paths.map((_, i) => `${key} ${String(i)}\n`))
    .join('')
  expect(await run({ paths, files, flags: { merge: true, stable: true, key: ['1,1'] } })).toEqual([
    expected,
    '',
    0,
  ])
})

it('merge retires groups before reading all operands', async () => {
  const live = new Set<ByteSpool>()
  let peak = 0
  // eslint-disable-next-line @typescript-eslint/unbound-method -- called with the tested spool
  const append = ByteSpool.prototype.append
  // eslint-disable-next-line @typescript-eslint/unbound-method -- called with the tested spool
  const close = ByteSpool.prototype.close
  const appendSpy = vi.spyOn(ByteSpool.prototype, 'append').mockImplementation(async function (
    this: ByteSpool,
    data,
  ) {
    live.add(this)
    peak = Math.max(peak, live.size)
    await append.call(this, data)
  })
  const closeSpy = vi.spyOn(ByteSpool.prototype, 'close').mockImplementation(async function (
    this: ByteSpool,
  ) {
    await close.call(this)
    live.delete(this)
  })
  const enc = new TextEncoder()
  const lines = Array.from({ length: 1024 }, (_, i) => `x ${String(i).padStart(4, '0')}\n`)
  const paths = lines.map((_, i) => spec(`/f${String(i)}`))
  async function* read(path: PathSpec): AsyncGenerator<Uint8Array> {
    await Promise.resolve()
    yield enc.encode(lines[Number(path.virtual.slice(2))])
  }
  try {
    const context = {
      stdin: null,
      flags: { merge: true, stable: true, key: ['1,1'] },
      cwd: PathSpec.fromStrPath('/'),
    } as Context
    const result = await sortGeneric(paths, context, read)
    if (result === null) throw new Error('sort declined')
    expect(DEC.decode(await materialize(result[0]))).toBe(lines.join(''))
    expect(result[1].exitCode).toBe(0)
    expect(peak).toBeLessThan(32)
    expect(live.size).toBe(0)
  } finally {
    appendSpy.mockRestore()
    closeSpy.mockRestore()
  }
})
