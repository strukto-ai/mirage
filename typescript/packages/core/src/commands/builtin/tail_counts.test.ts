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
  normalizeCounts,
  numberFlagError,
  parseByteCount,
  parseCounts,
  parseSeconds,
  type TailCounts,
} from './tail_counts.ts'

describe('normalizeCounts', () => {
  // A TailCounts is a plain object, so anything reaching tail from
  // outside TypeScript can leave fields undefined. `undefined !== null` is
  // true, so a bare guard used to take the count-forward branch and return
  // `slice(NaN)` -- the whole input, silently.
  it('reads a missing field as unset rather than as a count', () => {
    expect(normalizeCounts({ lines: 2 } as unknown as TailCounts)).toEqual({
      lines: 2,
      fromLine: null,
      byteCount: null,
      fromByte: null,
    })
  })
})

describe('parseCounts', () => {
  it('accepts GNU byte-count size suffixes', () => {
    expect(parseByteCount('2M')).toBe(2 * 1024 * 1024)
    expect(parseByteCount('3kB')).toBe(3000)
    expect(parseCounts(null, '+2M').fromByte).toBe(2 * 1024 * 1024)
  })

  it('sends a bare count to the count-back-from-the-end slot', () => {
    expect(parseCounts('3', null)).toEqual({
      lines: 3,
      fromLine: null,
      byteCount: null,
      fromByte: null,
    })
  })

  it('sends a leading + to the count-forward slot, for bytes too', () => {
    // The byte half is the fix: `-c +3` used to be parsed as the plain
    // number 3 and served as the LAST three bytes.
    expect(parseCounts(null, '+3').fromByte).toBe(3)
    expect(parseCounts(null, '+3').byteCount).toBeNull()
  })

  it('leaves an unset flag null so the caller picks its own default', () => {
    expect(parseCounts(null, null)).toEqual({
      lines: null,
      fromLine: null,
      byteCount: null,
      fromByte: null,
    })
  })
})

// Every row measured against GNU coreutils 9.4 under `LC_ALL=C` with a raw
// `bytes` argv (`head -c <w>`, `tail -n <w>`): both clauses name the word
// through gnulib's quote(), so the value is escaped rather than
// interpolated raw. Mirrors test_tail_counts.py.
const QUOTED_COUNTS: [string, string][] = [
  ['1é', '1\\303\\251'],
  ['1\r', '1\\r'],
  ['1\x01', '1\\001'],
  ['1\x7f', '1\\177'],
  ["1'", "1\\'"],
  ['1\\', '1\\\\'],
  ['', ''],
  // python's \d also matches Arabic-Indic digits; GNU's C-locale parser
  // rejects them and names the word one octal escape per byte.
  ['١٢', '\\331\\241\\331\\242'],
]

describe('the count clauses quote the word they name', () => {
  it.each(QUOTED_COUNTS)('escapes %j in the line-count clause', (value, escaped) => {
    expect(numberFlagError('tail', value, null)).toBe(
      `tail: invalid number of lines: '${escaped}'\n`,
    )
  })

  it.each(QUOTED_COUNTS)('escapes %j in the byte-count clause', (value, escaped) => {
    expect(numberFlagError('head', null, value)).toBe(
      `head: invalid number of bytes: '${escaped}'\n`,
    )
  })
})

// `parseSeconds` is C `strtod` as `xstrtod` reads it. Every row below is a
// measured GNU coreutils 9.4 answer for `tail -s <v> f` under `LC_ALL=C`
// with a raw `bytes` argv: a number means the grammar took the value,
// null means it refused. Mirrors test_tail_counts.py.
describe('parseSeconds', () => {
  it.each([
    [' 1', 1],
    ['\r1', 1],
    ['\t1', 1],
    ['+1', 1],
    ['-1', -1],
    ['.5', 0.5],
    ['1.', 1],
    ['1e2', 100],
    ['+.5e1', 5],
    ['00', 0],
    ['5', 5],
    ['0x10', 16],
    ['0x1p4', 16],
    ['0x.8p1', 1],
    ['0x10.8', 16.5],
  ])('reads %j as %d', (value, expected) => {
    expect(parseSeconds(value)).toBe(expected)
  })

  // GNU ACCEPTS `tail -s inf`: `0 <= inf` holds. `Number()` reads
  // `Infinity` but not strtod's `inf`/`infinity`, which is why this needs
  // its own branch.
  it.each(['inf', 'infinity', 'INF'])('reads %j as Infinity', (value) => {
    expect(parseSeconds(value)).toBe(Infinity)
  })

  it('reads -inf as -Infinity, leaving the range to the caller', () => {
    expect(parseSeconds('-inf')).toBe(-Infinity)
  })

  // glibc's strtod reads `nan` and `nan(chars)`; GNU then refuses it
  // because `0 <= nan` is false, which is the caller's half of the test.
  it.each(['nan', 'NAN', 'nan(x)', '-nan'])('reads %j as NaN', (value) => {
    expect(Number.isNaN(parseSeconds(value))).toBe(true)
  })

  // `xstrtod` demands the WHOLE string; trailing whitespace is not
  // strtod's, which is why `Number()` and `float()` were both too lenient.
  it.each([
    '1\r',
    '1 ',
    '1\t',
    '',
    '1_0',
    '1x',
    '0x',
    '1e',
    '1e+',
    '1,5',
    '.',
    '1.5.5',
    '0xp1',
    'inf inity',
  ])('refuses %j for the leftover', (value) => {
    expect(parseSeconds(value)).toBeNull()
  })
})
