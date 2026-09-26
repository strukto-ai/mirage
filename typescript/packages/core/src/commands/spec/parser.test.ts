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
import { helpSpec, registeredSpec, specOf } from './builtins.ts'
import { ParsedArgs, parseCommand, parseToKwargs } from './parser.ts'
import { CommandSpec, Operand, Option } from './types.ts'

/** The spec the registry parses for a builtin, --help/--version and all. */
function registered(name: string): CommandSpec {
  return registeredSpec(name, specOf(name))
}

describe('parseCommand — bool short flags', () => {
  const spec = new CommandSpec({
    options: [new Option({ short: '-l' }), new Option({ short: '-a' })],
    rest: new Operand({ type: 'path' }),
  })

  it('parses single short flag', () => {
    const p = parseCommand(spec, ['-l', '/ram/x'], '/')
    expect(p.flags).toEqual({ '-l': true })
    expect(p.paths()).toEqual(['/ram/x'])
  })

  it('parses clustered short bool flags', () => {
    const p = parseCommand(spec, ['-la', '/ram/x'], '/')
    expect(p.flags).toEqual({ '-l': true, '-a': true })
  })

  it('stops flag parsing at --', () => {
    const p = parseCommand(spec, ['--', '-l', '/ram/x'], '/')
    expect(p.flags).toEqual({})
    expect(p.paths()).toEqual(['/-l', '/ram/x'])
  })
})

describe('parseCommand — value flags', () => {
  const spec = new CommandSpec({
    options: [new Option({ short: '-n', type: 'str' }), new Option({ short: '-o', type: 'path' })],
    rest: new Operand({ type: 'path' }),
  })

  it('parses separate value form: -n 5', () => {
    const p = parseCommand(spec, ['-n', '5', '/ram/x'], '/')
    expect(p.flags['-n']).toBe('5')
  })

  it('parses attached value form: -n5', () => {
    const p = parseCommand(spec, ['-n5', '/ram/x'], '/')
    expect(p.flags['-n']).toBe('5')
  })

  it('resolves PATH-kind value flag against cwd', () => {
    const p = parseCommand(spec, ['-o', 'out.txt', '/ram/x'], '/ram')
    expect(p.flags['-o']).toBe('/ram/out.txt')
    expect(p.pathFlagValues).toEqual(['/ram/out.txt'])
  })

  it('routes an attached optional long PATH value', () => {
    const p = parseCommand(specOf('mktemp'), ['--tmpdir=staging', 'file.XXXX'], '/data')
    expect(p.flags['--tmpdir']).toBe('/data/staging')
    expect(p.pathFlagValues).toEqual(['/data/staging'])
  })
})

describe('parseCommand — numericShorthand', () => {
  const spec = new CommandSpec({
    options: [new Option({ short: '-n', type: 'str', numericShorthand: true })],
    rest: new Operand({ type: 'path' }),
  })

  it('treats -3 as -n 3 (GNU head/tail shorthand)', () => {
    const p = parseCommand(spec, ['-3', '/ram/x'], '/')
    expect(p.flags['-n']).toBe('3')
    expect(p.paths()).toEqual(['/ram/x'])
  })

  it('keeps -n 3 working alongside shorthand', () => {
    const p = parseCommand(spec, ['-n', '3', '/ram/x'], '/')
    expect(p.flags['-n']).toBe('3')
  })

  it('does nothing for non-numeric short tokens', () => {
    const p = parseCommand(spec, ['-x', '/ram/x'], '/')
    expect(p.flags['-n']).toBeUndefined()
  })

  it('is opt-in: spec without numericShorthand ignores -3', () => {
    const noShortcut = new CommandSpec({
      options: [new Option({ short: '-n', type: 'str' })],
      rest: new Operand({ type: 'path' }),
    })
    const p = parseCommand(noShortcut, ['-3', '/ram/x'], '/')
    expect(p.flags['-n']).toBeUndefined()
  })
})

describe('parseCommand — long flags', () => {
  const spec = new CommandSpec({
    options: [new Option({ long: '--verbose' }), new Option({ long: '--name', type: 'str' })],
    rest: new Operand({ type: 'path' }),
  })

  it('parses long bool', () => {
    const p = parseCommand(spec, ['--verbose', '/ram/x'], '/')
    expect(p.flags['--verbose']).toBe(true)
  })

  it('parses long value', () => {
    const p = parseCommand(spec, ['--name', 'README', '/ram/x'], '/')
    expect(p.flags['--name']).toBe('README')
  })
})

describe('parseCommand — positional classification', () => {
  const spec = new CommandSpec({
    positional: [new Operand({ type: 'str' }), new Operand({ type: 'path' })],
  })

  it('classifies args by positional kind', () => {
    const p = parseCommand(spec, ['pattern', '/ram/x'], '/')
    expect(p.args).toEqual([
      ['pattern', 'str'],
      ['/ram/x', 'path'],
    ])
  })

  it('passes overflow args through like the last slot when no rest', () => {
    const p = parseCommand(spec, ['pattern', '/ram/x', 'extra'], '/')
    expect(p.args).toHaveLength(3)
    expect(p.args[2]?.[1]).toBe('path')
  })
})

describe('parseCommand — --cache is an ordinary word', () => {
  it('refuses --cache as an unrecognized option', () => {
    const p = parseCommand(specOf('grep'), ['--cache', '/c', 'bar', 'f.txt'], '/data', 'grep')
    expect(p.invalidOptions).toEqual(['--cache'])
    expect(p.args).toEqual([
      ['/c', 'str'],
      ['/data/bar', 'path'],
      ['/data/f.txt', 'path'],
    ])
    expect(p.wordKinds).toEqual(['str', 'str', 'path', 'path'])
  })

  it('reads --cache after end of options as an operand', () => {
    const p = parseCommand(specOf('cat'), ['--', '--cache'], '/data', 'cat')
    expect(p.invalidOptions).toEqual([])
    expect(p.args).toEqual([['/data/--cache', 'path']])
  })
})

describe('parseCommand — clustered flags shift positionals when one is missing from spec', () => {
  // Regression: a real user ran `grep -RIl "Base3\|base3" /r2/Review` and the
  // pattern + path got misclassified because `-I` wasn't in the grep spec.
  // The parser saw `-RIl`, found `-I` not registered, gave up on the whole
  // cluster, and pushed `-RIl` itself as the first positional — making
  // "Base3\|base3" the rest path and the real path arg the second one.
  const grepLikeMissingI = new CommandSpec({
    options: [
      new Option({ short: '-R' }),
      // -I deliberately missing
      new Option({ short: '-l' }),
    ],
    positional: [new Operand({ type: 'str' })],
    rest: new Operand({ type: 'path' }),
  })

  const grepLikeFull = new CommandSpec({
    options: [
      new Option({ short: '-R' }),
      new Option({ short: '-I' }),
      new Option({ short: '-l' }),
    ],
    positional: [new Operand({ type: 'str' })],
    rest: new Operand({ type: 'path' }),
  })

  it('reports the missing cluster char without shifting positionals', () => {
    const p = parseCommand(grepLikeMissingI, ['-RIl', 'Base3\\|base3', '/r2/Review'], '/')
    // -RIl can't fully resolve; the offending char is reported instead of
    // the token becoming the pattern and shifting the real pattern.
    expect(p.texts()).toEqual(['Base3\\|base3'])
    expect(p.paths()).toEqual(['/r2/Review'])
    expect(p.invalidOptions).toEqual(['I'])
  })

  it('correctly assigns pattern + path once -I is registered', () => {
    const p = parseCommand(grepLikeFull, ['-RIl', 'Base3\\|base3', '/r2/Review'], '/')
    expect(p.flags).toEqual({ '-R': true, '-I': true, '-l': true })
    expect(p.texts()).toEqual(['Base3\\|base3'])
    expect(p.paths()).toEqual(['/r2/Review'])
  })
})

describe('parseCommand — providedBy frees the positional slot', () => {
  // POSIX: `grep -e pat file` must behave like `grep pat file`. Without
  // providedBy, the pattern positional still consumed the first raw arg, so
  // the file path was classified as TEXT and paths() came back empty.
  const grepLike = new CommandSpec({
    options: [new Option({ short: '-n' }), new Option({ short: '-e', type: 'str' })],
    positional: [new Operand({ type: 'str', providedBy: ['-e'] })],
    rest: new Operand({ type: 'path' }),
  })

  it('classifies remaining args as rest paths when the flag is present', () => {
    const p = parseCommand(grepLike, ['-e', 'orange', '/data/a.txt'], '/')
    expect(p.flags['-e']).toBe('orange')
    expect(p.texts()).toEqual([])
    expect(p.paths()).toEqual(['/data/a.txt'])
  })

  it('keeps the positional slot when the flag is absent', () => {
    const p = parseCommand(grepLike, ['orange', '/data/a.txt'], '/')
    expect(p.texts()).toEqual(['orange'])
    expect(p.paths()).toEqual(['/data/a.txt'])
  })

  it('handles extra flags and multiple paths', () => {
    const p = parseCommand(grepLike, ['-n', '-e', 'pat', '/a.txt', '/b.txt'], '/')
    expect(p.flags['-n']).toBe(true)
    expect(p.paths()).toEqual(['/a.txt', '/b.txt'])
  })

  it('fixes `grep -e pat file` with the real builtin spec', () => {
    const p = parseCommand(specOf('grep'), ['-e', 'orange', '/data/a.txt'], '/')
    expect(p.flags['-e']).toEqual(['orange'])
    expect(p.texts()).toEqual([])
    expect(p.paths()).toEqual(['/data/a.txt'])
  })

  it('fixes `zgrep -e pat file` with the real builtin spec', () => {
    const p = parseCommand(specOf('zgrep'), ['-e', 'orange', '/data/a.gz'], '/')
    expect(p.flags['-e']).toEqual(['orange'])
    expect(p.texts()).toEqual([])
    expect(p.paths()).toEqual(['/data/a.gz'])
  })
})

describe('parseCommand — multiple value flags accumulate newline-joined', () => {
  // POSIX: each -e adds a pattern; a pattern argument is itself a
  // newline-separated pattern list, so repeats join with \n.
  it('accumulates repeated -e for grep', () => {
    const p = parseCommand(specOf('grep'), ['-e', 'foo', '-e', 'bar', '/a.txt'], '/')
    expect(p.flags['-e']).toEqual(['foo', 'bar'])
    expect(p.texts()).toEqual([])
    expect(p.paths()).toEqual(['/a.txt'])
  })

  it('accumulates attached-value repeats', () => {
    const p = parseCommand(specOf('grep'), ['-e', 'foo', '-ebar', '/a.txt'], '/')
    expect(p.flags['-e']).toEqual(['foo', 'bar'])
  })

  it('non-multiple value flags keep the last value', () => {
    const p = parseCommand(specOf('grep'), ['-m', '1', '-m', '2', 'pat'], '/')
    expect(p.flags['-m']).toBe('2')
  })

  it('cluster into a multiple flag accumulates', () => {
    const p = parseCommand(specOf('grep'), ['-ne', 'foo', '-e', 'bar', '/a.txt'], '/')
    expect(p.flags['-n']).toBe(true)
    expect(p.flags['-e']).toEqual(['foo', 'bar'])
    expect(p.paths()).toEqual(['/a.txt'])
  })

  it('long =value and separate forms of a multiple flag accumulate', () => {
    const spec = new CommandSpec({
      options: [new Option({ long: '--tag', type: 'str', multiple: true })],
      rest: new Operand({ type: 'path' }),
    })
    const p = parseCommand(spec, ['--tag=a', '--tag', 'b', '/x'], '/')
    expect(p.flags['--tag']).toEqual(['a', 'b'])
    expect(p.paths()).toEqual(['/x'])
  })

  it('accumulates repeated -e for rg and frees the positional slot', () => {
    const p = parseCommand(specOf('rg'), ['-e', 'foo', '-e', 'bar', '/x'], '/')
    expect(p.flags['--regexp']).toEqual(['foo', 'bar'])
    expect(p.texts()).toEqual([])
    expect(p.paths()).toEqual(['/x'])
  })
})

describe('parseCommand — grep -f pattern file', () => {
  it('frees the positional slot and routes the pattern file', () => {
    const p = parseCommand(specOf('grep'), ['-f', 'pats.txt', 'a.txt'], '/data')
    expect(p.flags['--file']).toEqual(['/data/pats.txt'])
    expect(p.texts()).toEqual([])
    expect(p.paths()).toEqual(['/data/a.txt'])
    expect(p.routingPaths()).toContain('/data/pats.txt')
  })

  it('keeps -e and -f together', () => {
    const p = parseCommand(specOf('grep'), ['-e', 'foo', '-f', '/p.txt', '/a.txt'], '/')
    expect(p.flags['-e']).toEqual(['foo'])
    expect(p.flags['--file']).toEqual(['/p.txt'])
    expect(p.paths()).toEqual(['/a.txt'])
  })

  it('repeated -f accumulates and routes each file', () => {
    const p = parseCommand(specOf('grep'), ['-f', 'p1.txt', '-f', 'p2.txt', 'a.txt'], '/data')
    expect(p.flags['--file']).toEqual(['/data/p1.txt', '/data/p2.txt'])
    expect(p.paths()).toEqual(['/data/a.txt'])
    expect(p.routingPaths()).toContain('/data/p1.txt')
    expect(p.routingPaths()).toContain('/data/p2.txt')
  })

  it('keeps rg -f - as stdin, as grep does', () => {
    // Resolved against the cwd, `-` became a pattern file named `/-`.
    const p = parseCommand(specOf('rg'), ['-f', '-', '/a.txt'], '/data', 'rg')
    expect(p.flags['--file']).toEqual(['-'])
    expect(p.paths()).toEqual(['/a.txt'])
  })
})

describe('parseCommand — GNU long flag =value syntax', () => {
  it('parses --max-depth=1', () => {
    const p = parseCommand(specOf('du'), ['--max-depth=1', '/data'], '/')
    expect(p.flags['--max-depth']).toBe('1')
    expect(p.paths()).toEqual(['/data'])
  })

  it('parses rg --type=md', () => {
    const p = parseCommand(specOf('rg'), ['--type=md', 'pat', '/x'], '/')
    expect(p.flags['--type']).toEqual(['md'])
    expect(p.texts()).toEqual(['pat'])
    expect(p.paths()).toEqual(['/x'])
  })

  it('unknown long flag with = is reported as invalid', () => {
    const p = parseCommand(specOf('grep'), ['--bogus=x', 'pat', '/a.txt'], '/')
    expect(p.flags['--bogus']).toBeUndefined()
    expect(p.texts()).toEqual(['pat'])
    expect(p.paths()).toEqual(['/a.txt'])
    expect(p.invalidOptions).toEqual(['--bogus=x'])
    expect(p.warnings).toEqual([])
  })
})

describe('parseCommand — optional-value long options', () => {
  it('bare form is boolean and never consumes the next token', () => {
    const p = parseCommand(specOf('grep'), ['--color', 'world', '/a.txt'], '/')
    expect(p.flags['--color']).toBe(true)
    expect(p.texts()).toEqual(['world'])
    expect(p.paths()).toEqual(['/a.txt'])
    expect(p.warnings).toEqual([])
  })

  it('equals form carries the value', () => {
    const p = parseCommand(specOf('grep'), ['--color=auto', 'world', '/a.txt'], '/')
    expect(p.flags['--color']).toBe('auto')
    expect(p.warnings).toEqual([])
  })

  it('ls --color keeps its path operand', () => {
    const p = parseCommand(specOf('ls'), ['--color', '/data'], '/')
    expect(p.flags['--color']).toBe(true)
    expect(p.paths()).toEqual(['/data'])
  })
})

describe('parseCommand — optional-value short options', () => {
  // date's -I[FMT] is getopt's `I::`: the value only rides attached, and a
  // detached word stays an operand (coreutils 9.7).
  it('uses only an attached value and leaves the next option intact', () => {
    const bare = parseCommand(specOf('date'), ['-I', '-d', 'now', '+%F'], '/')
    const attached = parseCommand(specOf('date'), ['-Is', '+%F'], '/')
    expect(bare.flags['--iso-8601']).toBe(true)
    expect(bare.flags['--date']).toBe('now')
    expect(bare.texts()).toEqual(['+%F'])
    expect(attached.flags['--iso-8601']).toBe('seconds')
  })
})

describe('parseCommand: optional-value shorts inside a cluster', () => {
  // getopt's `I::` inside a cluster: whatever follows the letter is its
  // value, and nothing after it leaves it bare (coreutils 9.7: `date -uIs` is
  // `date -u -Is`, `date -uI` is `date -u -I`).
  it('takes the rest of the cluster as the value', () => {
    const valued = parseCommand(specOf('date'), ['-uIs'], '/')
    expect(valued.flags['--utc']).toBe(true)
    expect(valued.flags['--iso-8601']).toBe('seconds')
    expect(valued.invalidOptions).toEqual([])
    const bare = parseCommand(specOf('date'), ['-uI'], '/')
    expect(bare.flags['--iso-8601']).toBe(true)
  })

  // GNU mkdir's -Z takes no argument, only --context= does, so -vZ is a
  // cluster and -Zfoo refuses the `f` (coreutils 9.7).
  it('keeps a plain short of an optional long from taking a value', () => {
    const clustered = parseCommand(specOf('mkdir'), ['-vZ', '/d'], '/')
    expect(clustered.flags['--verbose']).toBe(true)
    expect(clustered.flags['--context']).toBe(true)
    const attached = parseCommand(specOf('mkdir'), ['-Zfoo', '/d'], '/')
    expect(attached.invalidOptions).toEqual(['f'])
    const valued = parseCommand(specOf('mkdir'), ['--context=ctx', '/d'], '/')
    expect(valued.flags['--context']).toBe('ctx')
  })
})

describe('parseCommand — unknown dash tokens warn and drop', () => {
  it('reports unknown long flags and keeps operands aligned', () => {
    const p = parseCommand(specOf('grep'), ['--bogus', 'pat', '/a.txt'], '/')
    expect(p.texts()).toEqual(['pat'])
    expect(p.paths()).toEqual(['/a.txt'])
    expect(p.invalidOptions).toEqual(['--bogus'])
  })

  it('reports missing values for declared flags', () => {
    expect(parseCommand(specOf('grep'), ['-m'], '/').needsValueOptions).toEqual(['m'])
    expect(parseCommand(specOf('du'), ['--max-depth'], '/').needsValueOptions).toEqual([
      '--max-depth',
    ])
    expect(parseCommand(specOf('grep'), ['-ne'], '/').needsValueOptions).toEqual(['e'])
  })

  it('keeps dash tokens for an operand-class command', () => {
    const p = parseCommand(specOf('expr'), ['-x', 'hello'], '/', 'expr')
    expect(p.texts()).toEqual(['-x', 'hello'])
    expect(p.warnings).toEqual([])
  })

  // The rest operand's kind used to decide this and cannot: basename,
  // dirname, csplit, numfmt and sleep all declare a TEXT rest and all five
  // report an option they do not know (measured on coreutils 9.4).
  it('reports an unknown option for a TEXT-rest command', () => {
    const long = parseCommand(specOf('basename'), ['--zzz'], '/', 'basename')
    expect(long.invalidOptions).toEqual(['--zzz'])
    expect(long.optionErrorKinds).toEqual(['invalid'])
    expect(long.texts()).toEqual([])
    const short = parseCommand(specOf('basename'), ['-Q'], '/', 'basename')
    expect(short.invalidOptions).toEqual(['Q'])
    expect(short.texts()).toEqual([])
  })

  // An unnamed parse gets the rule, not the exception: the sets are keyed by
  // command name and '' is in neither.
  it('is a strict getopt_long parse when the command is unnamed', () => {
    expect(parseCommand(specOf('basename'), ['--zzz'], '/').invalidOptions).toEqual(['--zzz'])
  })

  // unknownIsOperand is what an installed CLI's node is parsed under: the
  // program owns whatever mirage does not declare, so an undeclared dash word
  // lands in the node's textual rest slot and no abbreviation is expanded on
  // the program's behalf. With no slot to forward into, the same parse refuses
  // it: the program cannot be handed a word the node has nowhere to put.
  it('forwards dash words into the rest slot under unknownIsOperand', () => {
    const spec = new CommandSpec({
      options: [new Option({ long: '--width', type: 'int' })],
      rest: new Operand({ type: 'str' }),
    })
    const parsed = parseCommand(spec, ['--widt', '80', '-n', 'x'], '/', 'pager', undefined, true)
    expect(parsed.flags).toEqual({})
    expect(parsed.invalidOptions).toEqual([])
    expect(parsed.texts()).toEqual(['--widt', '80', '-n', 'x'])
    const slotless = new CommandSpec({
      options: [new Option({ long: '--width', type: 'int' })],
    })
    expect(
      parseCommand(slotless, ['--frobnicate'], '/', 'pager', undefined, true).invalidOptions,
    ).toEqual(['--frobnicate'])
  })

  // The very same spec parsed without the flag is the other answer, which is
  // what makes the call the deciding fact: nothing about the grammar, and
  // nothing carried on the spec, tells the two apart.
  it('refuses the same dash word when parsed strictly', () => {
    const spec = new CommandSpec({
      options: [new Option({ long: '--width', type: 'int' })],
      rest: new Operand({ type: 'str' }),
    })
    const parsed = parseCommand(spec, ['--widt', '80', '-n', 'x'], '/', 'pager')
    expect(parsed.flags).toEqual({ '--width': '80' })
    expect(parsed.invalidOptions).toEqual(['n'])
  })

  it('keeps numeric dash tokens as operands', () => {
    const p = parseCommand(specOf('grep'), ['-5', 'pat'], '/')
    expect(p.texts()).toEqual(['-5'])
    expect(p.warnings).toEqual([])
  })

  it('known flags produce no warnings', () => {
    const p = parseCommand(specOf('grep'), ['-n', '-e', 'pat', '/a.txt'], '/')
    expect(p.warnings).toEqual([])
  })
})

describe('parseCommand — clusters ending in a value flag (getopt)', () => {
  it('-ne pat: bools then value flag consuming the next arg', () => {
    const p = parseCommand(specOf('grep'), ['-ne', 'pat', '/a.txt'], '/')
    expect(p.flags['-n']).toBe(true)
    expect(p.flags['-e']).toEqual(['pat'])
    expect(p.texts()).toEqual([])
    expect(p.paths()).toEqual(['/a.txt'])
  })

  it('-nepat: bools then value flag with attached value', () => {
    const p = parseCommand(specOf('grep'), ['-nepat', '/a.txt'], '/')
    expect(p.flags['-n']).toBe(true)
    expect(p.flags['-e']).toEqual(['pat'])
    expect(p.paths()).toEqual(['/a.txt'])
  })

  it('-im1: bool then numeric value attached', () => {
    const p = parseCommand(specOf('grep'), ['-im1', 'pat', '/a.txt'], '/')
    expect(p.flags['-i']).toBe(true)
    expect(p.flags['-m']).toBe('1')
    expect(p.texts()).toEqual(['pat'])
  })

  it('unknown char in cluster reports the offending char', () => {
    const p = parseCommand(specOf('grep'), ['-nx', 'pat', '/a.txt'], '/')
    expect(p.flags['-n']).toBeUndefined()
    expect(p.texts()).toEqual(['pat'])
    expect(p.invalidOptions).toEqual(['x'])
  })

  it('find multi-char short flags still work', () => {
    const p = parseCommand(specOf('find'), ['/data', '-name', '*.txt'], '/')
    expect(p.flags['-name']).toEqual(['*.txt'])
  })

  it('find grouping tokens are not classified as path operands', () => {
    const p = parseCommand(
      specOf('find'),
      ['/data', '(', '-name', 'inner.txt', '-o', '-name', 'deep.txt', ')'],
      '/',
    )
    expect(p.paths()).toEqual(['/data'])
  })
})

describe('parseToKwargs', () => {
  it('strips leading dashes and converts kebab to snake', () => {
    const parsed = new ParsedArgs({
      flags: { '-l': true, '--max-depth': '5' },
      args: [],
    })
    expect(parseToKwargs(parsed)).toEqual({ args_l: true, max_depth: '5' })
  })

  it('uses AMBIGUOUS_NAMES map to rename colliding keys', () => {
    const parsed = new ParsedArgs({ flags: { '-l': true, '-O': 'x', '-I': 'y' }, args: [] })
    const kw = parseToKwargs(parsed)
    expect(kw.args_l).toBe(true)
    expect(kw.args_O).toBe('x')
    expect(kw.args_I).toBe('y')
  })

  it('maps -1 to args_1 (numeric flag, not a valid JS identifier)', () => {
    const parsed = new ParsedArgs({ flags: { '-1': true }, args: [] })
    expect(parseToKwargs(parsed)).toEqual({ args_1: true })
  })
})

// There is no per-occurrence record beside the bag. GNU validates every
// value as getopt hands it over, so a scalar dest checks the value it is
// about to drop before the next one replaces it (the int and choices tests
// under 'choices violations'), and a command that must see every value
// declares the option `multiple` (argparse's append).
describe('parseCommand — repeated values', () => {
  it('keeps every value of an accumulating option for the command', () => {
    const parsed = parseCommand(specOf('nl'), ['-w', 'abc', '-v', 'xyz', '-w', '3'], '/')
    expect(parseToKwargs(parsed)).toEqual({
      number_width: ['abc', '3'],
      starting_line_number: ['xyz'],
    })
  })

  it("carries only the line's options in the kwargs bag", () => {
    const parsed = parseCommand(
      specOf('grep'),
      ['-e', 'a', '-e', 'b', '-m', '1', '-m', '2', 'x'],
      '/',
    )
    const kwargs = parseToKwargs(parsed)
    expect(kwargs.e).toEqual(['a', 'b'])
    expect(kwargs.m).toBe('2')
    expect(Object.keys(kwargs).sort()).toEqual(['e', 'm'])
  })
})

describe('parseCommand — awk spec', () => {
  it('accumulates repeated -v assignments', () => {
    const p = parseCommand(
      specOf('awk'),
      ['-v', 'a=1', '-v', 'b=2', '{print a, b}', '/data/x.txt'],
      '/',
    )
    expect(p.flags['-v']).toEqual(['a=1', 'b=2'])
    expect(p.texts()).toEqual(['{print a, b}'])
    expect(p.paths()).toEqual(['/data/x.txt'])
  })

  it('accumulates repeated -f program files', () => {
    const p = parseCommand(specOf('awk'), ['-f', '/p1.awk', '-f', '/p2.awk', '/data/a.txt'], '/')
    expect(p.flags['-f']).toEqual(['/p1.awk', '/p2.awk'])
    expect(p.texts()).toEqual([])
    expect(p.paths()).toEqual(['/data/a.txt'])
  })

  it('frees the program slot when -f is present', () => {
    const p = parseCommand(specOf('awk'), ['-f', '/prog.awk', '/data/a.txt', '/data/b.txt'], '/')
    expect(p.texts()).toEqual([])
    expect(p.paths()).toEqual(['/data/a.txt', '/data/b.txt'])
  })
})

describe('overflow operand pass-through', () => {
  it('classifies overflow like the last positional slot', () => {
    const uniq = parseCommand(specOf('uniq'), ['a.txt', 'b.txt', 'c.txt'], '/data')
    expect(uniq.args.map(([, k]) => k)).toEqual(['path', 'path', 'path'])
    const tr = parseCommand(specOf('tr'), ['a', 'b', 'extra.txt'], '/data')
    expect(tr.args.map(([, k]) => k)).toEqual(['str', 'str', 'str'])
  })
})

describe('shortValue: false keeps the short boolean and clusterable', () => {
  it('clusters cp -bv instead of eating v as the backup control', () => {
    // GNU cp -b never takes an argument: -bv is a cluster, never -b=v.
    const clustered = parseCommand(specOf('cp'), ['-bv', '/a', '/b'], '/')
    expect(clustered.flags['--backup']).toBe(true)
    expect(clustered.flags['--verbose']).toBe(true)
  })

  it('keeps bare -u boolean and its operands intact', () => {
    const bare = parseCommand(specOf('cp'), ['-u', '/a', '/b'], '/')
    expect(bare.flags['--update']).toBe(true)
    expect(bare.paths()).toEqual(['/a', '/b'])
  })

  it('still carries the value on --backup=CONTROL', () => {
    const valued = parseCommand(specOf('cp'), ['--backup=numbered', '/a', '/b'], '/')
    expect(valued.flags['--backup']).toBe('numbered')
  })
})

describe('spellings share one dest and honor command-line order', () => {
  it('lets the last occurrence win when -u follows --update=all', () => {
    // GNU treats -u and --update as one option, so the last occurrence on
    // the line decides regardless of spelling (pinned against GNU
    // coreutils 9.7). One canonical key, no per-spelling mirror.
    const shortLast = parseCommand(specOf('cp'), ['--update=all', '-u', '/a', '/b'], '/')
    expect(shortLast.flags['--update']).toBe(true)
    expect('-u' in shortLast.flags).toBe(false)
  })

  it('lets the last occurrence win when --update=all follows -u', () => {
    const longLast = parseCommand(specOf('cp'), ['-u', '--update=all', '/a', '/b'], '/')
    expect(longLast.flags['--update']).toBe('all')
  })

  it('accumulates multiple values across spellings in line order', () => {
    // sort -k/--key is ONE option: values interleave in true command-line
    // order. The old per-spelling lists lost interleaving.
    const parsed = parseCommand(specOf('sort'), ['-k1', '--key=2', '-k3', '/f'], '/')
    expect(parsed.flags['--key']).toEqual(['1', '2', '3'])
    expect('-k' in parsed.flags).toBe(false)
  })
})

describe('attached short values land on the canonical dest', () => {
  it('unifies -Ih onto --iso-8601 and honors order both ways', () => {
    // Last-wins holds for `--long=` and the short form alike.
    const attached = parseCommand(specOf('date'), ['-Ih'], '/')
    expect(attached.flags['--iso-8601']).toBe('hours')
    expect('-I' in attached.flags).toBe(false)
    const shortLast = parseCommand(specOf('date'), ['--iso-8601=ns', '-Ih'], '/')
    expect(shortLast.flags['--iso-8601']).toBe('hours')
    const longLast = parseCommand(specOf('date'), ['-Ih', '--iso-8601=ns'], '/')
    expect(longLast.flags['--iso-8601']).toBe('ns')
  })
})

describe("digit options build split's line count", () => {
  // split's getopt string lists the digits: those of one word build the count
  // wherever they sit, a later word replaces it, and -d stays a plain flag
  // (coreutils 9.7: `split -d10` is -d and ten lines).
  it.each([[['-d10']], [['-10d']], [['-1d0']], [['-d', '-10']]])('%j', (argv) => {
    const parsed = parseCommand(specOf('split'), [...argv, '/in'], '/', 'split')
    expect(parsed.flags['--numeric-suffixes']).toBe(true)
    expect(parsed.flags['--lines']).toBe('10')
    expect(parsed.invalidOptions).toEqual([])
  })

  it('lets a later word replace the count and keeps the long value', () => {
    const later = parseCommand(specOf('split'), ['-12', '-5', '/in'], '/', 'split')
    expect(later.flags['--lines']).toBe('5')
    const valued = parseCommand(specOf('split'), ['--numeric-suffixes=3', '/in'], '/', 'split')
    expect(valued.flags['--numeric-suffixes']).toBe('3')
  })

  it("is the builtin program's own rule", () => {
    // A mount's own command borrowing the name gets getopt's plain rule.
    const spec = new CommandSpec({
      options: [
        new Option({ short: '-d' }),
        new Option({ short: '-l', type: 'str', numericShorthand: true }),
      ],
    })
    expect(parseCommand(spec, ['-d10'], '/', 'split').invalidOptions).toEqual(['1'])
  })
})

describe('count flags accumulate occurrences', () => {
  const spec = new CommandSpec({
    options: [new Option({ short: '-v', long: '--verbose', count: true })],
    rest: new Operand({ type: 'path' }),
  })

  it('parses -vvv and -v -v alike', () => {
    expect(parseCommand(spec, ['-vvv', '/f'], '/').flags['--verbose']).toBe(3)
    expect(parseCommand(spec, ['-v', '--verbose', '-v', '/f'], '/').flags['--verbose']).toBe(3)
    expect('--verbose' in parseCommand(spec, ['/f'], '/').flags).toBe(false)
  })
})

describe('choices violations are reported, never thrown', () => {
  it('reports the canonical spelling, value, and allowed set', () => {
    const parsed = parseCommand(specOf('tee'), ['--output-error=bogus', '/f'], '/', 'tee')
    expect(parsed.invalidValueOptions).toEqual([
      ['--output-error', 'bogus', ['warn', 'warn-nopipe', 'exit', 'exit-nopipe']],
    ])
    expect(
      parseCommand(specOf('tee'), ['--output-error=warn', '/f'], '/', 'tee').invalidValueOptions,
    ).toEqual([])
  })

  // Prefix matching is opt-in per (command, option), so a choices set that
  // is NOT in the table compares the whole word, which is argparse's own
  // rule for `choices`. CPython is the measured case: on 3.11.15
  // `--check-hash-based-pycs a` and `al` are both refused where gnulib would
  // have resolved them to `always`.
  it('takes no prefix for a choices set outside the table', () => {
    const parsed = parseCommand(
      specOf('python3'),
      ['--check-hash-based-pycs=a', '-c', 'x'],
      '/',
      'python3',
    )
    expect(parsed.flags['--check-hash-based-pycs']).toBe('a')
    expect(parsed.invalidValueOptions).toEqual([
      ['--check-hash-based-pycs', 'a', ['always', 'default', 'never']],
    ])
    const exact = parseCommand(
      specOf('python3'),
      ['--check-hash-based-pycs=always', '-c', 'x'],
      '/',
      'python3',
    )
    expect(exact.flags['--check-hash-based-pycs']).toBe('always')
    expect(exact.invalidValueOptions).toEqual([])
  })

  // The empty word has no ambiguity wording to reach outside the table:
  // nothing is an exact match, so it is invalid like any other non-candidate.
  it('reports the empty word invalid for a choices set outside the table', () => {
    const parsed = parseCommand(
      specOf('python3'),
      ['--check-hash-based-pycs=', '-c', 'x'],
      '/',
      'python3',
    )
    expect(parsed.invalidValueOptions).toEqual([
      ['--check-hash-based-pycs', '', ['always', 'default', 'never']],
    ])
    expect(parsed.ambiguousValueOptions).toEqual([])
  })

  // A mount author's own command is not a GNU program, so its choices are
  // argparse's: `--mode=rem` is refused rather than resolved to `remove`.
  // Nothing the author can write opts a custom spec into the table, which
  // names three builtin Option OBJECTS and is tested by identity. Mirrors
  // test_parser.py.
  it('never lets a custom spec inherit argmatch', () => {
    const spec = new CommandSpec({
      options: [new Option({ long: '--mode', type: 'str', choices: ['read', 'remove'] })],
    })
    const parsed = parseCommand(spec, ['--mode=rem'], '/', 'mycmd')
    expect(parsed.flags['--mode']).toBe('rem')
    expect(parsed.invalidValueOptions).toEqual([['--mode', 'rem', ['read', 'remove']]])
    // Even naming it after a real ARGMATCH option changes nothing.
    const named = new CommandSpec({
      options: [new Option({ long: '--to', type: 'str', choices: ['none', 'si'] })],
    })
    expect(parseCommand(named, ['--to=s'], '/', 'mycmd').invalidValueOptions).toEqual([
      ['--to', 's', ['none', 'si']],
    ])
  })

  // A mount may register a command under a builtin's own name, so the name is
  // not the identity. A custom `tee` that reproduces GNU tee's
  // `--output-error` field for field still compares the whole word: the
  // option it declares is its own object, not the one the builtin spec holds.
  // Mirrors test_parser.py.
  it('does not let a command that borrows a builtin name borrow argmatch', () => {
    const lookalike = new Option({
      long: '--output-error',
      type: 'str',
      valueOptional: true,
      choices: ['warn', 'warn-nopipe', 'exit', 'exit-nopipe'],
    })
    const builtin = specOf('tee').options.find((o) => o.long === '--output-error')
    expect(lookalike).toEqual(builtin)
    expect(lookalike).not.toBe(builtin)
    const parsed = parseCommand(
      new CommandSpec({ options: [lookalike] }),
      ['--output-error=exit-n'],
      '/',
      'tee',
    )
    expect(parsed.flags['--output-error']).toBe('exit-n')
    expect(parsed.invalidValueOptions).toEqual([
      ['--output-error', 'exit-n', ['warn', 'warn-nopipe', 'exit', 'exit-nopipe']],
    ])
  })

  // The registry never hands the parser the spec the builtin declared: it
  // appends --help/--version and parses the COPY (commands/config.ts), so
  // `spec === BUILTIN_SPECS[name]` is false for every builtin by the time a
  // line is read. Identity of the Option survives that copy, which is the
  // whole reason the table names options rather than specs -- keying on the
  // spec would disable ARGMATCH everywhere while every unit test that passes
  // specOf(name) straight in kept passing. Mirrors test_parser.py.
  it('keeps argmatch through the copy the registry parses', () => {
    const tee = specOf('tee')
    const registered = helpSpec(tee)
    expect(registered).not.toBe(tee)
    const parsed = parseCommand(registered, ['--output-error=exit-n'], '/', 'tee')
    expect(parsed.flags['--output-error']).toBe('exit-nopipe')
    expect(parsed.invalidValueOptions).toEqual([])
  })

  // python's compileSpec twin caches on a frozen dataclass, so ITS key is
  // structural and a spec built to look exactly like tee's shares the
  // builtin's compiled tables. The ARGMATCH decision is therefore read off
  // the spec in both languages and never stored on the compiled tables,
  // which is the only way the two answer alike here. Mirrors test_parser.py.
  it('gives a structural twin of a builtin spec no argmatch', () => {
    const tee = specOf('tee')
    // Declared the long way round, exactly as builtin_specs/text_proc.ts
    // declares it, so the twin is equal field for field and shares not one
    // Option object with the builtin.
    const twin = new CommandSpec({
      options: [
        new Option({ short: '-a', long: '--append' }),
        new Option({ short: '-i', long: '--ignore-interrupts' }),
        new Option({ short: '-p' }),
        new Option({
          long: '--output-error',
          type: 'str',
          valueOptional: true,
          choices: ['warn', 'warn-nopipe', 'exit', 'exit-nopipe'],
        }),
      ],
      rest: new Operand({ type: 'path' }),
    })
    expect(twin).toEqual(tee)
    expect(twin).not.toBe(tee)
    expect(parseCommand(twin, ['--output-error=exit-n'], '/', 'tee').invalidValueOptions).toEqual([
      ['--output-error', 'exit-n', ['warn', 'warn-nopipe', 'exit', 'exit-nopipe']],
    ])
    expect(parseCommand(tee, ['--output-error=exit-n'], '/', 'tee').flags['--output-error']).toBe(
      'exit-nopipe',
    )
  })

  // An installed CLI's node is outside the table for the same reason, so `gh
  // issue list --state=o` is refused where GNU would resolve it. The CLI's
  // group level already enforces its choices exactly (walk's finishNode), so
  // a leaf that prefix-matched would make one Option.choices mean two things
  // inside one tree. unknownIsOperand says nothing about this: it governs the
  // dash word, not the value. Mirrors test_parser.py.
  it('compares the whole choice word for a CLI node', () => {
    const options = [
      new Option({ long: '--state', type: 'str', choices: ['open', 'closed', 'all'] }),
    ]
    const spec = new CommandSpec({ options })
    const parsed = parseCommand(spec, ['--state=o'], '/', 'gh', undefined, true)
    expect(parsed.flags['--state']).toBe('o')
    expect(parsed.invalidValueOptions).toEqual([['--state', 'o', ['open', 'closed', 'all']]])
    const exact = parseCommand(spec, ['--state=open'], '/', 'gh', undefined, true)
    expect(exact.flags['--state']).toBe('open')
    expect(exact.invalidValueOptions).toEqual([])
    // The same spec parsed without the flag answers identically, which is the
    // point: the choice rule is the table's, not the call's.
    const strict = parseCommand(spec, ['--state=o'], '/', 'gh')
    expect(strict.invalidValueOptions).toEqual([['--state', 'o', ['open', 'closed', 'all']]])
  })

  it('exempts the bare optional-value form', () => {
    const parsed = parseCommand(specOf('tee'), ['--output-error', '/f'], '/', 'tee')
    expect(parsed.flags['--output-error']).toBe(true)
    expect(parsed.invalidValueOptions).toEqual([])
  })

  it('checks every value of a multiple flag', () => {
    const spec = new CommandSpec({
      options: [
        new Option({
          short: '-m',
          type: 'str',
          multiple: true,
          choices: ['x', 'y'],
        }),
      ],
    })
    const parsed = parseCommand(spec, ['-m', 'x', '-m', 'z'], '/')
    expect(parsed.invalidValueOptions).toEqual([['-m', 'z', ['x', 'y']]])
  })

  // `tee --output-error` is one of the spec-declared choices sets that
  // really are gnulib ARGMATCH tables, so the parser resolves a prefix and
  // rewrites the bag to the canonical word. Measured on coreutils 9.7:
  // `tee --output-error=exit-n` exits 0 (exit-nopipe) and `=w` is
  // `ambiguous argument 'w'`.
  it('resolves an unambiguous prefix to the canonical word', () => {
    const parsed = parseCommand(specOf('tee'), ['--output-error=warn-', '/f'], '/', 'tee')
    expect(parsed.flags['--output-error']).toBe('warn-nopipe')
    expect(parsed.invalidValueOptions).toEqual([])
    expect(parsed.ambiguousValueOptions).toEqual([])
  })

  it('leaves an exact word alone rather than reading it as a prefix', () => {
    const parsed = parseCommand(specOf('tee'), ['--output-error=warn', '/f'], '/', 'tee')
    expect(parsed.flags['--output-error']).toBe('warn')
    expect(parsed.invalidValueOptions).toEqual([])
  })

  // The second table, so the rule is the option's and not one command's:
  // measured on 9.7, `numfmt --to=s` is `si` and `--to=ie` is ambiguous
  // between `iec` and `iec-i`.
  it('resolves the other argmatch table own prefixes', () => {
    const parsed = parseCommand(specOf('numfmt'), ['--to=s', '1'], '/', 'numfmt')
    expect(parsed.flags['--to']).toBe('si')
    expect(parsed.ambiguousValueOptions).toEqual([])
    const ambiguous = parseCommand(specOf('numfmt'), ['--to=ie', '1'], '/', 'numfmt')
    expect(ambiguous.optionErrorKinds).toEqual(['ambiguous_value'])
    expect(ambiguous.ambiguousValueOptions).toEqual([
      ['--to', 'ie', ['none', 'si', 'iec', 'iec-i']],
    ])
  })

  it('puts an ambiguous prefix in its own list and on the tape', () => {
    const parsed = parseCommand(specOf('tee'), ['--output-error=w', '/f'], '/', 'tee')
    expect(parsed.optionErrorKinds).toEqual(['ambiguous_value'])
    expect(parsed.ambiguousValueOptions).toEqual([
      ['--output-error', 'w', ['warn', 'warn-nopipe', 'exit', 'exit-nopipe']],
    ])
    expect(parsed.invalidValueOptions).toEqual([])
    // The value the line typed stays in the bag: nothing resolved it, and
    // the renderer names the word as typed.
    expect(parsed.flags['--output-error']).toBe('w')
  })

  it('reports the empty value as ambiguous, not invalid', () => {
    const parsed = parseCommand(specOf('tee'), ['--output-error=', '/f'], '/', 'tee')
    expect(parsed.ambiguousValueOptions).toEqual([
      ['--output-error', '', ['warn', 'warn-nopipe', 'exit', 'exit-nopipe']],
    ])
  })

  it('matches prefixes case-sensitively', () => {
    const parsed = parseCommand(specOf('tee'), ['--output-error=W', '/f'], '/', 'tee')
    expect(parsed.invalidValueOptions).toEqual([
      ['--output-error', 'W', ['warn', 'warn-nopipe', 'exit', 'exit-nopipe']],
    ])
  })

  it('resolves every occurrence of an argmatch flag as it is read', () => {
    // Each occurrence goes through the table as it is scanned, so the one the
    // bag drops is still refused and the one it keeps is still rewritten to
    // its candidate.
    const parsed = parseCommand(specOf('numfmt'), ['--to=ie', '--to=s', '1'], '/', 'numfmt')
    expect(parsed.flags['--to']).toBe('si')
    expect(parsed.ambiguousValueOptions).toEqual([['--to', 'ie', ['none', 'si', 'iec', 'iec-i']]])
  })

  it('checks every occurrence of a scalar flag', () => {
    // GNU refuses the argument as it is scanned (`numfmt --to=bogus
    // --to=si` is refused for bogus), so the value the bag dropped is
    // checked too, in line order.
    const parsed = parseCommand(specOf('numfmt'), ['--to=bogus', '--to=si', '1'], '/')
    expect(parsed.flags['--to']).toBe('si')
    expect(parsed.invalidValueOptions).toEqual([['--to', 'bogus', ['none', 'si', 'iec', 'iec-i']]])
    expect(
      parseCommand(specOf('numfmt'), ['--to=si', '--to=si', '1'], '/').invalidValueOptions,
    ).toEqual([])
  })

  it('reports the first refused value on the line first', () => {
    // GNU stops at the first bad argument it reads, whatever its option
    // and whatever check refuses it, so the kinds tape carries each
    // refusal's tag in scan order for the reporter to follow.
    const spec = new CommandSpec({
      options: [
        new Option({ short: '-n', type: 'int' }),
        new Option({ long: '--mode', type: 'str', choices: ['a', 'b'] }),
      ],
    })
    const parsed = parseCommand(spec, ['--mode', 'bad', '-n', 'abc'], '/')
    expect(parsed.optionErrorKinds).toEqual(['value', 'int'])
    expect(parsed.invalidValueOptions).toEqual([['--mode', 'bad', ['a', 'b']]])
    expect(parsed.invalidIntOptions).toEqual([['-n', 'abc']])
    const both = parseCommand(specOf('numfmt'), ['--from=bad1', '--to=bad2', '1'], '/')
    expect(both.optionErrorKinds).toEqual(['value', 'value'])
    expect(both.invalidValueOptions.map(([dest]) => dest)).toEqual(['--from', '--to'])
  })

  it('int checks cover every occurrence of a scalar flag', () => {
    const spec = new CommandSpec({ options: [new Option({ short: '-n', type: 'int' })] })
    const parsed = parseCommand(spec, ['-n', 'abc', '-n', '3'], '/')
    expect(parsed.flags['-n']).toBe('3')
    expect(parsed.invalidIntOptions).toEqual([['-n', 'abc']])
  })
})

describe('required and default', () => {
  it('reports an absent required option', () => {
    const spec = new CommandSpec({
      options: [new Option({ long: '--out', type: 'str', required: true })],
    })
    expect(parseCommand(spec, [], '/').missingRequiredOptions).toEqual(['--out'])
    expect(parseCommand(spec, ['--out', 'x'], '/').missingRequiredOptions).toEqual([])
  })

  it('lands the default as if typed, satisfying required', () => {
    const spec = new CommandSpec({
      options: [
        new Option({
          long: '--mode',
          type: 'str',
          required: true,
          default: 'fast',
        }),
      ],
    })
    const parsed = parseCommand(spec, [], '/')
    expect(parsed.flags['--mode']).toBe('fast')
    expect(parsed.missingRequiredOptions).toEqual([])
    expect(parseCommand(spec, ['--mode', 'slow'], '/').flags['--mode']).toBe('slow')
  })

  it('resolves and routes a PATH default', () => {
    const spec = new CommandSpec({
      options: [new Option({ long: '--file', type: 'path', default: 'cfg.txt' })],
    })
    const parsed = parseCommand(spec, [], '/data')
    expect(parsed.flags['--file']).toBe('/data/cfg.txt')
    expect(parsed.pathFlagValues).toEqual(['/data/cfg.txt'])
  })
})

describe('multiple + default', () => {
  it('lands the default as a one-element list and resolves PATH values', () => {
    const spec = new CommandSpec({
      options: [
        new Option({
          short: '-f',
          long: '--file',
          type: 'path',
          multiple: true,
          default: 'cfg.txt',
        }),
      ],
    })
    const parsed = parseCommand(spec, [], '/data')
    expect(parsed.flags['--file']).toEqual(['/data/cfg.txt'])
    expect(parsed.pathFlagValues).toEqual(['/data/cfg.txt'])
    const typed = parseCommand(spec, ['-f', 'a', '-f', 'b'], '/data')
    expect(typed.flags['--file']).toEqual(['/data/a', '/data/b'])
  })
})

describe('long-option abbreviation', () => {
  it('expands a unique prefix like getopt_long', () => {
    const spec = new CommandSpec({
      options: [new Option({ long: '--recursive' }), new Option({ long: '--count' })],
    })
    const parsed = parseCommand(spec, ['--rec', 'x'], '/')
    expect(parsed.flags['--recursive']).toBe(true)
    expect(parsed.invalidOptions).toEqual([])
    expect(parsed.ambiguousOptions).toEqual([])
  })

  it('reports ambiguous prefixes with possibilities in declaration order', () => {
    const spec = new CommandSpec({
      options: [
        new Option({ long: '--context', type: 'str' }),
        new Option({ long: '--color', valueOptional: true, type: 'str' }),
        new Option({ long: '--count' }),
      ],
    })
    const parsed = parseCommand(spec, ['--c'], '/')
    expect(parsed.ambiguousOptions).toEqual([['--c', ['--context', '--color', '--count']]])
    expect(parsed.invalidOptions).toEqual([])
  })

  it('lets an exact long win over a longer spelling', () => {
    const spec = new CommandSpec({
      options: [
        new Option({ long: '--binary' }),
        new Option({ long: '--binary-files', type: 'str' }),
      ],
    })
    const parsed = parseCommand(spec, ['--binary'], '/')
    expect(parsed.flags['--binary']).toBe(true)
    expect(parsed.ambiguousOptions).toEqual([])
  })

  it('carries attached and detached values through abbreviation', () => {
    const spec = new CommandSpec({
      options: [
        new Option({ long: '--color', valueOptional: true, type: 'str' }),
        new Option({ long: '--exclude', type: 'str' }),
      ],
    })
    expect(parseCommand(spec, ['--colo=never'], '/').flags['--color']).toBe('never')
    expect(parseCommand(spec, ['--excl', 'tmp'], '/').flags['--exclude']).toBe('tmp')
  })

  // A program with no long-option parser at all (bash's echo builtin,
  // Info-ZIP unzip) never expands an abbreviation, because there is no table
  // to expand against -- and the same line expands it for a getopt command.
  it('matches exactly for a program with no long-option parser', () => {
    const parsed = parseCommand(registered('echo'), ['--hel', 'hi'], '/', 'echo')
    expect(parsed.flags).toEqual({})
    expect(parsed.texts()).toEqual(['--hel', 'hi'])
    const strict = parseCommand(registered('basename'), ['--hel', 'hi'], '/', 'basename')
    expect(strict.flags['--help']).toBe(true)
    expect(strict.texts()).toEqual(['hi'])
  })

  // Both tables describe one real program, so a spec that is not that
  // program's own grammar does not get the rule however the line names it. A
  // mount may register a command under a builtin's name: nothing refuses
  // that, and here the rule would swallow the flag the author declared.
  // Mirrors test_parser.py.
  it('never lets a custom spec inherit a per-program parsing rule', () => {
    const spec = new CommandSpec({
      options: [new Option({ long: '--mode', type: 'str' })],
      rest: new Operand({ type: 'str' }),
    })
    const parsed = parseCommand(spec, ['--mode=x', 'value'], '/', 'expr')
    expect(parsed.flags).toEqual({ '--mode': 'x' })
    expect(parsed.texts()).toEqual(['value'])
    // ... and the same spec keeps its long options where echo has none.
    const lenient = new CommandSpec({
      options: [new Option({ long: '--verbose' })],
      rest: new Operand({ type: 'str' }),
    })
    expect(parseCommand(lenient, ['--verb', 'hi'], '/', 'echo').flags['--verbose']).toBe(true)
  })

  // expr's long options are the two the registry injects into every spec, so
  // the spec has to be the registered one: the declaration carries neither,
  // and a hand-built lookalike is no longer expr's grammar.
  //
  // gnulib's parse_long_options guards on `argc == 2`, so expr reads a long
  // option only when it is the whole line. Measured on coreutils 9.4:
  // `expr --help` helps, `expr --help x` is a syntax error on `x`, and
  // `expr -- --help` prints `--help`.
  it('reads a sole-argument long option, prefix and all', () => {
    const spec = registered('expr')
    const exact = parseCommand(spec, ['--help'], '/', 'expr')
    expect(exact.flags['--help']).toBe(true)
    expect(exact.texts()).toEqual([])
    expect(parseCommand(spec, ['--h'], '/', 'expr').flags['--help']).toBe(true)
    const unknown = parseCommand(spec, ['--hex'], '/', 'expr')
    expect(unknown.flags).toEqual({})
    expect(unknown.invalidOptions).toEqual([])
    expect(unknown.texts()).toEqual(['--hex'])
  })

  it('makes a long option outside the window an operand', () => {
    const spec = registered('expr')
    const outside = parseCommand(spec, ['--help', 'x'], '/', 'expr')
    expect(outside.flags).toEqual({})
    expect(outside.invalidOptions).toEqual([])
    expect(outside.texts()).toEqual(['--help', 'x'])
    const dashed = parseCommand(spec, ['--', '--help'], '/', 'expr')
    expect(dashed.flags).toEqual({})
    expect(dashed.texts()).toEqual(['--help'])
  })
})

describe('int-typed values', () => {
  it('reports a non-integer value, never throws', () => {
    const spec = new CommandSpec({
      options: [new Option({ long: '--port', type: 'int' })],
    })
    const parsed = parseCommand(spec, ['--port', 'abc'], '/')
    expect(parsed.invalidIntOptions).toEqual([['--port', 'abc']])
    const ok = parseCommand(spec, ['--port', '-42'], '/')
    expect(ok.invalidIntOptions).toEqual([])
    expect(ok.flags['--port']).toBe('-42')
  })

  it('checks every value of a multiple flag', () => {
    const spec = new CommandSpec({
      options: [new Option({ long: '--id', type: 'int', multiple: true })],
    })
    const parsed = parseCommand(spec, ['--id', '1', '--id', 'x'], '/')
    expect(parsed.invalidIntOptions).toEqual([['--id', 'x']])
  })
})

describe('synonym long spellings', () => {
  it('resolves a shared prefix like glibc', () => {
    const grep = specOf('grep')
    const parsed = parseCommand(grep, ['--colo', 'pat', '/a.txt'], '/', 'grep')
    expect(parsed.ambiguousOptions).toEqual([])
    expect(parsed.flags['--color']).toBe(true)
    const attached = parseCommand(grep, ['--colo=never', 'pat', '/a.txt'], '/', 'grep')
    expect(attached.flags['--color']).toBe('never')
    expect(parseCommand(specOf('date'), ['--u'], '/', 'date').flags['--utc']).toBe(true)
  })

  // Two declared options are two options, whatever their shape, so a prefix
  // of both is ambiguous, listed in GNU's table order (coreutils 9.7).
  it.each([
    ['ls', ['--re', '/'], ['--reverse', '--recursive']],
    ['uname', ['--k'], ['--kernel-name', '--kernel-release', '--kernel-version']],
    ['mv', ['--no-c', '/a', '/b'], ['--no-clobber', '--no-copy']],
    ['md5sum', ['--st', '/f'], ['--status', '--strict']],
    ['sort', ['--m', '/f'], ['--merge', '--month-sort']],
  ])('%s %j is ambiguous', (name, argv, possible) => {
    const parsed = parseCommand(specOf(name), argv, '/', name)
    expect(parsed.ambiguousOptions).toEqual([[argv[0], possible]])
  })

  it('lists synonyms in an ambiguity like GNU', () => {
    const spec = new CommandSpec({
      options: [
        new Option({ long: '--context', type: 'str' }),
        new Option({ long: '--color', valueOptional: true, type: 'str' }),
        new Option({ long: '--colour', valueOptional: true, type: 'str' }),
        new Option({ long: '--count' }),
      ],
    })
    const parsed = parseCommand(spec, ['--c'], '/')
    expect(parsed.ambiguousOptions).toEqual([
      ['--c', ['--context', '--color', '--colour', '--count']],
    ])
  })

  it('keeps scan order in optionErrorKinds', () => {
    const spec = new CommandSpec({
      options: [new Option({ long: '--context', type: 'str' }), new Option({ long: '--count' })],
    })
    expect(parseCommand(spec, ['--c', '--bogus'], '/').optionErrorKinds).toEqual([
      'ambiguous',
      'invalid',
    ])
    expect(parseCommand(spec, ['--bogus', '--c'], '/').optionErrorKinds).toEqual([
      'invalid',
      'ambiguous',
    ])
  })
})

describe('float-typed values', () => {
  it('reports non-numbers and accepts the portable core', () => {
    const spec = new CommandSpec({ options: [new Option({ long: '--ratio', type: 'float' })] })
    expect(parseCommand(spec, ['--ratio', '5x'], '/').invalidFloatOptions).toEqual([
      ['--ratio', '5x'],
    ])
    for (const good of ['2.5', '-3', '.5', '1e3', '+0.25']) {
      const ok = parseCommand(spec, ['--ratio', good], '/')
      expect(ok.invalidFloatOptions).toEqual([])
      expect(ok.flags['--ratio']).toBe(good)
    }
    for (const bad of ['inf', 'nan', '1_000', '.']) {
      expect(parseCommand(spec, ['--ratio', bad], '/').invalidFloatOptions).toEqual([
        ['--ratio', bad],
      ])
    }
  })
})

describe('two-token options', () => {
  it('consumes both tokens under one dest', () => {
    const p = parseCommand(specOf('jq'), ['--arg', 'v', 'hello', '-n', '$v'], '/')
    expect(p.flags['--arg']).toEqual(['v', 'hello'])
    expect(p.texts()).toEqual(['$v'])
    expect(p.paths()).toEqual([])
  })

  it('accumulates flattened across occurrences', () => {
    const p = parseCommand(specOf('jq'), ['--arg', 'a', '1', '--argjson', 'b', '2', '.'], '/')
    expect(p.flags['--arg']).toEqual(['a', '1'])
    expect(p.flags['--argjson']).toEqual(['b', '2'])
    expect(p.texts()).toEqual(['.'])
  })

  it('never classifies the value as a path', () => {
    const p = parseCommand(specOf('jq'), ['--arg', 'v', '/etc/passwd', '.', '/d/a.json'], '/')
    expect(p.flags['--arg']).toEqual(['v', '/etc/passwd'])
    expect(p.paths()).toEqual(['/d/a.json'])
  })

  it('needs a value when a token is missing', () => {
    expect(parseCommand(specOf('jq'), ['--arg', 'v'], '/').needsValueOptions).toEqual(['--arg'])
  })

  it('has no equals form', () => {
    expect(parseCommand(specOf('jq'), ['--arg=v', 'hello', '.'], '/').invalidOptions).toEqual([
      '--arg=v',
    ])
  })
})

describe('flag-driven operand kinds', () => {
  it('resolves only the value of a path pair', () => {
    const p = parseCommand(specOf('jq'), ['--rawfile', 'body', 'f.txt', '-n', '$body'], '/data')
    expect(p.flags['--rawfile']).toEqual(['body', '/data/f.txt'])
    expect(p.pathFlagValues).toEqual(['/data/f.txt'])
  })

  it('turns later operands into text under --args', () => {
    const p = parseCommand(specOf('jq'), ['--args', '.', 'a', '/etc/passwd'], '/')
    expect(p.texts()).toEqual(['.', 'a', '/etc/passwd'])
    expect(p.paths()).toEqual([])
  })

  it('turns later operands into text under --jsonargs', () => {
    const p = parseCommand(specOf('jq'), ['--jsonargs', '.', '1'], '/')
    expect(p.texts()).toEqual(['.', '1'])
    expect(p.paths()).toEqual([])
  })

  it('keeps operands as paths without those flags', () => {
    const p = parseCommand(specOf('jq'), ['.', '/d/a.json'], '/')
    expect(p.texts()).toEqual(['.'])
    expect(p.paths()).toEqual(['/d/a.json'])
  })
})

describe("parseCommand — tar's old option style", () => {
  it('parses a cluster as flags', () => {
    const p = parseCommand(specOf('tar'), ['xzf', '/data/a.tgz'], '/')
    expect(p.flags['-x']).toBe(true)
    expect(p.flags['-z']).toBe(true)
    expect(p.flags['-f']).toBe('/data/a.tgz')
    expect(p.paths()).toEqual([])
    expect(p.pathFlagValues).toEqual(['/data/a.tgz'])
  })

  it('marks the cluster word TEXT so it is never classified as a path', () => {
    // The cluster carries no dash, so without a TEXT kind the shape
    // heuristic would classify it and dispatch would re-read it as a
    // resolved path instead of letters.
    const p = parseCommand(specOf('tar'), ['xzf', '/data/a.tgz'], '/')
    expect(p.wordKinds).toEqual(['str', 'path'])
  })

  it('keeps operands in their own argv slots', () => {
    const p = parseCommand(
      specOf('tar'),
      ['czf', '/data/a.tgz', '/data/one.txt', '/data/two.txt'],
      '/',
    )
    expect(p.paths()).toEqual(['/data/one.txt', '/data/two.txt'])
    expect(p.wordKinds).toEqual(['str', 'path', 'path', 'path'])
  })

  it('binds two value letters in letter order', () => {
    const p = parseCommand(specOf('tar'), ['xfC', '/data/a.tgz', '/data/out'], '/')
    expect(p.flags['-f']).toBe('/data/a.tgz')
    expect(p.flags['-C']).toEqual(['/data/out'])
  })

  it('keeps a bool letter that follows a value letter', () => {
    const p = parseCommand(specOf('tar'), ['cfz', '/data/a.tgz'], '/')
    expect(p.flags['-f']).toBe('/data/a.tgz')
    expect(p.flags['-z']).toBe(true)
  })

  it('reports a missing cluster argument instead of throwing', () => {
    expect(parseCommand(specOf('tar'), ['xzf'], '/').oldOptionNeedsValue).toBe('f')
  })

  it('reports an undeclared cluster letter as an undeclared option', () => {
    const p = parseCommand(specOf('tar'), ['xQz', '/data/a.tgz'], '/')
    expect(p.invalidOptions).toEqual(['Q'])
    expect(p.oldOptionNeedsValue).toBeNull()
  })

  it('reports no old option on a dashed line', () => {
    const p = parseCommand(specOf('tar'), ['-x', '-z', '-f', '/data/a.tgz'], '/')
    expect(p.oldOptionNeedsValue).toBeNull()
    expect(p.wordKinds).toEqual(['str', 'str', 'str', 'path'])
  })

  it('still accepts long options after the cluster', () => {
    const p = parseCommand(
      specOf('tar'),
      ['xzf', '/data/a.tgz', '--strip-components', '1', '-C', '/data/out'],
      '/',
    )
    expect(p.flags['--strip-components']).toBe('1')
    expect(p.flags['-C']).toEqual(['/data/out'])
  })

  it('is off for every other command', () => {
    // A first word with no dash stays an operand everywhere else.
    const p = parseCommand(specOf('gzip'), ['dkf'], '/')
    expect(p.paths()).toEqual(['/dkf'])
    expect(p.oldOptionNeedsValue).toBeNull()
  })
})

describe('the kind of a word the scan reads as syntax', () => {
  // A null kind sent the word to the shape heuristic, which read
  // `-o/data/s1.txt` as the relative path <cwd>/-o/data/s1.txt, so sort
  // got a phantom input file and no output option at all.
  it.each([
    [['-o/data/s1.txt', '/data/in.txt']],
    [['-uo/data/s1.txt', '/data/in.txt']],
    [['--output=/data/s1.txt', '/data/in.txt']],
  ])('an option word carrying its path is TEXT: %j', (argv) => {
    const p = parseCommand(specOf('sort'), argv, '/')
    expect(p.wordKinds).toEqual(['str', 'path'])
    expect(p.pathFlagValues).toEqual(['/data/s1.txt'])
    expect(p.paths()).toEqual(['/data/in.txt'])
  })

  it('a value word keeps its option kind', () => {
    const p = parseCommand(specOf('sort'), ['-o', '/data/s1.txt', '/data/in.txt'], '/')
    expect(p.wordKinds).toEqual(['str', 'path', 'path'])
  })

  it('an invalid option word is TEXT', () => {
    // GNU refuses the letter: `sort: invalid option -- '/'`. Read as a
    // path, the word reached dispatch resolved and was opened instead.
    const p = parseCommand(specOf('sort'), ['-/data/x.txt', '/data/in.txt'], '/')
    expect(p.wordKinds).toEqual(['str', 'path'])
    expect(p.invalidOptions).toEqual(['/'])
  })

  it('a dash word that is an operand keeps the operand kind', () => {
    expect(parseCommand(specOf('head'), ['--', '-o/data/x.txt'], '/').wordKinds).toEqual([
      'str',
      'path',
    ])
    // unzip has no long-option parser, so an undeclared `--` word is its
    // archive operand.
    expect(parseCommand(specOf('unzip'), ['--a/b.zip'], '/', 'unzip').wordKinds).toEqual(['path'])
  })
})

describe('required operands and typed dests', () => {
  it('reports a missing required operand rather than throwing', () => {
    // The parser classifies and reports; the dialect that words the refusal is
    // the caller's choice, which is why this is a list of names.
    const spec = new CommandSpec({
      positional: [new Operand({ type: 'str', name: 'PAGE_ID', required: true })],
    })
    expect(parseCommand(spec, [], '/').missingRequiredOperands).toEqual(['PAGE_ID'])
    expect(parseCommand(spec, ['abc'], '/').missingRequiredOperands).toEqual([])
  })

  it('lets a flag that supplies a slot satisfy required', () => {
    // providedBy is the declarative form of grep's `if (!pattern_given)`: the
    // slot is skipped, so it cannot also be missing.
    const spec = new CommandSpec({
      options: [new Option({ long: '--expr', short: '-e', type: 'str' })],
      positional: [
        new Operand({ type: 'str', name: 'PATTERN', required: true, providedBy: ['-e'] }),
      ],
    })
    expect(parseCommand(spec, [], '/').missingRequiredOperands).toEqual(['PATTERN'])
    expect(parseCommand(spec, ['-e', 'x'], '/').missingRequiredOperands).toEqual([])
  })

  it('excludes defaults from typed dests and keeps scan order', () => {
    const spec = new CommandSpec({
      options: [
        new Option({ long: '--limit', type: 'int', default: '25' }),
        new Option({ long: '--sort', type: 'str' }),
        new Option({ long: '--json', type: 'bool' }),
      ],
    })
    // --limit is present in flags (the default landed) but was never typed,
    // which is the whole distinction a clap usage line needs.
    const parsed = parseCommand(spec, ['--json', '--sort', 'x'], '/')
    expect(parsed.flags['--limit']).toBe('25')
    expect(parsed.typedDests).toEqual(['--json', '--sort'])
  })
})

describe('operandBase (tar -C)', () => {
  it('re-bases the operands typed after it, leaving -f on the cwd', () => {
    // GNU tar's -C is a chdir for the operands that follow it, so the
    // archive stays relative to the session cwd while the files move.
    const parsed = parseCommand(
      specOf('tar'),
      ['-czf', 'out.tgz', '-C', '/work/check', 'my_paper'],
      '/home',
    )
    expect(parsed.args.filter(([, k]) => k === 'path').map(([v]) => v)).toEqual([
      '/work/check/my_paper',
    ])
    expect(parsed.flags['-f']).toBe('/home/out.tgz')
    expect(parsed.flags['-C']).toEqual(['/work/check'])
  })

  it('is cumulative like a real chdir', () => {
    const parsed = parseCommand(
      specOf('tar'),
      ['-cf', 'a.tar', '-C', 'd1', 'x', '-C', '../d2', 'y'],
      '/work',
    )
    expect(parsed.args.filter(([, k]) => k === 'path').map(([v]) => v)).toEqual([
      '/work/d1/x',
      '/work/d2/y',
    ])
    // Every occurrence is kept in order: GNU chdirs at each one.
    expect(parsed.flags['-C']).toEqual(['/work/d1', '/work/d2'])
  })

  it('only moves what follows it', () => {
    const parsed = parseCommand(
      specOf('tar'),
      ['-cf', 'a.tar', 'top.txt', '-C', '/work/e', 'e.txt'],
      '/work',
    )
    expect(parsed.args.filter(([, k]) => k === 'path').map(([v]) => v)).toEqual([
      '/work/top.txt',
      '/work/e/e.txt',
    ])
  })

  it('survives the old-style cluster', () => {
    const parsed = parseCommand(specOf('tar'), ['czf', 'a.tgz', '-C', 'sub', 'x'], '/work')
    expect(parsed.args.filter(([, k]) => k === 'path').map(([v]) => v)).toEqual(['/work/sub/x'])
    expect(parsed.wordBases.at(-1)).toBe('/work/sub')
  })

  it('records no bases for a spec that declares none', () => {
    const parsed = parseCommand(specOf('cat'), ['a.txt'], '/work')
    expect(parsed.wordBases).toEqual([null])
  })
})

describe('options an environment variable supplies', () => {
  const versioned = new CommandSpec({
    options: [new Option({ long: '--version', type: 'str', env: 'X_VERSION' })],
  })

  it('fills an option the line omitted', () => {
    expect(parseCommand(versioned, [], '/', '', { X_VERSION: '9' }).flags['--version']).toBe('9')
  })

  it('yields to what the line typed', () => {
    const parsed = parseCommand(versioned, ['--version', 'typed'], '/', '', {
      X_VERSION: '9',
    })
    expect(parsed.flags['--version']).toBe('typed')
  })

  it('outranks a declared default', () => {
    const spec = new CommandSpec({
      options: [
        new Option({ long: '--version', type: 'str', default: 'fallback', env: 'X_VERSION' }),
      ],
    })
    expect(parseCommand(spec, [], '/', '', { X_VERSION: '9' }).flags['--version']).toBe('9')
    expect(parseCommand(spec, [], '/', '', {}).flags['--version']).toBe('fallback')
  })

  it('satisfies a required option before it is refused', () => {
    const spec = new CommandSpec({
      options: [new Option({ long: '--version', type: 'str', env: 'X_VERSION', required: true })],
    })
    expect(parseCommand(spec, [], '/', '', { X_VERSION: '9' }).missingRequiredOptions).toEqual([])
    expect(parseCommand(spec, [], '/', '', {}).missingRequiredOptions).toEqual(['--version'])
  })

  it('is coerced and choice-checked like a typed value', () => {
    // Filling after the parse left these unchecked: an int stayed a string
    // nobody validated and a choice was never tested.
    const ints = new CommandSpec({
      options: [new Option({ long: '--count', type: 'int', env: 'X_COUNT' })],
    })
    expect(parseCommand(ints, [], '/', '', { X_COUNT: 'nope' }).invalidIntOptions).toEqual([
      ['--count', 'nope'],
    ])
    expect(parseCommand(ints, [], '/', '', { X_COUNT: '4' }).invalidIntOptions).toEqual([])
    const picks = new CommandSpec({
      options: [new Option({ long: '--mode', type: 'str', choices: ['a', 'b'], env: 'X_MODE' })],
    })
    expect(parseCommand(picks, [], '/', '', { X_MODE: 'zzz' }).invalidValueOptions.length).toBe(1)
    expect(parseCommand(picks, [], '/', '', { X_MODE: 'a' }).invalidValueOptions).toEqual([])
  })

  it('resolves a path value against the cwd like a typed one', () => {
    const spec = new CommandSpec({
      options: [new Option({ long: '--conf', type: 'path', env: 'X_CONF' })],
    })
    expect(parseCommand(spec, [], '/work', '', { X_CONF: 'rel.json' }).flags['--conf']).toBe(
      '/work/rel.json',
    )
  })

  it('does not count as typed', () => {
    // clap's usage line echoes what the line carried; an env-supplied option
    // is supplied but not typed.
    const parsed = parseCommand(versioned, [], '/', '', { X_VERSION: '9' })
    expect(parsed.flags['--version']).toBe('9')
    expect(parsed.typedDests).toEqual([])
  })
})

describe('parseCommand — remainder (argparse nargs=REMAINDER)', () => {
  const PYTHON_LIKE = new CommandSpec({
    options: [new Option({ short: '-c', type: 'str' }), new Option({ short: '-u' })],
    rest: new Operand({ type: 'str', remainder: true }),
  })

  it('rejects an unknown flag before the operand', () => {
    const p = parseCommand(PYTHON_LIKE, ['-z', '-c', 'print(1)'], '/')
    expect(p.invalidOptions).toEqual(['z'])
  })

  it('keeps dash words after the operand verbatim', () => {
    const p = parseCommand(PYTHON_LIKE, ['s.py', '--foo', '-z'], '/')
    expect(p.texts()).toEqual(['s.py', '--foo', '-z'])
    expect(p.invalidOptions).toEqual([])
  })

  it('consumes the marker that hands off the line', () => {
    // The router writes the `--`; the parser eats exactly that one, so
    // the words after it are the program's argv.
    const p = parseCommand(PYTHON_LIKE, ['-c', 'print(1)', '--', '-u', 'x'], '/')
    expect(p.flags['-c']).toBe('print(1)')
    expect(p.flags['-u']).not.toBe(true)
    expect(p.texts()).toEqual(['-u', 'x'])
  })

  // `node - -e x` and `python3 - -c x` both run the piped program and hand
  // it the rest as argv (node 22.8.0, CPython 3.12). Pinning all four
  // together is what keeps js from drifting off python again.
  for (const cmd of ['js', 'node', 'python', 'python3']) {
    it(`${cmd} stops parsing flags at the stdin operand`, () => {
      const p = parseCommand(specOf(cmd), ['-', '-e', 'PROG'], '/')
      expect(p.flags).toEqual({})
      expect(p.texts()).toEqual(['-', '-e', 'PROG'])
    })

    it(`${cmd} hands a script its own flags`, () => {
      const p = parseCommand(specOf(cmd), ['s.js', '-m', '--module'], '/')
      expect(p.flags).toEqual({})
      expect(p.texts()).toEqual(['s.js', '-m', '--module'])
    })
  }

  it('js flags before the first operand are still the interpreter’s', () => {
    const p = parseCommand(specOf('js'), ['-m', '-e', 'CODE', 'a'], '/')
    expect(p.flags['--module']).toBe(true)
    expect(p.flags['-e']).toBe('CODE')
    expect(p.texts()).toEqual(['a'])
  })
})

// A boolean long handed a value is reported as its own kind, not as an
// unrecognized option: getopt_long recognized the option and refused the value.
// The entry carries the CANONICAL spelling plus the typed value, because GNU
// names the canonical one even for an abbreviation.
describe('a boolean long handed a value', () => {
  it.each<[string[], string]>([
    [['--byte-offset=2', 'x'], '--byte-offset=2'],
    // Measured: `grep --byte=2` answers for `--byte-offset`.
    [['--byte=2', 'x'], '--byte-offset=2'],
    [['--line-buffered=', 'x'], '--line-buffered='],
  ])('reports %j as its own kind', (argv, token) => {
    const parsed = parseCommand(specOf('grep'), argv, '/')
    expect(parsed.invalidOptions).toEqual([token])
    expect(parsed.optionErrorKinds).toEqual(['unexpected_value'])
  })

  // The control: the two reports must not collapse into one. `grep --bogus=2`
  // is `unrecognized option '--bogus=2'` with the value quoted, which is a
  // different GNU message.
  it('leaves an undeclared long unrecognized', () => {
    const parsed = parseCommand(specOf('grep'), ['--bogus=2', 'x'], '/')
    expect(parsed.invalidOptions).toEqual(['--bogus=2'])
    expect(parsed.optionErrorKinds).toEqual(['invalid'])
  })

  // A control: only a BOOLEAN long refuses `=value`.
  it('leaves a value long alone', () => {
    const parsed = parseCommand(specOf('nl'), ['--number-width=3'], '/')
    expect(parsed.invalidOptions).toEqual([])
    expect(parsed.optionErrorKinds).toEqual([])
  })

  // GNU stops at the first offending token, so order decides.
  it.each<[string[], string[]]>([
    [
      ['--bogus', '--byte-offset=2'],
      ['invalid', 'unexpected_value'],
    ],
    [
      ['--byte-offset=2', '--bogus'],
      ['unexpected_value', 'invalid'],
    ],
  ])('keeps scan order for %j', (argv, kinds) => {
    const parsed = parseCommand(specOf('grep'), [...argv, 'x'], '/')
    expect(parsed.optionErrorKinds).toEqual(kinds)
  })
})

describe('ParsedArgs helpers', () => {
  const parsed = new ParsedArgs({
    flags: { '-l': true, '--name': 'README' },
    args: [
      ['/ram/x', 'path'],
      ['literal', 'str'],
      ['/ram/y', 'path'],
    ],
    pathFlagValues: ['/ram/z'],
  })

  it('paths() returns PATH args only', () => {
    expect(parsed.paths()).toEqual(['/ram/x', '/ram/y'])
  })

  it('texts() returns TEXT args only', () => {
    expect(parsed.texts()).toEqual(['literal'])
  })

  it('routingPaths() combines paths() and pathFlagValues', () => {
    expect(parsed.routingPaths()).toEqual(['/ram/x', '/ram/y', '/ram/z'])
  })

  it('flag() reads with fallback', () => {
    expect(parsed.flag('-l')).toBe(true)
    expect(parsed.flag('--missing', 'def')).toBe('def')
  })
})

it.each([['-O', '-'], ['-O-']])('keeps wget stdout out of path operands', (...argv) => {
  const parsed = parseCommand(specOf('wget'), [...argv, 'https://example.test/'], '/data', 'wget')
  expect(parsed.flags['-O']).toBe('-')
  expect(parsed.pathFlagValues).toEqual([])
  const literal = parseCommand(
    specOf('wget'),
    ['-O', './-', 'https://example.test/'],
    '/data',
    'wget',
  )
  expect(literal.flags['-O']).toBe('/data/-')
  expect(literal.pathFlagValues).toEqual(['/data/-'])
})
