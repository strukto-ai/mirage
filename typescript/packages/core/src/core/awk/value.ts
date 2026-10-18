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

export function applyPad(
  prefix: string,
  body: string,
  flags: string,
  width: number | null,
  allowZero: boolean,
): string {
  const s = prefix + body
  if (width === null || s.length >= width) return s
  const pad = width - s.length
  if (flags.includes('-')) return s + ' '.repeat(pad)
  if (allowZero && flags.includes('0')) return prefix + '0'.repeat(pad) + body
  return ' '.repeat(pad) + s
}

function binaryParts(x: number): [bigint, number] {
  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, x)
  const hi = view.getUint32(0)
  const expField = (hi >>> 20) & 0x7ff
  const frac = (BigInt(hi & 0xfffff) << 32n) | BigInt(view.getUint32(4))
  return expField === 0 ? [frac, -1074] : [frac | (1n << 52n), expField - 1075]
}

/** Exact unsigned decimal digits of a finite nonzero |x|: significant digit string (no leading zeros) and the power of ten of the leading digit. */
function exactDecimal(x: number): { digits: string; pointExp: number } {
  const [m, e2] = binaryParts(x)
  const k = Math.max(0, -e2)
  const s = (e2 >= 0 ? m << BigInt(e2) : m * 5n ** BigInt(k)).toString()
  return { digits: s, pointExp: s.length - 1 - k }
}

function incDigits(s: string): string {
  return (BigInt(s) + 1n).toString().padStart(s.length, '0')
}

function roundSig(
  digits: string,
  pointExp: number,
  sig: number,
): { digits: string; pointExp: number } {
  if (digits.length <= sig) return { digits: digits.padEnd(sig, '0'), pointExp }
  let kept = digits.slice(0, sig)
  const nextD = digits.charCodeAt(sig) - 48
  const restNonzero = /[1-9]/.test(digits.slice(sig + 1))
  const lastKept = kept.charCodeAt(sig - 1) - 48
  const roundUp = nextD > 5 || (nextD === 5 && (restNonzero || lastKept % 2 === 1))
  if (roundUp) {
    kept = incDigits(kept)
    if (kept.length > sig) {
      kept = kept.slice(0, sig)
      pointExp += 1
    }
  }
  return { digits: kept, pointExp }
}

function roundFixed(
  intPart: string,
  fracPart: string,
  p: number,
): { intPart: string; fracPart: string } {
  if (p >= fracPart.length) return { intPart, fracPart: fracPart.padEnd(p, '0') }
  const kept = fracPart.slice(0, p)
  const nextD = fracPart.charCodeAt(p) - 48
  const restNonzero = /[1-9]/.test(fracPart.slice(p + 1))
  const lastKept = p > 0 ? kept.charCodeAt(p - 1) - 48 : intPart.charCodeAt(intPart.length - 1) - 48
  const roundUp = nextD > 5 || (nextD === 5 && (restNonzero || lastKept % 2 === 1))
  if (!roundUp) return { intPart, fracPart: kept }
  const combined = intPart + kept
  const inc = incDigits(combined)
  const newFrac = p > 0 ? inc.slice(inc.length - p) : ''
  const newInt = inc.slice(0, inc.length - p) || '0'
  return { intPart: newInt, fracPart: newFrac }
}

function fixedParts(x: number): { intPart: string; fracPart: string } {
  const [m, e2] = binaryParts(x)
  if (e2 >= 0) return { intPart: (m << BigInt(e2)).toString(), fracPart: '' }
  const k = -e2
  const n = m * 5n ** BigInt(k)
  const padded = n.toString().padStart(k + 1, '0')
  return { intPart: padded.slice(0, padded.length - k), fracPart: padded.slice(padded.length - k) }
}

function trimZeros(s: string): string {
  return s.replace(/0+$/, '')
}

function floatSign(x: number, flags: string): string {
  if (x < 0 || Object.is(x, -0)) return '-'
  if (flags.includes('+')) return '+'
  if (flags.includes(' ')) return ' '
  return ''
}

function specialFloat(
  x: number,
  flags: string,
  width: number | null,
  upper: boolean,
): string | null {
  if (Number.isNaN(x)) return applyPad('', upper ? 'NAN' : 'nan', flags, width, false)
  if (!Number.isFinite(x)) {
    const sign = x < 0 ? '-' : flags.includes('+') ? '+' : flags.includes(' ') ? ' ' : ''
    return applyPad(sign, upper ? 'INF' : 'inf', flags, width, false)
  }
  return null
}

function formatF(
  x: number,
  flags: string,
  width: number | null,
  precision: number | null,
  upper: boolean,
): string {
  const special = specialFloat(x, flags, width, upper)
  if (special !== null) return special
  const p = precision ?? 6
  const sign = floatSign(x, flags)
  let { intPart, fracPart } = fixedParts(Math.abs(x))
  ;({ intPart, fracPart } = roundFixed(intPart || '0', fracPart, p))
  let body = intPart
  if (p > 0 || flags.includes('#')) body += '.' + fracPart
  return applyPad(sign, body, flags, width, flags.includes('0'))
}

function formatE(
  x: number,
  flags: string,
  width: number | null,
  precision: number | null,
  upper: boolean,
): string {
  const special = specialFloat(x, flags, width, upper)
  if (special !== null) return special
  const p = precision ?? 6
  const sign = floatSign(x, flags)
  let body: string
  if (x === 0) {
    body = p > 0 || flags.includes('#') ? '0.' + '0'.repeat(p) : '0'
    body += (upper ? 'E+' : 'e+') + '00'
  } else {
    const ex = exactDecimal(Math.abs(x))
    const r = roundSig(ex.digits, ex.pointExp, p + 1)
    const mant = r.digits.charAt(0) + (p > 0 || flags.includes('#') ? '.' + r.digits.slice(1) : '')
    const es = r.pointExp < 0 ? '-' : '+'
    body = mant + (upper ? 'E' : 'e') + es + String(Math.abs(r.pointExp)).padStart(2, '0')
  }
  return applyPad(sign, body, flags, width, flags.includes('0'))
}

function formatG(
  x: number,
  flags: string,
  width: number | null,
  precision: number | null,
  upper: boolean,
): string {
  const special = specialFloat(x, flags, width, upper)
  if (special !== null) return special
  let p = precision ?? 6
  if (p === 0) p = 1
  const sign = floatSign(x, flags)
  const alt = flags.includes('#')
  let body: string
  if (x === 0) {
    body = alt ? '0.' + '0'.repeat(p - 1) : '0'
  } else {
    const ex = exactDecimal(Math.abs(x))
    const r = roundSig(ex.digits, ex.pointExp, p)
    const expo = r.pointExp
    if (expo < -4 || expo >= p) {
      let mantDigits = r.digits
      if (!alt) mantDigits = trimZeros(mantDigits) || '0'
      const mant =
        mantDigits.charAt(0) + (mantDigits.length > 1 || alt ? '.' + mantDigits.slice(1) : '')
      const es = expo < 0 ? '-' : '+'
      body = mant + (upper ? 'E' : 'e') + es + String(Math.abs(expo)).padStart(2, '0')
    } else {
      const fracLen = p - 1 - expo
      let intPart: string
      let fracPart: string
      if (expo >= 0) {
        intPart = r.digits.slice(0, expo + 1)
        fracPart = r.digits.slice(expo + 1)
      } else {
        intPart = '0'
        fracPart = '0'.repeat(-expo - 1) + r.digits
      }
      fracPart = fracPart.padEnd(fracLen, '0').slice(0, fracLen)
      if (!alt) fracPart = trimZeros(fracPart)
      body = intPart + (fracPart || alt ? '.' + fracPart : '')
    }
  }
  return applyPad(sign, body, flags, width, flags.includes('0'))
}

const NUMERIC_STRING = /^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$/

const NUMERIC_PREFIX = /^[ \t\n]*[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?/

const CONVFMT_SPEC = /^%([-+ #0]*)([0-9]*)(\.[0-9]*)?([eEfFgG])$/

const DEFAULT_CONVFMT = '%.6g'

const BLANK_EDGES = /^[ \t\n]+|[ \t\n]+$/g

const INT_LIMIT = 2 ** 63

const INT_CLAMP = 2n ** 63n

export const ValueKind = {
  UNINIT: 'UNINIT',
  NUM: 'NUM',
  STR: 'STR',
  STRNUM: 'STRNUM',
} as const
export type ValueKind = (typeof ValueKind)[keyof typeof ValueKind]

export interface Value {
  readonly kind: ValueKind
  readonly num: number
  readonly text: string
}

export const UNINIT: Value = { kind: ValueKind.UNINIT, num: 0, text: '' }

export function num(value: number): Value {
  return { kind: ValueKind.NUM, num: value, text: '' }
}

export function text(value: string): Value {
  return { kind: ValueKind.STR, num: 0, text: value }
}

export function stripBlanks(raw: string): string {
  return raw.replace(BLANK_EDGES, '')
}

/** Whether a string lexically matches an awk NUMBER token, blanks aside. */
export function looksNumeric(raw: string): boolean {
  const stripped = stripBlanks(raw)
  if (stripped === '') return false
  return NUMERIC_STRING.test(stripped)
}

/**
 * Wrap input-derived text, tagging it strnum when it looks numeric.
 * Fields, split() output and command-line assignments produce these; the
 * tag is what makes `$1 == 10` a numeric comparison. An absent or empty
 * field is a plain string: every awk agrees `$9 == 0` is false while
 * `x == 0` is true for an unset variable x.
 */
export function strnum(raw: string): Value {
  if (raw === '') return text('')
  if (looksNumeric(raw)) return { kind: ValueKind.STRNUM, num: parseNumber(raw), text: raw }
  return text(raw)
}

/** Convert a leading numeric prefix to a number, strtod style. */
export function parseNumber(raw: string): number {
  const match = NUMERIC_PREFIX.exec(raw)
  if (match === null) return 0
  const body = stripBlanks(match[0])
  if (body === '' || body === '+' || body === '-') return 0
  return Number(body)
}

export function toNum(value: Value): number {
  if (value.kind === ValueKind.UNINIT) return 0
  if (value.kind === ValueKind.NUM || value.kind === ValueKind.STRNUM) return value.num
  return parseNumber(value.text)
}

/**
 * Truncate toward zero the way awk reads an integer. NaN reads as 0 and
 * an infinity clamps to the 64-bit edge, so a field index or a substr
 * position never misbehaves on a degenerate number.
 */
export function toInt(value: number): bigint {
  if (Number.isNaN(value)) return 0n
  if (!Number.isFinite(value)) return value > 0 ? INT_CLAMP : -INT_CLAMP
  return BigInt(Math.trunc(value))
}

/** `toInt` narrowed to a safe JS number, for positions and counts. */
export function toIndex(value: number): number {
  const wide = toInt(value)
  if (wide > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER
  if (wide < BigInt(Number.MIN_SAFE_INTEGER)) return Number.MIN_SAFE_INTEGER
  return Number(wide)
}

function applyConvfmt(value: number, convfmt: string): string {
  const match = CONVFMT_SPEC.exec(convfmt) ?? CONVFMT_SPEC.exec(DEFAULT_CONVFMT)
  if (match === null) return String(value)
  const flags = match[1] ?? ''
  const width = match[2] !== undefined && match[2] !== '' ? Number(match[2]) : null
  const precision = match[3] === undefined ? null : Number(match[3].slice(1) || '0')
  return formatFloat(match[4] ?? 'g', value, flags, width, precision)
}

export function formatFloat(
  conv: string,
  value: number,
  flags: string,
  width: number | null,
  precision: number | null,
): string {
  const upper = conv === conv.toUpperCase()
  const lower = conv.toLowerCase()
  if (lower === 'f') return formatF(value, flags, width, precision, upper)
  if (lower === 'e') return formatE(value, flags, width, precision, upper)
  return formatG(value, flags, width, precision, upper)
}

/**
 * Render a number the way awk converts numbers to strings: an integral
 * value prints as an integer whatever CONVFMT says, anything else goes
 * through CONVFMT (or OFMT for output).
 */
export function formatNum(value: number, convfmt: string): string {
  if (Number.isNaN(value)) return 'nan'
  if (!Number.isFinite(value)) return value > 0 ? 'inf' : '-inf'
  if (Number.isInteger(value) && Math.abs(value) < INT_LIMIT) return BigInt(value).toString()
  return applyConvfmt(value, convfmt)
}

export function toStr(value: Value, convfmt: string): string {
  if (value.kind === ValueKind.UNINIT) return ''
  if (value.kind === ValueKind.NUM) return formatNum(value.num, convfmt)
  return value.text
}

export function isTrue(value: Value): boolean {
  if (value.kind === ValueKind.UNINIT) return false
  if (value.kind === ValueKind.NUM || value.kind === ValueKind.STRNUM) return value.num !== 0
  return value.text !== ''
}

function comparesNumerically(value: Value): boolean {
  return value.kind !== ValueKind.STR
}

/**
 * Compare two awk values. POSIX compares numerically when both sides are
 * numeric, numeric strings or uninitialized, and lexically otherwise.
 */
export function compare(left: Value, right: Value, convfmt: string): number {
  if (comparesNumerically(left) && comparesNumerically(right)) {
    const lhs = toNum(left)
    const rhs = toNum(right)
    if (lhs === rhs) return 0
    return lhs < rhs ? -1 : 1
  }
  const lhs = toStr(left, convfmt)
  const rhs = toStr(right, convfmt)
  if (lhs === rhs) return 0
  return lhs < rhs ? -1 : 1
}
