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

// cmp's byte counts, byte rendering and diagnostics, pinned on GNU 9.1.
// Mirrors python/tests/commands/builtin/generic/test_cmp.py.

import { describe, expect, it } from 'vitest'
import { cmpGeneric, parseFlags } from './cmp.ts'
import { PathSpec } from '../../../types.ts'
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import type { Context } from '../../config.ts'

const DEC = new TextDecoder()
const ENC = new TextEncoder()
const P1 = new PathSpec({ virtual: '/F/one', directory: '/F', vfsPath: 'one' })
const P2 = new PathSpec({ virtual: '/F/two', directory: '/F', vfsPath: 'two' })
const DASH = new PathSpec({ virtual: '/F/-', directory: '/F', vfsPath: '-', rawPath: '-' })
const DEV_STDIN = new PathSpec({ virtual: '/dev/stdin', directory: '/dev', vfsPath: 'stdin' })

const HINT = "\ncmp: Try 'cmp --help' for more information.\n"

// What cmp's builder does: read the counts, then compare.
async function cmp(
  paths: PathSpec[],
  texts: readonly string[],
  ctx: Context,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
  sizeOf?: (p: PathSpec) => Promise<number | null>,
): Promise<[ByteSource | null, IOResult]> {
  const parsed = parseFlags(ctx.flags, texts)
  if (parsed instanceof IOResult) return [null, parsed]
  return cmpGeneric(parsed, paths, texts, ctx, stream, sizeOf)
}

function refusal(flags: Context['flags'], texts: readonly string[] = []): [string, number] {
  const parsed = parseFlags(flags, texts)
  if (!(parsed instanceof IOResult)) throw new Error('cmp took the counts')
  return [DEC.decode(parsed.stderr as Uint8Array), parsed.exitCode]
}

describe('parseFlags', () => {
  it.each([
    ['4', 4],
    ['1K', 1024],
    ['1kiB', 1024],
    ['0x400', 1024],
    ['+1010', 1010],
    [' 1', 1],
    ['7E', 7 * 1024 ** 6],
  ])('takes -n %j', (raw, value) => {
    expect(parseFlags({ bytes: raw })).toMatchObject({ limit: value })
  })

  // diffutils 3.10 takes no od block or char suffix, no Q or R (newer than
  // its gnulib), and caps a count at INTMAX: each is an invalid value, exit 2.
  it.each(['1b', '1m', '0Q', '1 ', '-1', '9223372036854775808', '8E', 'abc'])(
    'refuses -n %j',
    (raw) => {
      expect(refusal({ bytes: raw })).toEqual([`cmp: invalid --bytes value '${raw}'${HINT}`, 2])
    },
  )

  it.each([
    ['1b:1', '1b:1'],
    ['1:1b', '1b'],
    ['1:2:3', '2:3'],
    [':1', ':1'],
  ])('names the -i operand from where it stopped: %s', (raw, named) => {
    // GNU prints the operand from the position its count started at, so a
    // bad SKIP1 names the whole pair and a bad SKIP2 names only itself.
    expect(refusal({ ignore_initial: raw })).toEqual([
      `cmp: invalid --ignore-initial value '${named}'${HINT}`,
      2,
    ])
  })

  it('takes a colon pair for one each', () => {
    expect(parseFlags({ ignore_initial: '1K:2' })).toMatchObject({ skip: [1024, 2] })
    expect(parseFlags({ ignore_initial: '3' })).toMatchObject({ skip: [3, 3] })
  })

  it('refuses -l with -s', () => {
    expect(refusal({ verbose: true, silent: true })).toEqual([
      `cmp: options -l and -s are incompatible${HINT}`,
      2,
    ])
  })
})

describe('cmpGeneric with stdin', () => {
  // One name at one skip, or the second skip of zero that leaves the one
  // descriptor where the first put it: diffutils 3.10 reads neither.
  it.each([
    [[DASH, DEV_STDIN], [], { ignore_initial: '1' }],
    [[DASH, DASH], ['1', '0'], {}],
  ])('takes two stdin operands at one offset as equal unread: %#', async (paths, texts, flags) => {
    const stream = (p: PathSpec): AsyncIterable<Uint8Array> => {
      throw new Error(`read ${p.virtual}`)
    }
    const ctx = { flags, stdin: ENC.encode('abc') } as unknown as Context
    const [src, io] = await cmp(paths, texts, ctx, stream)
    expect([src, io.exitCode, io.stderr]).toEqual([null, 0, null])
  })
})

// `cmp -n` quotes the value but does NOT escape it. diffutils is not
// coreutils: it interpolates the bytes with a plain `%s` inside the quotes
// rather than passing them through gnulib's `quote()`, so a control byte, a
// backslash and a single quote all reach stderr as themselves. Measured
// against GNU diffutils' cmp under `LC_ALL=C` with a raw `bytes` argv:
// `cmp -n 1é` reports `invalid --bytes value '1é'` and `cmp -n "1'"`
// reports `'1''`, where the neighbouring coreutils clauses would say
// `'1\303\251'` and `'1\''`. This asymmetry is deliberate; do not "fix" it
// by routing this clause through quote(). Mirrors test_cmp.py.
describe('-n leaves the value unescaped', () => {
  it.each([['1é'], ['1\x01'], ['1\r'], ["1'"], ['1\\']])('keeps %j as typed', (value) => {
    expect(refusal({ bytes: value })).toEqual([`cmp: invalid --bytes value '${value}'${HINT}`, 2])
  })
})

async function runSkips(
  texts: string[],
  flags: Record<string, unknown> = {},
): Promise<[string, number]> {
  const stream = (p: PathSpec): AsyncIterable<Uint8Array> =>
    (async function* gen() {
      await Promise.resolve()
      yield ENC.encode(p.virtual === P1.virtual ? 'xhello\n' : 'hello\n')
    })()
  const ctx = { flags, stdin: null } as unknown as Context
  const [src, io] = await cmp([P1, P2], texts, ctx, stream)
  return [DEC.decode(await materialize(src)), io.exitCode]
}

describe('the skip operands', () => {
  // Mirrors python's test_the_skip_operands_read_as_i_and_keep_the_larger.
  const differ = '/F/one /F/two differ: char 1, line 1\n'
  it.each([
    // SKIP1 skips the first file only; SKIP2 the second.
    [['1'], {}, '', 0],
    [['0', '1'], {}, differ, 1],
    [['1', '1'], {}, differ, 1],
    // Base 0 and cmp's own suffixes, as -i reads them.
    [['0x1'], {}, '', 0],
    [['01'], {}, '', 0],
    [['+1'], {}, '', 0],
    // Each file keeps the larger of -i's skip and its operand's.
    [['0', '2'], { ignore_initial: '1' }, differ, 1],
    [['0', '0'], { ignore_initial: '1:0' }, '', 0],
  ] as const)('%j with %j', async (texts, flags, out, code) => {
    expect(await runSkips([...texts], flags)).toEqual([out, code])
  })

  it.each([
    [['1', 'y'], "cmp: invalid --ignore-initial value 'y'"],
    [[''], "cmp: invalid --ignore-initial value ''"],
    [['1:2'], "cmp: invalid --ignore-initial value '1:2'"],
    [['1 '], "cmp: invalid --ignore-initial value '1 '"],
    [['9223372036854775808'], "cmp: invalid --ignore-initial value '9223372036854775808'"],
    [['y', '1', '2'], "cmp: invalid --ignore-initial value 'y'"],
  ] as const)('refuses %j', (texts, message) => {
    expect(refusal({}, texts)).toEqual([`${message}${HINT}`, 2])
  })
})

function chunked(
  files: Record<string, string[]>,
  pulled: string[],
): (p: PathSpec) => AsyncIterable<Uint8Array> {
  return (p) =>
    (async function* gen() {
      for (const chunk of files[p.virtual] ?? []) {
        await Promise.resolve()
        pulled.push(p.virtual)
        yield ENC.encode(chunk)
      }
    })()
}

describe('the streamed compare', () => {
  // Mirrors python's test_a_difference_stops_the_reads.
  it('stops the reads at a difference', async () => {
    const pulled: string[] = []
    const files = { [P1.virtual]: ['ab\nc', 'd', 'never'], [P2.virtual]: ['ab', '\ncX', 'never'] }
    const ctx = { flags: {}, stdin: null } as unknown as Context
    const [src, io] = await cmp([P1, P2], [], ctx, chunked(files, pulled))
    expect([DEC.decode(await materialize(src)), io.exitCode]).toEqual([
      '/F/one /F/two differ: char 5, line 2\n',
      1,
    ])
    expect(pulled.filter((p) => p === P1.virtual)).toHaveLength(2)
    expect(pulled.filter((p) => p === P2.virtual)).toHaveLength(2)
  })

  // Mirrors python's test_a_shorter_file_ends_the_streamed_compare.
  it.each([
    [['ab', '\n'], ['a', 'b\nmore'], 'after byte 3, line 1'],
    [['ab', 'c'], ['abcd'], 'after byte 3, in line 1'],
    [[], ['x'], 'which is empty'],
  ])('ends at the shorter file: %#', async (first, second, err) => {
    const files = { [P1.virtual]: first, [P2.virtual]: second }
    const ctx = { flags: {}, stdin: null } as unknown as Context
    const [src, io] = await cmp([P1, P2], [], ctx, chunked(files, []))
    expect(src).toBeNull()
    expect([DEC.decode(await materialize(io.stderr)), io.exitCode]).toEqual([
      `cmp: EOF on /F/one ${err}\n`,
      1,
    ])
  })

  // Mirrors python's test_s_answers_from_the_sizes_when_they_differ.
  it.each([
    [[3, 5], undefined, 1, false],
    [[3, 5], '3', 0, true],
    [[5, 5], undefined, 0, true],
    [[null, 5], undefined, 0, true],
  ] as const)('answers -s from sizes %j -n %s', async (sizes, limit, code, read) => {
    const pulled: string[] = []
    const files = { [P1.virtual]: ['abc'], [P2.virtual]: ['abc'] }
    const flags = limit === undefined ? { silent: true } : { silent: true, bytes: limit }
    const ctx = { flags, stdin: null } as unknown as Context
    const sizeOf = (p: PathSpec): Promise<number | null> =>
      Promise.resolve(p.virtual === P1.virtual ? sizes[0] : sizes[1])
    const [src, io] = await cmp([P1, P2], [], ctx, chunked(files, pulled), sizeOf)
    expect([src, io.exitCode, pulled.length > 0]).toEqual([null, code, read])
  })
})
