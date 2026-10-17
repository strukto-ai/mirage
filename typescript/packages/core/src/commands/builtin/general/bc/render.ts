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

import type { BcNumber } from './types.ts'
import { integerText } from './numbers.ts'
import * as constants from './constants.ts'

export function cAtoi(text: string): number {
  let at = 0
  while (at < text.length && constants.C_BLANKS.includes(text.charAt(at))) at++
  const negative = text.charAt(at) === '-'
  if (negative || text.charAt(at) === '+') at++
  let digits = ''
  while (at < text.length && constants.DECIMAL_DIGITS.has(text.charAt(at))) {
    digits += text.charAt(at)
    at++
  }
  if (digits === '') return 0
  let value = BigInt(digits)
  if (negative) value = -value
  const limit = 1n << (constants.C_LONG_BITS - 1n)
  if (value > limit - 1n) value = limit - 1n
  if (value < -limit) value = -limit
  let low = value & ((1n << constants.C_INT_BITS) - 1n)
  if (low >= 1n << (constants.C_INT_BITS - 1n)) low -= 1n << constants.C_INT_BITS
  return Number(low)
}

export function outputLineSize(env: Record<string, string> | undefined): number {
  const raw = env?.[constants.LINE_LENGTH_VAR]
  if (raw === undefined) return constants.DEFAULT_LINE_LENGTH
  const size = cAtoi(raw)
  if (size !== 0 && size < constants.MIN_LINE_LENGTH) return constants.DEFAULT_LINE_LENGTH
  return size
}
export function columnWidth(char: string): number {
  const point = char.codePointAt(0) ?? 0
  if (point < constants.UTF8_TWO_BYTES) return 1
  if (point < constants.UTF8_THREE_BYTES) return 2
  if (point < constants.UTF8_FOUR_BYTES) return 3
  return 4
}

export class OutputColumn {
  col = 0
  constructor(private readonly lineSize: number) {}

  write(text: string): string {
    const out: string[] = []
    for (const char of text) {
      if (char === '\n') {
        this.col = 0
        out.push(char)
        continue
      }
      const width = columnWidth(char)
      if (this.lineSize !== 0 && this.col !== 0 && this.col + width > this.lineSize - 2) {
        out.push('\\\n')
        this.col = 0
      }
      out.push(char)
      this.col += width
    }
    return out.join('')
  }
}

export function fixedDigits(num: BcNumber): string {
  const magnitude = num.coefficient < 0n ? -num.coefficient : num.coefficient
  const digits = integerText(magnitude).padStart(num.scale + 1, '0')
  const point = digits.length - num.scale
  const text = num.scale === 0 ? digits : digits.slice(0, point) + '.' + digits.slice(point)
  return num.coefficient < 0n ? '-' + text : text
}

export function renderInBase(num: BcNumber, obase: number): string {
  const base = BigInt(obase)
  const magnitude = num.coefficient < 0n ? -num.coefficient : num.coefficient
  const denominator = 10n ** BigInt(num.scale)
  let whole = magnitude / denominator
  let remainder = magnitude % denominator
  const hasWhole = whole !== 0n
  const width = String(obase - 1).length
  const digit = (value: bigint): string =>
    obase <= constants.MAX_CHAR_BASE
      ? constants.BASE_DIGITS.charAt(Number(value))
      : integerText(value).padStart(width, '0')
  const before: string[] = []
  do {
    before.unshift(digit(whole % base))
    whole /= base
  } while (whole !== 0n)
  let text = obase <= constants.MAX_CHAR_BASE ? before.join('') : ' ' + before.join(' ')
  if (num.scale > 0) {
    if (!hasWhole) text = ''
    const after: string[] = []
    for (let precision = 1n; precision < denominator; precision *= base) {
      remainder *= base
      after.push(digit(remainder / denominator))
      remainder %= denominator
    }
    text += '.' + after.join(obase <= constants.MAX_CHAR_BASE ? '' : ' ')
  }
  return num.coefficient < 0n ? '-' + text : text
}

export function renderNumber(num: BcNumber, obase: number): string {
  if (num.coefficient === 0n) return '0'
  const text = obase === constants.DEFAULT_BASE ? fixedDigits(num) : renderInBase(num, obase)
  if (text.startsWith('0.')) return text.slice(1)
  if (text.startsWith('-0.')) return '-' + text.slice(2)
  return text
}
