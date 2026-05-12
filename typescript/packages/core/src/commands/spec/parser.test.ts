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
import { parseCommand, parseToKwargs, resolvePath } from './parser.ts'
import { CommandSpec, Operand, OperandKind, Option, ParsedArgs } from './types.ts'

describe('resolvePath', () => {
  it('passes through absolute paths', () => {
    expect(resolvePath('/cwd', '/abs/path')).toBe('/abs/path')
  })

  it('joins relative paths with cwd', () => {
    expect(resolvePath('/cwd/sub', 'file.txt')).toBe('/cwd/sub/file.txt')
  })

  it('normalizes .. segments', () => {
    expect(resolvePath('/cwd/sub', '../file.txt')).toBe('/cwd/file.txt')
  })
})

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

  it('reproduces the misclassification when -I is missing from the spec', () => {
    const p = parseCommand(grepLikeMissingI, ['-RIl', 'Base3\\|base3', '/r2/Review'], '/')
    // -RIl falls through, becomes the pattern, real pattern shifts to path[0]
    expect(p.texts()).toEqual(['-RIl'])
    expect(p.paths()).toEqual(['/Base3\\|base3', '/r2/Review'])
  })

  it('correctly assigns pattern + path once -I is registered', () => {
    const p = parseCommand(grepLikeFull, ['-RIl', 'Base3\\|base3', '/r2/Review'], '/')
    expect(p.flags).toEqual({ '-R': true, '-I': true, '-l': true })
    expect(p.texts()).toEqual(['Base3\\|base3'])
    expect(p.paths()).toEqual(['/r2/Review'])
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
