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

import { C_SPACE } from '../constants.ts'

// The leading decimal run C's atoi reads, after blanks and one sign.
const DECIMAL = new RegExp(`^${C_SPACE}([+-]?)([0-9]+)`)
const LONG_MIN = -(2n ** 63n)
const LONG_MAX = 2n ** 63n - 1n
export const INT_MAX = 2n ** 31n - 1n

/**
 * ASCII decimal `digits` as a number, null when it is `bound` or more. Leading
 * zeros go first and a run longer than the bound is refused by its length, so
 * however many digits are typed, the conversion only ever sees as many as the
 * bound has. Mirrors Python's bounded_decimal.
 */
export function boundedDecimal(digits: string, bound: bigint): bigint | null {
  const significant = digits.replace(/^0+/, '')
  if (significant.length > bound.toString().length) return null
  const value = BigInt(significant === '' ? '0' : significant)
  return value < bound ? value : null
}

/**
 * C's `atoi`: the decimal number `text` begins with, after C blanks and one
 * sign, 0 when it begins with none, saturated to the `long` range as glibc's
 * `strtol` underneath it is. Mirrors Python's `atoi`.
 */
export function atoi(text: string): number {
  const match = DECIMAL.exec(text)
  if (match === null) return 0
  const negative = match[1] === '-'
  const limit = negative ? -LONG_MIN : LONG_MAX
  const value = boundedDecimal(match[2] ?? '0', limit + 1n) ?? limit
  return Number(negative ? -value : value)
}
