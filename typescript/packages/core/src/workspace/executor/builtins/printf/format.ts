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

import { C_SPACE, INTMAX, UINTMAX } from '../../../../commands/builtin/constants.ts'
import { STRTOD, strtodDouble, strtoldErange } from '../../../../commands/builtin/utils/strtod.ts'
import { quoteText } from '../../../../commands/quote.ts'
import { byteChar, encodeText } from '../../../../shell/bytes.ts'
import { codePointText } from '../../../../shell/escapes.ts'

// printf's escape grammar is not echo's: it reads a bare \NNN, while
// `echo -e` wants \0NNN and gives \c a different meaning. Only the
// simple table and \x, \u and \U overlap, and only printf warns when
// those three have no digits, so each reader keeps its own.
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

// C's int, which bounds a `*` width or precision.
const INT_MAX = (1n << 31n) - 1n
const INT_MIN = -(1n << 31n)

// The integer strtoimax and strtoumax read at base 0 in the C locale: the
// blanks and sign, then hex after 0x, binary after 0b (glibc 2.38 on), octal
// after a leading 0, else decimal. A 0x or 0b with no digit after it reads
// as the 0 alone.
const STRTOL = new RegExp(
  `^${C_SPACE}([+-]?)(?:0[xX]([0-9a-fA-F]+)|0[bB]([01]+)|(0[0-7]*)|([1-9][0-9]*))`,
)
const PRINTF_FLAGS = '-+ 0#'
const PRINTF_CONV = 'sdiouxXeEfFgGaAcbq%'
const HEX_DIGIT = /[0-9a-fA-F]/
const OCT_DIGIT = /[0-7]/
const DEC_DIGIT = /[0-9]/

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

/**
 * Read an integer argument as strtoimax (signed) or strtoumax does.
 *
 * Returns the value, how many characters were read (0 when no number
 * starts the text) and whether it was out of range. A signed value stops at
 * the 64-bit bounds and an unsigned one at 2**64 - 1, while a negative
 * unsigned one in range wraps around 2**64.
 */
function readInt(text: string, signed: boolean): [bigint, number, boolean] {
  const found = STRTOL.exec(text)
  if (found === null) return [0n, 0, false]
  const [, sign, hexa, binary, octal, decimal] = found
  let n: bigint
  if (hexa !== undefined) n = BigInt('0x' + hexa)
  else if (binary !== undefined) n = BigInt('0b' + binary)
  else if (octal !== undefined) n = BigInt('0o' + octal)
  else n = (decimal ?? '0').length <= 20 ? BigInt(decimal ?? '0') : UINTMAX + 1n
  const read = found[0].length
  if (signed) {
    const limit = INTMAX + (sign === '-' ? 1n : 0n)
    const value = n > limit ? limit : n
    return [sign === '-' ? -value : value, read, n > limit]
  }
  if (n > UINTMAX) return [UINTMAX, read, true]
  return [sign === '-' ? -n & UINTMAX : n, read, false]
}

/**
 * The error a numeric argument fails printf with, or null.
 *
 * bash's builtin says `invalid number` for an argument it could not read
 * whole, naming the base when the text opens as an octal (`0` and a digit)
 * or hex (`0x`) number, and only warns when the value was out of range; an
 * empty argument is a quiet 0. GNU's program refuses an empty or unread
 * argument, a partly read one and an out of range one alike, quoting the
 * argument. A warning that does not fail printf goes to `warnings`.
 */
function numericError(
  raw: string,
  read: number,
  erange: boolean,
  program: boolean,
  warnings: string[],
): string | null {
  if (program) {
    let problem: string
    if (erange) problem = 'Numerical result out of range'
    else if (read === 0) problem = 'expected a numeric value'
    else if (read < raw.length) problem = 'value not completely converted'
    else return null
    return `printf: '${quoteText(raw)}': ${problem}\n`
  }
  if (read < raw.length) {
    const base = /^0[0-9]/.test(raw) ? 'octal ' : raw.startsWith('0x') ? 'hex ' : ''
    return `printf: ${raw}: invalid ${base}number\n`
  }
  if (erange) warnings.push(`printf: warning: ${raw}: Numerical result out of range\n`)
  return null
}

/**
 * The value of a leading-quote argument: its next character's code. bash's
 * builtin takes a lone quote as 0. GNU's program refuses it, and warns that
 * it ignored any characters after the first unless `POSIXLY_CORRECT` is in
 * its environment (`posix`).
 */
function characterValue(
  raw: string,
  program: boolean,
  posix: boolean,
  warnings: string[],
): [number, string | null] {
  const rest = raw.slice(1)
  const code = rest.codePointAt(0)
  if (code === undefined)
    return [0, program ? `printf: '${quoteText(raw)}': expected a numeric value\n` : null]
  const after = rest.slice(String.fromCodePoint(code).length)
  if (program && !posix && after !== '')
    warnings.push(
      `printf: warning: ${after}: character(s) following character constant have been ignored\n`,
    )
  return [code, null]
}

/** An integer argument's value and the error it fails printf with. */
function intArgument(
  raw: string,
  signed: boolean,
  program: boolean,
  posix: boolean,
  warnings: string[],
): [bigint, string | null] {
  if (raw.startsWith("'") || raw.startsWith('"')) {
    const [code, err] = characterValue(raw, program, posix, warnings)
    return [BigInt(code), err]
  }
  const [value, read, erange] = readInt(raw, signed)
  return [value, numericError(raw, read, erange, program, warnings)]
}

/** A floating-point argument's value and the error it fails printf with. */
function floatArgument(
  raw: string,
  program: boolean,
  posix: boolean,
  warnings: string[],
): [number, string | null] {
  if (raw.startsWith("'") || raw.startsWith('"'))
    return characterValue(raw, program, posix, warnings)
  const found = STRTOD.exec(raw)
  if (found === null) return [0, numericError(raw, 0, false, program, warnings)]
  return [
    strtodDouble(found),
    numericError(raw, found[0].length, strtoldErange(found), program, warnings),
  ]
}

/**
 * A `*` width or precision, held to C's `int`: the value, the error that
 * fails printf, and whether that error stops it. GNU's program refuses one
 * outside the range and stops, except a precision under it, which reads as
 * omitted. bash's builtin holds it at the bound and warns, naming the
 * argument after the `*` (`following`).
 */
function starValue(
  star: string,
  precision: boolean,
  following: string | null,
  program: boolean,
  posix: boolean,
  warnings: string[],
): [bigint, string | null, boolean] {
  const [value, err] = intArgument(star, true, program, posix, warnings)
  if (value >= INT_MIN && value <= INT_MAX) return [value, err, false]
  if (program) {
    if (precision && value < 0n) return [value, err, false]
    if (err !== null) warnings.push(err)
    const field = precision ? 'precision' : 'field width'
    return [value, `printf: invalid ${field}: '${quoteText(star)}'\n`, true]
  }
  if (following !== null)
    warnings.push(`printf: warning: ${following}: Numerical result out of range\n`)
  return [value < INT_MIN ? INT_MIN : value > INT_MAX ? INT_MAX : value, err, false]
}

/** Pad `prefix + body` to `width` per the justify/zero flags. */
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

/**
 * Render `%d %i %o %u %x %X` with GNU flag rules. The value is as read,
 * signed for `%d`/`%i` and unsigned for the rest.
 */
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
    const neg = value < 0n
    digits = (neg ? -value : value).toString()
    if (neg) prefix = '-'
    else if (flags.includes('+')) prefix = '+'
    else if (flags.includes(' ')) prefix = ' '
  } else if (conv === 'o') digits = value.toString(8)
  else if (conv === 'x' || conv === 'X') digits = value.toString(16)
  else digits = value.toString(10)
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

export function formatF(
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

export function formatE(
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

export function formatG(
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

/**
 * Interpret a backslash escape at `fmt[i]`, the format string or a `%b`
 * argument (`bArg`). Returns emitted text, next index, and whether output
 * should stop (`\c`).
 *
 * An octal escape in the format is `\NNN`, one to three digits. A `%b`
 * argument also takes `\0NNN`: after a leading `0`, up to three more
 * digits. bash 5.2.37 writes `printf '\0003'` as NUL then `3` and
 * `printf %b '\0003'` as the byte 3.
 *
 * A `\x`, `\u` or `\U` with no hex digit after it is written as it
 * stands, and bash's warning for it goes to `warnings`, in the order bash
 * writes them to stderr. bash writes it as a `bash: printf:` diagnostic and
 * leaves the exit status alone, so `printf '\x'` still exits 0.
 */
function readEscape(
  fmt: string,
  i: number,
  warnings: string[],
  bArg: boolean,
): [string, number, boolean] {
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
    if (digits) {
      const value = parseInt(digits, 16)
      // \x names a byte; \u and \U name a code point.
      return [ch === 'x' ? byteChar(value) : codePointText(value), j, false]
    }
    const kind = ch === 'x' ? 'hex' : 'unicode'
    warnings.push(`printf: missing ${kind} digit for \\${ch}\n`)
    return ['\\' + ch, i + 2, false]
  }
  if (OCT_DIGIT.test(ch)) {
    const start = i + 1
    const limit = bArg && ch === '0' ? 4 : 3
    let j = start
    while (j < n && j - start < limit && OCT_DIGIT.test(fmt.charAt(j))) j += 1
    return [byteChar(parseInt(fmt.slice(start, j), 8)), j, false]
  }
  return ['\\' + ch, i + 2, false]
}

function expandEscapes(s: string, warnings: string[]): [string, boolean] {
  let out = ''
  let i = 0
  const n = s.length
  while (i < n) {
    if (s.charAt(i) === '\\') {
      const [text, ni, stop] = readEscape(s, i, warnings, true)
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
  const data = encodeText(s)
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
  program: boolean,
  posix: boolean,
  warnings: string[],
): [string, string | null, boolean] {
  if (conv === 's') return [formatPrintfStr(raw ?? '', flags, width, precision), null, false]
  if (conv === 'c') return [formatChar(raw ?? '', flags, width), null, false]
  if (conv === 'b') {
    const [expanded, stop] = expandEscapes(raw ?? '', warnings)
    const text = precision !== null ? expanded.slice(0, precision) : expanded
    return [applyPad('', text, flags, width, false), null, stop]
  }
  if (conv === 'q') return [applyPad('', quoteShell(raw ?? ''), flags, width, false), null, false]
  if ('diouxX'.includes(conv)) {
    const [value, err] =
      raw === null
        ? [0n, null]
        : intArgument(raw, conv === 'd' || conv === 'i', program, posix, warnings)
    return [formatInt(value, conv, flags, width, precision), err, false]
  }
  const [value, err] = raw === null ? [0, null] : floatArgument(raw, program, posix, warnings)
  if (conv === 'f' || conv === 'F')
    return [formatF(value, flags, width, precision, conv === 'F'), err, false]
  if (conv === 'e' || conv === 'E')
    return [formatE(value, flags, width, precision, conv === 'E'), err, false]
  if (conv === 'g' || conv === 'G')
    return [formatG(value, flags, width, precision, conv === 'G'), err, false]
  return [formatHexFloat(value, flags, width, precision, conv === 'A'), err, false]
}

/**
 * Apply GNU printf's format-reuse semantics: scan `fmt` once per cycle,
 * consuming arguments; repeat while arguments remain and a cycle
 * consumed at least one (so a conversion-less format prints once and
 * excess args are dropped). Returns the output, the stderr messages in the
 * order bash writes them, whether a conversion failed, and the first
 * argument dropped, which coreutils printf names in a warning (null when
 * every argument was used or `\c` ended the output). An invalid number
 * fails (exit status 1); a missing-digit escape warning does not.
 *
 * A `\c` in a `%b` argument returns at once and reports no failure. bash's
 * `%b` returns there with the status it has so far, and only the end of
 * the builtin folds an invalid number into it, so bash 5.2.37 exits 0 for
 * `printf '%d%b' abc '\c'`. `program` words numeric errors as the
 * coreutils program does rather than as bash's builtin, and `posix` says
 * the program runs with `POSIXLY_CORRECT` set.
 */
export function runPrintf(
  fmt: string,
  args: string[],
  program = false,
  posix = false,
): [string, string[], boolean, string | null] {
  const out: string[] = []
  const messages: string[] = []
  let failed = false
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
        const [text, ni, stopHere] = readEscape(fmt, i, messages, false)
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
          const following = argI < total ? (args[argI] ?? null) : null
          const [wv, err, fatal] = starValue(star, false, following, program, posix, messages)
          if (err !== null) {
            messages.push(err)
            failed = true
          }
          if (fatal) return [out.join(''), messages, true, null]
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
          const following = argI < total ? (args[argI] ?? null) : null
          const [pv, err, fatal] = starValue(star, true, following, program, posix, messages)
          if (err !== null) {
            messages.push(err)
            failed = true
          }
          if (fatal) return [out.join(''), messages, true, null]
          const p = Number(pv)
          precision = p < 0 ? null : p
        }
        const raw = argI < total ? (args[argI] ?? '') : null
        if (raw !== null) argI += 1
        const [text, err, stopHere] = convert(
          conv,
          raw,
          flags,
          width,
          precision,
          program,
          posix,
          messages,
        )
        if (err !== null) {
          messages.push(err)
          failed = true
        }
        out.push(text)
        if (stopHere) return [out.join(''), messages, false, null]
        continue
      }
      out.push(ch)
      i += 1
    }
    if (stop || argI >= total || argI === consumedStart) break
  }
  const excess = !stop && argI < total ? (args[argI] ?? null) : null
  return [out.join(''), messages, failed, excess]
}
