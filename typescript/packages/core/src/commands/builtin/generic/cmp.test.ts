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
const P1 = new PathSpec({ virtual: '/F/one', directory: '/F', resourcePath: 'one' })
const P2 = new PathSpec({ virtual: '/F/two', directory: '/F', resourcePath: 'two' })

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values)
}

async function run(
  first: Uint8Array,
  second: Uint8Array,
  flags: Record<string, unknown> = {},
): Promise<{ out: string; err: string; code: number }> {
  const stream = (p: PathSpec): AsyncIterable<Uint8Array> => {
    const held = p.virtual === P1.virtual ? first : second
    return (async function* gen() {
      await Promise.resolve()
      yield held
    })()
  }
  const [src, io] = await cmpGeneric([P1, P2], { flags } as unknown as CommandOpts, stream)
  return {
    out: DEC.decode(await materialize(src)),
    err: DEC.decode(await materialize(io.stderr)),
    code: io.exitCode,
  }
}

describe('parseCount', () => {
  it('takes digits and GNU size suffixes', () => {
    expect(parseCount('4', '--bytes')).toBe(4)
    expect(parseCount('1K', '--bytes')).toBe(1024)
    expect(parseCount('1k', '--bytes')).toBe(1024)
    expect(parseCount('1kB', '--bytes')).toBe(1000)
    expect(parseCount('1kiB', '--bytes')).toBe(1024)
    expect(parseCount('1M', '--bytes')).toBe(1024 * 1024)
  })

  it.each(['1b', '1B', '1c', '1w', '1m', '1g', '1t'])(
    'rejects %s, a letter od takes and cmp does not',
    (raw) => {
      // diffutils 3.10 lists only kB/K/MB/M/... : no block or char
      // suffixes, and lowercase only as far as k. `cmp -n 1b` is exit 2,
      // where od would read it as 512 bytes.
      expect(() => parseCount(raw, '--bytes')).toThrow(UsageError)
    },
  )

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

  it('rejects an unknown suffix', () => {
    // Q and R postdate the gnulib diffutils 3.10 was built against, so
    // they are invalid values rather than overflowing ones: `0Q` fails
    // where `0Z` is a valid zero.
    expect(() => parseCount('1Q', '--bytes')).toThrow(UsageError)
    expect(() => parseCount('0Q', '--bytes')).toThrow(UsageError)
    expect(parseCount('0Z', '--bytes')).toBe(0)
  })

  it('reads the digits at base zero', () => {
    // xstrtoumax's base 0: a bare leading zero is octal and 0x is hex,
    // neither of which BigInt() would read on its own.
    expect(parseCount('010', '--bytes')).toBe(8)
    expect(parseCount('0x400', '--bytes')).toBe(1024)
    expect(parseCount('+1010', '--bytes')).toBe(1010)
    expect(parseCount(' 1', '--bytes')).toBe(1)
    expect(() => parseCount('1 ', '--bytes')).toThrow(UsageError)
    expect(() => parseCount('-1', '--bytes')).toThrow(UsageError)
  })

  it('rejects a product past INTMAX', () => {
    // The ceiling is INTMAX, not UINTMAX, and overflow reports as the
    // same invalid-value error as a bad suffix -- not od's "too large".
    expect(parseCount('7E', '--bytes')).toBe(7 * 1024 ** 6)
    for (const raw of ['9223372036854775808', '8E', '1Z', '1Y']) {
      expect(() => parseCount(raw, '--bytes')).toThrow(UsageError)
    }
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

describe('cmpGeneric', () => {
  it('switches the word to byte under -b', async () => {
    // GNU counts in `byte` under -b and in `char` otherwise.
    const plain = await run(ENC.encode('abc'), ENC.encode('aXc'))
    const tagged = await run(ENC.encode('abc'), ENC.encode('aXc'), { b: true })
    expect(plain.out).toBe('/F/one /F/two differ: char 2, line 1\n')
    expect(tagged.out).toBe('/F/one /F/two differ: byte 2, line 1 is 142 b 130 X\n')
  })

  it('pads the octal to three columns under -l', async () => {
    const r = await run(bytes(97, 1, 99), bytes(97, 127, 99), { args_l: true })
    expect(r.out).toBe('2   1 177\n')
  })

  it('adds a four-wide char column under -bl', async () => {
    const r = await run(ENC.encode('abc'), ENC.encode('aXc'), { args_l: true, b: true })
    expect(r.out).toBe('2 142 b    130 X\n')
  })

  it('applies the skip per file', async () => {
    // `-i 0:3` keeps all of the first file and drops three bytes of the
    // second, so the very first compared byte differs.
    const r = await run(ENC.encode('abcdefgh'), ENC.encode('abcXefgh'), { i: '0:3' })
    expect(r.out).toBe('/F/one /F/two differ: char 1, line 1\n')
    expect(r.code).toBe(1)
  })

  it('reports EOF on stderr naming the byte and the line', async () => {
    const r = await run(ENC.encode('ab\nc'), ENC.encode('ab\ncdef'))
    expect(r.out).toBe('')
    expect(r.err).toBe('cmp: EOF on /F/one after byte 4, in line 2\n')
    expect(r.code).toBe(1)
  })

  it('drops the line clause from the EOF diagnostic under -l', async () => {
    const r = await run(ENC.encode('aXc'), ENC.encode('aYcdef'), { args_l: true })
    expect(r.out).toBe('2 130 131\n')
    expect(r.err).toBe('cmp: EOF on /F/one after byte 3\n')
    expect(r.code).toBe(1)
  })

  it('reports no difference for a limit inside the common prefix', async () => {
    const r = await run(ENC.encode('abcdef'), ENC.encode('abcXef'), { n: '2' })
    expect(r).toEqual({ out: '', err: '', code: 0 })
  })
})

// `cmp -n` quotes the value but does NOT escape it. diffutils is not
// coreutils: it interpolates the bytes with a plain `%s` inside the quotes
// rather than passing them through gnulib's `quote()`, so a control byte, a
// backslash and a single quote all reach stderr as themselves. Measured
// against GNU diffutils' cmp under `LC_ALL=C` with a raw `bytes` argv:
// `cmp -n 1é` reports `invalid --bytes value '1é'` and `cmp -n "1'"`
// reports `'1''`, where the coreutils clauses next door would say
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
