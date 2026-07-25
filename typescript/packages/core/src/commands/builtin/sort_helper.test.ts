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
import {
  buildConfig,
  computeFields,
  extract,
  type KeyMods,
  parseKeydef,
  SortKeyError,
  sortLines,
} from './sort_helper.ts'

const G: KeyMods = {
  numeric: false,
  human: false,
  version: false,
  month: false,
  fold: false,
  reverse: false,
}

function lines(text: string, flags: Record<string, string | boolean | string[]> = {}): string[] {
  return sortLines(text.split('\n'), buildConfig(flags))
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
