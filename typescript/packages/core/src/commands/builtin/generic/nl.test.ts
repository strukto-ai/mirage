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
import { specOf } from '../../spec/builtins.ts'
import { parseCommand, parseToKwargs } from '../../spec/parser.ts'
import type { CommandOpts } from '../../config.ts'
import { nlGeneric, parseFlags } from './nl.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

function stubStream(): AsyncIterable<Uint8Array> {
  throw new Error('nl read an operand although a numeric option was refused')
}

async function* stdinOf(text: string): AsyncIterable<Uint8Array> {
  await Promise.resolve()
  yield ENC.encode(text)
}

async function run(line: Line): Promise<{ exit: number; stdout: string; stderr: string }> {
  const opts = {
    stdin: stdinOf('x\n'),
    ...line,
    filetypeFns: null,
    cwd: '/',
    vfs: { kind: 'ram' } as never,
  } as CommandOpts
  // `CommandFnResult` is nullable — null is how a handler says it does not
  // apply — and nl never answers that way, so say so rather than destructure
  // a union.
  const result = await nlGeneric([], opts, stubStream)
  if (result === null) throw new Error('nl declined to handle its own operands')
  const [out, io] = result
  return {
    exit: io.exitCode,
    stdout: out === null ? '' : DEC.decode(await materialize(out)),
    stderr: io.stderr instanceof Uint8Array ? DEC.decode(io.stderr) : '',
  }
}

// nl's flag bag as the real parser fills it from one command line. The
// precedence rule is about the order the options were TYPED, so a
// hand-written record would be assuming the very thing under test; these
// cases go through the spec parser so the bag carries whatever order the
// parser actually preserves.
type Line = Pick<CommandOpts, 'flags'>

function parseLine(line: Line): ReturnType<typeof parseFlags> {
  return parseFlags(line.flags)
}

function nlBag(...argv: string[]): Line {
  return { flags: parseToKwargs(parseCommand(specOf('nl'), argv, '/')) }
}

describe('nl refuses a numeric option it cannot read whole', () => {
  // GNU coreutils 9.4: exit 1, a single stderr line, no `Try --help` line,
  // and — unlike expand and cut — the WHOLE argument quoted, so `-w 2x`
  // reports '2x' rather than 'x'. Each of the four options has its own
  // wording.
  it.each([
    ['starting_line_number', 'abc', "nl: invalid starting line number: 'abc'\n"],
    ['starting_line_number', '2x', "nl: invalid starting line number: '2x'\n"],
    ['line_increment', 'abc', "nl: invalid line number increment: 'abc'\n"],
    ['number_width', 'abc', "nl: invalid line number field width: 'abc'\n"],
    ['number_width', '2x', "nl: invalid line number field width: '2x'\n"],
    ['join_blank_lines', 'abc', "nl: invalid line number of blank lines: 'abc'\n"],
  ])('refuses %s=%s before numbering anything', async (dest, value, message) => {
    const got = await run({ flags: { [dest]: value } })
    expect(got.exit).toBe(1)
    expect(got.stdout).toBe('')
    expect(got.stderr).toBe(message)
  })

  // GNU `printf 'x\n' | nl -v 5` prints 5 spaces, '5', a TAB and 'x'.
  it('still numbers with a valid starting line number', async () => {
    const got = await run({ flags: { starting_line_number: '5' } })
    expect(got.exit).toBe(0)
    expect(got.stdout).toBe('     5\tx\n')
    expect(got.stderr).toBe('')
  })

  // A leading `+` is a sign on every one of the four, and reads as the
  // unsigned value would.
  it.each([
    ['starting_line_number', '+5', '     5\tx\n'],
    ['number_width', '+3', '  1\tx\n'],
    ['line_increment', '+2', '     1\tx\n'],
    ['join_blank_lines', '+2', '     1\tx\n'],
  ])('accepts %s=%s as a sign', async (dest, value, stdout) => {
    const got = await run({ flags: { [dest]: value } })
    expect(got.exit).toBe(0)
    expect(got.stdout).toBe(stdout)
    expect(got.stderr).toBe('')
  })
})

// nl's four numeric options split two ways, and the split is observable in
// both the exit status and the shape of the message.
describe('nl -v and -i are signed', () => {
  // GNU numbers from a negative start and counts UP, and `-i -2` genuinely
  // decrements, so neither a negative nor a zero is an error.
  it('numbers from a negative start', async () => {
    const got = await run({ flags: { starting_line_number: '-5' } })
    expect(got.exit).toBe(0)
    expect(got.stdout).toBe('    -5\tx\n')
    expect(got.stderr).toBe('')
  })

  it('accepts a zero increment', async () => {
    const got = await run({ flags: { line_increment: '0' } })
    expect(got.exit).toBe(0)
    expect(got.stdout).toBe('     1\tx\n')
    expect(got.stderr).toBe('')
  })
})

describe('nl -w and -l require at least 1', () => {
  // A value that PARSED but fell out of range carries a THIRD colon-clause,
  // gnulib's strerror(ERANGE). Still exit 1 and still no `Try --help` line.
  it.each([
    [
      'number_width',
      '-3',
      "nl: invalid line number field width: '-3': Numerical result out of range\n",
    ],
    [
      'number_width',
      '0',
      "nl: invalid line number field width: '0': Numerical result out of range\n",
    ],
    [
      'join_blank_lines',
      '-2',
      "nl: invalid line number of blank lines: '-2': Numerical result out of range\n",
    ],
    [
      'join_blank_lines',
      '0',
      "nl: invalid line number of blank lines: '0': Numerical result out of range\n",
    ],
  ])('refuses %s=%s as out of range', async (dest, value, message) => {
    const got = await run({ flags: { [dest]: value } })
    expect(got.exit).toBe(1)
    expect(got.stdout).toBe('')
    expect(got.stderr).toBe(message)
  })

  // The clause attaches to a RANGE failure, never to a scan failure, so
  // within one option the message shape depends on why the value failed.
  // It must not be appended unconditionally.
  it.each([
    ['number_width', "nl: invalid line number field width: ''\n"],
    ['join_blank_lines', "nl: invalid line number of blank lines: ''\n"],
  ])('refuses an empty %s without the range clause', async (dest, message) => {
    const got = await run({ flags: { [dest]: '' } })
    expect(got.exit).toBe(1)
    expect(got.stdout).toBe('')
    expect(got.stderr).toBe(message)
  })
})

// GNU validates each numeric option's value the moment getopt hands it over
// and exits on that first failure, so the LEFTMOST bad option on the line
// speaks and every pair reverses when the flags are swapped. Measured on GNU
// coreutils 9.4 (ground truth section N). Declaration order (-v, -i, -w, -l)
// would force -v to win in `nl -w abc -v xyz`; GNU reports the width.
describe('nl reports the first bad option in command-line order', () => {
  it.each<[string[], string]>([
    [['-w', 'abc', '-v', 'xyz'], "nl: invalid line number field width: 'abc'\n"],
    [['-v', 'xyz', '-w', 'abc'], "nl: invalid starting line number: 'xyz'\n"],
    [['-i', 'abc', '-v', 'xyz'], "nl: invalid line number increment: 'abc'\n"],
    [['-v', 'xyz', '-i', 'abc'], "nl: invalid starting line number: 'xyz'\n"],
    [['-l', 'abc', '-w', 'xyz'], "nl: invalid line number of blank lines: 'abc'\n"],
    [['-w', 'xyz', '-l', 'abc'], "nl: invalid line number field width: 'xyz'\n"],
    [['-i', 'abc', '-w', 'xyz'], "nl: invalid line number increment: 'abc'\n"],
    [['-w', 'abc', '-i', 'xyz'], "nl: invalid line number field width: 'abc'\n"],
    [['-l', 'abc', '-i', 'xyz'], "nl: invalid line number of blank lines: 'abc'\n"],
    [['-i', 'abc', '-l', 'xyz'], "nl: invalid line number increment: 'abc'\n"],
    [['-l', 'abc', '-v', 'xyz'], "nl: invalid line number of blank lines: 'abc'\n"],
    [['-v', 'xyz', '-l', 'abc'], "nl: invalid starting line number: 'xyz'\n"],
    // The rule is about position, not spelling: the long forms reverse
    // exactly the same way.
    [['--line-increment=abc', '--number-width=xyz'], "nl: invalid line number increment: 'abc'\n"],
    [
      ['--number-width=xyz', '--line-increment=abc'],
      "nl: invalid line number field width: 'xyz'\n",
    ],
  ])('nl %j names the leftmost offender', async (argv, message) => {
    const got = await run(nlBag(...argv))
    expect(got.exit).toBe(1)
    expect(got.stdout).toBe('')
    expect(got.stderr).toBe(message)
  })

  // A valid value on the left does not shield the bad one on the right, and
  // the out-of-range clause travels with whichever option loses.
  it.each<[string[], string]>([
    [['-v', '5', '-w', 'abc'], "nl: invalid line number field width: 'abc'\n"],
    [['-w', 'abc', '-v', '5'], "nl: invalid line number field width: 'abc'\n"],
    [['-w', '3', '-v', 'xyz'], "nl: invalid starting line number: 'xyz'\n"],
    [['-i', '2', '-l', 'abc'], "nl: invalid line number of blank lines: 'abc'\n"],
    [
      ['-w', '0', '-v', 'xyz'],
      "nl: invalid line number field width: '0': Numerical result out of range\n",
    ],
    [['-v', 'xyz', '-w', '0'], "nl: invalid starting line number: 'xyz'\n"],
  ])('nl %j is not shielded by the valid value', async (argv, message) => {
    const got = await run(nlBag(...argv))
    expect(got.exit).toBe(1)
    expect(got.stdout).toBe('')
    expect(got.stderr).toBe(message)
  })

  it.each<[string[], string]>([
    [['-w', '3', '-w', 'abc'], "nl: invalid line number field width: 'abc'\n"],
    [['-v', '5', '-v', 'abc'], "nl: invalid starting line number: 'abc'\n"],
    [['-i', '5', '-i', 'abc'], "nl: invalid line number increment: 'abc'\n"],
    [['-l', '5', '-l', 'abc'], "nl: invalid line number of blank lines: 'abc'\n"],
  ])('nl %j refuses a bad last value', async (argv, message) => {
    const got = await run(nlBag(...argv))
    expect(got.exit).toBe(1)
    expect(got.stdout).toBe('')
    expect(got.stderr).toBe(message)
  })

  // The orderings the flag bag alone cannot express: GNU validated the
  // EARLIER value and exited on it, while the bag kept only the later one.
  // The parser's per-occurrence record is what answers these (section T).
  it.each<[string[], string]>([
    [['-w', 'abc', '-w', '3'], "nl: invalid line number field width: 'abc'\n"],
    [['-v', 'abc', '-v', '5'], "nl: invalid starting line number: 'abc'\n"],
    [['-i', 'abc', '-i', '5'], "nl: invalid line number increment: 'abc'\n"],
    [['-l', 'abc', '-l', '5'], "nl: invalid line number of blank lines: 'abc'\n"],
    // Both occurrences bad: the leftmost still speaks.
    [['-w', 'abc', '-w', 'xyz'], "nl: invalid line number field width: 'abc'\n"],
    // Spelling does not matter, only position.
    [['--number-width=abc', '-w', '3'], "nl: invalid line number field width: 'abc'\n"],
    [['-w', 'abc', '--number-width=3'], "nl: invalid line number field width: 'abc'\n"],
  ])('nl %j refuses the earlier bad value', async (argv, message) => {
    const got = await run(nlBag(...argv))
    expect(got.exit).toBe(1)
    expect(got.stdout).toBe('')
    expect(got.stderr).toBe(message)
  })

  // Every value of an accumulating option is checked, in the order the
  // options were FIRST typed. That is GNU's answer whenever the bad value
  // comes first (`nl -w abc -v xyz -w 3` refuses the width although -v sits
  // between its two occurrences, coreutils 9.4 section T) and a documented
  // divergence when a repeat lands after a different fatal option:
  // `nl -w 3 -v xyz -w abc` names the width here where GNU names -v,
  // because keeping the line's own order would take a per-occurrence
  // record across options, which neither argparse nor the parser keeps.
  it.each<[string[], string]>([
    [['-w', '3', '-v', 'xyz', '-w', 'abc'], "nl: invalid line number field width: 'abc'\n"],
    [['-w', 'abc', '-v', 'xyz', '-w', '3'], "nl: invalid line number field width: 'abc'\n"],
    [['-v', 'xyz', '-w', 'abc', '-v', '5'], "nl: invalid starting line number: 'xyz'\n"],
    [['-w', '3', '-w', 'abc', '-v', 'xyz'], "nl: invalid line number field width: 'abc'\n"],
  ])('nl %j names the leftmost bad value across a repeat', async (argv, message) => {
    const got = await run(nlBag(...argv))
    expect(got.exit).toBe(1)
    expect(got.stdout).toBe('')
    expect(got.stderr).toBe(message)
  })

  // A control on the fix: reading the leftmost BAD value must not also make
  // the leftmost GOOD one win, or `nl -w 3 -w 9` would pad to 3.
  it.each<[string[], string]>([
    [['-w', '3', '-v', '5', '-w', '9'], '        5\tx\n'],
    [['-v', '2', '-v', '8'], '     8\tx\n'],
  ])('nl %j still takes the last valid value', async (argv, stdout) => {
    const got = await run(nlBag(...argv))
    expect(got.exit).toBe(0)
    expect(got.stdout).toBe(stdout)
    expect(got.stderr).toBe('')
  })

  // GNU assigns as it reads, so a later valid value overwrites an earlier
  // one. Both stdouts are od-verified in ground truth section N3.
  it.each<[string[], string]>([
    [['-v', '1', '-v', '7'], '     7\tx\n'],
    [['-w', '3', '-w', '9'], '        1\tx\n'],
  ])('nl %j uses the last valid value', async (argv, stdout) => {
    const got = await run(nlBag(...argv))
    expect(got.exit).toBe(0)
    expect(got.stdout).toBe(stdout)
    expect(got.stderr).toBe('')
  })
})

// GNU's own style set, read off build_type_arg: the FIRST character of the
// argument must be one of a/t/n/p, so `-b tt` is accepted (and means `t`)
// while `-b A`, `-b P` and an empty `-b` are refused. All three style
// options word their own refusal, and all three are reported WITHOUT
// exiting, so the line ends in usage() and its hint (section U).
const HINT = "Try 'nl --help' for more information.\n"

describe('nl validates its style and format options like GNU', () => {
  it.each<[string[], string]>([
    [['-b', 'bogus'], "nl: invalid body numbering style: 'bogus'\n"],
    [['-b', ''], "nl: invalid body numbering style: ''\n"],
    [['-b', 'A'], "nl: invalid body numbering style: 'A'\n"],
    [['-b', 'P'], "nl: invalid body numbering style: 'P'\n"],
    [['-b', '1'], "nl: invalid body numbering style: '1'\n"],
    [['-f', 'bogus'], "nl: invalid footer numbering style: 'bogus'\n"],
    [['-f', ''], "nl: invalid footer numbering style: ''\n"],
    [['-h', 'bogus'], "nl: invalid header numbering style: 'bogus'\n"],
    [['-h', 'A'], "nl: invalid header numbering style: 'A'\n"],
    [['-n', 'bogus'], "nl: invalid line numbering format: 'bogus'\n"],
    [['-n', ''], "nl: invalid line numbering format: ''\n"],
    // -n compares the WHOLE word, unlike the styles' first character.
    [['-n', 'LN'], "nl: invalid line numbering format: 'LN'\n"],
    [['-n', 'rnn'], "nl: invalid line numbering format: 'rnn'\n"],
    [['-n', 'l'], "nl: invalid line numbering format: 'l'\n"],
  ])('nl %j is refused with the --help hint', async (argv, message) => {
    const got = await run(nlBag(...argv))
    expect(got.exit).toBe(1)
    expect(got.stdout).toBe('')
    expect(got.stderr).toBe(message + HINT)
  })

  // A control: `-b p` (empty pattern) and `-b tt` are both legal.
  it.each(['-b', '-f', '-h'])('%s accepts every style GNU accepts', async (flag) => {
    for (const raw of ['a', 't', 'n', 'p', 'pfoo', 'tt', 'nn', 'aa']) {
      const got = await run(nlBag(flag, raw))
      expect([raw, got.exit, got.stderr]).toEqual([raw, 0, ''])
    }
  })

  it.each(['ln', 'rn', 'rz'])('-n accepts %s', async (raw) => {
    const got = await run(nlBag('-n', raw))
    expect(got.exit).toBe(0)
    expect(got.stderr).toBe('')
  })

  // GNU validates neither -d nor -s, not even a three-character -d.
  it.each<[string[]]>([
    [['-d', '']],
    [['-d', 'x']],
    [['-d', 'xy']],
    [['-d', 'xyz']],
    [['-s', '']],
    [['-s', '::']],
  ])('nl %j is accepted unvalidated', async (argv) => {
    const got = await run(nlBag(...argv))
    expect(got.exit).toBe(0)
    expect(got.stderr).toBe('')
  })

  // `-b nn` is the `n` style, not an unknown one falling through to `t`:
  // GNU keeps the whole argument but switches on its first character, so a
  // trailing byte changes nothing. Measured stdout, section U.
  it.each<[string, string]>([
    ['tt', '     1\tx\n'],
    ['nn', '       x\n'],
    ['aa', '     1\tx\n'],
    ['n', '       x\n'],
  ])('reads only the first character of -b %s', async (raw, stdout) => {
    const got = await run(nlBag('-b', raw))
    expect(got.exit).toBe(0)
    expect(got.stdout).toBe(stdout)
    expect(got.stderr).toBe('')
  })
})

// The deferred mechanism, end to end: a style refusal does not exit, so a
// numeric refusal after it prints BOTH lines and drops the hint (the numeric
// option killed the parse before usage() was reached), while a valid numeric
// value after it leaves the hint in place. Measured on GNU coreutils 9.4
// (section U).
describe('nl defers a style refusal and exits on a numeric one', () => {
  it.each<[string[], string]>([
    [
      ['-b', 'bogus', '-w', 'abc'],
      "nl: invalid body numbering style: 'bogus'\n" +
        "nl: invalid line number field width: 'abc'\n",
    ],
    [['-b', 'bogus', '-w', '3'], "nl: invalid body numbering style: 'bogus'\n" + HINT],
    [['-w', 'abc', '-b', 'bogus'], "nl: invalid line number field width: 'abc'\n"],
    [
      ['-n', 'bogus', '-w', 'abc'],
      "nl: invalid line numbering format: 'bogus'\n" +
        "nl: invalid line number field width: 'abc'\n",
    ],
    [['-w', 'abc', '-n', 'bogus'], "nl: invalid line number field width: 'abc'\n"],
    [
      ['-b', 'bogus', '-v', 'xyz', '-w', 'abc'],
      "nl: invalid body numbering style: 'bogus'\n" + "nl: invalid starting line number: 'xyz'\n",
    ],
    // Several deferred refusals accumulate in scan order, then the hint.
    [
      ['-b', 'bogus', '-h', 'bogus'],
      "nl: invalid body numbering style: 'bogus'\n" +
        "nl: invalid header numbering style: 'bogus'\n" +
        HINT,
    ],
    [
      ['-n', 'bogus', '-b', 'bogus'],
      "nl: invalid line numbering format: 'bogus'\n" +
        "nl: invalid body numbering style: 'bogus'\n" +
        HINT,
    ],
    [
      ['-b', 'bogus', '-h', 'bogus', '-f', 'bogus'],
      "nl: invalid body numbering style: 'bogus'\n" +
        "nl: invalid header numbering style: 'bogus'\n" +
        "nl: invalid footer numbering style: 'bogus'\n" +
        HINT,
    ],
    [
      ['-b', 'bogus', '-f', 'bogus', '-w', 'abc'],
      "nl: invalid body numbering style: 'bogus'\n" +
        "nl: invalid footer numbering style: 'bogus'\n" +
        "nl: invalid line number field width: 'abc'\n",
    ],
    // A style occurrence GNU has already reported still counts after a
    // later occurrence overrides it.
    [['-b', 'bogus', '-b', 't'], "nl: invalid body numbering style: 'bogus'\n" + HINT],
    [['-b', 't', '-b', 'bogus'], "nl: invalid body numbering style: 'bogus'\n" + HINT],
  ])("nl %j prints GNU's lines in GNU's order", async (argv, stderr) => {
    const got = await run(nlBag(...argv))
    expect(got.exit).toBe(1)
    expect(got.stdout).toBe('')
    expect(got.stderr).toBe(stderr)
  })
})

// A `p` style's pattern is a POSIX BRE, and GNU compiles it with glibc, so both
// the refusals and the acceptances are glibc's rather than either host engine's.
// Every row below was measured twice, on `nl -b pPAT` and on `expr abc : PAT`,
// which answer with the same string (new ground-truth section W). The messages
// are glibc `regerror` strings, which is why they read unlike coreutils' own:
// `Unmatched ( or \(` really is the wording.
const BAD_PATTERNS: [string, string][] = [
  ['[', 'Invalid regular expression'],
  ['[^', 'Invalid regular expression'],
  // A bracket that ran off the end with anything in it is the OTHER message;
  // only a bare `[` or `[^` is REG_BADPAT.
  ['[a', 'Unmatched [, [^, [:, [., or [='],
  ['[]', 'Unmatched [, [^, [:, [., or [='],
  ['[[:alpha:]', 'Unmatched [, [^, [:, [., or [='],
  ['[a-', 'Unmatched [, [^, [:, [., or [='],
  ['[[:', 'Unmatched [, [^, [:, [., or [='],
  ['\\(', 'Unmatched ( or \\('],
  ['a\\(b', 'Unmatched ( or \\('],
  ['\\)', 'Unmatched ) or \\)'],
  ['a\\)', 'Unmatched ) or \\)'],
  ['\\', 'Trailing backslash'],
  ['\\1', 'Invalid back reference'],
  ['\\9', 'Invalid back reference'],
  ['\\(a\\)\\2', 'Invalid back reference'],
  ['\\(a\\1\\)', 'Invalid back reference'],
  ['[[:bogus:]]', 'Invalid character class name'],
  ['[[.ab.]]', 'Invalid collation character'],
  ['[[..]]', 'Invalid collation character'],
  ['[[=ab=]]', 'Invalid collation character'],
  ['a\\{1,', 'Unmatched \\{'],
  ['a\\{2,1\\}', 'Invalid content of \\{\\}'],
  ['a\\{\\}', 'Invalid content of \\{\\}'],
  ['a\\{x\\}', 'Invalid content of \\{\\}'],
  ['a\\{ 1\\}', 'Invalid content of \\{\\}'],
  ['a\\{-1\\}', 'Invalid content of \\{\\}'],
  ['a\\{1,,2\\}', 'Invalid content of \\{\\}'],
  ['a\\{1,2,3\\}', 'Invalid content of \\{\\}'],
  // RE_DUP_MAX is 32767: 32767 compiles, 32768 does not, on either bound.
  ['a\\{32768\\}', 'Regular expression too big'],
  ['a\\{0,32768\\}', 'Regular expression too big'],
  ['a\\{100000\\}', 'Regular expression too big'],
  // `Invalid range end` is about the KIND of endpoint, never its order.
  ['[[:alpha:]-z]', 'Invalid range end'],
  ['[z-[:alpha:]]', 'Invalid range end'],
  ['[[=a=]-z]', 'Invalid range end'],
  ['[a-c-e]', 'Invalid range end'],
]

describe('nl -b p<re> compiles a POSIX BRE, not this engine s dialect', () => {
  // A compile failure is fatal and prints NO style line and NO hint: the style
  // `p` was accepted, so only glibc's own wording appears, and the failure
  // exits where it stands rather than reaching usage() (section U6).
  it.each(['-b', '-f', '-h'])('%s refuses every pattern glibc refuses', async (flag) => {
    for (const [pattern, message] of BAD_PATTERNS) {
      const got = await run(nlBag(flag, 'p' + pattern))
      expect([pattern, got.exit, got.stdout, got.stderr]).toEqual([
        pattern,
        1,
        '',
        `nl: ${message}\n`,
      ])
    }
  })

  // The constructs where GNU's BRE is the exact INVERSE of both host engines,
  // and the ones where glibc accepts what both engines refuse. Each row is a
  // subject line the pattern must match, so a pass proves the translation and
  // not merely that something compiled.
  it.each<[string, string]>([
    // A leading `*` is a literal, where both engines say "nothing to repeat".
    ['*', '*a'],
    ['**', '*a'],
    ['\\+', '+'],
    ['\\?', '?'],
    // With nothing to repeat, the WHOLE `\{...\}` is literal text -- so a body
    // glibc would refuse inside a real interval is never even read.
    ['\\{1\\}', '{1}'],
    ['\\{2,1\\}', '{2,1}'],
    ['\\{x\\}', '{x}'],
    ['\\{32768\\}', '{32768}'],
    // `\{,m\}` is `{0,m}`, not a malformed body.
    ['a\\{,3\\}', 'x'],
    ['a\\{,\\}', 'x'],
    ['a\\{32767\\}', 'a'.repeat(32767)],
    // An inverted plain range compiles; it is the NEGATED one that matches.
    ['[^z-a]', 'q'],
    ['[a-cd-f]', 'e'],
    ['[a-c-]', '-'],
    // `\(`/`\)` group and bare parens are literal -- both inverted in JS and
    // python.
    ['\\(a\\)b', 'ab'],
    ['(a)', '(a)'],
    // Bare `+ ? { } |` are literals; the escaped forms are the operators.
    ['a+b', 'a+b'],
    ['a?', 'a?'],
    ['a{2}', 'a{2}'],
    ['a|b', 'a|b'],
    ['a\\|b', 'b'],
    ['a\\{2\\}', 'aa'],
    // GNU's own extensions, and the POSIX classes.
    ['\\wx', '_x'],
    ['\\<x', 'x y'],
    ['\\(a\\)\\1', 'aa'],
    ['[[:alpha:]]', 'q'],
    ['[[:digit:]]', '7'],
    ['[[=a=]]', 'a'],
    ['[[.a.]-z]', 'm'],
    ['[]]', ']'],
    // The search is UNANCHORED -- `re_search`, not expr's `re_match`.
    ['o', 'foo'],
    ['foo', 'xfooy'],
    ['o$', 'foo'],
    ['^f', 'foo'],
  ])('numbers the line glibc numbers for %j', async (pattern, subject) => {
    const opts = {
      stdin: stdinOf(`${subject}\n`),
      ...nlBag('-b', 'p' + pattern),
      filetypeFns: null,
      cwd: '/',
      vfs: { kind: 'ram' } as never,
    } as CommandOpts
    const result = await nlGeneric([], opts, stubStream)
    if (result === null) throw new Error('nl declined to handle its own operands')
    const [out, io] = result
    expect(io.exitCode).toBe(0)
    expect(out === null ? '' : DEC.decode(await materialize(out))).toBe(`     1\t${subject}\n`)
  })

  // A pattern with no match is not an error, only an unnumbered line. Asserted
  // on the refusal and not on stdout on purpose: the unnumbered line's bytes
  // are a separate, pre-existing divergence (GNU pads the separator with blanks
  // where mirage writes the separator itself).
  it.each(['^o', '[z-a]', '[9-0]x', 'pfoo', 'q'])(
    'accepts %j, which matches nothing',
    async (p) => {
      const got = await run(nlBag('-b', 'p' + p))
      expect([got.exit, got.stderr]).toEqual([0, ''])
    },
  )

  // A compile failure joins the FATAL family -- it exits where it stands, so
  // nothing to its right is scanned and the hint never arrives -- but it
  // flushes the style lines already deferred to its left (section U6).
  it.each<[string[], string]>([
    [['-b', 'p[', '-w', 'abc'], 'nl: Invalid regular expression\n'],
    [['-w', 'abc', '-b', 'p['], "nl: invalid line number field width: 'abc'\n"],
    [
      ['-h', 'bogus', '-b', 'p['],
      "nl: invalid header numbering style: 'bogus'\n" + 'nl: Invalid regular expression\n',
    ],
    [['-b', 'p[', '-h', 'bogus'], 'nl: Invalid regular expression\n'],
    [
      ['-b', 'bogus', '-b', 'p['],
      "nl: invalid body numbering style: 'bogus'\n" + 'nl: Invalid regular expression\n',
    ],
    [
      ['-n', 'bogus', '-f', 'p\\)'],
      "nl: invalid line numbering format: 'bogus'\n" + 'nl: Unmatched ) or \\)\n',
    ],
  ])('nl %j is fatal where the pattern stands', async (argv, stderr) => {
    const got = await run(nlBag(...argv))
    expect(got.exit).toBe(1)
    expect(got.stdout).toBe('')
    expect(got.stderr).toBe(stderr)
  })

  // `-b [` is an invalid STYLE, so the `[` is never a pattern at all: the style
  // test reads the first character and `[` is not one of a/t/n/p, which puts
  // this in the deferred family with the hint rather than the fatal regex one.
  it('reads a bad style before it reads a pattern', async () => {
    const got = await run(nlBag('-b', '['))
    expect(got.exit).toBe(1)
    expect(got.stderr).toBe("nl: invalid body numbering style: '['\n" + HINT)
  })
})

// An unnumbered line is NOT the number field plus the separator: GNU builds one
// `print_no_line_fmt` of `lineno_width` blanks and then `strlen(separator_str)`
// MORE blanks, so the separator is padded over rather than printed. The default
// line is seven spaces, not six and a TAB. All od-verified on GNU coreutils 9.4
// (ground-truth section W, which corrects sections U and V on this point).
describe('nl pads an unnumbered line over the separator', () => {
  it.each<[string[], string]>([
    [[], '       x\n'],
    [['-w', '3'], '    x\n'],
    [['-w', '1'], '  x\n'],
    [['-w', '10'], '           x\n'],
    [['-s', ''], '      x\n'],
    [['-s', '::'], '        x\n'],
    [['-s', 'ab c'], '          x\n'],
    [['-w', '3', '-s', '::'], '     x\n'],
    // The `-n` format changes how a NUMBER is rendered and nothing about the
    // padding, so all three formats pad identically.
    [['-n', 'ln'], '       x\n'],
    [['-n', 'rz'], '       x\n'],
    [['-n', 'ln', '-w', '3'], '    x\n'],
    // The separator's length is counted in BYTES, which is glibc's strlen: a
    // two-byte character pads by two. Measured `nl -b n -s 'é'`.
    [['-s', 'é'], '        x\n'],
    [['-s', '→'], '         x\n'],
  ])('nl -b n %j', async (extra, stdout) => {
    const got = await run(nlBag('-b', 'n', ...extra))
    expect(got.exit).toBe(0)
    expect(got.stdout).toBe(stdout)
  })

  // The default `-b t` leaves a blank line unnumbered, and pads it: measured
  // `printf 'a\n\nb\n' | nl` writes the blank line as seven spaces, so the
  // padding is not specific to `-b n`.
  it('pads a blank line the same way', async () => {
    const opts = {
      stdin: stdinOf('a\n\nb\n'),
      ...nlBag(),
      filetypeFns: null,
      cwd: '/',
      vfs: { kind: 'ram' } as never,
    } as CommandOpts
    const result = await nlGeneric([], opts, stubStream)
    if (result === null) throw new Error('nl declined to handle its own operands')
    const [out, io] = result
    expect(io.exitCode).toBe(0)
    expect(out === null ? '' : DEC.decode(await materialize(out))).toBe(
      '     1\ta\n       \n     2\tb\n',
    )
  })

  // A `-b p<re>` line that did not match is padded, not separated.
  it('pads a line no pattern matched', async () => {
    const got = await run(nlBag('-b', 'pfoo'))
    expect(got.exit).toBe(0)
    expect(got.stdout).toBe('       x\n')
  })
})

// A trailing newline in a value is refused on both hosts, and the python twin
// was the one that accepted it: its `$` also matches immediately BEFORE a
// trailing newline, so `re.match(r'^[+-]?[0-9]+$', '3\n')` SUCCEEDED and read
// `nl -w $'3\n'` as the valid width 3 (ground truth NL2-A).
//
// The value is rendered through gnulib `quote()`, so the newline is the TWO
// characters `\n` and not the byte -- these rows were written the other way
// round in round 8, when the escaping was still missing, and are now
// byte-exact against GNU (NL3-A).
const NL_DESTS: readonly (readonly [string, string])[] = [
  ['starting_line_number', 'invalid starting line number'],
  ['line_increment', 'invalid line number increment'],
  ['number_width', 'invalid line number field width'],
  ['join_blank_lines', 'invalid line number of blank lines'],
]

describe('nl refuses a trailing newline in a numeric value', () => {
  for (const [dest, label] of NL_DESTS) {
    it.each([
      ['3\n', '3\\n'],
      ['5\n', '5\\n'],
      ['1\n2', '1\\n2'],
      ['3\r', '3\\r'],
      ['3\x0b', '3\\v'],
      ['3\x01', '3\\001'],
    ] as [string, string][])(`${dest} = %j`, async (value, quoted) => {
      const got = await run({ flags: { [dest]: value } })
      expect(got.exit).toBe(1)
      expect(got.stdout).toBe('')
      expect(got.stderr).toBe(`nl: ${label}: '${quoted}'\n`)
    })
  }
})

// The other direction, and the reason anchoring alone was not the whole rule:
// LEADING C whitespace is SKIPPED, because that is what `strtol` does.
// `nl -v $'\t5'` numbers from 5 while `nl -w '3 '` is refused, so the pattern
// has to reject a trailing blank and accept a leading one. The class is C
// `isspace`, which is NARROWER than JavaScript's `\s`: that also matches every
// Unicode space plus U+FEFF, so `\s` would have accepted a great deal GNU
// refuses. Ground truth NL3-C.
describe('nl skips leading C whitespace on a numeric value', () => {
  for (const [dest] of NL_DESTS) {
    it.each(['\t3', ' 3', '\n3', '\x0b3', '\f3', '\r3', '  3', '\t\n 3', ' +3'])(
      `${dest} = %j`,
      (value) => {
        expect(typeof parseFlags({ [dest]: value })).not.toBe('string')
      },
    )
  }

  // Trailing whitespace, a split sign, two signs, and the four bytes that are
  // whitespace to a unicode-aware class and garbage to GNU.
  it.each([
    ['3 ', '3 '],
    ['  3  ', '  3  '],
    ['+ 3', '+ 3'],
    ['--3', '--3'],
    ['+-3', '+-3'],
    ['\x1c3', '\\0343'],
    ['\u00a03', '\\302\\2403'],
  ] as [string, string][])('refuses number_width = %j', async (value, quoted) => {
    const got = await run({ flags: { number_width: value } })
    expect(got.exit).toBe(1)
    expect(got.stderr).toBe(`nl: invalid line number field width: '${quoted}'\n`)
  })

  it('takes a negative after the blanks on a signed option', () => {
    expect(typeof parseFlags({ starting_line_number: ' -5' })).not.toBe('string')
  })
})

// nl's numeric options have TWO out-of-range clauses, not one, and which one
// speaks is a type question rather than an option question: a value that
// scanned but fell below the option's minimum gets strerror(ERANGE), while
// one too big for the type it is scanned into gets strerror(EOVERFLOW).
// Without the second clause the huge value is ACCEPTED and then blows up
// building the pad. Every row od-verified on GNU coreutils 9.4 (NL2-I).
const EOVERFLOW_TEXT = 'Value too large for defined data type'
const ERANGE_TEXT = 'Numerical result out of range'

describe('nl reports a value too large for the type', () => {
  it.each([
    ['number_width', '2147483648', 'invalid line number field width'],
    ['number_width', '+2147483648', 'invalid line number field width'],
    ['number_width', '99999999999999999999', 'invalid line number field width'],
    ['join_blank_lines', '9223372036854775808', 'invalid line number of blank lines'],
    ['join_blank_lines', '99999999999999999999', 'invalid line number of blank lines'],
    ['starting_line_number', '9223372036854775808', 'invalid starting line number'],
    ['starting_line_number', '-9223372036854775809', 'invalid starting line number'],
    ['line_increment', '9223372036854775808', 'invalid line number increment'],
    ['line_increment', '-9223372036854775809', 'invalid line number increment'],
  ])('%s = %s', async (dest, value, label) => {
    const got = await run({ flags: { [dest]: value } })
    expect(got.exit).toBe(1)
    expect(got.stdout).toBe('')
    expect(got.stderr).toBe(`nl: ${label}: '${value}': ${EOVERFLOW_TEXT}\n`)
  })

  // The controls: each option's own limit is IN range, and the four do not
  // share one limit -- `-l 2147483648` is accepted where `-w 2147483648` is
  // refused. `-w 2147483647` is left out on purpose: it is valid and GNU
  // really does emit two gigabytes of pad for one line.
  it.each([
    ['join_blank_lines', '2147483648'],
    ['join_blank_lines', '9223372036854775807'],
    ['starting_line_number', '9223372036854775807'],
    ['starting_line_number', '-9223372036854775808'],
    ['line_increment', '9223372036854775807'],
    ['line_increment', '-9223372036854775808'],
  ])('accepts %s = %s', (dest, value) => {
    expect(typeof parseFlags({ [dest]: value })).not.toBe('string')
  })

  // The two options that demand at least 1 switch WORDINGS partway down
  // their negative side, at exactly -2**30. Measured by bisection on
  // coreutils 9.4 / glibc 2.39 / x86-64 and stable over five runs and
  // whatever else the line carried; -2**30 matches no type boundary, so this
  // is an unexplained gnulib artifact of that platform and is the row here
  // most likely to move.
  it.each([
    ['number_width', 'invalid line number field width'],
    ['join_blank_lines', 'invalid line number of blank lines'],
  ])('%s switches wording at the overflow floor', async (dest, label) => {
    const inside = await run({ flags: { [dest]: '-1073741824' } })
    expect(inside.stderr).toBe(`nl: ${label}: '-1073741824': ${ERANGE_TEXT}\n`)
    const below = await run({ flags: { [dest]: '-1073741825' } })
    expect(below.stderr).toBe(`nl: ${label}: '-1073741825': ${EOVERFLOW_TEXT}\n`)
  })

  // That floor belongs to -w and -l alone: `-i -9223372036854775808` numbers
  // happily, so the two signed options never produce the ERANGE clause.
  it.each(['-1073741825', '-2000000000', '-2147483648'])('signed options accept %s', (value) => {
    expect(typeof parseFlags({ starting_line_number: value })).not.toBe('string')
    expect(typeof parseFlags({ line_increment: value })).not.toBe('string')
  })
})

// `-d ''` DISABLES section-delimiter matching; it does not restore the
// default `\:`. This host's `??` already had that right where python's `or`
// read the empty string as absent, so these are the parity anchors.
describe('nl reads an empty -d as disabling delimiters', () => {
  it('keeps an empty delimiter empty', () => {
    const parsed = parseLine(nlBag('-d', ''))
    if (typeof parsed === 'string') throw new Error(`refused: ${parsed}`)
    expect(parsed.delimiter).toBe('')
  })

  it('takes the default when -d is absent', () => {
    const parsed = parseLine(nlBag())
    if (typeof parsed === 'string') throw new Error(`refused: ${parsed}`)
    expect(parsed.delimiter).toBe('\\:')
  })

  it('numbers the delimiter lines as ordinary text', async () => {
    const opts = {
      stdin: stdinOf('\\:\\:\\:\nH\n\\:\\:\nB\n'),
      ...nlBag('-d', ''),
      filetypeFns: null,
      cwd: '/',
      vfs: { kind: 'ram' } as never,
    } as CommandOpts
    const result = await nlGeneric([], opts, stubStream)
    if (result === null) throw new Error('nl declined to handle its own operands')
    const [out, io] = result
    expect(io.exitCode).toBe(0)
    expect(out === null ? '' : DEC.decode(await materialize(out))).toBe(
      '     1\t\\:\\:\\:\n     2\tH\n     3\t\\:\\:\n     4\tB\n',
    )
  })

  // The control: the same input with -d absent.
  it('consumes the delimiter lines under the default', async () => {
    const opts = {
      stdin: stdinOf('\\:\\:\\:\nH\n\\:\\:\nB\n'),
      ...nlBag(),
      filetypeFns: null,
      cwd: '/',
      vfs: { kind: 'ram' } as never,
    } as CommandOpts
    const result = await nlGeneric([], opts, stubStream)
    if (result === null) throw new Error('nl declined to handle its own operands')
    const [out, io] = result
    expect(io.exitCode).toBe(0)
    expect(out === null ? '' : DEC.decode(await materialize(out))).toBe('\n       H\n\n     1\tB\n')
  })
})

// GNU pads a one-character -d with ':', and "one character" is glibc strlen,
// i.e. one BYTE. Neither host's native length answers it: this one counts
// UTF-16 units and python counts code points, so both read a two-byte `é` as
// one and padded it, and only python also padded a four-byte emoji. Measured
// against GNU by feeding each candidate line in (NL2-H): `ééé` opens a header
// while `é:é:é:` does not.
describe('nl pads a delimiter only when it is one byte', () => {
  async function render(delimiter: string, text: string): Promise<string> {
    const opts = {
      stdin: stdinOf(text),
      ...nlBag('-d', delimiter),
      filetypeFns: null,
      cwd: '/',
      vfs: { kind: 'ram' } as never,
    } as CommandOpts
    const result = await nlGeneric([], opts, stubStream)
    if (result === null) throw new Error('nl declined to handle its own operands')
    const [out] = result
    return out === null ? '' : DEC.decode(await materialize(out))
  }

  // A one-byte delimiter IS padded, so the tripled PAIR is the header.
  it.each([
    ['x', 'x:x:x:'],
    [':', '::::::'],
  ])('pads %j so %j opens a header', async (delimiter, header) => {
    expect(await render(delimiter, `${header}\nH\nA\n`)).toBe('\n       H\n       A\n')
  })

  // A multi-byte delimiter is NOT padded, so the tripled delimiter itself is
  // the header and the `:`-padded form is ordinary text.
  it.each([
    ['é', 'ééé'],
    ['😀', '😀😀😀'],
    ['xy', 'xyxyxy'],
    ['xyz', 'xyzxyzxyz'],
  ])('leaves %j unpadded so %j opens a header', async (delimiter, header) => {
    expect(await render(delimiter, `${header}\nH\nA\n`)).toBe('\n       H\n       A\n')
  })

  it.each([
    ['é', 'é:é:é:'],
    ['😀', '😀:😀:😀:'],
  ])('leaves %j unpadded so %j is ordinary text', async (delimiter, line) => {
    expect(await render(delimiter, `${line}\nH\n`)).toBe(`     1\t${line}\n     2\tH\n`)
  })
})

// nl reads its flags once into a frozen struct of the RAW option words, the
// shape CLAUDE.md requires of every generic and the shape the python twin's
// NlFlags already had; the config the renderer reads is derived from it
// rather than being what the flag read returns.
describe('nl parseFlags returns the raw option words', () => {
  it('carries every word the line typed', () => {
    const parsed = parseLine(
      nlBag('-b', 'a', '-v', '5', '-i', '2', '-w', '3', '-s', '::', '-n', 'rz', '-d', '!', '-p'),
    )
    if (typeof parsed === 'string') throw new Error(`refused: ${parsed}`)
    expect(parsed).toEqual({
      bodyNumberingRaw: 'a',
      startRaw: '5',
      incrementRaw: '2',
      widthRaw: '3',
      separator: '::',
      footerNumberingRaw: undefined,
      headerNumberingRaw: undefined,
      joinBlankLinesRaw: undefined,
      numberFormat: 'rz',
      delimiter: '!',
      noRenumber: true,
    })
  })

  it('returns the stderr text for a line GNU refuses', () => {
    expect(parseLine(nlBag('-w', 'abc'))).toBe("nl: invalid line number field width: 'abc'\n")
  })
})

// GNU numbers the line, prints it, and THEN adds the increment; an addition
// that leaves intmax_t marks the counter, and the next line that NEEDS a
// number is the one that dies. The deferral is the whole point: `-v <max-2>`
// on THREE lines prints all three and exits 0, and only the fourth line makes
// it fatal. `error(EXIT_FAILURE, 0, ...)` means errnum 0, so there is no colon
// clause -- unlike every option refusal. Everything here od-verified, ground
// truth NL3-F.
const INTMAX_MAX_TXT = '9223372036854775807'

describe('nl line number overflow is deferred', () => {
  async function numbered(start: string, count: number, flags = {}) {
    const stdin = Array.from({ length: count }, (_, i) => `l${String(i)}\n`).join('')
    const opts = {
      stdin: stdinOf(stdin),
      flags: { starting_line_number: start, ...flags },
      filetypeFns: null,
      cwd: '/',
      vfs: { kind: 'ram' } as never,
    } as CommandOpts
    const result = await nlGeneric([], opts, stubStream)
    if (result === null) throw new Error('nl declined to handle its own operands')
    const [out, io] = result
    const text = out === null ? '' : DEC.decode(await materialize(out))
    return {
      exit: io.exitCode,
      stdout: text,
      stderr: io.stderr instanceof Uint8Array ? DEC.decode(io.stderr) : '',
    }
  }

  it.each([
    [INTMAX_MAX_TXT, 1, 1, 0],
    [INTMAX_MAX_TXT, 2, 1, 1],
    [INTMAX_MAX_TXT, 3, 1, 1],
    ['9223372036854775806', 1, 1, 0],
    ['9223372036854775806', 2, 2, 0],
    ['9223372036854775806', 3, 2, 1],
    ['9223372036854775805', 3, 3, 0],
    ['9223372036854775805', 4, 3, 1],
  ] as [string, number, number, number][])(
    'start %s on %i lines prints %i and exits %i',
    async (start, count, printed, exitCode) => {
      const got = await numbered(start, count)
      expect(got.exit).toBe(exitCode)
      expect(got.stdout.split('\n').filter((l) => l !== '')).toHaveLength(printed)
      expect(got.stderr).toBe(exitCode === 0 ? '' : 'nl: line number overflow\n')
    },
  )

  // `-b n` never advances the counter, so it never overflows -- the row that
  // says the check is on the advance and the advance belongs to numbering.
  it('counts only numbered lines', async () => {
    const got = await numbered(INTMAX_MAX_TXT, 2, { body_numbering: 'n' })
    expect(got.exit).toBe(0)
    expect(got.stdout).toBe('       l0\n       l1\n')
    expect(got.stderr).toBe('')
  })

  // An unnumbered line between the limit and the abort still prints, so the
  // abort is "this line needs a number and cannot have one", not "stop
  // reading".
  it('still prints unnumbered lines first', async () => {
    const opts = {
      stdin: stdinOf('a\n\nb\n'),
      flags: { starting_line_number: INTMAX_MAX_TXT },
      filetypeFns: null,
      cwd: '/',
      vfs: { kind: 'ram' } as never,
    } as CommandOpts
    const result = await nlGeneric([], opts, stubStream)
    if (result === null) throw new Error('nl declined to handle its own operands')
    const [out, io] = result
    const text = out === null ? '' : DEC.decode(await materialize(out))
    expect(io.exitCode).toBe(1)
    expect(text).toBe(`${INTMAX_MAX_TXT}\ta\n       \n`)
  })

  it('reaches the negative limit too', async () => {
    const got = await numbered('-9223372036854775808', 2, { line_increment: '-1' })
    expect(got.exit).toBe(1)
    expect(got.stdout).toBe('-9223372036854775808\tl0\n')
    expect(got.stderr).toBe('nl: line number overflow\n')
  })

  // The counter is a bigint, not a number. A float64 line number loses digits
  // here: this host printed 9223372036854776000 where GNU and the python twin
  // print the value, which is what the bigint move fixed.
  it('numbers past 2**53 exactly', async () => {
    const got = await numbered('9007199254740991', 2)
    expect(got.exit).toBe(0)
    expect(got.stdout).toBe('9007199254740991\tl0\n9007199254740992\tl1\n')
  })

  it('and at the top of the signed range', async () => {
    const got = await numbered(INTMAX_MAX_TXT, 1)
    expect(got.exit).toBe(0)
    expect(got.stdout).toBe(`${INTMAX_MAX_TXT}\tl0\n`)
  })
})
