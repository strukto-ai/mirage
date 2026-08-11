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

import { UsageError } from '../../errors.ts'
import { parseCount } from './od.ts'

describe('od parseCount', () => {
  it('parses decimal', () => {
    expect(parseCount('64', '-N')).toBe(64)
  })

  it('honors strtol base 0: 0x is hex, a leading 0 is octal', () => {
    expect(parseCount('0x10', '-N')).toBe(16)
    expect(parseCount('010', '-j')).toBe(8)
    expect(parseCount('0', '-j')).toBe(0)
  })

  it('applies GNU size suffixes', () => {
    expect(parseCount('3k', '-N')).toBe(3072)
    expect(parseCount('1KiB', '-N')).toBe(1024)
    expect(parseCount('1KB', '-N')).toBe(1000)
    expect(parseCount('2b', '-N')).toBe(1024)
    expect(parseCount('010K', '-N')).toBe(8192)
  })

  it('skips leading whitespace and one + while keeping the radix', () => {
    expect(parseCount('+10', '-N')).toBe(10)
    expect(parseCount(' 10', '-N')).toBe(10)
    expect(parseCount('+0x10', '-N')).toBe(16)
    expect(parseCount('+010', '-j')).toBe(8)
    expect(parseCount('+10K', '-N')).toBe(10240)
  })

  it.each(['abc', '', 'x10', '++10', '-10', '+ 10'])(
    "junk number '%s' uses the invalid-argument message",
    (value) => {
      expect(() => parseCount(value, '-N')).toThrow(
        new UsageError(`od: invalid -N argument '${value}'`, 1),
      )
    },
  )

  // GNU distinguishes an unparseable number from an unknown suffix; 08 is
  // octal-0 followed by the junk suffix "8", matching strtoumax.
  it.each(['5c', '1g', '1t', '08', '0x'])(
    "junk suffix '%s' uses the invalid-suffix message",
    (value) => {
      expect(() => parseCount(value, '-j')).toThrow(
        new UsageError(`od: invalid suffix in -j argument '${value}'`, 1),
      )
    },
  )

  it('reports uintmax overflow as too large', () => {
    // Q/R/Y/Z are in GNU's suffix set but always overflow uintmax.
    expect(() => parseCount('1Q', '-N')).toThrow(
      new UsageError("od: -N argument '1Q' too large", 1),
    )
  })

  it('holds the uintmax boundary exactly', () => {
    // 2**64 - 1 is valid and 2**64 is not, in every radix (pinned against
    // coreutils 9.7). As doubles both are 2 ** 64, so the check runs in
    // BigInt; the accepted count still rounds to a double on return.
    expect(parseCount('18446744073709551615', '-N')).toBe(2 ** 64)
    expect(parseCount('0xffffffffffffffff', '-N')).toBe(2 ** 64)
    expect(() => parseCount('18446744073709551616', '-N')).toThrow(
      new UsageError("od: -N argument '18446744073709551616' too large", 1),
    )
    expect(() => parseCount('0x10000000000000000', '-j')).toThrow(
      new UsageError("od: -j argument '0x10000000000000000' too large", 1),
    )
  })
})
