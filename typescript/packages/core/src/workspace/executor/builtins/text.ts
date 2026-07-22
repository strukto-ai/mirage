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

import { interpretEscapes } from '../../../commands/builtin/utils/escapes.ts'
import { ECHO_OPTION } from '../../../commands/spec/shell.ts'
import { IOResult } from '../../../io/types.ts'
import { ExecutionNode } from '../../types.ts'
import type { Result } from './scope.ts'

/**
 * Print arguments, honoring GNU echo's option rules.
 *
 * GNU echo is not getopt: options are LEADING words matching `-[neE]+`
 * only. The first word that does not match (including `-x` or a
 * repeated `hi -n`) ends option parsing and prints literally. Within
 * clusters the last of -e/-E wins; -n sticks.
 */
export function handleEcho(args: string[]): Result {
  let noNewline = false
  let escapes = false
  let idx = 0
  for (const word of args) {
    if (!ECHO_OPTION.test(word)) break
    for (const ch of word.slice(1)) {
      if (ch === 'n') noNewline = true
      else if (ch === 'e') escapes = true
      else escapes = false
    }
    idx += 1
  }
  let text = args.slice(idx).join(' ')
  if (escapes) text = interpretEscapes(text)
  if (!noNewline) text += '\n'
  const out = new TextEncoder().encode(text)
  return [out, new IOResult(), new ExecutionNode({ command: 'echo', exitCode: 0 })]
}

const PRINTF_SIMPLE_ESCAPES: Record<string, string> = {
  '\\': '\\',
  n: '\n',
  t: '\t',
  r: '\r',
  a: '\x07',
  b: '\b',
  f: '\f',
  v: '\v',
}

const PRINTF_INT = /^[+-]?(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)/
const PRINTF_FLAGS = '-+ 0#'
const PRINTF_CONV = 'sdiouxXeEfFgGaAcbq%'
const HEX_DIGIT = /[0-9a-fA-F]/
const OCT_DIGIT = /[0-7]/
const DEC_DIGIT = /[0-9]/
const UINT64_MASK = (1n << 64n) - 1n

const ANSIC_ESCAPES: Record<string, string> = {
  '\x07': '\\a',
  '\b': '\\b',
  '\t': '\\t',
  '\n': '\\n',
  '\v': '\\v',
  '\f': '\\f',
  '\r': '\\r',
  '\x1b': '\\E',
  '\\': '\\\\',
  "'": "\\'",
}

const Q_SAFE = /[A-Za-z0-9%+\-./:=@_]/

type Star = number | '*' | null

/** Wrap an integer into signed 64-bit two's-complement range. */
function wrapSigned(n: bigint): bigint {
  return BigInt.asIntN(64, n)
}

/**
 * Parse a printf integer argument like C's `strtol` (base auto: `0x`
 * hex, leading `0` octal, else decimal, optional sign). Returns
 * [value, ok]; ok is false on a trailing or wholly invalid tail.
 */
function parsePrintfInt(value: string): [bigint, boolean] {
  const s = value.trim()
  if (s === '') return [0n, true]
  const m = PRINTF_INT.exec(s)
  if (!m) return [0n, false]
  const tok = m[0]
  const ok = tok === s
  const sign = tok.startsWith('-') ? -1n : 1n
  const digits = tok.replace(/^[+-]/, '')
  let n: bigint
  if (digits.startsWith('0x') || digits.startsWith('0X')) n = BigInt('0x' + digits.slice(2))
  else if (digits.length > 1 && digits.startsWith('0')) n = BigInt('0o' + digits.slice(1))
  else n = BigInt(digits)
  return [sign * n, ok]
}

/**
 * Resolve a numeric argument, honoring the GNU leading-quote form (`"A`
 * / `'A` yields the code point of the next character).
 */
function numericValue(value: string): [bigint, boolean] {
  if (value.startsWith("'") || value.startsWith('"')) {
    const rest = value.slice(1)
    return [rest ? BigInt(rest.codePointAt(0) ?? 0) : 0n, true]
  }
  return parsePrintfInt(value)
}

function isDecimalDigit(code: number): boolean {
  return code >= 48 && code <= 57
}

function isDecimalFloat(value: string): boolean {
  let index = 0
  if (value[index] === '+' || value[index] === '-') index += 1
  const integerStart = index
  while (isDecimalDigit(value.charCodeAt(index))) index += 1
  const integerDigits = index - integerStart
  let fractionalDigits = 0
  if (value[index] === '.') {
    index += 1
    const fractionalStart = index
    while (isDecimalDigit(value.charCodeAt(index))) index += 1
    fractionalDigits = index - fractionalStart
  }
  if (integerDigits === 0 && fractionalDigits === 0) return false
  if (value[index] === 'e' || value[index] === 'E') {
    index += 1
    if (value[index] === '+' || value[index] === '-') index += 1
    const exponentStart = index
    while (isDecimalDigit(value.charCodeAt(index))) index += 1
    if (index === exponentStart) return false
  }
  return index === value.length
}

/** Resolve a floating-point argument (decimal, hex float, inf/nan, or the leading-quote code-point form). Returns [value, ok]. */
function parseFloatArg(value: string): [number, boolean] {
  const s = value.trim()
  if (s === '') return [0, true]
  if (s.startsWith("'") || s.startsWith('"')) {
    const rest = s.slice(1)
    return [rest ? (rest.codePointAt(0) ?? 0) : 0, true]
  }
  const low = s.toLowerCase().replace(/^[+-]/, '')
  if (low.startsWith('0x')) {
    const v = parseHexFloat(s)
    return v === null ? [0, false] : [v, true]
  }
  if (isDecimalFloat(s)) return [Number(s), true]
  const l = s.toLowerCase().replace(/^[+-]/, '')
  if (l === 'inf' || l === 'infinity') return [s.startsWith('-') ? -Infinity : Infinity, true]
  if (l === 'nan') return [NaN, true]
  return [0, false]
}

function parseHexFloat(s: string): number | null {
  const m = /^([+-]?)0[xX]([0-9a-fA-F]*)(?:\.([0-9a-fA-F]*))?(?:[pP]([+-]?\d+))?$/.exec(s)
  if (!m) return null
  const sign = m[1] === '-' ? -1 : 1
  const intHex = m[2] ?? ''
  const fracHex = m[3] ?? ''
  const p = m[4] ? parseInt(m[4], 10) : 0
  if (!intHex && !fracHex) return null
  let mant = 0
  for (const c of intHex) mant = mant * 16 + parseInt(c, 16)
  let scale = 1
  for (const c of fracHex) {
    scale /= 16
    mant += parseInt(c, 16) * scale
  }
  return sign * mant * 2 ** p
}

/** Pad `prefix + body` to `width` per the justify/zero flags. */
function applyPad(
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

/** Render `%d %i %o %u %x %X` with 64-bit wrap and GNU flag rules. */
function formatInt(
  value: bigint,
  conv: string,
  flags: string,
  width: number | null,
  precision: number | null,
): string {
  let prefix = ''
  let digits: string
  if (conv === 'd' || conv === 'i') {
    const n = wrapSigned(value)
    const neg = n < 0n
    digits = (neg ? -n : n).toString()
    if (neg) prefix = '-'
    else if (flags.includes('+')) prefix = '+'
    else if (flags.includes(' ')) prefix = ' '
  } else {
    const u = value & UINT64_MASK
    if (conv === 'o') digits = u.toString(8)
    else if (conv === 'x' || conv === 'X') digits = u.toString(16)
    else digits = u.toString(10)
  }
  if (precision !== null) {
    if (precision === 0 && /^0*$/.test(digits)) digits = ''
    else if (digits.length < precision) digits = digits.padStart(precision, '0')
  }
  const nonzero = /[^0]/.test(digits)
  if (flags.includes('#')) {
    if (conv === 'x' && nonzero) prefix = '0x'
    else if (conv === 'X' && nonzero) prefix = '0X'
    else if (conv === 'o' && !digits.startsWith('0')) digits = '0' + digits
  }
  if (conv === 'X') digits = digits.toUpperCase()
  const allowZero = flags.includes('0') && precision === null
  return applyPad(prefix, digits, flags, width, allowZero)
}

/** Render a string for `%s` with GNU width/precision rules. */
function formatPrintfStr(
  s: string,
  flags: string,
  width: number | null,
  precision: number | null,
): string {
  if (precision !== null) s = s.slice(0, precision)
  return applyPad('', s, flags, width, false)
}

function formatChar(value: string, flags: string, width: number | null): string {
  const ch = value ? value.charAt(0) : '\0'
  return applyPad('', ch, flags, width, false)
}

// ---- float formatting (exact-decimal, round-half-to-even; matches C double) ----

function floatBits(x: number): { sign: number; expField: number; frac: bigint } {
  const buf = new ArrayBuffer(8)
  new DataView(buf).setFloat64(0, x)
  const hi = new DataView(buf).getUint32(0)
  const lo = new DataView(buf).getUint32(4)
  const sign = hi >>> 31
  const expField = (hi >>> 20) & 0x7ff
  const frac = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo >>> 0)
  return { sign, expField, frac }
}

/** Exact unsigned decimal digits of a finite nonzero |x|: significant digit string (no leading zeros) and the power of ten of the leading digit. */
function exactDecimal(x: number): { digits: string; pointExp: number } {
  const { expField, frac } = floatBits(x)
  let m: bigint
  let e2: number
  if (expField === 0) {
    m = frac
    e2 = -1074
  } else {
    m = frac | (1n << 52n)
    e2 = expField - 1075
  }
  let n: bigint
  let k: number
  if (e2 >= 0) {
    n = m << BigInt(e2)
    k = 0
  } else {
    k = -e2
    n = m * 5n ** BigInt(k)
  }
  const s = n.toString()
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
  const { expField, frac } = floatBits(x)
  let m: bigint
  let e2: number
  if (expField === 0) {
    m = frac
    e2 = -1074
  } else {
    m = frac | (1n << 52n)
    e2 = expField - 1075
  }
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

function frexp(x: number): [number, number] {
  if (x === 0 || !Number.isFinite(x)) return [x, 0]
  let e = Math.ceil(Math.log2(Math.abs(x)))
  let m = x / 2 ** e
  while (Math.abs(m) >= 1) {
    m /= 2
    e += 1
  }
  while (Math.abs(m) < 0.5) {
    m *= 2
    e -= 1
  }
  return [m, e]
}

function roundHex(fracHex: string, precision: number): string {
  if (precision >= fracHex.length) return fracHex.padEnd(precision, '0')
  const kept = fracHex.slice(0, precision)
  const nd = parseInt(fracHex.charAt(precision), 16)
  const restNonzero = /[1-9a-fA-F]/.test(fracHex.slice(precision + 1))
  const lastKept = precision > 0 ? parseInt(kept.charAt(precision - 1), 16) : 1
  const roundUp = nd > 8 || (nd === 8 && (restNonzero || lastKept % 2 === 1))
  if (!roundUp) return kept
  if (precision === 0) return ''
  const inc = (BigInt('0x' + kept) + 1n).toString(16).padStart(precision, '0')
  return inc.slice(-precision)
}

function formatHexFloat(
  x: number,
  flags: string,
  width: number | null,
  precision: number | null,
  upper: boolean,
): string {
  const special = specialFloat(x, flags, width, upper)
  if (special !== null) return special
  const sign = floatSign(x, flags)
  let lead = 0
  let fracHex = ''
  let exp2 = 0
  if (Math.abs(x) !== 0) {
    lead = 1
    const [m, e] = frexp(Math.abs(x))
    exp2 = e - 1
    let frac = m * 2 - 1
    for (let i = 0; i < 13; i++) {
      frac *= 16
      const d = Math.floor(frac)
      fracHex += '0123456789abcdef'.charAt(d)
      frac -= d
    }
  }
  fracHex = precision !== null ? roundHex(fracHex, precision) : fracHex.replace(/0+$/, '')
  const prefix = sign + (upper ? '0X' : '0x')
  let body = String(lead)
  if (fracHex || flags.includes('#')) body += '.' + fracHex
  const es = exp2 >= 0 ? '+' : '-'
  body += (upper ? 'P' : 'p') + es + String(Math.abs(exp2))
  if (upper) body = body.toUpperCase()
  return applyPad(prefix, body, flags, width, flags.includes('0'))
}

/** Interpret a backslash escape at `fmt[i]`. Returns emitted text, next index, and whether output should stop (`\c`). */
function readEscape(fmt: string, i: number): [string, number, boolean] {
  const n = fmt.length
  if (i + 1 >= n) return ['\\', i + 1, false]
  const ch = fmt.charAt(i + 1)
  if (ch === 'c') return ['', i + 2, true]
  const simple = PRINTF_SIMPLE_ESCAPES[ch]
  if (simple !== undefined) return [simple, i + 2, false]
  if (ch === 'x' || ch === 'u' || ch === 'U') {
    const limit = ch === 'x' ? 2 : ch === 'u' ? 4 : 8
    let digits = ''
    let j = i + 2
    while (j < n && digits.length < limit && HEX_DIGIT.test(fmt.charAt(j))) {
      digits += fmt.charAt(j)
      j += 1
    }
    if (digits) return [String.fromCodePoint(parseInt(digits, 16)), j, false]
    return ['\\' + ch, i + 2, false]
  }
  if (OCT_DIGIT.test(ch)) {
    let digits = ''
    let j = i + 1
    if (fmt.charAt(j) === '0') j += 1
    while (j < n && digits.length < 3 && OCT_DIGIT.test(fmt.charAt(j))) {
      digits += fmt.charAt(j)
      j += 1
    }
    if (!digits) return ['\0', j, false]
    return [String.fromCharCode(parseInt(digits, 8)), j, false]
  }
  return ['\\' + ch, i + 2, false]
}

function expandEscapes(s: string): [string, boolean] {
  let out = ''
  let i = 0
  const n = s.length
  while (i < n) {
    if (s.charAt(i) === '\\') {
      const [text, ni, stop] = readEscape(s, i)
      out += text
      i = ni
      if (stop) return [out, true]
    } else {
      out += s.charAt(i)
      i += 1
    }
  }
  return [out, false]
}

function quoteShell(s: string): string {
  if (s === '') return "''"
  const data = new TextEncoder().encode(s)
  let needAnsic = false
  for (const b of data) if (b < 0x20 || b === 0x7f || b >= 0x80) needAnsic = true
  if (needAnsic) {
    let parts = "$'"
    for (const b of data) {
      const ch = String.fromCharCode(b)
      const esc = ANSIC_ESCAPES[ch]
      if (esc !== undefined) parts += esc
      else if (b >= 0x20 && b < 0x7f) parts += ch
      else parts += '\\' + b.toString(8).padStart(3, '0')
    }
    return parts + "'"
  }
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s.charAt(i)
    if (Q_SAFE.test(ch) || ((ch === '#' || ch === '~') && i !== 0)) out += ch
    else out += '\\' + ch
  }
  return out
}

function readConversion(fmt: string, i: number): [string, Star, Star, string, number] | null {
  const n = fmt.length
  let j = i + 1
  if (j < n && fmt.charAt(j) === '%') return ['', null, null, '%', j + 1]
  let flags = ''
  while (j < n && PRINTF_FLAGS.includes(fmt.charAt(j))) {
    flags += fmt.charAt(j)
    j += 1
  }
  let width: Star = null
  if (j < n && fmt.charAt(j) === '*') {
    width = '*'
    j += 1
  } else {
    const ws = j
    while (j < n && DEC_DIGIT.test(fmt.charAt(j))) j += 1
    if (j > ws) width = parseInt(fmt.slice(ws, j), 10)
  }
  let precision: Star = null
  if (j < n && fmt.charAt(j) === '.') {
    j += 1
    if (j < n && fmt.charAt(j) === '*') {
      precision = '*'
      j += 1
    } else {
      const ps = j
      while (j < n && DEC_DIGIT.test(fmt.charAt(j))) j += 1
      precision = j > ps ? parseInt(fmt.slice(ps, j), 10) : 0
    }
  }
  const conv = fmt.charAt(j)
  if (j < n && PRINTF_CONV.includes(conv)) return [flags, width, precision, conv, j + 1]
  return null
}

function convert(
  conv: string,
  raw: string | null,
  flags: string,
  width: number | null,
  precision: number | null,
): [string, string | null, boolean] {
  if (conv === 's') return [formatPrintfStr(raw ?? '', flags, width, precision), null, false]
  if (conv === 'c') return [formatChar(raw ?? '', flags, width), null, false]
  if (conv === 'b') {
    const [expanded, stop] = expandEscapes(raw ?? '')
    const text = precision !== null ? expanded.slice(0, precision) : expanded
    return [applyPad('', text, flags, width, false), null, stop]
  }
  if (conv === 'q') return [applyPad('', quoteShell(raw ?? ''), flags, width, false), null, false]
  if ('diouxX'.includes(conv)) {
    let value = 0n
    let err: string | null = null
    if (raw !== null) {
      const [v, valid] = numericValue(raw)
      value = v
      if (!valid) err = `printf: ${raw}: invalid number\n`
    }
    return [formatInt(value, conv, flags, width, precision), err, false]
  }
  let value = 0
  let err: string | null = null
  if (raw !== null) {
    const [v, valid] = parseFloatArg(raw)
    value = v
    if (!valid) err = `printf: ${raw}: invalid number\n`
  }
  if (conv === 'f' || conv === 'F')
    return [formatF(value, flags, width, precision, conv === 'F'), err, false]
  if (conv === 'e' || conv === 'E')
    return [formatE(value, flags, width, precision, conv === 'E'), err, false]
  if (conv === 'g' || conv === 'G')
    return [formatG(value, flags, width, precision, conv === 'G'), err, false]
  return [formatHexFloat(value, flags, width, precision, conv === 'A'), err, false]
}

function runPrintf(fmt: string, args: string[]): [string, string[]] {
  const out: string[] = []
  const errors: string[] = []
  let argI = 0
  const total = args.length
  let stop = false
  for (;;) {
    const consumedStart = argI
    let i = 0
    const n = fmt.length
    while (i < n && !stop) {
      const ch = fmt.charAt(i)
      if (ch === '\\') {
        const [text, ni, stopHere] = readEscape(fmt, i)
        out.push(text)
        i = ni
        stop = stopHere
        continue
      }
      if (ch === '%') {
        const spec = readConversion(fmt, i)
        if (spec === null) {
          out.push('%')
          i += 1
          continue
        }
        const [flags0, widthStar, precStar, conv, ni] = spec
        let flags = flags0
        i = ni
        if (conv === '%') {
          out.push('%')
          continue
        }
        let width: number | null = typeof widthStar === 'number' ? widthStar : null
        if (widthStar === '*') {
          const star = argI < total ? (args[argI] ?? '0') : '0'
          if (argI < total) argI += 1
          const [wv] = numericValue(star)
          const w = Number(wv)
          if (w < 0) {
            flags += '-'
            width = -w
          } else width = w
        }
        let precision: number | null = typeof precStar === 'number' ? precStar : null
        if (precStar === '*') {
          const star = argI < total ? (args[argI] ?? '0') : '0'
          if (argI < total) argI += 1
          const [pv] = numericValue(star)
          const p = Number(pv)
          precision = p < 0 ? null : p
        }
        const raw = argI < total ? (args[argI] ?? '') : null
        if (raw !== null) argI += 1
        const [text, err, stopHere] = convert(conv, raw, flags, width, precision)
        if (err !== null) errors.push(err)
        out.push(text)
        if (stopHere) {
          stop = true
        }
        continue
      }
      out.push(ch)
      i += 1
    }
    if (stop || argI >= total || argI === consumedStart) break
  }
  return [out.join(''), errors]
}

/**
 * Print formatted output, honoring GNU printf's format-reuse rules.
 *
 * Supports `%s %c %b %q`, the integer conversions `%d %i %o %u %x %X`,
 * the float conversions `%f %F %e %E %g %G %a %A`, and `%%`, with
 * `- + 0 # (space)` flags, numeric or `*` width/precision, and backslash
 * escapes (including `\u`/`\U`) interpreted once in the same scan. When
 * arguments remain after one pass the format is reused until they are
 * exhausted; a missing argument renders as the empty string / `0`.
 * Integers wrap at 64 bits; `%a` formats at IEEE double precision.
 */
export function handlePrintf(args: string[]): Result {
  if (args.length === 0) {
    return [new Uint8Array(), new IOResult(), new ExecutionNode({ command: 'printf', exitCode: 0 })]
  }
  const [output, errors] = runPrintf(args[0] ?? '', args.slice(1))
  const out = new TextEncoder().encode(output)
  if (errors.length > 0) {
    const err = new TextEncoder().encode(errors.join(''))
    return [
      out,
      new IOResult({ exitCode: 1, stderr: err }),
      new ExecutionNode({ command: 'printf', exitCode: 1, stderr: err }),
    ]
  }
  return [out, new IOResult(), new ExecutionNode({ command: 'printf', exitCode: 0 })]
}

/**
 * `read VAR1 [VAR2 ...]` — read one line from stdin and assign to env vars.
 * Mirrors Python's `mirage.workspace.executor.builtins.handle_read`.
 *
 * Mirrors POSIX behavior:
 *   - Single var: assign whole line.
 *   - Multiple vars: split on whitespace, last var gets the remainder.
 *   - No stdin / EOF: assign all vars to "" and exit 1.
 */
