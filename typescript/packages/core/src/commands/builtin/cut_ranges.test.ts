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
import type { FlagValue } from '../spec/types.ts'
import type { CommandOpts } from '../config.ts'
import { parseRanges } from './cut_ranges.ts'
import { cutGeneric } from './generic/cut.ts'

const DEC = new TextDecoder()
const TRY = "Try 'cut --help' for more information.\n"
const OPEN_END = 2 ** 31 - 1

function stubStream(): AsyncIterable<Uint8Array> {
  throw new Error('cut read an operand although its range was refused')
}

async function run(flags: Record<string, FlagValue>): Promise<{ exit: number; stderr: string }> {
  const opts = {
    stdin: null,
    flags,
    filetypeFns: null,
    cwd: '/',
    resource: { kind: 'ram' } as never,
  } as CommandOpts
  // `CommandFnResult` is nullable — null is how a handler says it does not
  // apply — and cut never answers that way, so say so rather than destructure
  // a union.
  const result = await cutGeneric([], opts, stubStream)
  if (result === null) throw new Error('cut declined to handle its own operands')
  const [, io] = result
  return {
    exit: io.exitCode,
    stderr: io.stderr instanceof Uint8Array ? DEC.decode(io.stderr) : '',
  }
}

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

describe('cut reports a refused range with GNU exit status', () => {
  it('exits 1 for a field list it cannot read whole', async () => {
    expect(await run({ delimiter: ',', fields: '2-3x' })).toEqual({
      exit: 1,
      stderr: "cut: invalid field value 'x'\n" + TRY,
    })
    expect(await run({ delimiter: ',', fields: 'abc' })).toEqual({
      exit: 1,
      stderr: "cut: invalid field value 'abc'\n" + TRY,
    })
    expect(await run({ delimiter: ',', fields: '0' })).toEqual({
      exit: 1,
      stderr: 'cut: fields are numbered from 1\n' + TRY,
    })
    expect(await run({ delimiter: ',', fields: '3-1' })).toEqual({
      exit: 1,
      stderr: 'cut: invalid decreasing range\n' + TRY,
    })
    expect(await run({ delimiter: ',', fields: '1-2-3' })).toEqual({
      exit: 1,
      stderr: 'cut: invalid field range\n' + TRY,
    })
  })

  it('exits 1 for a byte/character list it cannot read whole', async () => {
    expect(await run({ characters: 'abc' })).toEqual({
      exit: 1,
      stderr: "cut: invalid byte/character position 'abc'\n" + TRY,
    })
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
