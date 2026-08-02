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
import { flagKwargName } from './constants.ts'
import { CommandSpec, FlagView, OperandKind, Option, specFlagNames } from './types.ts'

// Mirrors python/tests/commands/spec/test_types.py.

describe('FlagView', () => {
  it('reads each flag shape at its declared type', () => {
    const fl = new FlagView({ i: true, m: '5', type: 'py', e: ['a', 'b'] })
    expect(fl.asBool('i')).toBe(true)
    expect(fl.asBool('v')).toBe(false)
    expect(fl.asInt('m')).toBe(5)
    expect(fl.asInt('A')).toBeUndefined()
    expect(fl.asStr('type')).toBe('py')
    expect(fl.asStr('glob')).toBeUndefined()
    expect(fl.asList('e')).toEqual(['a', 'b'])
    expect(fl.asList('f')).toEqual([])
  })

  // Python's as_int calls int(), which raises on a partial or junk value.
  // parseInt would take the '5' out of '5x' and return NaN for 'abc', and
  // NaN is still a number, so a bad value would flow on undetected.
  it('rejects a value that is not wholly an integer', () => {
    expect(() => new FlagView({ m: '5x' }).asInt('m')).toThrow(/expects an integer/)
    expect(() => new FlagView({ m: 'abc' }).asInt('m')).toThrow(/expects an integer/)
    expect(() => new FlagView({ m: '' }).asInt('m')).toThrow(/expects an integer/)
    expect(() => new FlagView({ m: '1.5' }).asInt('m')).toThrow(/expects an integer/)
  })

  it('accepts the forms Python int() accepts', () => {
    expect(new FlagView({ m: ' 42 ' }).asInt('m')).toBe(42)
    expect(new FlagView({ m: '-7' }).asInt('m')).toBe(-7)
    expect(new FlagView({ m: '+7' }).asInt('m')).toBe(7)
    expect(new FlagView({ m: '1_0' }).asInt('m')).toBe(10)
  })

  it('coerces a single string to a one-element list', () => {
    expect(new FlagView({ e: 'solo' }).asList('e')).toEqual(['solo'])
  })

  it('is lenient without a spec', () => {
    const fl = new FlagView({ anything: true })
    expect(fl.asBool('anything')).toBe(true)
    expect(fl.asBool('missing')).toBe(false)
  })

  // The whole point of passing a spec: a missing key is otherwise
  // indistinguishable from "flag not passed", so a typo reads as false.
  it('rejects names the spec does not declare', () => {
    const fl = new FlagView({ i: true }, specOf('grep'))
    expect(fl.asBool('i')).toBe(true)
    expect(() => fl.asBool('ignorecase')).toThrow(/ignorecase/)
    expect(() => fl.asInt('max_count')).toThrow()
    expect(() => fl.asList('patterns')).toThrow()
  })

  it('exposes the raw value for callers that validate it themselves', () => {
    expect(new FlagView({ output_error: 'warn' }).raw('output_error')).toBe('warn')
    expect(new FlagView({}).raw('output_error')).toBeUndefined()
  })
})

describe('specFlagNames', () => {
  it('returns canonical names only, ambiguous spellings mapped', () => {
    const spec = new CommandSpec({
      options: [
        new Option({ short: 'l' }),
        new Option({ short: 'm', long: '--max-count', valueKind: OperandKind.TEXT }),
        new Option({ long: '--hidden' }),
      ],
    })
    // One name per option: the long spelling wins when both exist, so a
    // stale short-name read throws instead of silently reading false.
    expect([...specFlagNames(spec)].sort()).toEqual(['args_l', 'hidden', 'max_count'])
  })
})

describe('flagKwargName', () => {
  it('strips dashes and matches the dispatcher spelling', () => {
    expect(flagKwargName('-i')).toBe('i')
    expect(flagKwargName('--max-count')).toBe('max_count')
    expect(flagKwargName('l')).toBe('args_l')
  })
})

describe('FlagView — count values', () => {
  it('reads a count int through asInt and asBool', () => {
    const fl = new FlagView({ verbose: 3 })
    expect(fl.asInt('verbose')).toBe(3)
    expect(fl.asBool('verbose')).toBe(true)
    expect(new FlagView({ verbose: 0 }).asBool('verbose')).toBe(false)
  })

  it('never reads a boolean as an int', () => {
    const fl = new FlagView({ append: true })
    expect(fl.asInt('append')).toBeUndefined()
    expect(fl.asBool('append')).toBe(true)
  })
})
