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
import { compileSpec, expandLong } from './compile.ts'
import { CommandSpec, Option } from './types.ts'

describe('compileSpec — count/choices/required/default tables', () => {
  it('collects the new tables keyed by canonical spelling', () => {
    const spec = new CommandSpec({
      options: [
        new Option({ short: '-v', long: '--verbose', count: true }),
        new Option({
          long: '--mode',
          type: 'str',
          choices: ['a', 'b'],
          default: 'a',
        }),
        new Option({ long: '--out', type: 'str', required: true }),
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
      options: [new Option({ long: '--level', type: 'str', count: true })],
    })
    expect(() => compileSpec(spec)).toThrow(/count requires a boolean flag/)
  })

  it('rejects choices or default on a boolean flag', () => {
    const spec = new CommandSpec({
      options: [new Option({ long: '--quiet', choices: ['a', 'b'] })],
    })
    expect(() => compileSpec(spec)).toThrow(/require a value flag/)
  })

  it('rejects a default outside the choices set', () => {
    const spec = new CommandSpec({
      options: [
        new Option({
          long: '--mode',
          type: 'str',
          choices: ['a', 'b'],
          default: 'c',
        }),
      ],
    })
    expect(() => compileSpec(spec)).toThrow(/not one of its choices/)
  })

  it('caches per spec object', () => {
    const spec = new CommandSpec({ options: [new Option({ short: '-x' })] })
    expect(compileSpec(spec)).toBe(compileSpec(spec))
  })
})

describe('type int validation', () => {
  it('requires a numeric float default', () => {
    expect(() =>
      compileSpec(
        new CommandSpec({
          options: [new Option({ long: '--ratio', type: 'float', default: 'fast' })],
        }),
      ),
    ).toThrow(/is not a number/)
  })

  it('requires an integer default', () => {
    expect(() =>
      compileSpec(
        new CommandSpec({
          options: [
            new Option({
              long: '--port',
              type: 'int',
              default: 'auto',
            }),
          ],
        }),
      ),
    ).toThrow(/is not an integer/)
  })
})

describe('expandLong', () => {
  it('handles exact, prefix, ambiguous, and unknown spellings', () => {
    const cs = compileSpec(
      new CommandSpec({
        options: [
          new Option({ long: '--binary' }),
          new Option({ long: '--binary-files', type: 'str' }),
          new Option({ long: '--count' }),
        ],
      }),
    )
    expect(expandLong(cs, '--binary')).toEqual(['--binary'])
    expect(expandLong(cs, '--bin')).toEqual(['--binary', '--binary-files'])
    expect(expandLong(cs, '--co')).toEqual(['--count'])
    expect(expandLong(cs, '--zz')).toEqual([])
    expect(expandLong(cs, '--')).toEqual([])
  })
})

describe('pair options', () => {
  it('refuses a boolean flag', () => {
    const spec = new CommandSpec({ options: [new Option({ long: '--arg', pair: true })] })
    expect(() => compileSpec(spec)).toThrow(/pair requires a value flag/)
  })

  it('refuses a short spelling', () => {
    const spec = new CommandSpec({
      options: [new Option({ short: '-a', long: '--arg', type: 'str', pair: true })],
    })
    expect(() => compileSpec(spec)).toThrow(/pair requires a long spelling/)
  })

  it('types only the value of a path pair', () => {
    // jq --rawfile name file: the name is text, the file is a path.
    const spec = new CommandSpec({
      options: [new Option({ long: '--rawfile', type: 'path', pair: true })],
    })
    const compiled = compileSpec(spec)
    expect(compiled.kindByDest.get('--rawfile')).toBe('path')
    expect(compiled.pairDests.has('--rawfile')).toBe(true)
  })

  it('accumulates like multiple', () => {
    const spec = new CommandSpec({
      options: [new Option({ long: '--arg', type: 'str', pair: true })],
    })
    const compiled = compileSpec(spec)
    expect(compiled.pairDests.has('--arg')).toBe(true)
    expect(compiled.multipleDests.has('--arg')).toBe(true)
  })
})
