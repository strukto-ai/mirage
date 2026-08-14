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
import { normalizeCounts, parseCounts, tailBytes, type TailCounts } from './tail_helper.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

function run(data: string, n: string | null, c: string | null): string {
  return DEC.decode(tailBytes(ENC.encode(data), parseCounts(n, c)))
}

describe('normalizeCounts', () => {
  // A TailCounts is a plain object, so anything reaching tailBytes from
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

  it.each([
    [{ lines: 2 }, 'd\ne\n'],
    [{}, 'a\nb\nc\nd\ne\n'],
    [{ byteCount: 3 }, '\ne\n'],
  ])('serves %j as its own kind of tail, not as the whole input', (partial, expected) => {
    const data = ENC.encode('a\nb\nc\nd\ne\n')
    expect(DEC.decode(tailBytes(data, partial as TailCounts))).toBe(expected)
  })
})

describe('parseCounts', () => {
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

describe('tailBytes', () => {
  it('-c N and -c -N both take the last N bytes', () => {
    expect(run('abcdefghij', null, '3')).toBe('hij')
    expect(run('abcdefghij', null, '-3')).toBe('hij')
  })

  it('-c +N starts at byte N, 1-indexed', () => {
    expect(run('abcdefghij', null, '+3')).toBe('cdefghij')
    expect(run('abcdefghij', null, '+1')).toBe('abcdefghij')
    expect(run('abcdefghij', null, '+0')).toBe('abcdefghij')
    expect(run('abcdefghij', null, '+99')).toBe('')
  })

  it('-c 0 is empty but a count past the end is the whole file', () => {
    expect(run('abcdefghij', null, '0')).toBe('')
    expect(run('abcdefghij', null, '99')).toBe('abcdefghij')
  })

  it('falls back to the last 10 lines when neither flag is set', () => {
    const body = Array.from({ length: 20 }, (_, i) => `line${String(i + 1)}`).join('\n')
    expect(run(body, null, null).split('\n')).toHaveLength(10)
  })

  it('keeps the line behaviour it already had', () => {
    expect(run('a\nb\nc\nd\ne\n', '3', null)).toBe('c\nd\ne\n')
    expect(run('a\nb\nc\nd\ne\n', '-3', null)).toBe('c\nd\ne\n')
    expect(run('a\nb\nc\nd\ne\n', '+2', null)).toBe('b\nc\nd\ne\n')
    expect(run('a\nb\nc\n', '0', null)).toBe('')
  })

  it('lets -c win over -n, as GNU does', () => {
    expect(run('abcdefghij', '2', '3')).toBe('hij')
  })
})
