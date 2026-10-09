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
import { cmpGeneric, parseCount, parseSkip, visible } from './cmp.ts'
import { UsageError } from '../../errors.ts'
import { PathSpec } from '../../../types.ts'
import { materialize } from '../../../io/types.ts'
import type { CommandOpts } from '../../config.ts'

const DEC = new TextDecoder()
const ENC = new TextEncoder()
const P1 = new PathSpec({ virtual: '/F/one', directory: '/F', vfsPath: 'one' })
const P2 = new PathSpec({ virtual: '/F/two', directory: '/F', vfsPath: 'two' })
const DASH = new PathSpec({ virtual: '/F/-', directory: '/F', vfsPath: '-', rawPath: '-' })
const DEV_STDIN = new PathSpec({ virtual: '/dev/stdin', directory: '/dev', vfsPath: 'stdin' })

describe('parseCount', () => {
  it.each([
    ['4', 4],
    ['1K', 1024],
    ['1k', 1024],
    ['1kB', 1000],
    ['1kiB', 1024],
    ['1M', 1024 * 1024],
    ['0Z', 0],
    ['010', 8],
    ['0x400', 1024],
    ['+1010', 1010],
    [' 1', 1],
    ['7E', 7 * 1024 ** 6],
  ])('takes %j', (raw, value) => {
    expect(parseCount(raw, '--bytes')).toBe(value)
  })

  // diffutils 3.10 takes no od block or char suffix, no Q or R (newer than
  // its gnulib), and caps a count at INTMAX: each is an invalid value, exit 2.
  it.each([
    '1b',
    '1B',
    '1c',
    '1w',
    '1m',
    '1g',
    '1t',
    '1Q',
    '0Q',
    '1 ',
    '-1',
    '9223372036854775808',
    '8E',
    '1Z',
    '1Y',
  ])('refuses %j', (raw) => {
    expect(() => parseCount(raw, '--bytes')).toThrow(UsageError)
  })

  it('names the long option it was given', () => {
    // GNU says `invalid --bytes value` for -n and `invalid
    // --ignore-initial value` for -i, exit 2. diffutils routes the
    // Try-help line through error(), so it carries the `cmp: ` prefix
    // that coreutils' bare hint does not.
    let caught: unknown
    try {
      parseCount('abc', '--bytes')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(UsageError)
    expect((caught as UsageError).message).toBe(
      "cmp: invalid --bytes value 'abc'\ncmp: Try 'cmp --help' for more information.",
    )
    expect((caught as UsageError).exitCode).toBe(2)
  })
})

describe('parseSkip', () => {
  it('takes one count for both files', () => {
    expect(parseSkip('3')).toEqual([3, 3])
  })

  it.each([
    ['1b:1', '1b:1'],
    ['1:1b', '1b'],
    ['1:abc', 'abc'],
    ['abc:1', 'abc:1'],
    ['1:2:3', '2:3'],
    ['1:', ''],
    [':1', ':1'],
    [':', ':'],
  ])('names the operand from where it stopped: %s', (raw, named) => {
    // GNU prints the operand from the position xstrtoumax was reading,
    // so a bad SKIP1 names the whole pair and a bad SKIP2 names only
    // itself. A colon is the one character the first count may stop on.
    let caught: unknown
    try {
      parseSkip(raw)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(UsageError)
    expect((caught as UsageError).message.split('\n')[0]).toBe(
      `cmp: invalid --ignore-initial value '${named}'`,
    )
  })

  it('takes a colon pair for one each', () => {
    expect(parseSkip('0:3')).toEqual([0, 3])
    expect(parseSkip('1K:2')).toEqual([1024, 2])
  })
})

describe('visible', () => {
  it.each([
    ['b'.charCodeAt(0), 'b'],
    [9, '^I'],
    [1, '^A'],
    [127, '^?'],
    [0xc3, 'M-C'],
    [0xa9, 'M-)'],
    [0x80, 'M-^@'],
  ])('renders %i the cat -v way', (byte, rendered) => {
    expect(visible(byte)).toBe(rendered)
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
    const opts = { flags, stdin: ENC.encode('abc') } as unknown as CommandOpts
    const [src, io] = await cmpGeneric(paths, texts, opts, stream)
    expect([src, io.exitCode, io.stderr]).toEqual([null, 0, null])
  })
})

// `cmp -n` quotes the value but does NOT escape it. diffutils is not
// coreutils: it interpolates the bytes with a plain `%s` inside the quotes
// rather than passing them through gnulib's `quote()`, so a control byte, a
// backslash and a single quote all reach stderr as themselves. Measured
// against GNU diffutils' cmp under `LC_ALL=C` with a raw `bytes` argv:
// `cmp -n 1é` reports `invalid --bytes value '1é'` and `cmp -n "1'"`
// reports `'1''`, where the coreutils clauses next entry point would say
// `'1\303\251'` and `'1\''`. This asymmetry is deliberate; do not "fix" it
// by routing this clause through quote(). Mirrors test_cmp.py.
describe('parseCount leaves the value unescaped', () => {
  it.each([['1é'], ['1\x01'], ['1\r'], ["1'"], ['1\\']])('keeps %j as typed', (value) => {
    expect(() => parseCount(value, '--bytes')).toThrow(
      new UsageError(
        `cmp: invalid --bytes value '${value}'\n` + "cmp: Try 'cmp --help' for more information.",
        2,
      ),
    )
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
  const opts = { flags, stdin: null } as unknown as CommandOpts
  const [src, io] = await cmpGeneric([P1, P2], texts, opts, stream)
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
  ] as const)('refuses %j', async (texts, message) => {
    await expect(runSkips([...texts])).rejects.toThrow(
      new UsageError(`${message}\ncmp: Try 'cmp --help' for more information.`),
    )
  })
})
