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

// The binary128 long double strtold rounds to, written 0.DIGITS x 10**EXP:
// the largest finite value and the least normal one.
const LDBL_MAX: [number, string] = [4933, '118973149535723176508575932662800702']
const LDBL_MIN: [number, string] = [-4931, '336210314311209350626267781732175260']

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

// Whether strtold reports ERANGE for a STRTOD match: past the largest finite
// long double, and for a nonzero value under the least normal one that it
// cannot hold exactly. A decimal never lands on the binary grid there, while
// a hex float does unless it has a bit below 2**-16494. An infinity or nan
// as typed is no error. The long double is binary128, as on arm64; x86-64's
// 80-bit format has the same exponent range. Mirrors Python's strtold_erange.
export function strtoldErange(found: RegExpExecArray): boolean {
  const [, , hexa, decimal] = found
  if (hexa !== undefined) {
    const [mantissa = '', power = '0'] = hexa.slice(2).toLowerCase().split('p')
    const [whole = '', fraction = ''] = mantissa.split('.')
    const digits = BigInt('0x' + (whole + fraction || '0'))
    if (digits === 0n) return false
    const exponent = Number(power) - 4 * fraction.length
    const bits = digits.toString(2)
    const top = bits.length - 1 + exponent
    const low = bits.length - 1 - bits.lastIndexOf('1') + exponent
    return top >= 16384 || (top < -16382 && low < -16494)
  }
  if (decimal === undefined) return false
  const [mantissa = '', power = '0'] = decimal.toLowerCase().split('e')
  const [whole = '', fraction = ''] = mantissa.split('.')
  const joined = whole + fraction
  const unled = joined.replace(/^0+/, '')
  const digits = unled.replace(/0+$/, '')
  if (digits === '') return false
  // Both sides are 0.DIGITS x 10**EXP with a nonzero lead digit and no
  // trailing zero, so equal exponents order by the digits as text.
  const exponent = whole.length - (joined.length - unled.length) + Number(power)
  const [maxExponent, maxDigits] = LDBL_MAX
  const [minExponent, minDigits] = LDBL_MIN
  return (
    exponent > maxExponent ||
    (exponent === maxExponent && digits > maxDigits) ||
    exponent < minExponent ||
    (exponent === minExponent && digits < minDigits)
  )
}
