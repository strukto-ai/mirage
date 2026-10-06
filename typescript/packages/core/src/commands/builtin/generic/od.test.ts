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
  // strtoumax base 0 (0x hex, leading 0 octal), GNU size suffixes, and one
  // leading '+' or whitespace that keeps the radix.
  it.each([
    ['010K', '-N', 8192],
    ['+0x10', '-N', 16],
  ] as const)("parses '%s' for %s as %d", (raw, flag, value) => {
    expect(parseCount(raw, flag)).toBe(value)
  })

  it.each(['', '+ 10'])("junk number '%s' uses the invalid-argument message", (value) => {
    expect(() => parseCount(value, '-N')).toThrow(
      new UsageError(`od: invalid -N argument '${value}'`, 1),
    )
  })

  // GNU distinguishes an unparseable number from an unknown suffix; 08 is
  // octal-0 followed by the junk suffix "8", matching strtoumax.
  it.each(['08', '0x'])("junk suffix '%s' uses the invalid-suffix message", (value) => {
    expect(() => parseCount(value, '-j')).toThrow(
      new UsageError(`od: invalid suffix in -j argument '${value}'`, 1),
    )
  })

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
