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
import { CommandSpec, Operand, Option, ParsedArgs } from './types.ts'

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

describe('parseCommand — --cache extraction', () => {
  const spec = new CommandSpec({ rest: new Operand({ type: 'path' }) })

  it('greedily consumes non-flag args into cachePaths, matching Python', () => {
    const p = parseCommand(spec, ['--cache', '/ram/cached', '/ram/x'], '/')
    expect(p.cachePaths).toEqual(['/ram/cached', '/ram/x'])
    expect(p.paths()).toEqual([])
  })

  it('stops --cache loop at the next flag token', () => {
    const spec2 = new CommandSpec({
      options: [new Option({ short: '-l' })],
      rest: new Operand({ type: 'path' }),
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
  it('uses only an attached value and leaves the next option intact', () => {
    const bare = parseCommand(specOf('split'), ['-d', '-l', '2', '/input', '/prefix'], '/')
    const attached = parseCommand(specOf('split'), ['-d10', '/input'], '/')
    expect(bare.flags['--numeric-suffixes']).toBe(true)
    expect(bare.flags['--lines']).toBe('2')
    expect(bare.paths()).toEqual(['/input', '/prefix'])
    expect(attached.flags['--numeric-suffixes']).toBe('10')
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
  it('unifies -d10 onto --numeric-suffixes and honors order both ways', () => {
    // Last-wins holds for `--long=` and the short form alike.
    const attached = parseCommand(specOf('split'), ['-d10', '/in', '/pre'], '/')
    expect(attached.flags['--numeric-suffixes']).toBe('10')
    expect('-d' in attached.flags).toBe(false)

    const shortLast = parseCommand(
      specOf('split'),
      ['--numeric-suffixes=3', '-d10', '/in', '/p'],
      '/',
    )
    expect(shortLast.flags['--numeric-suffixes']).toBe('10')

    const longLast = parseCommand(
      specOf('split'),
      ['-d10', '--numeric-suffixes=3', '/in', '/p'],
      '/',
    )
    expect(longLast.flags['--numeric-suffixes']).toBe('3')
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
    const parsed = parseCommand(specOf('tee'), ['--output-error=bogus', '/f'], '/')
    expect(parsed.invalidValueOptions).toEqual([
      ['--output-error', 'bogus', ['warn', 'warn-nopipe', 'exit', 'exit-nopipe']],
    ])
    expect(
      parseCommand(specOf('tee'), ['--output-error=warn', '/f'], '/').invalidValueOptions,
    ).toEqual([])
  })

  it('exempts the bare optional-value form', () => {
    const parsed = parseCommand(specOf('tee'), ['--output-error', '/f'], '/')
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

  it('keeps exact-only matching for free-text commands', () => {
    const spec = new CommandSpec({
      options: [new Option({ long: '--verbose' })],
      rest: new Operand({ type: 'str' }),
    })
    const parsed = parseCommand(spec, ['--verb', 'hi'], '/')
    expect(parsed.flags['--verbose']).toBeUndefined()
    expect(parsed.texts()).toEqual(['--verb', 'hi'])
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
    const parsed = parseCommand(grep, ['--colo', 'pat', '/a.txt'], '/')
    expect(parsed.ambiguousOptions).toEqual([])
    expect(parsed.flags['--color']).toBe(true)
    const attached = parseCommand(grep, ['--colo=never', 'pat', '/a.txt'], '/')
    expect(attached.flags['--color']).toBe('never')
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
    // The cluster carries no dash, so without an explicit TEXT kind the
    // shape heuristic would classify it and dispatch would re-read it as
    // a resolved path instead of letters.
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
    expect(p.wordKinds).toEqual([null, null, null, 'path'])
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
