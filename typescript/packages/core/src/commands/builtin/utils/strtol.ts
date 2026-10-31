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
import { decimalValue, parseBase0 } from './size_suffix.ts'

// A whole decimal word as GNU's count options read one: C blanks, one sign,
// ASCII digits, and nothing after them, not even a blank.
const DECIMAL = new RegExp(`^${C_SPACE}([+-]?)([0-9]+)`)
// C's strto(u)l at base 0: C blanks, one sign, then hex after 0x, octal after
// a bare 0, decimal otherwise; the text after the digits is left.
const BASE0 = new RegExp(`^${C_SPACE}([+-]?)(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)`)
const LONG_MIN = -(2n ** 63n)
const LONG_MAX = 2n ** 63n - 1n
export const INT_MAX = 2n ** 31n - 1n
// What GNU 9.7 appends after a refused number that scanned, measured under
// LC_ALL=C: ERANGE for a value outside the option's range and
// EOVERFLOW for one the program words as too large for its type.
export const ERANGE_REASON = 'Numerical result out of range'
export const EOVERFLOW_REASON = 'Value too large for defined data type'

/**
 * `text` as a signed decimal operand, as GNU's counts read. Mirrors Python's
 * `signed_decimal`.
 */
export function signedDecimal(text: string): bigint | null {
  const match = DECIMAL.exec(text)
  if (match?.[0].length !== text.length) return null
  const value = decimalValue(match[2] ?? '0')
  return match[1] === '-' ? -value : value
}

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
  const value = decimalValue(match[2] ?? '0')
  const signed = match[1] === '-' ? -value : value
  return Number(signed < LONG_MIN ? LONG_MIN : signed > LONG_MAX ? LONG_MAX : signed)
}

/**
 * C's `strtol(text, &end, 0)`: the value and the text at `end`. No number is
 * 0 with the whole text left, and a value past the `long` range saturates, as
 * glibc's does. Mirrors Python's `strtol`.
 */
export function strtol(text: string): [bigint, string] {
  const match = BASE0.exec(text)
  if (match === null) return [0n, text]
  const value = parseBase0(match[2] ?? '0')
  const signed = match[1] === '-' ? -value : value
  const clamped = signed < LONG_MIN ? LONG_MIN : signed > LONG_MAX ? LONG_MAX : signed
  return [clamped, text.slice(match[0].length)]
}
