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
import { compileSpec, expandGitLong, expandLong, expandTableLong } from './compile.ts'
import { TAR_LONG_OPTIONS } from './constants.ts'
import { CommandSpec, Argument } from './types.ts'

describe('compileSpec — count/choices/required/default tables', () => {
  it('collects the new tables keyed by canonical spelling', () => {
    const spec = new CommandSpec({
      arguments: [
        new Argument(['-v', '--verbose'], { action: 'count' }),
        new Argument('--mode', { choices: ['a', 'b'], default: 'a' }),
        new Argument('--out', { required: true }),
      ],
    })
    const cs = compileSpec(spec)
    expect(cs.countDests).toEqual(new Set(['--verbose']))
    expect(cs.choicesByDest).toEqual(new Map([['--mode', ['a', 'b']]]))
    expect(cs.requiredDests).toEqual(['--out'])
    expect(cs.defaults).toEqual(new Map([['--mode', 'a']]))
  })

  it('rejects count on a value flag', () => {
    const spec = new CommandSpec({
      arguments: [new Argument('--level', { action: 'count', type: 'int' })],
    })
    expect(() => compileSpec(spec)).toThrow(/do not take a type or nargs/)
  })

  it('rejects choices or default on a boolean flag', () => {
    const spec = new CommandSpec({
      arguments: [new Argument('--quiet', { action: 'store_true', choices: ['a', 'b'] })],
    })
    expect(() => compileSpec(spec)).toThrow(/require a value flag/)
  })

  it('rejects a default outside the choices set', () => {
    const spec = new CommandSpec({
      arguments: [new Argument('--mode', { choices: ['a', 'b'], default: 'c' })],
    })
    expect(() => compileSpec(spec)).toThrow(/not one of its choices/)
  })

  it('caches per spec object', () => {
    const spec = new CommandSpec({ arguments: [new Argument('-x', { action: 'store_true' })] })
    expect(compileSpec(spec)).toBe(compileSpec(spec))
  })

  it('requires an option spelling', () => {
    const spec = new CommandSpec({ arguments: [new Argument([], { action: 'store_true' })] })
    expect(() => compileSpec(spec)).toThrow(/requires a name or option spelling/)
  })

  it.each([
    [new Argument('-m', { action: 'store_true' }), new Argument('-m')],
    [new Argument('--mode', { action: 'store_true' }), new Argument('--mode')],
  ])('rejects duplicate option spellings', (first, second) => {
    const spec = new CommandSpec({ arguments: [first, second] })
    expect(() => compileSpec(spec)).toThrow(/duplicate option spelling/)
  })
})

describe('type int validation', () => {
  it('requires a numeric float default', () => {
    expect(() =>
      compileSpec(
        new CommandSpec({
          arguments: [new Argument('--ratio', { type: 'float', default: 'fast' })],
        }),
      ),
    ).toThrow(/is not a number/)
  })

  it('requires an integer default', () => {
    expect(() =>
      compileSpec(
        new CommandSpec({ arguments: [new Argument('--port', { type: 'int', default: 'auto' })] }),
      ),
    ).toThrow(/is not an integer/)
  })
})

describe('expandLong', () => {
  it('handles exact, prefix, ambiguous, and unknown spellings', () => {
    const cs = compileSpec(
      new CommandSpec({
        arguments: [
          new Argument('--binary', { action: 'store_true' }),
          new Argument('--binary-files'),
          new Argument('--count', { action: 'store_true' }),
        ],
      }),
    )
    expect(expandLong(cs, '--binary')).toEqual(['--binary'])
    expect(expandLong(cs, '--bin')).toEqual(['--binary', '--binary-files'])
    expect(expandLong(cs, '--co')).toEqual(['--count'])
    expect(expandLong(cs, '--zz')).toEqual([])
    expect(expandLong(cs, '--')).toEqual([])
  })

  // Two options of one shape are still two options; only a named synonym
  // folds a shared prefix into one (glibc's entries sharing one `val`).
  it('resolves a shared prefix only across named synonyms', () => {
    const cs = compileSpec(
      new CommandSpec({
        arguments: [
          new Argument('--color', { action: 'store_true' }),
          new Argument('--colour', { action: 'store_true' }),
          new Argument('--count', { action: 'store_true' }),
        ],
      }),
    )
    expect(expandLong(cs, '--col')).toEqual(['--color', '--colour'])
    expect(expandLong(cs, '--col', new Map([['--colour', '--color']]))).toEqual(['--color'])
    expect(expandLong(cs, '--co', new Map([['--colour', '--color']]))).toEqual([
      '--color',
      '--colour',
      '--count',
    ])
  })
})

describe('pair options', () => {
  it('refuses a boolean flag', () => {
    const spec = new CommandSpec({
      arguments: [new Argument('--arg', { action: 'store_true', nargs: 2 })],
    })
    expect(() => compileSpec(spec)).toThrow(/do not take a type or nargs/)
  })
})

// git 2.50.1's `branch` and `show-ref` tables, as far as these cases reach.
const BRANCH = [
  '[no-]verbose',
  '[no-]color',
  'contains',
  'no-contains',
  '[no-]move',
  'merged',
  'no-merged',
]
const SHOW_REF = ['[no-]heads', '[no-]head']

describe('expandGitLong', () => {
  it('lets an exact name win over a longer one it prefixes', () => {
    expect(expandGitLong(SHOW_REF, '--head')).toEqual({ spelling: '--head' })
  })

  it('expands a unique abbreviation, `no-` included', () => {
    expect(expandGitLong(BRANCH, '--verb')).toEqual({ spelling: '--verbose' })
    expect(expandGitLong(BRANCH, '--no-verb')).toEqual({ spelling: '--no-verbose' })
    expect(expandGitLong(BRANCH, '--no-cont')).toEqual({ spelling: '--no-contains' })
  })

  it('names the last two candidates of an ambiguity, as git does', () => {
    expect(expandGitLong(BRANCH, '--no-m')).toEqual({ ambiguous: ['--no-move', '--no-merged'] })
    expect(expandGitLong(SHOW_REF, '--hea')).toEqual({ ambiguous: ['--heads', '--head'] })
  })

  it('answers nothing for a word no option starts with', () => {
    expect(expandGitLong(BRANCH, '--zzz')).toBeNull()
    expect(expandGitLong([], '--verb')).toBeNull()
  })
})

describe('expandTableLong', () => {
  // Mirrors python's test_table_long_resolves_as_the_programs_getopt_long_does.
  it.each([
    // An entry spelled exactly names its option, an alias its primary.
    ['--file', ['--file']],
    ['--get', ['--extract']],
    ['--ungzip', ['--gzip']],
    // A prefix one option owns resolves, its aliases included.
    ['--crea', ['--create']],
    ['--gun', ['--gzip']],
    ['--dir', ['--directory']],
    ['--vers', ['--version']],
    // A prefix of two options is ambiguous in table order, an option mirage
    // never declared included (GNU tar 1.35's own lines).
    ['--fil', ['--file', '--files-from']],
    ['--li', ['--list', '--listed-incremental']],
    ['--us', ['--use-compress-program', '--usage']],
    ['--ver', ['--verify', '--verbose', '--verbatim-files-from', '--version']],
    ['--to', ['--to-stdout', '--to-command', '--touch', '--totals']],
    ['--zzz', []],
    ['--', []],
  ])('resolves %s as tar does', (typed, found) => {
    expect(expandTableLong(TAR_LONG_OPTIONS, typed)).toEqual(found)
  })

  it('lists every later candidate naming another option', () => {
    // glibc compares each later match with the FIRST one only, so a later
    // alias of a third option is listed beside its own primary.
    const table = [['--apple'], ['--apricot', '--apron'], ['--ape']]
    expect(expandTableLong(table, '--ap')).toEqual(['--apple', '--apricot', '--apron', '--ape'])
    expect(expandTableLong([['--apricot', '--apron']], '--apr')).toEqual(['--apricot'])
  })
})
