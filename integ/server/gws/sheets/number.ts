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

import { asStr } from '../wire/json.ts'
import type { JsonObj } from '../wire/json.ts'

// What a type with no pattern of its own shows in an en_US spreadsheet, the
// locale every spreadsheet here has, as live Sheets rendered it on
// 2026-09-21: CURRENCY takes this pattern, PERCENT shows the plain number
// scaled by 100, and NUMBER, SCIENTIFIC and TEXT show the plain number.
const CURRENCY = '"$"#,##0.00'

// One `;` section of a numeric pattern, read into what rendering needs.
interface Section {
  prefix: string
  suffix: string
  intMin: number
  group: boolean
  decMin: number
  decMax: number
  percent: number
  exponent: { digits: number; plus: boolean } | null
}

// The text a number shows under a NumberFormat, for the numeric half of the
// pattern language: `0`, `#` and `?` digits, `,` grouping, `.` decimals, `%`
// (which also scales by 100), `E+`/`E-` exponents, quoted, backslashed and
// `_` literals, and up to three `;` sections (positive, negative, zero).
// Dates, times and text patterns are not modeled: null, and the caller shows
// the number the way it shows one with no format.
export function formatNumber(value: number, format: JsonObj): string | null {
  const type = asStr(format.type) ?? ''
  let pattern = asStr(format.pattern) ?? ''
  if (pattern === '') {
    if (type === 'PERCENT') return `${String(Number((value * 100).toPrecision(15)))}%`
    if (type !== 'CURRENCY') return null
    pattern = CURRENCY
  }
  const texts = splitSections(pattern)
  const pick = value < 0 && texts.length > 1 ? 1 : value === 0 && texts.length > 2 ? 2 : 0
  const section = parseSection(texts[pick] ?? '')
  if (section === null) return null
  const sign = value < 0 && pick === 0 ? '-' : ''
  return sign + render(Math.abs(value), section)
}

function splitSections(pattern: string): string[] {
  const out: string[] = []
  let current = ''
  let quoted = false
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern.charAt(i)
    if (ch === '"') quoted = !quoted
    if (ch === '\\' && !quoted) {
      current += ch + pattern.charAt(i + 1)
      i += 1
    } else if (ch === ';' && !quoted) {
      out.push(current)
      current = ''
    } else current += ch
  }
  out.push(current)
  return out
}

function parseSection(text: string): Section | null {
  const s: Section = {
    prefix: '',
    suffix: '',
    intMin: 0,
    group: false,
    decMin: 0,
    decMax: 0,
    percent: 0,
    exponent: null,
  }
  let digits = false
  let point = false
  const literal = (t: string): void => {
    if (digits) s.suffix += t
    else s.prefix += t
  }
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i)
    const next = text.charAt(i + 1)
    if (ch === '"') {
      const end = text.indexOf('"', i + 1)
      const stop = end === -1 ? text.length : end
      literal(text.slice(i + 1, stop))
      i = stop
    } else if (ch === '\\') {
      literal(next)
      i += 1
    } else if (ch === '_') {
      literal(' ')
      i += 1
    } else if (ch === '*') {
      i += 1
    } else if (ch === '[') {
      const end = text.indexOf(']', i)
      i = end === -1 ? text.length : end
    } else if (ch === '0' || ch === '#' || ch === '?') {
      digits = true
      if (s.exponent !== null) s.exponent.digits += 1
      else if (point) {
        s.decMax += 1
        if (ch === '0') s.decMin = s.decMax
      } else if (ch === '0') s.intMin += 1
    } else if (ch === '.' && !point && s.exponent === null) {
      point = true
      digits = true
    } else if (ch === ',' && digits) {
      if (!point && s.exponent === null) s.group = true
    } else if (ch === '%') {
      s.percent += 1
      literal('%')
    } else if ((ch === 'E' || ch === 'e') && (next === '+' || next === '-') && digits) {
      s.exponent = { digits: 0, plus: next === '+' }
      i += 1
    } else if (/[A-Za-z@]/.test(ch)) {
      return null
    } else literal(ch)
  }
  return s
}

function render(value: number, s: Section): string {
  const scaled = value * 100 ** s.percent
  if (s.exponent === null) return s.prefix + fixed(roundTo(scaled, s.decMax), s) + s.suffix
  const intDigits = Math.max(s.intMin, 1)
  let exp = scaled === 0 ? 0 : Math.floor(Math.log10(scaled)) - (intDigits - 1)
  let mantissa = roundTo(scaled / 10 ** exp, s.decMax)
  if (mantissa >= 10 ** intDigits) {
    exp += 1
    mantissa = roundTo(scaled / 10 ** exp, s.decMax)
  }
  const sign = exp < 0 ? '-' : s.exponent.plus ? '+' : ''
  const power = String(Math.abs(exp)).padStart(s.exponent.digits, '0')
  return `${s.prefix}${fixed(mantissa, s)}E${sign}${power}${s.suffix}`
}

// Half away from zero on the decimal digits, the way a spreadsheet rounds,
// not the binary rounding `toFixed` does on its own (1.005 is 1.01).
function roundTo(value: number, digits: number): number {
  const scale = 10 ** digits
  return Math.round(value * scale * (1 + Number.EPSILON)) / scale
}

function fixed(value: number, s: Section): string {
  const [whole = '', frac = ''] = value.toFixed(s.decMax).split('.')
  let decimals = frac
  while (decimals.length > s.decMin && decimals.endsWith('0')) decimals = decimals.slice(0, -1)
  let int = whole.replace(/^0+/, '').padStart(s.intMin, '0')
  if (s.group) int = grouped(int)
  return decimals === '' ? int : `${int}.${decimals}`
}

function grouped(digits: string): string {
  let out = ''
  for (let i = 0; i < digits.length; i += 1) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ','
    out += digits.charAt(i)
  }
  return out
}
