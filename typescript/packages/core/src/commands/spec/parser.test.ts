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
import { specOf } from './builtins.ts'
import { parseCommand, parseToKwargs } from './parser.ts'
import { CommandSpec, Operand, OperandKind, Option, ParsedArgs } from './types.ts'

describe('parseCommand — bool short flags', () => {
  const spec = new CommandSpec({
    options: [new Option({ short: '-l' }), new Option({ short: '-a' })],
    rest: new Operand({ kind: OperandKind.PATH }),
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
    options: [
      new Option({ short: '-n', valueKind: OperandKind.TEXT }),
      new Option({ short: '-o', valueKind: OperandKind.PATH }),
    ],
    rest: new Operand({ kind: OperandKind.PATH }),
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
})

describe('parseCommand — numericShorthand', () => {
  const spec = new CommandSpec({
    options: [new Option({ short: '-n', valueKind: OperandKind.TEXT, numericShorthand: true })],
    rest: new Operand({ kind: OperandKind.PATH }),
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
      options: [new Option({ short: '-n', valueKind: OperandKind.TEXT })],
      rest: new Operand({ kind: OperandKind.PATH }),
    })
    const p = parseCommand(noShortcut, ['-3', '/ram/x'], '/')
    expect(p.flags['-n']).toBeUndefined()
  })
})

describe('parseCommand — long flags', () => {
  const spec = new CommandSpec({
    options: [
      new Option({ long: '--verbose' }),
      new Option({ long: '--name', valueKind: OperandKind.TEXT }),
    ],
    rest: new Operand({ kind: OperandKind.PATH }),
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
    positional: [new Operand({ kind: OperandKind.TEXT }), new Operand({ kind: OperandKind.PATH })],
  })

  it('classifies args by positional kind', () => {
    const p = parseCommand(spec, ['pattern', '/ram/x'], '/')
    expect(p.args).toEqual([
      ['pattern', OperandKind.TEXT],
      ['/ram/x', OperandKind.PATH],
    ])
  })

  it('drops extra args when no rest', () => {
    const p = parseCommand(spec, ['pattern', '/ram/x', 'extra'], '/')
    expect(p.args).toHaveLength(2)
  })
})

describe('parseCommand — --cache extraction', () => {
  const spec = new CommandSpec({ rest: new Operand({ kind: OperandKind.PATH }) })

  it('greedily consumes non-flag args into cachePaths, matching Python', () => {
    const p = parseCommand(spec, ['--cache', '/ram/cached', '/ram/x'], '/')
    expect(p.cachePaths).toEqual(['/ram/cached', '/ram/x'])
    expect(p.paths()).toEqual([])
  })

  it('stops --cache loop at the next flag token', () => {
    const spec2 = new CommandSpec({
      options: [new Option({ short: '-l' })],
      rest: new Operand({ kind: OperandKind.PATH }),
    })
    const p = parseCommand(spec2, ['--cache', '/ram/cached', '-l', '/ram/x'], '/')
    expect(p.cachePaths).toEqual(['/ram/cached'])
    expect(p.flags['-l']).toBe(true)
    expect(p.paths()).toEqual(['/ram/x'])
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
    positional: [new Operand({ kind: OperandKind.TEXT })],
    rest: new Operand({ kind: OperandKind.PATH }),
  })

  const grepLikeFull = new CommandSpec({
    options: [
      new Option({ short: '-R' }),
      new Option({ short: '-I' }),
      new Option({ short: '-l' }),
    ],
    positional: [new Operand({ kind: OperandKind.TEXT })],
    rest: new Operand({ kind: OperandKind.PATH }),
  })

  it('drops the cluster with a warning when -I is missing from the spec', () => {
    const p = parseCommand(grepLikeMissingI, ['-RIl', 'Base3\\|base3', '/r2/Review'], '/')
    // -RIl can't fully resolve; it is dropped with a warning instead of
    // becoming the pattern and shifting the real pattern into the paths.
    expect(p.texts()).toEqual(['Base3\\|base3'])
    expect(p.paths()).toEqual(['/r2/Review'])
    expect(p.warnings.some((w) => w.includes('-RIl'))).toBe(true)
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
    options: [
      new Option({ short: '-n' }),
      new Option({ short: '-e', valueKind: OperandKind.TEXT }),
    ],
    positional: [new Operand({ kind: OperandKind.TEXT, providedBy: ['-e'] })],
    rest: new Operand({ kind: OperandKind.PATH }),
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

describe('parseCommand — repeatable value flags accumulate newline-joined', () => {
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

  it('non-repeatable value flags keep the last value', () => {
    const p = parseCommand(specOf('grep'), ['-m', '1', '-m', '2', 'pat'], '/')
    expect(p.flags['-m']).toBe('2')
  })

  it('cluster into a repeatable flag accumulates', () => {
    const p = parseCommand(specOf('grep'), ['-ne', 'foo', '-e', 'bar', '/a.txt'], '/')
    expect(p.flags['-n']).toBe(true)
    expect(p.flags['-e']).toEqual(['foo', 'bar'])
    expect(p.paths()).toEqual(['/a.txt'])
  })

  it('long =value and separate forms of a repeatable flag accumulate', () => {
    const spec = new CommandSpec({
      options: [new Option({ long: '--tag', valueKind: OperandKind.TEXT, repeatable: true })],
      rest: new Operand({ kind: OperandKind.PATH }),
    })
    const p = parseCommand(spec, ['--tag=a', '--tag', 'b', '/x'], '/')
    expect(p.flags['--tag']).toEqual(['a', 'b'])
    expect(p.paths()).toEqual(['/x'])
  })

  it('accumulates repeated -e for rg and frees the positional slot', () => {
    const p = parseCommand(specOf('rg'), ['-e', 'foo', '-e', 'bar', '/x'], '/')
    expect(p.flags['-e']).toEqual(['foo', 'bar'])
    expect(p.texts()).toEqual([])
    expect(p.paths()).toEqual(['/x'])
  })
})

describe('parseCommand — grep -f pattern file', () => {
  it('frees the positional slot and routes the pattern file', () => {
    const p = parseCommand(specOf('grep'), ['-f', 'pats.txt', 'a.txt'], '/data')
    expect(p.flags['-f']).toEqual(['/data/pats.txt'])
    expect(p.texts()).toEqual([])
    expect(p.paths()).toEqual(['/data/a.txt'])
    expect(p.routingPaths()).toContain('/data/pats.txt')
  })

  it('keeps -e and -f together', () => {
    const p = parseCommand(specOf('grep'), ['-e', 'foo', '-f', '/p.txt', '/a.txt'], '/')
    expect(p.flags['-e']).toEqual(['foo'])
    expect(p.flags['-f']).toEqual(['/p.txt'])
    expect(p.paths()).toEqual(['/a.txt'])
  })

  it('repeated -f accumulates and routes each file', () => {
    const p = parseCommand(specOf('grep'), ['-f', 'p1.txt', '-f', 'p2.txt', 'a.txt'], '/data')
    expect(p.flags['-f']).toEqual(['/data/p1.txt', '/data/p2.txt'])
    expect(p.paths()).toEqual(['/data/a.txt'])
    expect(p.routingPaths()).toContain('/data/p1.txt')
    expect(p.routingPaths()).toContain('/data/p2.txt')
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
    expect(p.flags['--type']).toBe('md')
    expect(p.texts()).toEqual(['pat'])
    expect(p.paths()).toEqual(['/x'])
  })

  it('unknown long flag with = is dropped with a warning', () => {
    const p = parseCommand(specOf('grep'), ['--color=auto', 'pat', '/a.txt'], '/')
    expect(p.flags['--color']).toBeUndefined()
    expect(p.texts()).toEqual(['pat'])
    expect(p.paths()).toEqual(['/a.txt'])
    expect(p.warnings.some((w) => w.includes('--color=auto'))).toBe(true)
  })
})

describe('parseCommand — unknown dash tokens warn and drop', () => {
  it('drops unknown long flags from operands', () => {
    const p = parseCommand(specOf('grep'), ['--bogus', 'pat', '/a.txt'], '/')
    expect(p.texts()).toEqual(['pat'])
    expect(p.paths()).toEqual(['/a.txt'])
    expect(p.warnings.some((w) => w.includes('--bogus'))).toBe(true)
  })

  it('keeps dash tokens for TEXT-rest commands', () => {
    const p = parseCommand(specOf('python'), ['-x', 'hello'], '/')
    expect(p.texts()).toEqual(['-x', 'hello'])
    expect(p.warnings).toEqual([])
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

  it('unknown char in cluster drops the token with a warning', () => {
    const p = parseCommand(specOf('grep'), ['-nx', 'pat', '/a.txt'], '/')
    expect(p.flags['-n']).toBeUndefined()
    expect(p.texts()).toEqual(['pat'])
    expect(p.warnings.some((w) => w.includes('-nx'))).toBe(true)
  })

  it('find multi-char short flags still work', () => {
    const p = parseCommand(specOf('find'), ['/data', '-name', '*.txt'], '/')
    expect(p.flags['-name']).toEqual(['*.txt'])
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
