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

// The number glibc's strtod reads in the C locale, and strtold with it:
// blanks (isspace, so CR and TAB count), a sign, then a hex float, a decimal
// float, inf or infinity, or nan with an optional (chars) tag, any case. The
// groups are the sign, the hex float, the decimal float, inf and nan. A match
// is the longest number at the front of a word, which is what strtod
// consumes; a GNU tool that reads its value through xstrtod refuses any
// leftover, trailing blanks included, so it reads with strtodWhole (`tail -s
// $'1\r'` is an invalid number of seconds).
export const STRTOD =
  /^[ \t\n\v\f\r]*([+-]?)(?:(0[xX](?:[0-9a-fA-F]+(?:\.[0-9a-fA-F]*)?|\.[0-9a-fA-F]+)(?:[pP][+-]?[0-9]+)?)|((?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)|([iI][nN][fF](?:[iI][nN][iI][tT][yY])?)|([nN][aA][nN](?:\([0-9A-Za-z_]*\))?))/

// The binary128 long double strtold rounds to: a value from 2**16384 -
// 2**16270 up (LDBL_MAX plus half its ulp, a tie rounding to the even
// infinity) overflows, one under 2**-16382 is tiny, and a tiny one is held
// exactly only on the subnormal grid of 2**-16494.
const OVERFLOW = ((1n << 114n) - 1n) << 16270n

// The leading digits that settle the range exactly, the rest only saying
// whether anything nonzero was dropped. 32 hex digits hold the 113 bits a
// long double keeps and more. In decimal the overflow edge is an integer of
// 4,933 digits, and a tiny value needs at most 11,563 digits past its lead
// to land on the grid or to be compared with the least normal one, so
// 12,000 settle both.
const HEX_KEPT = 32
const DECIMAL_KEPT = 12000

// A STRTOD match spanning the whole word, as xstrtod demands, or null.
// Mirrors Python's strtod_whole.
export function strtodWhole(text: string): RegExpExecArray | null {
  const found = STRTOD.exec(text)
  return found !== null && found[0].length === text.length ? found : null
}

// A hex float such as 0x1.8p3, rounded once from its exact mantissa to the
// nearest double, ties to even, as Python's float.fromhex rounds it, and
// an infinity past the range. Mirrors Python's _hex_double.
function hexDouble(text: string): number {
  const [mantissa = '', power = '0'] = text.slice(2).split(/[pP]/)
  const [whole = '', fraction = ''] = mantissa.split('.')
  const digits = BigInt('0x' + (whole + fraction || '0'))
  if (digits === 0n) return 0
  const bits = digits.toString(2).length
  let exponent = Number(power) - 4 * fraction.length
  const lead = bits - 1 + exponent
  if (lead > 1023) return Infinity
  // The bits a double keeps at this magnitude: 53, fewer once subnormal.
  const kept = Math.min(53, lead + 1075)
  if (kept < 0) return 0
  let keptDigits = digits
  if (bits > kept) {
    const drop = BigInt(bits - kept)
    keptDigits = digits >> drop
    const rest = digits - (keptDigits << drop)
    const half = 1n << (drop - 1n)
    if (rest > half || (rest === half && (keptDigits & 1n) === 1n)) keptDigits += 1n
    exponent += bits - kept
  }
  // The kept digits times a power of two is a double, so scaling in steps
  // the range holds is exact: no step overflows or underflows on its own.
  let value = Number(keptDigits)
  for (; exponent > 1023; exponent -= 1023) value *= 2 ** 1023
  for (; exponent < -1022; exponent += 1022) value *= 2 ** -1022
  return value * 2 ** exponent
}

// The double strtod returns for a STRTOD match: rounded once to the nearest
// double, ties to even, a magnitude past the range read as an infinity, and
// every spelling of nan the one quiet NaN. Mirrors Python's strtod_double.
export function strtodDouble(found: RegExpExecArray): number {
  const [, sign, hexa, decimal, inf, nan] = found
  if (nan !== undefined) return Number.NaN
  let value: number
  if (inf !== undefined) value = Infinity
  else if (hexa !== undefined) value = hexDouble(hexa)
  else value = Number(decimal)
  return sign === '-' ? -value : value
}

// An exponent as typed, held to 10**9 either way: past that bound it cannot
// change whether a value is in range. Mirrors Python's _saturated.
function saturated(power: string): number {
  const digits = power.replace(/^[+-]/, '').replace(/^0+/, '')
  const value = digits.length > 9 ? 1e9 : Number(digits || '0')
  return power.startsWith('-') ? -value : value
}

// Whether strtold reports ERANGE for a STRTOD match: when the value rounds
// past the largest finite long double, and when a nonzero value under the
// least normal one cannot be held exactly. Tininess is judged before
// rounding, so a value that rounds up to the least normal one is still out
// of range. An infinity or nan as typed is no error. The long double is
// binary128, as on arm64; x86-64's 80-bit format has the same exponent
// range. Only the leading digits that settle the answer are read into
// numbers, so the cost stays bounded however long the argument is. Mirrors
// Python's strtold_erange.
export function strtoldErange(found: RegExpExecArray): boolean {
  const [, , hexa, decimal] = found
  let significand: bigint
  let exponent: number
  let base: bigint
  let dropped: boolean
  if (hexa !== undefined) {
    const [mantissa = '', power = ''] = hexa.slice(2).toLowerCase().split('p')
    const [whole = '', fraction = ''] = mantissa.split('.')
    const digits = (whole + fraction).replace(/^0+/, '')
    if (digits === '') return false
    exponent = saturated(power) - 4 * fraction.length
    const lead = parseInt(digits.charAt(0), 16).toString(2).length
    const top = 4 * digits.length - 5 + lead + exponent
    if (top >= -16382 && top < 16383) return false
    if (top >= 16384 || top < -16495) return true
    const kept = digits.slice(0, HEX_KEPT)
    dropped = /[^0]/.test(digits.slice(HEX_KEPT))
    significand = BigInt('0x' + kept)
    exponent += 4 * (digits.length - kept.length)
    base = 2n
  } else if (decimal !== undefined) {
    const [mantissa = '', power = ''] = decimal.toLowerCase().split('e')
    const [whole = '', fraction = ''] = mantissa.split('.')
    const joined = whole + fraction
    const unled = joined.replace(/^0+/, '')
    // A scan, not /0+$/: a regex retries from every zero of a long inner
    // run, which is quadratic in the argument's length.
    let end = unled.length
    while (end > 0 && unled.charCodeAt(end - 1) === 48) end -= 1
    const digits = unled.slice(0, end)
    if (digits === '') return false
    // The value is 0.DIGITS x 10**scale.
    const scale = whole.length - (joined.length - unled.length) + saturated(power)
    if (scale >= -4930 && scale <= 4932) return false
    if (scale >= 4934 || scale <= -4966) return true
    const kept = digits.slice(0, DECIMAL_KEPT)
    dropped = digits.length > kept.length
    significand = BigInt(kept)
    exponent = scale - kept.length
    base = 10n
  } else return false
  const num = significand * base ** BigInt(Math.max(exponent, 0))
  const den = base ** BigInt(Math.max(-exponent, 0))
  if (num >= OVERFLOW * den) return true
  return num << 16382n < den && (dropped || (num << 16494n) % den !== 0n)
}
