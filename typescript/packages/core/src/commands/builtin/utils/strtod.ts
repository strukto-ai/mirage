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
