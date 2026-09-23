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
import { specOf } from '../../spec/builtins.ts'
import { parseCommand, parseToKwargs } from '../../spec/parser.ts'
import { expandGeneric, nextTabStop, parseTabStops, type TabStops } from './expand.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

function stubStream(): AsyncIterable<Uint8Array> {
  throw new Error('expand read an operand although its tab size was refused')
}

async function* stdinOf(text: string): AsyncIterable<Uint8Array> {
  await Promise.resolve()
  yield ENC.encode(text)
}

async function run(
  line: Line,
  stdin: AsyncIterable<Uint8Array> | null = null,
): Promise<{ exit: number; stdout: string; stderr: string }> {
  const opts = {
    stdin,
    ...line,
    filetypeFns: null,
    cwd: '/',
    vfs: { kind: 'ram' } as never,
  } as CommandOpts
  // `CommandFnResult` is nullable — null is how a handler says it does not
  // apply — and expand never answers that way, so say so rather than
  // destructure a union.
  const result = await expandGeneric([], opts, stubStream)
  if (result === null) throw new Error('expand declined to handle its own operands')
  const [out, io] = result
  return {
    exit: io.exitCode,
    stdout: out === null ? '' : DEC.decode(await materialize(out)),
    stderr: io.stderr instanceof Uint8Array ? DEC.decode(io.stderr) : '',
  }
}

describe('expand --tabs refuses a value it cannot read whole', () => {
  // GNU coreutils 9.4: exit 1, a single stderr line and no `Try --help`
  // line, and the quote starts at the first character the scan could not
  // read — '8x' reports 'x' because the 8 parsed, '-4' reports the whole
  // argument because `-` is not a sign to expand and stops it at position 0.
  it.each([
    ['abc', "expand: tab size contains invalid character(s): 'abc'\n"],
    ['8x', "expand: tab size contains invalid character(s): 'x'\n"],
    ['-4', "expand: tab size contains invalid character(s): '-4'\n"],
    ['+x', "expand: tab size contains invalid character(s): 'x'\n"],
  ])('refuses --tabs=%s before reading anything', async (value, message) => {
    const got = await run({ flags: { tabs: value } }, stdinOf('a\tb\n'))
    expect(got.exit).toBe(1)
    expect(got.stdout).toBe('')
    expect(got.stderr).toBe(message)
  })

  it('still expands a valid tab size', async () => {
    const got = await run({ flags: { tabs: '4' } }, stdinOf('a\tb\n'))
    expect(got.exit).toBe(0)
    expect(got.stdout).toBe('a   b\n')
    expect(got.stderr).toBe('')
  })

  // GNU accepts a leading `+` on every integer flag value and reads `+4`
  // as 4, so `--tabs=+4` is byte-identical to `--tabs=4`.
  it('accepts a leading plus as a sign', async () => {
    const got = await run({ flags: { tabs: '+4' } }, stdinOf('a\tb\n'))
    expect(got.exit).toBe(0)
    expect(got.stdout).toBe('a   b\n')
    expect(got.stderr).toBe('')
  })

  // `--tabs=''` is an empty tab-stop LIST, i.e. zero tab stops, which
  // leaves expand on its default 8 rather than being an error. expand is
  // the one flag in this family whose empty value succeeds.
  it('reads an empty tab list as the default size 8', async () => {
    const got = await run({ flags: { tabs: '' } }, stdinOf('a\tb\n'))
    expect(got.exit).toBe(0)
    expect(got.stdout).toBe('a       b\n')
    expect(got.stderr).toBe('')
  })
})

// expand's flag bag as the real parser fills it from one command line. `-t`
// ACCUMULATES across occurrences, so a hand-written record cannot express
// `-t 2,4 -t 6` at all; these cases go through the spec parser so the bag
// carries whatever occurrence record the parser actually preserves.
type Line = Pick<CommandOpts, 'flags'>

function expandBag(...argv: string[]): Line {
  return { flags: parseToKwargs(parseCommand(specOf('expand'), argv, '/')) }
}

function stops(list: string): TabStops {
  const parsed = parseTabStops([list])
  if (typeof parsed === 'string') throw new Error(`refused: ${parsed}`)
  return parsed
}

// GNU `expand -t` takes a LIST of tab stops, not one size. The tightened
// validation this fixes rejected every list as
// `tab size contains invalid character(s): ','`, which GNU accepts. Every
// expectation below is the od-verified stdout of the same line run against
// GNU coreutils 9.4 (ground truth NL2-D and NL2-E), and a differential
// harness ran 2464 more combinations of these lists against the real binary
// with no mismatch beyond one known diagnostic-quoting gap.
const ABCDE = 'a\tb\tc\td\te\n'

describe('expand renders a tab stop list as GNU does', () => {
  it.each([
    // ONE stop repeats as a tab SIZE -- the rule that makes `-t 3` mean
    // 3, 6, 9 rather than one stop at 3 and single blanks after it.
    ['3', 'a  b  c  d  e\n'],
    ['4', 'a   b   c   d   e\n'],
    // SEVERAL stops are absolute columns, and past the last one a TAB is
    // exactly one blank, forever.
    ['1,3', 'a  b c d e\n'],
    ['2,5', 'a b  c d e\n'],
    ['10,20', 'a         b         c d e\n'],
    ['2,3', 'a b c d e\n'],
    ['1,2,3,4,5,6,7,8,9,10', 'a b c d e\n'],
    // An empty element is skipped in silence, wherever it sits.
    ['1,,3', 'a  b c d e\n'],
    ['1,3,', 'a  b c d e\n'],
    [',1,3', 'a  b c d e\n'],
    // `,` and isblank (space, TAB) all separate, and only those.
    ['2 4 6', 'a b c d e\n'],
    ['2\t4\t6', 'a b c d e\n'],
    [' 2 , 4 , 6 ', 'a b c d e\n'],
    // `/N` is the multiples of N; `+N` steps N from the last stop.
    ['/4', 'a   b   c   d   e\n'],
    ['+4', 'a   b   c   d   e\n'],
    ['2,/4', 'a b c   d   e\n'],
    ['2,+4', 'a b   c   d   e\n'],
    // A zero after either specifier leaves it unset rather than erroring.
    ['+0', 'a       b       c       d       e\n'],
    ['/0', 'a       b       c       d       e\n'],
    ['+0,1', 'a b c d e\n'],
    ['2,+0', 'a b c d e\n'],
  ])('-t %s', async (list, rendered) => {
    const got = await run({ flags: { tabs: list } }, stdinOf(ABCDE))
    expect(got.exit).toBe(0)
    expect(got.stderr).toBe('')
    expect(got.stdout).toBe(rendered)
  })

  // A TAB sitting exactly ON a stop takes the NEXT one, and `/N` rounds up
  // the same way -- column 4 under `/4` pads to 8 rather than staying put.
  it.each([
    ['ab\tc\n', '2,5', 'ab   c\n'],
    ['abcde\tf\n', '2,5', 'abcde f\n'],
    ['xxxxxxxxx\tY\n', '5,9', 'xxxxxxxxx Y\n'],
    ['abcd\tX\n', '/4', 'abcd    X\n'],
    ['abc\tX\n', '/4', 'abc X\n'],
  ])('takes the first stop strictly past the column (%s, -t %s)', async (input, list, out) => {
    const got = await run({ flags: { tabs: list } }, stdinOf(input))
    expect(got.exit).toBe(0)
    expect(got.stdout).toBe(out)
  })

  // The same column, the same first stop, opposite answers.
  it.each([
    ['5,9', 'xxxxxxxxxx Y\n'],
    ['5', 'xxxxxxxxxx     Y\n'],
  ])('one stop repeats where several give one blank (-t %s)', async (list, out) => {
    const got = await run({ flags: { tabs: list } }, stdinOf('xxxxxxxxxx\tY\n'))
    expect(got.exit).toBe(0)
    expect(got.stdout).toBe(out)
  })
})

// `-t` ACCUMULATES across occurrences: the stop list and the two specifier
// sizes outlive one occurrence while the per-scan state does not, which is
// what makes `-t '+4,2'` refuse and `-t +4 -t 2` not.
describe('expand accumulates tab stops across -t occurrences', () => {
  it.each([
    [['-t', '2,4', '-t', '6'], 'a b c d e\n'],
    [['-t', '2,4,6'], 'a b c d e\n'],
    [['--tabs=2,4', '--tabs=6'], 'a b c d e\n'],
    [['-t', '+4', '-t', '2'], 'a b   c   d   e\n'],
    [['-t', '2', '-t', '+4'], 'a b   c   d   e\n'],
    [['-t', '2', '-t', '/4'], 'a b c   d   e\n'],
    [['-t', '4', '-t', ''], 'a   b   c   d   e\n'],
    [['-t', '', '-t', '4'], 'a   b   c   d   e\n'],
  ])('%s', async (argv, rendered) => {
    const got = await run(expandBag(...argv), stdinOf(ABCDE))
    expect(got.exit).toBe(0)
    expect(got.stderr).toBe('')
    expect(got.stdout).toBe(rendered)
  })

  it.each([
    [['6', '2,4'], 'expand: tab sizes must be ascending\n'],
    [['2,4', '1'], 'expand: tab sizes must be ascending\n'],
    [['4', '4'], 'expand: tab sizes must be ascending\n'],
    [['0', '4'], 'expand: tab size cannot be 0\n'],
    [['4', '0'], 'expand: tab size cannot be 0\n'],
    [['4', 'x'], "expand: tab size contains invalid character(s): 'x'\n"],
    [['+4', '+5'], "expand: '+' specifier only allowed with the last value\n"],
    [['/4', '/5'], "expand: '/' specifier only allowed with the last value\n"],
  ])('refuses %s across occurrences', (occurrences, message) => {
    expect(parseTabStops(occurrences)).toBe(message)
  })
})

// GNU's five tab-stop refusals. `tab size cannot be 0` and
// `tab sizes must be ascending` are both NEW here: `--tabs=0` was accepted
// by both hosts and then silently meant "no tab stops at all".
const EXPAND_REFUSALS: readonly (readonly [string, string])[] = [
  ['0', 'expand: tab size cannot be 0\n'],
  ['00', 'expand: tab size cannot be 0\n'],
  ['0,0', 'expand: tab size cannot be 0\n'],
  ['0,3', 'expand: tab size cannot be 0\n'],
  ['3,0', 'expand: tab size cannot be 0\n'],
  ['1,0', 'expand: tab size cannot be 0\n'],
  ['1,2,0', 'expand: tab size cannot be 0\n'],
  ['1,0,0', 'expand: tab size cannot be 0\n'],
  ['0,+4', 'expand: tab size cannot be 0\n'],
  ['3,1', 'expand: tab sizes must be ascending\n'],
  ['3,3', 'expand: tab sizes must be ascending\n'],
  ['2,2', 'expand: tab sizes must be ascending\n'],
  ['1,1', 'expand: tab sizes must be ascending\n'],
  ['1,3,2', 'expand: tab sizes must be ascending\n'],
  // A list that breaks BOTH rules: the walk tests each element for zero
  // before it tests it for ascending, so element 1 speaks in `3,1,0` and
  // element 0 speaks in `3,0`.
  ['3,1,0', 'expand: tab sizes must be ascending\n'],
  ['1,x', "expand: tab size contains invalid character(s): 'x'\n"],
  ['1,3x', "expand: tab size contains invalid character(s): 'x'\n"],
  ['1,-3', "expand: tab size contains invalid character(s): '-3'\n"],
  ['1;3', "expand: tab size contains invalid character(s): ';3'\n"],
  ['x,1', "expand: tab size contains invalid character(s): 'x,1'\n"],
  ['x,3,1', "expand: tab size contains invalid character(s): 'x,3,1'\n"],
  // A scan failure BREAKS the parse, so the zero and ascending walks never
  // run: `0,x` names the x although the zero came first.
  ['0,x', "expand: tab size contains invalid character(s): 'x'\n"],
  ['3,1,x', "expand: tab size contains invalid character(s): 'x'\n"],
  ['99999999999999999999', "expand: tab stop is too large '99999999999999999999'\n"],
  ['1,99999999999999999999', "expand: tab stop is too large '99999999999999999999'\n"],
  ['18446744073709551616', "expand: tab stop is too large '18446744073709551616'\n"],
  // An overflowing digit run does NOT break the parse, so a later invalid
  // character speaks too -- but it does suppress the walks.
  [
    '99999999999999999999,x',
    "expand: tab stop is too large '99999999999999999999'\n" +
      "expand: tab size contains invalid character(s): 'x'\n",
  ],
  ['1,99999999999999999999,0', "expand: tab stop is too large '99999999999999999999'\n"],
  ['+4,2', "expand: '+' specifier only allowed with the last value\n"],
  ['+4,0', "expand: '+' specifier only allowed with the last value\n"],
  ['+1,2', "expand: '+' specifier only allowed with the last value\n"],
  ['/4,2', "expand: '/' specifier only allowed with the last value\n"],
  ['/1,2', "expand: '/' specifier only allowed with the last value\n"],
  ['4+', "expand: '+' specifier not at start of number: '+'\n"],
  ['+4+5', "expand: '+' specifier not at start of number: '+5'\n"],
  ['/4+5', "expand: '+' specifier not at start of number: '+5'\n"],
  ['4/', "expand: '/' specifier not at start of number: '/'\n"],
  ['+4/5', "expand: '/' specifier not at start of number: '/5'\n"],
]

describe('expand refuses a tab list GNU refuses', () => {
  it.each(EXPAND_REFUSALS)('-t %s', (list, message) => {
    expect(parseTabStops([list])).toBe(message)
  })

  // Exit 1, empty stdout, and one line per problem with no hint. The stub
  // stream throws, so a refusal that opened an operand would fail here.
  it.each(EXPAND_REFUSALS)('-t %s is fatal before any operand', async (list, message) => {
    const got = await run({ flags: { tabs: list } }, stdinOf('a\tb\n'))
    expect(got.exit).toBe(1)
    expect(got.stdout).toBe('')
    expect(got.stderr).toBe(message)
  })

  // No stop and neither specifier: GNU stays on 8.
  it.each(['', ',', ',,', ' ', '+', '/'])('reads -t %s as the default', (list) => {
    expect(stops(list)).toEqual({ stops: [], extend: 0, increment: 0 })
  })

  // A newline is not `isblank` in C (that is space and TAB and nothing
  // else), so it is an invalid character rather than a separator. Python's
  // `$` also matched immediately BEFORE a trailing newline, so it accepted
  // `-t $'8\n'` where this host always refused it (ground truth NL2-A). The
  // quoted remainder is rendered through gnulib `quote()`, so each of these
  // is the escape's two characters and never the byte (NL3-A).
  it.each([
    ['8\n', '\\n'],
    ['8\n4', '\\n4'],
    ['8\r', '\\r'],
    ['8\v', '\\v'],
    ['8\f', '\\f'],
    ['8\x07', '\\a'],
    ['8\x01', '\\001'],
  ])('refuses -t %j, a non-blank separator', (list, quoted) => {
    expect(parseTabStops([list])).toBe(
      `expand: tab size contains invalid character(s): '${quoted}'\n`,
    )
  })

  // GNU scans with `c_isdigit`; a unicode-aware test accepts U+0663. And the
  // refusal names its BYTES: U+0663 is two of them, so it reads as two octal
  // escapes rather than as the character (NL3-A).
  it.each(['\u0663', '8\u0663'])('refuses -t %j, a non-ASCII digit', (list) => {
    expect(parseTabStops([list])).toBe(
      "expand: tab size contains invalid character(s): '\\331\\243'\n",
    )
  })
})

// `+4` is not a sign: it is gnulib's INCREMENT specifier, and `/4` is its
// EXTEND one. A bare `+4` and a bare `4` coincide (an increment of 4 from
// column 0 is the same sequence as a repeating size of 4), which is why an
// earlier round read `+` as a sign, but they are different parses.
describe('expand parses the / and + specifiers', () => {
  it.each([
    ['4', { stops: [4], extend: 0, increment: 0 }],
    ['+4', { stops: [], extend: 0, increment: 4 }],
    ['/4', { stops: [], extend: 4, increment: 0 }],
    ['2,+4', { stops: [2], extend: 0, increment: 4 }],
    ['2,/4', { stops: [2], extend: 4, increment: 0 }],
    // `/` wins when both were seen, matching GNU's `if (extend) ... else`.
    ['/+4', { stops: [], extend: 4, increment: 0 }],
    ['+/4', { stops: [], extend: 4, increment: 0 }],
  ])('-t %s', (list, expected) => {
    expect(stops(list)).toEqual(expected)
  })
})

describe('expand next tab stop is always strictly greater', () => {
  it.each([
    [{ stops: [], extend: 0, increment: 0 }, 0, 8],
    [{ stops: [], extend: 0, increment: 0 }, 3, 8],
    [{ stops: [], extend: 0, increment: 0 }, 8, 16],
    [{ stops: [3], extend: 0, increment: 0 }, 0, 3],
    [{ stops: [3], extend: 0, increment: 0 }, 3, 6],
    [{ stops: [5, 9], extend: 0, increment: 0 }, 0, 5],
    [{ stops: [5, 9], extend: 0, increment: 0 }, 5, 9],
    [{ stops: [5, 9], extend: 0, increment: 0 }, 9, 10],
    [{ stops: [5, 9], extend: 0, increment: 0 }, 20, 21],
    [{ stops: [], extend: 4, increment: 0 }, 0, 4],
    [{ stops: [], extend: 4, increment: 0 }, 4, 8],
    [{ stops: [], extend: 0, increment: 4 }, 0, 4],
    [{ stops: [], extend: 0, increment: 4 }, 5, 8],
    [{ stops: [2], extend: 4, increment: 0 }, 3, 4],
    [{ stops: [2], extend: 4, increment: 0 }, 5, 8],
    [{ stops: [2], extend: 0, increment: 4 }, 3, 6],
    [{ stops: [2], extend: 0, increment: 4 }, 7, 10],
  ])('%j at column %i', (tabs, column, expected) => {
    expect(nextTabStop(tabs, column)).toBe(expected)
  })
})

// Only a NEWLINE resets the column. Python's `str.expandtabs` treats a
// carriage return as a line break, so it padded `a\r\tb` by eight where GNU
// and this host pad by six (ground truth NL2-G).
describe('expand resets the column on a newline alone', () => {
  it.each([
    [{}, 'a\r\tb\n', 'a\r      b\n'],
    [{ tabs: '4' }, 'a\r\tb\n', 'a\r  b\n'],
    [{ tabs: '1,3' }, 'a\r\tb\n', 'a\r b\n'],
    [{}, 'ab\r\tX\n', 'ab\r     X\n'],
    [{}, 'a\vb\tX\n', 'a\vb     X\n'],
    [{}, 'a\fb\tX\n', 'a\fb     X\n'],
    [{ tabs: '4' }, 'a\r\n\tb\n', 'a\r\n    b\n'],
  ])('%j on %j', async (flags, input, rendered) => {
    const got = await run({ flags }, stdinOf(input))
    expect(got.exit).toBe(0)
    expect(got.stdout).toBe(rendered)
  })
})

// `-i` changes WHERE the stops apply, never what they are.
describe('expand -i reads the same tab list', () => {
  it.each([
    [{ initial: true, tabs: '1,3' }, '\ta\tb\n', ' a\tb\n'],
    [{ initial: true, tabs: '4' }, '\ta\tb\n', '    a\tb\n'],
    [{ initial: true, tabs: '3' }, '  \tx\n', '   x\n'],
  ])('%j', async (flags, input, rendered) => {
    const got = await run({ flags }, stdinOf(input))
    expect(got.exit).toBe(0)
    expect(got.stdout).toBe(rendered)
  })

  it('refuses the same tab list under -i', async () => {
    const got = await run({ flags: { initial: true, tabs: '0' } }, stdinOf('\ta\n'))
    expect(got.exit).toBe(1)
    expect(got.stderr).toBe('expand: tab size cannot be 0\n')
  })
})

// BACKSPACE decrements the column, floored at 0, where a carriage return
// advances it like any other byte. Both hosts had `\b` advancing, so every one
// of these padded one column too far. It composes with the tab-stop list
// rather than being a special case, which the `-t 1,3` and `-t 2,5` rows are
// here to show. All od-verified, ground truth NL3-E.
describe('expand backspace decrements the column', () => {
  it.each([
    ['a\bb\tX\n', {}, 'a\bb       X\n'],
    ['a\bb\tX\n', { tabs: '4' }, 'a\bb   X\n'],
    ['\b\tX\n', {}, '\b        X\n'],
    ['\b\b\b\tX\n', {}, '\b\b\b        X\n'],
    ['ab\b\tX\n', {}, 'ab\b       X\n'],
    ['abc\b\b\tX\n', {}, 'abc\b\b       X\n'],
    ['a\b\b\b\bb\tX\n', {}, 'a\b\b\b\bb       X\n'],
    ['\ba\tX\n', { tabs: '4' }, '\ba   X\n'],
    ['a\bb\tX\n', { tabs: '1,3' }, 'a\bb  X\n'],
    ['\b\b\tX\n', { tabs: '2,5' }, '\b\b  X\n'],
  ] as [string, Record<string, FlagValue>, string][])(
    '%j with %j',
    async (input, flags, rendered) => {
      const got = await run({ flags }, stdinOf(input))
      expect(got.exit).toBe(0)
      expect(got.stdout).toBe(rendered)
    },
  )

  // `-i` needs no backspace handling: `\b` is not `isblank`, so the leading
  // run stops at it and the TAB after is copied verbatim (NL3-E).
  it('ends the leading run under -i', async () => {
    const got = await run({ flags: { initial: true, tabs: '4' } }, stdinOf('  \b \tx\n'))
    expect(got.exit).toBe(0)
    expect(got.stdout).toBe('  \b \tx\n')
  })
})

// A misplaced `/` or `+` is REPORTED AND THEN THE SCAN CONTINUES, where an
// invalid character breaks it. Round 8 returned on both, so `-t 4+5+6` printed
// one line where GNU prints two and `-t 4+x` printed one where GNU prints the
// misplaced line and then the invalid-character one.
describe('a misplaced specifier does not end the scan', () => {
  it.each([
    ['4+', "expand: '+' specifier not at start of number: '+'\n"],
    ['4+5', "expand: '+' specifier not at start of number: '+5'\n"],
    [
      '4+x',
      "expand: '+' specifier not at start of number: '+x'\n" +
        "expand: tab size contains invalid character(s): 'x'\n",
    ],
    [
      '4/x',
      "expand: '/' specifier not at start of number: '/x'\n" +
        "expand: tab size contains invalid character(s): 'x'\n",
    ],
    [
      '4+,x',
      "expand: '+' specifier not at start of number: '+,x'\n" +
        "expand: tab size contains invalid character(s): 'x'\n",
    ],
    [
      '4+5+6',
      "expand: '+' specifier not at start of number: '+5+6'\n" +
        "expand: '+' specifier not at start of number: '+6'\n",
    ],
    [
      '1,2+x',
      "expand: '+' specifier not at start of number: '+x'\n" +
        "expand: tab size contains invalid character(s): 'x'\n",
    ],
    ['+4+5', "expand: '+' specifier not at start of number: '+5'\n"],
    ['+4/5', "expand: '/' specifier not at start of number: '/5'\n"],
  ])('-t %j', (list, message) => {
    expect(parseTabStops([list])).toBe(message)
  })

  // The other direction: one line, and nothing to its right is read.
  it.each([
    ['x+', "expand: tab size contains invalid character(s): 'x+'\n"],
    ['x/', "expand: tab size contains invalid character(s): 'x/'\n"],
    ['x,3,1', "expand: tab size contains invalid character(s): 'x,3,1'\n"],
    ['1,x,0', "expand: tab size contains invalid character(s): 'x,0'\n"],
    ['1;3;5', "expand: tab size contains invalid character(s): ';3;5'\n"],
    ['x0', "expand: tab size contains invalid character(s): 'x0'\n"],
  ])('-t %j ends it', (list, message) => {
    expect(parseTabStops([list])).toBe(message)
  })
})
