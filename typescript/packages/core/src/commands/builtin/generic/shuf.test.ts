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
import type { FlagValue } from '../../spec/types.ts'
import type { CommandOpts } from '../../config.ts'
import {
  MAX_OUTPUT_LINES,
  MEMORY_EXHAUSTED,
  SIZE_MAX,
  UINTMAX_MAX,
  emitCount,
  parseFlags,
  parseInputRange,
  rangeError,
  shufGeneric,
} from './shuf.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

function stubStream(): AsyncIterable<Uint8Array> {
  throw new Error('shuf read an operand although its line count was refused')
}

function stubWrite(): Promise<void> {
  throw new Error('shuf wrote although its line count was refused')
}

async function* stdinOf(text: string): AsyncIterable<Uint8Array> {
  await Promise.resolve()
  yield ENC.encode(text)
}

async function run(
  flags: Record<string, FlagValue>,
  stdinText = 'x\n',
): Promise<{ exit: number; stdout: string; stderr: string }> {
  const opts = {
    stdin: stdinOf(stdinText),
    flags,
    filetypeFns: null,
    cwd: '/',
    resource: { kind: 'ram' } as never,
  } as CommandOpts
  // `CommandFnResult` is nullable — null is how a handler says it does not
  // apply — and shuf never answers that way, so say so rather than
  // destructure a union.
  const result = await shufGeneric([], [], opts, stubStream, stubWrite)
  if (result === null) throw new Error('shuf declined to handle its own operands')
  const [out, io] = result
  return {
    exit: io.exitCode,
    stdout: out === null ? '' : DEC.decode(await materialize(out)),
    stderr: io.stderr instanceof Uint8Array ? DEC.decode(io.stderr) : '',
  }
}

describe('shuf -n refuses a line count it cannot read whole', () => {
  // GNU coreutils 9.4: exit 1, a single stderr line, no `Try --help` line,
  // and the WHOLE argument quoted — `-n 2x` reports '2x', not 'x'. To shuf
  // a `-` is an invalid character rather than a sign, so `-1` is refused
  // while scanning and carries NO `: Numerical result out of range` clause
  // the way `nl -w -3` does.
  it.each([
    ['abc', "shuf: invalid line count: 'abc'\n"],
    ['2x', "shuf: invalid line count: '2x'\n"],
    ['-1', "shuf: invalid line count: '-1'\n"],
    ['', "shuf: invalid line count: ''\n"],
  ])('refuses -n %j before reading anything', async (value, message) => {
    const got = await run({ head_count: value })
    expect(got.exit).toBe(1)
    expect(got.stdout).toBe('')
    expect(got.stderr).toBe(message)
  })

  it('still shuffles with a valid line count', async () => {
    const got = await run({ head_count: '1' })
    expect(got.exit).toBe(0)
    expect(got.stdout).toBe('x\n')
    expect(got.stderr).toBe('')
  })

  // `+2` is a sign, and reads as 2 would.
  it('accepts a leading plus as a sign', async () => {
    const got = await run({ head_count: '+1' })
    expect(got.exit).toBe(0)
    expect(got.stdout).toBe('x\n')
    expect(got.stderr).toBe('')
  })

  // Only the sign is refused: zero is a valid count, and it prints zero
  // bytes rather than one bare separator.
  it('reads 0 as a valid count that prints nothing', async () => {
    const got = await run({ head_count: '0' })
    expect(got.exit).toBe(0)
    expect(got.stdout).toBe('')
    expect(got.stderr).toBe('')
  })
})

describe('shuf -i answers every malformed range with one message', () => {
  // GNU is totally uniform here: non-numeric bounds, a decreasing range, a
  // negative low bound, a missing dash and an empty value all read the same,
  // with the WHOLE argument quoted and no `Try --help` line. shuf has no
  // decreasing-range diagnostic of its own, so cut's is not borrowed.
  it.each([['1-x'], ['x-3'], ['abc'], ['3-1'], ['-2-1'], ['1'], ['']])(
    'refuses -i %j',
    async (value) => {
      const got = await run({ input_range: value })
      expect(got.exit).toBe(1)
      expect(got.stdout).toBe('')
      expect(got.stderr).toBe(`shuf: invalid input range: '${value}'\n`)
    },
  )

  it('reads a single-element range', async () => {
    const got = await run({ input_range: '2-2' })
    expect(got.exit).toBe(0)
    expect(got.stdout).toBe('2\n')
    expect(got.stderr).toBe('')
  })

  it('emits every value of an ascending range, ignoring stdin', async () => {
    const got = await run({ input_range: '1-3' })
    expect(got.exit).toBe(0)
    expect(got.stdout.split('\n').slice(0, 3).sort()).toEqual(['1', '2', '3'])
    expect(got.stderr).toBe('')
  })
})

// A trailing newline in a value is refused on both hosts, and the python
// twin was the one that accepted it: its `$` also matches immediately BEFORE
// a trailing newline, so `re.match(r'^\+?[0-9]+$', '2\n')` SUCCEEDED and read
// `shuf -n $'2\n'` as the valid count 2 (ground truth NL2-A). The value is
// rendered through gnulib `quote()`, so the newline is the two characters
// `\n` and not the byte (NL3-A).
describe('shuf refuses a trailing newline in a value', () => {
  it.each([
    ['2\n', '2\\n'],
    ['1\n2', '1\\n2'],
    ['0\n', '0\\n'],
    ['2\r', '2\\r'],
    ['2\x01', '2\\001'],
  ] as [string, string][])('-n %j', async (value, quoted) => {
    const got = await run({ head_count: value })
    expect(got.exit).toBe(1)
    expect(got.stdout).toBe('')
    expect(got.stderr).toBe(`shuf: invalid line count: '${quoted}'\n`)
  })

  it.each([
    ['1-3\n', '1-3\\n'],
    ['1-3\n5', '1-3\\n5'],
    ['2-2\n', '2-2\\n'],
  ] as [string, string][])('-i %j', async (value, quoted) => {
    const got = await run({ input_range: value })
    expect(got.exit).toBe(1)
    expect(got.stdout).toBe('')
    expect(got.stderr).toBe(`shuf: invalid input range: '${quoted}'\n`)
  })

  // The control: the anchoring must not refuse a clean value.
  it.each(['2', '+2', '0'])('still accepts -n %s', (value) => {
    expect(typeof parseFlags({ head_count: value })).not.toBe('string')
  })
})

// LEADING C whitespace is SKIPPED, because that is `strtoumax`'s own skip,
// while trailing whitespace is garbage. `\s` would be wrong for the same
// reason as in nl: it also matches every Unicode space, which GNU refuses.
// Ground truth NL3-C.
describe('shuf skips leading C whitespace on -n', () => {
  it.each([' 2', '\t2', '\n2', '\x0b2', '\f2', '\r2', '  2', ' +2'])('accepts %j', (value) => {
    expect(typeof parseFlags({ head_count: value })).not.toBe('string')
  })

  // `-n` is unsigned, so ' -2' is refused where nl's `-v` accepts it.
  it.each([
    ['2 ', '2 '],
    [' -2', ' -2'],
    ['+ 2', '+ 2'],
    ['\x1c2', '\\0342'],
  ] as [string, string][])('refuses %j', (value, quoted) => {
    expect(parseFlags({ head_count: value })).toBe(`shuf: invalid line count: '${quoted}'\n`)
  })
})

// `-i` splits at the FIRST dash and scans each bound on its own, so a `+` and
// a leading blank ride on either bound independently. Every row measured
// against GNU (ground truth NL3-D).
describe('shuf -i takes a prefix on either bound', () => {
  it.each([
    ['1-3', [1n, 3n]],
    ['+1-3', [1n, 3n]],
    ['1-+3', [1n, 3n]],
    ['+1-+3', [1n, 3n]],
    [' +1-3', [1n, 3n]],
    ['1- 3', [1n, 3n]],
    ['+0-0', [0n, 0n]],
    ['10-20', [10n, 20n]],
    ['2-2', [2n, 2n]],
    ['01-03', [1n, 3n]],
  ] as [string, [bigint, bigint]][])('accepts %j', (raw, bounds) => {
    expect(parseInputRange(raw)).toEqual(bounds)
  })

  // A `-` is never a sign, and shuf has one message for all of it.
  it.each([
    '-1-3',
    '1--3',
    '++1-3',
    '1-2-3',
    '1-3-',
    ' 1 - 3 ',
    '1 -3',
    '-',
    '1-',
    '-3',
    '3-1',
    '1-3\n',
    'abc',
    '1',
    '',
  ])('refuses %j', (raw) => {
    expect(parseInputRange(raw)).toBe('invalid')
  })
})

// shuf reads its flags once into a frozen struct through a module-level
// parseFlags on a spec-bound FlagView, the shape CLAUDE.md requires of every
// generic and the shape the python twin already had; the body reads struct
// fields rather than querying the bag inline.
describe('shuf parseFlags is the one flag read', () => {
  it('returns the struct for a line GNU accepts', () => {
    const parsed = parseFlags({
      head_count: '+2',
      echo: true,
      zero_terminated: true,
      repeat: true,
      input_range: '1-3',
      output: '/data/out.txt',
    })
    expect(parsed).toEqual({
      count: 2n,
      echo: true,
      zeroTerminated: true,
      withReplacement: true,
      inputRange: '1-3',
      output: '/data/out.txt',
    })
  })

  it('returns the stderr text for a line GNU refuses', () => {
    expect(parseFlags({ head_count: '-1' })).toBe("shuf: invalid line count: '-1'\n")
  })

  it('defaults every field when the line carried no flag', () => {
    expect(parseFlags({})).toEqual({
      count: null,
      echo: false,
      zeroTerminated: false,
      withReplacement: false,
      inputRange: null,
      output: null,
    })
  })
})

// `-i`'s bounds are `uintmax_t`, so UINTMAX_MAX is a legal bound and one past
// it earns gnulib's LONGINT_OVERFLOW clause. The SPAN has a second, different
// limit at SIZE_MAX and that one reads as the PLAIN message, the same one a
// decreasing range gets. Every row measured against GNU coreutils 9.4 (ground
// truth SH1, SH3, SH4).
describe('shuf -i reads a bound as an exact integer up to UINTMAX_MAX', () => {
  it.each([
    ['9007199254740992-9007199254740992', [2n ** 53n, 2n ** 53n]],
    ['9007199254740993-9007199254740993', [2n ** 53n + 1n, 2n ** 53n + 1n]],
    ['9223372036854775807-9223372036854775807', [2n ** 63n - 1n, 2n ** 63n - 1n]],
    ['9223372036854775808-9223372036854775808', [2n ** 63n, 2n ** 63n]],
    [`${String(UINTMAX_MAX)}-${String(UINTMAX_MAX)}`, [UINTMAX_MAX, UINTMAX_MAX]],
    [`${String(UINTMAX_MAX - 1n)}-${String(UINTMAX_MAX)}`, [UINTMAX_MAX - 1n, UINTMAX_MAX]],
    [`0-${String(UINTMAX_MAX - 1n)}`, [0n, UINTMAX_MAX - 1n]],
    [`1-${String(UINTMAX_MAX)}`, [1n, UINTMAX_MAX]],
  ] as [string, [bigint, bigint]][])('accepts -i %j', (raw, bounds) => {
    expect(parseInputRange(raw)).toEqual(bounds)
  })

  // A bound past UINTMAX_MAX is `overflow`, and the clause is EOVERFLOW's --
  // not ERANGE's `: Numerical result out of range`, which `nl -w` uses for a
  // value outside an option's OWN range. `shuf -i` has no range below the C
  // type's.
  it.each([
    '18446744073709551616-18446744073709551616',
    '1-18446744073709551616',
    '18446744073709551616-1',
    '18446744073709551616-x',
    '99999999999999999999-1',
    '+18446744073709551616-1',
    ' 18446744073709551616-1',
    '99999999999999999999999999-99999999999999999999999999',
  ])('refuses -i %j with the overflow clause', async (raw) => {
    expect(parseInputRange(raw)).toBe('overflow')
    const got = await run({ input_range: raw })
    expect(got.exit).toBe(1)
    expect(got.stdout).toBe('')
    expect(got.stderr).toBe(
      `shuf: invalid input range: '${raw}': Value too large for defined data type\n`,
    )
  })

  // A bad LOW bound decides, whatever the high one is: an overflowing low
  // bound outranks a non-numeric high one, and a non-numeric low bound
  // outranks an overflowing high one (SH4).
  it('scans the bounds left to right', () => {
    expect(parseInputRange('18446744073709551616-x')).toBe('overflow')
    expect(parseInputRange('x-18446744073709551616')).toBe('invalid')
  })

  // `hi - lo` must be strictly under SIZE_MAX, and that limit is `invalid`,
  // not `overflow`: exactly one argument trips it -- the one whose element
  // count is 2**64 -- and it carries no clause, so it reads identically to
  // `-i 3-1` (SH3).
  it('refuses a span at SIZE_MAX with the plain message', async () => {
    const raw = `0-${String(SIZE_MAX)}`
    expect(parseInputRange(raw)).toBe('invalid')
    expect(parseInputRange(`+0-${String(SIZE_MAX)}`)).toBe('invalid')
    expect(parseInputRange(`0-${String(SIZE_MAX - 1n)}`)).toEqual([0n, SIZE_MAX - 1n])
    const got = await run({ input_range: raw })
    expect(got.exit).toBe(1)
    expect(got.stderr).toBe(`shuf: invalid input range: '${raw}'\n`)
  })

  it('renders the clause only when it is earned', () => {
    expect(rangeError('3-1', 'invalid')).toBe("shuf: invalid input range: '3-1'\n")
    expect(rangeError('1-3\n', 'invalid')).toBe("shuf: invalid input range: '1-3\\n'\n")
    expect(rangeError('18446744073709551616-1', 'overflow')).toBe(
      "shuf: invalid input range: '18446744073709551616-1': Value too large for defined data type\n",
    )
  })
})

// The reviewed bug, and the one shape that proves the bounds are exact rather
// than merely wide: read as float64, `9007199254740992` (2**53) incremented to
// itself so this loop never terminated, and `9007199254740993` parsed to 2**53
// and printed the WRONG integer with exit 0 (ground truth SH2). Both are
// one-element ranges, so the assertion is on the byte, and neither can hang
// the suite even if the fix regresses in some other direction.
describe('shuf -i emits a large bound exactly', () => {
  it.each([2n ** 53n, 2n ** 53n + 1n, 2n ** 63n - 1n, 2n ** 63n, UINTMAX_MAX])(
    'prints %s for its own one-element range',
    async (low) => {
      const got = await run({ input_range: `${String(low)}-${String(low)}` })
      expect(got.exit).toBe(0)
      expect(got.stdout).toBe(`${String(low)}\n`)
      expect(got.stderr).toBe('')
    },
  )
})

// GNU never builds the population when `-n` is below the element count, which
// is why `shuf -i 1-18446744073709551615 -n 3` answers instantly (ground truth
// SH5). Each case names a range far too large to enumerate, so an
// implementation that enumerates fails by timing out rather than by assertion
// -- which is exactly the failure the reviewer reported.
describe('shuf -i samples a huge range without enumerating it', () => {
  it.each([`1-${String(UINTMAX_MAX)}`, '1-1000000000000', '1-100000000'])(
    'draws three distinct values from -i %s',
    async (raw) => {
      const got = await run({ input_range: raw, head_count: '3' })
      expect(got.exit).toBe(0)
      const lines = got.stdout.split('\n').slice(0, -1)
      expect(lines).toHaveLength(3)
      expect(new Set(lines).size).toBe(3)
      const bounds = parseInputRange(raw)
      if (typeof bounds === 'string') throw new Error(`refused a valid range: ${bounds}`)
      for (const line of lines) {
        expect(BigInt(line) >= bounds[0] && BigInt(line) <= bounds[1]).toBe(true)
      }
    },
  )

  it('emits nothing for -n 0 however large the range is', async () => {
    const got = await run({ input_range: `1-${String(UINTMAX_MAX)}`, head_count: '0' })
    expect(got.exit).toBe(0)
    expect(got.stdout).toBe('')
    expect(got.stderr).toBe('')
  })

  it('draws with replacement from a huge range too', async () => {
    const got = await run({
      input_range: `1-${String(UINTMAX_MAX)}`,
      head_count: '4',
      repeat: true,
    })
    expect(got.exit).toBe(0)
    expect(got.stdout.split('\n').slice(0, -1)).toHaveLength(4)
  })
})

// A range GNU would enumerate given enough memory, answered with GNU's own
// `xalloc_die` line for exactly that situation (ground truth SH5). mirage
// renders one byte object rather than streaming, so the ceiling is stated
// rather than left to whatever the host survives.
describe('shuf refuses an output it cannot render', () => {
  it.each([
    [{ input_range: `1-${String(UINTMAX_MAX)}` }],
    [{ input_range: '1-1000000000000' }],
    [{ input_range: `1-${String(MAX_OUTPUT_LINES + 1n)}` }],
    [{ input_range: `1-${String(UINTMAX_MAX)}`, repeat: true }],
    [{ input_range: '1-3', head_count: String(MAX_OUTPUT_LINES + 1n), repeat: true }],
  ] as [Record<string, FlagValue>][])('answers memory exhausted for %j', async (flags) => {
    const got = await run(flags)
    expect(got.exit).toBe(1)
    expect(got.stdout).toBe('')
    expect(got.stderr).toBe('shuf: memory exhausted\n')
  })

  it('is the same ceiling reached through -r -n on stdin', async () => {
    const refused = await run({ head_count: String(MAX_OUTPUT_LINES + 1n), repeat: true }, 'a\n')
    expect(refused.exit).toBe(1)
    expect(refused.stderr).toBe('shuf: memory exhausted\n')
    // Without `-r` the same count is just a head count over two lines.
    const kept = await run({ head_count: String(MAX_OUTPUT_LINES + 1n) }, 'a\nb\n')
    expect(kept.exit).toBe(0)
    expect(kept.stdout.split('\n').slice(0, -1).sort()).toEqual(['a', 'b'])
  })

  it('names the wording once, so the two hosts cannot drift', () => {
    expect(MEMORY_EXHAUSTED).toBe('shuf: memory exhausted')
  })
})

// `-n` past UINTMAX_MAX is CLAMPED to SIZE_MAX, never refused, which is the
// opposite of what the same overflow does to `-i`. The clamp is stated rather
// than left to the host's numbers: `Number.parseInt` answers `Infinity` for a
// 400-digit count, which `BigInt` then refuses outright, where python reads
// the bignum. Measured, ground truth SH6.
describe('shuf -n clamps an overflowing count', () => {
  it.each([
    String(UINTMAX_MAX),
    '18446744073709551616',
    '+18446744073709551616',
    '99999999999999999999999999',
    '9'.repeat(400),
  ])('clamps -n %j to SIZE_MAX', (raw) => {
    const parsed = parseFlags({ head_count: raw })
    if (typeof parsed === 'string') throw new Error(`refused a count GNU accepts: ${parsed}`)
    expect(parsed.count).toBe(SIZE_MAX)
  })

  it.each([
    ['2', 2n],
    [' +2', 2n],
    ['0', 0n],
    [String(SIZE_MAX - 1n), SIZE_MAX - 1n],
  ] as [string, bigint][])('keeps -n %j below the clamp', (raw, expected) => {
    const parsed = parseFlags({ head_count: raw })
    if (typeof parsed === 'string') throw new Error(`refused a count GNU accepts: ${parsed}`)
    expect(parsed.count).toBe(expected)
  })
})

// `emitCount` is what lets the range path sample rather than enumerate, so it
// is pinned on its own: `-r` emits exactly the count it was asked for however
// few values it draws from, while a head count cannot exceed what is there.
// `emit_count` in shuf.py is the twin and carries the same table.
describe('shuf decides the emitted count before anything is built', () => {
  it.each([
    [3n, null, false, 3n],
    [3n, 5n, false, 3n],
    [3n, 2n, false, 2n],
    [3n, 0n, false, 0n],
    [3n, null, true, 3n],
    [3n, 5n, true, 5n],
    [1n, 7n, true, 7n],
    [0n, 5n, true, 0n],
    [0n, null, true, 0n],
    [0n, 5n, false, 0n],
    [UINTMAX_MAX, 3n, false, 3n],
    [UINTMAX_MAX, null, false, UINTMAX_MAX],
  ] as [bigint, bigint | null, boolean, bigint][])(
    'emitCount(%s, %s, %s) is %s',
    (available, count, repeat, expected) => {
      expect(emitCount(available, count, repeat)).toBe(expected)
    },
  )
})
