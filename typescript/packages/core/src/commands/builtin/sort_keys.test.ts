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
import { SortKeyError } from './errors.ts'
import {
  buildConfig,
  compareLines,
  computeFields,
  extract,
  type KeyMods,
  merged,
  parseKeydef,
  type SortConfig,
  sortLines,
} from './sort_keys.ts'

const G: KeyMods = {
  numeric: false,
  human: false,
  version: false,
  month: false,
  fold: false,
  reverse: false,
}

function configOf(flags: Record<string, string | boolean | number | string[]> = {}): SortConfig {
  const on = (name: string): boolean => flags[name] === true
  const rawK = flags.k
  return buildConfig({
    keyDefs: Array.isArray(rawK) ? rawK : typeof rawK === 'string' ? [rawK] : [],
    fieldSep: typeof flags.t === 'string' ? flags.t : null,
    reverse: on('r'),
    numeric: on('n'),
    unique: on('u'),
    foldCase: on('f'),
    humanNumeric: on('h'),
    versionSort: on('V'),
    monthSort: on('M'),
    ignoreBlanks: on('b'),
    stable: on('s'),
    generalNumeric: on('g'),
    dictionary: on('d'),
    ignoreNonprinting: on('i'),
  })
}

function lines(
  text: string,
  flags: Record<string, string | boolean | number | string[]> = {},
): string[] {
  return sortLines(text.split('\n'), configOf(flags))
}

describe('field model', () => {
  it('default sep: leading blanks belong to the following field', () => {
    const fields = computeFields('  zeta    5  x', null)
    expect(fields.map((f) => f[0])).toEqual([0, 6, 11])
  })

  it('explicit sep: no blank collapsing, empty fields kept', () => {
    const fields = computeFields('a::b', ':')
    expect(fields.length).toBe(3)
    expect(fields[1]).toEqual([2, 2, 2])
  })
})

describe('parseKeydef', () => {
  it('field only extends to EOL', () => {
    const key = parseKeydef('2', G, false)
    expect(key.startField).toBe(2)
    expect(key.startChar).toBe(1)
    expect(key.endField).toBeNull()
  })

  it('range with char offsets', () => {
    const key = parseKeydef('2.3,4.5', G, false)
    expect([key.startField, key.startChar]).toEqual([2, 3])
    expect([key.endField, key.endChar]).toEqual([4, 5])
  })

  it('per-key numeric overrides global reverse', () => {
    const key = parseKeydef('2,2n', { ...G, reverse: true }, false)
    expect(key.mods.numeric).toBe(true)
    expect(key.mods.reverse).toBe(false)
  })

  it('blank flag suppresses global inheritance', () => {
    const key = parseKeydef('2b', { ...G, numeric: true }, false)
    expect(key.mods.numeric).toBe(false)
    expect(key.startSkip).toBe(true)
  })

  it('no own options inherits globals', () => {
    const key = parseKeydef('2', { ...G, numeric: true, reverse: true }, true)
    expect(key.mods.numeric).toBe(true)
    expect(key.mods.reverse).toBe(true)
    expect(key.startSkip).toBe(true)
  })

  it('zero field throws', () => {
    expect(() => parseKeydef('0', G, false)).toThrow(SortKeyError)
  })

  it('unknown ordering letter throws', () => {
    expect(() => parseKeydef('2x', G, false)).toThrow(SortKeyError)
  })

  it('h is an ordering letter', () => {
    const key = parseKeydef('1,1h', { ...G, numeric: true }, false)
    expect(key.mods.human).toBe(true)
    expect(key.mods.numeric).toBe(false)
  })

  it('a number takes leading blanks and a plus', () => {
    expect(parseKeydef('+2', G, false).startField).toBe(2)
    expect(parseKeydef(' 2', G, false).startField).toBe(2)
    expect(parseKeydef('\t2', G, false).startField).toBe(2)
    expect(parseKeydef('1.+2', G, false).startChar).toBe(2)
    expect(parseKeydef('1,+2', G, false).endField).toBe(2)
  })

  it('a zero end offset is the end of its field', () => {
    const key = parseKeydef('2,2.0n', G, false)
    expect([key.endField, key.endChar]).toEqual([2, 0])
    expect(key.mods.numeric).toBe(true)
  })
})

// GNU coreutils 9.7's own words for a KEYDEF it refuses, measured on
// debian:stable-slim under LC_ALL=C. Mirrors test_sort_keys.py.
describe('a refused keydef in GNU words', () => {
  it.each([
    ['a', "invalid number at field start: invalid count at start of 'a'"],
    ['', "invalid number at field start: invalid count at start of ''"],
    ['-1', "invalid number at field start: invalid count at start of '-1'"],
    ['1.a', "invalid number after '.': invalid count at start of 'a'"],
    ['1.', "invalid number after '.': invalid count at start of ''"],
    ['1,a', "invalid number after ',': invalid count at start of 'a'"],
    ['1,', "invalid number after ',': invalid count at start of ''"],
    ['1,-2', "invalid number after ',': invalid count at start of '-2'"],
    ['1,1.a', "invalid number after '.': invalid count at start of 'a'"],
    ['0', "field number is zero: invalid field specification '0'"],
    ['0.x', "field number is zero: invalid field specification '0.x'"],
    ['1.0', "character offset is zero: invalid field specification '1.0'"],
    ['1.0x', "character offset is zero: invalid field specification '1.0x'"],
    ['1,0', "field number is zero: invalid field specification '1,0'"],
    ['1x', "stray character in field spec: invalid field specification '1x'"],
    ['1,1x', "stray character in field spec: invalid field specification '1,1x'"],
    ['1x,2', "stray character in field spec: invalid field specification '1x,2'"],
    ['1n.2', "stray character in field spec: invalid field specification '1n.2'"],
    ['1,2,3', "stray character in field spec: invalid field specification '1,2,3'"],
    ['1N', "stray character in field spec: invalid field specification '1N'"],
    ['1nMx', "stray character in field spec: invalid field specification '1nMx'"],
    ["'1", "invalid number at field start: invalid count at start of '\\'1'"],
    ["1'x", "stray character in field spec: invalid field specification '1\\'x'"],
    ['1\nx', "stray character in field spec: invalid field specification '1\\nx'"],
    ['1é', "stray character in field spec: invalid field specification '1\\303\\251'"],
  ])('%j', (spec, message) => {
    expect(() => parseKeydef(spec, G, false)).toThrow(new SortKeyError(message))
  })
})

// sort.c's check_ordering_compatibility, measured against GNU coreutils 9.7
// under LC_ALL=C. Mirrors TestOrderingCompatibility in test_sort_keys.py.
describe('ordering compatibility', () => {
  it.each([
    [{ n: true, g: true }, 'gn'],
    [{ n: true, d: true }, 'dn'],
    [{ h: true, M: true }, 'hM'],
    [{ n: true, i: true }, 'in'],
    [{ n: true, d: true, i: true }, 'dn'],
    [{ n: true, g: true, f: true }, 'fgn'],
    [{ n: true, g: true, b: true, r: true }, 'gn'],
    [{ M: true, V: true }, 'MV'],
    [{ h: true, n: true }, 'hn'],
    [{ g: true, M: true }, 'gM'],
    [{ d: true, M: true }, 'dM'],
  ])('the global options %j are the one key', (flags, letters) => {
    expect(() => configOf(flags)).toThrow(
      new SortKeyError(`options '-${letters}' are incompatible`),
    )
  })

  it.each([
    [['1n,1g'], 'gn'],
    [['1nM'], 'Mn'],
    [['1,1nR'], 'nR'],
    [['1bn,1g'], 'gn'],
    [['1hM'], 'hM'],
    [['1fiM'], 'fiM'],
    [['1idn'], 'dn'],
    [['1,1Mg'], 'gM'],
    [['2Mn', '1gn'], 'Mn'],
    [['1n', '2gh'], 'gh'],
  ])('each key is checked in the order typed: %j', (k, letters) => {
    expect(() => configOf({ k })).toThrow(
      new SortKeyError(`options '-${letters}' are incompatible`),
    )
  })

  it('a key without letters inherits the conflict', () => {
    expect(() => configOf({ k: ['1,1'], n: true, g: true })).toThrow(
      new SortKeyError("options '-gn' are incompatible"),
    )
    expect(() => configOf({ k: ['1'], n: true, d: true })).toThrow(
      new SortKeyError("options '-dn' are incompatible"),
    )
  })

  it('globals no key inherits are not checked', () => {
    const cfg = configOf({ k: ['1,1n'], n: true, g: true })
    expect(cfg.keys.map((key) => key.mods.generalNumeric)).toEqual([false])
    expect(() => configOf({ k: ['1d'], n: true })).not.toThrow()
  })

  it.each([
    [{ k: ['1dVR'] }],
    [{ k: ['1,1VR'] }],
    [{ V: true, d: true }],
    [{ V: true, i: true }],
    [{ d: true, f: true }],
    [{ k: ['1n', '2g'] }],
    [{ n: true, r: true, b: true }],
  ])('orderings that combine: %j', (flags) => {
    expect(() => configOf(flags)).not.toThrow()
  })
})

describe('extract', () => {
  it('field-to-EOL includes leading separator', () => {
    const line = 'a 2 z'
    expect(extract(line, computeFields(line, null), parseKeydef('2', G, false))).toBe(' 2 z')
  })

  it('single-field range includes leading blank', () => {
    const line = 'a 2 z'
    expect(extract(line, computeFields(line, null), parseKeydef('2,2', G, false))).toBe(' 2')
  })

  it('char offset past field reaches separator', () => {
    const line = 'y 5'
    expect(extract(line, computeFields(line, null), parseKeydef('1.2', G, false))).toBe(' 5')
  })

  it('missing field is empty', () => {
    const line = 'x 3'
    expect(extract(line, computeFields(line, null), parseKeydef('3,3', G, false))).toBe('')
  })
})

describe('sortLines KEYDEF', () => {
  it('-k2 extends to EOL, differs from -k2,2', () => {
    const data = 'a 2 z\nb 2 a\nc 1 m'
    expect(lines(data, { k: '2' })).toEqual(['c 1 m', 'b 2 a', 'a 2 z'])
    expect(lines(data, { k: '2,2' })).toEqual(['c 1 m', 'a 2 z', 'b 2 a'])
  })

  it('per-key numeric', () => {
    const data = 'apple 3\nbanana 1\ncherry 2\napple 10'
    expect(lines(data, { k: '2,2n' })).toEqual(['banana 1', 'cherry 2', 'apple 3', 'apple 10'])
  })

  it('global reverse ignored by a per-key typed key', () => {
    const data = 'z 2\nm 2\na 2'
    expect(lines(data, { k: '2,2n', r: true })).toEqual(['z 2', 'm 2', 'a 2'])
  })

  it('stable disables the last-resort compare', () => {
    const data = 'z 2\nm 2\na 2'
    expect(lines(data, { k: '2,2n' })).toEqual(['a 2', 'm 2', 'z 2'])
    expect(lines(data, { k: '2,2n', s: true })).toEqual(['z 2', 'm 2', 'a 2'])
  })

  it('multiple keys applied in order', () => {
    const data = 'a 2 z\nb 2 a\nc 1 m'
    expect(lines(data, { k: ['2,2n', '1,1r'] })).toEqual(['c 1 m', 'b 2 a', 'a 2 z'])
  })

  it('blank-only key sorts as string under global numeric', () => {
    const data = '  a 30\n  b 5\n  c 200'
    expect(lines(data, { k: '2b', n: true })).toEqual(['  c 200', '  a 30', '  b 5'])
  })

  it('char offsets with explicit separator', () => {
    const data = 'apple:12\nbee:3\ncat:100'
    expect(lines(data, { k: '1.2,1.3', t: ':' })).toEqual(['cat:100', 'bee:3', 'apple:12'])
  })
})

// Measured against GNU coreutils 9.7 on debian:stable-slim, LC_ALL=C.
// Mirrors TestUniqueStopsAtTheKeys in test_sort_keys.py.
describe('unique stops at the keys', () => {
  it('compares key-equal lines equal under unique', () => {
    expect(compareLines('b 1', 'a 1', configOf({ k: '2,2', u: true }))).toBe(0)
    expect(compareLines('b 1', 'a 1', configOf({ k: '2,2' }))).toBeGreaterThan(0)
  })

  it('keeps the first key-equal line in input order', () => {
    expect(lines('b 1\na 1', { k: '2,2', u: true })).toEqual(['b 1'])
    expect(lines('b\na\nB', { f: true, u: true })).toEqual(['a', 'b'])
  })

  it('keeps input order among ties under reverse', () => {
    expect(lines('a 1\nb 1\nc 2', { k: '2,2', u: true, r: true })).toEqual(['c 2', 'a 1'])
  })
})

// -n and -h in the C locale, pinned against GNU sort 9.7. Mirrors
// TestNumericKeys in test_sort_keys.py.
describe('numeric keys', () => {
  it('takes a newline as a blank before a number', () => {
    // A -z record may hold one; sort.c's blanks table counts it.
    expect(sortLines(['\n5', '3', '\n-5', '-4'], configOf({ n: true }))).toEqual([
      '\n-5',
      '-4',
      '3',
      '\n5',
    ])
  })

  it('separates fields at a newline', () => {
    expect(sortLines(['b\n1', 'a\n2'], configOf({ k: '2,2n' }))).toEqual(['b\n1', 'a\n2'])
  })

  it('ranks the unit above the magnitude', () => {
    expect(lines('1500\n1.5K\n2000\n1K', { h: true })).toEqual(['1500', '2000', '1K', '1.5K'])
  })

  it('takes only k as a unit in lowercase', () => {
    expect(lines('1m\n1M\n2\n1k', { h: true })).toEqual(['1m', '2', '1k', '1M'])
  })

  it('negates a negative number unit and gives zero none', () => {
    expect(lines('-1K\n-2\n1\n-1M\n0\n-0K\n0K', { h: true })).toEqual([
      '-1M',
      '-1K',
      '-2',
      '-0K',
      '0',
      '0K',
      '1',
    ])
  })

  it('reads the unit after the digits and points', () => {
    expect(lines('5.K\n3K\n.5K\n3\nK', { h: true, s: true })).toEqual([
      'K',
      '3',
      '.5K',
      '3K',
      '5.K',
    ])
  })

  it('compares human numbers exactly', () => {
    expect(lines('1.000000000000000002K\n1.000000000000000001K', { h: true, s: true })).toEqual([
      '1.000000000000000001K',
      '1.000000000000000002K',
    ])
  })
})

// Mirrors TestMergeLines in test_sort_keys.py.
describe('merged', () => {
  const merge = (runs: string[][], cfg: SortConfig): string[] => [...merged(runs, cfg)]

  it('never reorders a run', () => {
    expect(merge([['b', 'a']], configOf())).toEqual(['b', 'a'])
  })

  it('emits the smallest head first', () => {
    expect(merge([['c', 'a'], ['b']], configOf())).toEqual(['b', 'c', 'a'])
    expect(
      merge(
        [
          ['a', 'd'],
          ['b', 'e'],
          ['c', 'f'],
        ],
        configOf(),
      ),
    ).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
  })

  it('gives a tie to the earlier run', () => {
    const runs = [['k 3'], ['k 1'], ['k 2']]
    expect(merge(runs, configOf({ k: '1,1', s: true }))).toEqual(['k 3', 'k 1', 'k 2'])
    expect(merge(runs, configOf({ k: '1,1' }))).toEqual(['k 1', 'k 2', 'k 3'])
  })

  it('skips empty runs', () => {
    expect(merge([[], ['b', 'a'], []], configOf())).toEqual(['b', 'a'])
    expect(merge([[], []], configOf())).toEqual([])
  })

  it('collapses only adjacent duplicates under unique', () => {
    const cfg = configOf({ u: true })
    expect(merge([['a', 'b', 'a']], cfg)).toEqual(['a', 'b', 'a'])
    expect(
      merge(
        [
          ['a', 'b'],
          ['a', 'c'],
        ],
        cfg,
      ),
    ).toEqual(['a', 'b', 'c'])
  })

  it('keeps the first line of a key-equal series under unique', () => {
    expect(merge([['x 1'], ['a 1']], configOf({ k: '2,2', u: true }))).toEqual(['x 1'])
    expect(merge([['b'], ['B']], configOf({ f: true, u: true }))).toEqual(['b'])
  })
})
