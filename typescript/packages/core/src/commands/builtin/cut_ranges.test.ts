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
import { materialize } from '../../io/types.ts'
import { cutStream, parseRanges, type CutOptions } from './cut_ranges.ts'

const TRY = "Try 'cut --help' for more information.\n"
const OPEN_END = 2 ** 31 - 1

describe('parseRanges accepts what GNU cut accepts', () => {
  it('reads a single position, a range and a list', () => {
    expect(parseRanges('1', 'fields')).toEqual([[1, 1]])
    expect(parseRanges('2-3', 'fields')).toEqual([[2, 3]])
    expect(parseRanges('1,3', 'fields')).toEqual([
      [1, 1],
      [3, 3],
    ])
    expect(parseRanges('2-2', 'fields')).toEqual([[2, 2]])
  })

  // GNU: `cut -d, -f 2-`, `-f -2` and `-c 2-` are all valid and exit 0.
  // The open end is 2**31 - 1, the value Python's cut_ranges.py uses; the
  // two have to agree or a clamped range differs across the languages.
  it('opens a range at 2**31 - 1, as Python does', () => {
    expect(parseRanges('2-', 'fields')).toEqual([[2, OPEN_END]])
    expect(parseRanges('2-', 'characters')).toEqual([[2, OPEN_END]])
    expect(parseRanges('-2', 'fields')).toEqual([[1, 2]])
  })
})

describe('parseRanges refuses what GNU cut refuses', () => {
  // GNU coreutils 9.4, input `printf 'a,b,c\n'`. GNU quotes from the first
  // unparseable character onward, so a spec whose digits it read reports the
  // remainder (`2-3x` and `1,2x` both report 'x') and one it could not start
  // reports whole (`abc`); a blank terminates the number rather than being
  // named, so `'2 '` reports the same refusal as `0` and `''`. An empty list
  // element parses as field 0 wherever it sits, which is why a leading,
  // trailing or doubled comma all land on the zero message rather than
  // naming the comma.
  it.each([
    ['2-3x', "cut: invalid field value 'x'\n"],
    ['abc', "cut: invalid field value 'abc'\n"],
    ['1,2x', "cut: invalid field value 'x'\n"],
    ['0', 'cut: fields are numbered from 1\n'],
    ['', 'cut: fields are numbered from 1\n'],
    ['2 ', 'cut: fields are numbered from 1\n'],
    ['1,', 'cut: fields are numbered from 1\n'],
    [',1', 'cut: fields are numbered from 1\n'],
    ['1,,2', 'cut: fields are numbered from 1\n'],
    ['3-1', 'cut: invalid decreasing range\n'],
    ['1-2-3', 'cut: invalid field range\n'],
  ])('refuses -f %j with both stderr lines', (spec, message) => {
    expect(parseRanges(spec, 'fields')).toBe(message + TRY)
  })

  // -b and -c share every string with each other; -f shares only
  // `invalid decreasing range`, which carries no mode noun. Note the two
  // range strings are worded differently from each other: the position one
  // joins its nouns with a slash, the range one spells out ' or '.
  it.each([
    ['abc', "cut: invalid byte/character position 'abc'\n"],
    ['2-3x', "cut: invalid byte/character position 'x'\n"],
    ['0', 'cut: byte/character positions are numbered from 1\n'],
    ['', 'cut: byte/character positions are numbered from 1\n'],
    ['2 ', 'cut: byte/character positions are numbered from 1\n'],
    ['1,', 'cut: byte/character positions are numbered from 1\n'],
    ['1-2-3', 'cut: invalid byte or character range\n'],
    ['3-1', 'cut: invalid decreasing range\n'],
  ])('refuses -c and -b %j in their own wording', (spec, message) => {
    expect(parseRanges(spec, 'characters')).toBe(message + TRY)
    expect(parseRanges(spec, 'bytes')).toBe(message + TRY)
  })
})

// The refused remainder is rendered through gnulib `quote()`, the same rule
// every other coreutils diagnostic uses -- derived from all 255 reachable
// bytes in `cut` itself and found identical to `nl`, `expand`, `shuf` and
// `expr` (ground truth NL3-A). Before this, cut interpolated the raw string,
// so `cut -f 2-3é` emitted the character where GNU emits two octal escapes.
describe('cut quotes the remainder through gnulib', () => {
  const MODES: readonly (readonly ['fields' | 'bytes' | 'characters', string])[] = [
    ['fields', 'invalid field value'],
    ['bytes', 'invalid byte/character position'],
    ['characters', 'invalid byte/character position'],
  ]
  for (const [mode, label] of MODES) {
    it.each([
      ['2-3\u00e9', '\\303\\251'],
      ['1,\u00e9', '\\303\\251'],
      ['x\u00e9', 'x\\303\\251'],
      ['1,2\\x', '\\\\x'],
      ["1,2'x", "\\'x"],
      ['1,2\tx', 'x'],
      ['1,2\nx', '\\nx'],
      ['x\x01y', 'x\\001y'],
      ['\u{1f600}', '\\360\\237\\230\\200'],
    ] as [string, string][])(`${mode} %j`, (spec, quoted) => {
      const got = parseRanges(spec, mode)
      expect(typeof got).toBe('string')
      expect(String(got).split('\n')[0]).toBe(`cut: ${label} '${quoted}'`)
    })
  }

  // A control: the quoting change must not move what parses.
  it.each(['1-3', '1,2,3', '1-', '-3', '2'])('still accepts %s', (spec) => {
    expect(typeof parseRanges(spec, 'fields')).not.toBe('string')
  })
})

const STREAM_OPTIONS: CutOptions = {
  ranges: [[2, 2]],
  mode: 'fields',
  delimiter: ',',
  complement: false,
  onlyDelimited: false,
  whitespace: null,
  noPartial: false,
  outputDelimiter: null,
  zeroTerminated: false,
}

it.each(['\n', '\0'])('cut emits before the tail and closes (%j)', async (separator) => {
  let closed = false
  async function* source() {
    await Promise.resolve()
    try {
      yield new TextEncoder().encode(`left,right${separator}`)
      throw new Error('cut fetched the tail')
    } finally {
      closed = true
    }
  }
  const output = cutStream(source(), { ...STREAM_OPTIONS, zeroTerminated: separator === '\0' })[
    Symbol.asyncIterator
  ]()
  try {
    expect((await output.next()).value).toEqual(new TextEncoder().encode(`right${separator}`))
  } finally {
    await output.return?.()
  }
  expect(closed).toBe(true)
})

it.each([
  ['a,b\nc,d\n', 'b\nd\n'],
  ['a,b\nc,d', 'b\nd\n'],
  ['a,b\0c,d\0', 'b\0d\0'],
  ['', ''],
])('cut records survive one-byte chunks %j', async (data, expected) => {
  async function* source() {
    await Promise.resolve()
    for (const byte of new TextEncoder().encode(data)) yield Uint8Array.of(byte)
  }
  const output = cutStream(source(), { ...STREAM_OPTIONS, zeroTerminated: data.includes('\0') })
  expect(new TextDecoder().decode(await materialize(output))).toBe(expected)
})
