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

import { materialize } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import { unreadableStdin } from '../../../shell/descriptors.ts'
import { enoent } from '../../../errors/fs.ts'
import type { CommandOpts } from '../../config.ts'
import { parseFlags, sortGeneric } from './sort.ts'

const DEC = new TextDecoder()

async function stderrOf(flags: CommandOpts['flags']): Promise<[string, number]> {
  const opts = {
    stdin: new TextEncoder().encode('b\na\n'),
    flags,
    filetypeFns: null,
    cwd: '/',
    vfs: { kind: 'ram' } as never,
  } as CommandOpts
  const result = await sortGeneric([], opts, () => {
    throw new Error('paths are empty; the source is stdin')
  })
  if (result === null) throw new Error('sort returned no result')
  const io = result[1]
  // stderr is null on a run that was not refused, which the prefix cases
  // below are.
  return [DEC.decode((io.stderr ?? new Uint8Array()) as Uint8Array), io.exitCode]
}

// GNU's ARGMATCH refusal names the refused word through gnulib's quote(),
// so a byte outside 0x20-0x7e comes back escaped rather than interpolated
// raw. Every row measured against GNU coreutils 9.4 under `LC_ALL=C` with a
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
  // coreutils 9.4). The stdin here is NOT sorted, so the canonical word is
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
  flags?: CommandOpts['flags']
  stdin?: CommandOpts['stdin']
}

async function run(r: Run): Promise<[string, string, number]> {
  const opts = {
    stdin: r.stdin ?? null,
    flags: r.flags ?? {},
    filetypeFns: null,
    cwd: '/',
    vfs: { kind: 'ram' } as never,
  } as CommandOpts
  const files = r.files ?? {}
  async function* stream(path: PathSpec): AsyncIterable<Uint8Array> {
    await Promise.resolve()
    const source = files[path.virtual]
    if (source === undefined) throw new Error(`unexpected read of ${path.virtual}`)
    if (source instanceof Error) throw source
    yield source
  }
  const result = await sortGeneric(r.paths ?? [], opts, stream)
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
    expect(parseFlags({ C: true, check: 'quiet' }).checkQuiet).toBe(true)
    expect(parseFlags({ c: true, check: 'diagnose-first' }).check).toBe(true)
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
      parseFlags({ output: [PathSpec.fromStrPath('/data/p1'), PathSpec.fromStrPath('/data/p1')] })
        .output?.virtual,
    ).toBe('/data/p1')
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
