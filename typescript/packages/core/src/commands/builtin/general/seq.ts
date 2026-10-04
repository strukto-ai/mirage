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

import type { PathSpec } from '../../../types.ts'
import type { Accessor } from '../../../accessor/base.ts'
import { IOResult } from '../../../io/types.ts'
import { YieldBudget } from '../../../io/yield_budget.ts'
import { encodeText } from '../../../shell/bytes.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import {
  extraOperandError,
  missingOperandError,
  usageExitCode,
  usageHint,
} from '../../spec/usage.ts'
import { UsageError } from '../../errors.ts'
import { quoteText } from '../../quote.ts'
import { CommandName } from '../../spec/types.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { strtodWhole } from '../utils/strtod.ts'

// GNU seq's long_double_format: one floating directive, its flags and an
// optional L, with nothing but %% around it.
const FORMAT_DIRECTIVE = /([-+#0 ']*)([0-9]*)(?:\.([0-9]*))?(L?)/y
const FLOAT_CONVERSIONS = 'efgaEFGA'

// GNU's long double, as the pins here measure it: IEEE binary128, arm64
// Linux's, with 112 fraction bits under the lead bit and a least normal
// exponent of -16382. x86-64's 80-bit one has the same exponent range.
const QUAD_FRACTION_BITS = 112
const QUAD_MIN_EXPONENT = -16382

// The magnitude from which strtold reads an infinity: halfway from LDBL_MAX to
// 2**16384, a tie that rounds up to the even 2**16384. GNU refuses an operand
// that large.
const LONG_DOUBLE_OVERFLOW = ((1n << 114n) - 1n) << 16270n

// strtold reads zero for a magnitude at or under 2**-UNDERFLOW_BITS, half of
// the least subnormal, and GNU takes the zero.
const UNDERFLOW_BITS = 16495n

// About how many bytes of output one chunk of the stream carries.
const OUTPUT_CHUNK = 64 * 1024

// A seq format split around its one directive: a `-f` format GNU accepts, or
// the default one. Mirrors Python's SeqFormat.
export interface SeqFormat {
  readonly prefix: string
  readonly flags: string
  readonly width: string
  readonly precision: string | null
  readonly conversion: string
  readonly suffix: string
}

// Index of the first `%` that is not half of `%%`, or -1.
function lonePercent(text: string): number {
  let i = 0
  while (i < text.length) {
    if (text[i] === '%') {
      if (text[i + 1] !== '%') return i
      i += 2
      continue
    }
    i += 1
  }
  return -1
}

// GNU seq's `-f` check: exactly one floating `%` directive. Mirrors Python's
// parse_format.
export function parseFormat(fmt: string): SeqFormat {
  const shown = `'${quoteText(fmt)}'`
  const start = lonePercent(fmt)
  if (start < 0) throw new UsageError(`seq: format ${shown} has no % directive`, 1)
  FORMAT_DIRECTIVE.lastIndex = start + 1
  const match = FORMAT_DIRECTIVE.exec(fmt)
  const end = FORMAT_DIRECTIVE.lastIndex
  const conversion = fmt[end]
  if (conversion === undefined) throw new UsageError(`seq: format ${shown} ends in %`, 1)
  if (!FLOAT_CONVERSIONS.includes(conversion)) {
    throw new UsageError(`seq: format ${shown} has unknown %${conversion} directive`, 1)
  }
  const suffix = fmt.slice(end + 1)
  if (lonePercent(suffix) >= 0) {
    throw new UsageError(`seq: format ${shown} has too many % directives`, 1)
  }
  return {
    prefix: fmt.slice(0, start),
    flags: match?.[1] ?? '',
    width: match?.[2] ?? '',
    precision: match?.[3] ?? null,
    conversion,
    suffix,
  }
}

export enum NumberKind {
  FINITE = 'finite',
  INFINITE = 'infinite',
  NAN = 'nan',
}

// A number as GNU seq holds it, held exactly: `units / 10**scale`. GNU
// computes in long double, whose rounding depends on the machine (64 mantissa
// bits on x86-64, 113 on arm64); exact values print what GNU prints wherever
// its own output does not depend on that. The sign is kept for a zero too
// (`seq -0 1` prints `-0`), and units is 0 for an infinity or a NaN. Mirrors
// Python's SeqNumber.
export interface SeqNumber {
  readonly negative: boolean
  readonly units: bigint
  readonly scale: number
  readonly kind: NumberKind
}

function seqNumber(negative: boolean, units = 0n, scale = 0, kind = NumberKind.FINITE): SeqNumber {
  return { negative, units, scale, kind }
}

// An operand as GNU seq's scan_arg reads it: what it names, its print width
// in the form it was typed (`-.1` counts as `-0.1` and `1.` as `1`, 0 for a
// hex number or an infinity), and its digits after the point, null when it is
// no fixed-point number (a hex float with a point or a `p` exponent). Mirrors
// Python's SeqOperand.
export interface SeqOperand {
  readonly value: SeqNumber
  readonly width: number
  readonly precision: number | null
}

// FIRST and INCREMENT when the line leaves them out.
const ONE: SeqOperand = { value: seqNumber(false, 1n), width: 1, precision: 0 }

// The default format for whole numbers, `%.0f`, which GNU's seq_fast prints
// without printf.
const PLAIN: SeqFormat = {
  prefix: '',
  flags: '',
  width: '',
  precision: '0',
  conversion: 'f',
  suffix: '',
}

// A seq refusal followed by the `Try` hint, as usage() ends it.
function refuse(line: string): UsageError {
  return new UsageError(
    `seq: ${line}\n${usageHint(CommandName.SEQ)}`,
    usageExitCode(CommandName.SEQ),
  )
}

// A decimal exponent's digits, sign and all, as a bigint at any length.
function signedDigits(text: string): bigint {
  return BigInt(text)
}

// `units / 10**scale` as strtold bounds it: zero when it underflows, null
// when it overflows.
function inRange(negative: boolean, units: bigint, scale: number): SeqNumber | null {
  const denominator = 10n ** BigInt(scale)
  if (units >= LONG_DOUBLE_OVERFLOW * denominator) return null
  if (units << UNDERFLOW_BITS <= denominator) return seqNumber(negative)
  return seqNumber(negative, units, scale)
}

// The value strtold reads for a STRTOD match, held exactly, or null when it
// overflows. A magnitude far outside the long double range is settled from
// its digit count before any arithmetic (from 10**4933 up it overflows, under
// 10**-4966 it is zero, as are 2**16384 and 2**-16495 for a hex float), so an
// exponent of any length costs nothing. Mirrors Python's read_number.
export function readNumber(found: RegExpExecArray): SeqNumber | null {
  const [, sign, hexa, decimal, inf] = found
  const negative = sign === '-'
  if (inf !== undefined) return seqNumber(negative, 0n, 0, NumberKind.INFINITE)
  if (decimal !== undefined) {
    const [mantissa = '', power = '0'] = decimal.toLowerCase().split('e')
    const [whole = '', fraction = ''] = mantissa.split('.')
    const digits = (whole + fraction).replace(/^0+/, '')
    const significant = digits.replace(/0+$/, '')
    if (significant === '') return seqNumber(negative)
    const exponent =
      signedDigits(power) - BigInt(fraction.length) + BigInt(digits.length - significant.length)
    const top = BigInt(significant.length) + exponent
    if (top > 4933n) return null
    if (top < -4965n) return seqNumber(negative)
    const units = BigInt(significant)
    if (exponent >= 0n) return inRange(negative, units * 10n ** exponent, 0)
    return inRange(negative, units, Number(-exponent))
  }
  if (hexa !== undefined) {
    const [mantissa = '', power = '0'] = hexa.slice(2).toLowerCase().split('p')
    const [whole = '', fraction = ''] = mantissa.split('.')
    let bits = BigInt(`0x${whole}${fraction}`)
    if (bits === 0n) return seqNumber(negative)
    let exponent = signedDigits(power) - BigInt(4 * fraction.length)
    const top = BigInt(bits.toString(2).length) + exponent
    if (top > 16384n) return null
    if (top < -16494n) return seqNumber(negative)
    const trailing = BigInt((bits & -bits).toString(2).length - 1)
    const room = exponent < 0n ? -exponent : 0n
    const shift = trailing < room ? trailing : room
    bits >>= shift
    exponent += shift
    if (exponent >= 0n) return inRange(negative, bits << exponent, 0)
    return inRange(negative, bits * 5n ** -exponent, Number(-exponent))
  }
  return seqNumber(negative, 0n, 0, NumberKind.NAN)
}

// GNU seq's scan_arg: an operand's value, print width and precision. The
// width and precision come from the digits as typed, so `1.50` prints two
// decimals and `1e2` none. A hex operand has no width, and one with a point
// or a lowercase `p` no precision either. Mirrors Python's scan_operand.
export function scanOperand(text: string): SeqOperand {
  const found = strtodWhole(text)
  const value = found === null ? null : readNumber(found)
  if (value === null) throw refuse(`invalid floating point argument: '${quoteText(text)}'`)
  if (value.kind === NumberKind.NAN) {
    throw refuse(`invalid 'not-a-number' argument: '${quoteText(text)}'`)
  }
  const shown = text.replace(/^[ \t\n\v\f\r+]+/, '')
  const point = shown.indexOf('.')
  let precision: number | null = point >= 0 || shown.includes('p') ? null : 0
  let width = 0
  if (value.kind === NumberKind.FINITE && !/[xX]/.test(shown)) {
    width = shown.length
    let fraction = 0
    if (point >= 0) {
      fraction = (shown.slice(point + 1).split(/[eE]/)[0] ?? '').length
      precision = fraction
      if (fraction === 0) width -= 1
      else if (point === 0 || !'0123456789'.includes(shown[point - 1] ?? '')) width += 1
    }
    const marker = Math.max(shown.indexOf('e'), shown.indexOf('E'))
    if (marker >= 0 && precision !== null) {
      let exponent = Number(signedDigits(shown.slice(marker + 1)))
      precision += exponent < 0 ? -exponent : -Math.min(precision, exponent)
      width -= shown.length - marker
      if (exponent < 0) {
        if (point < 0 || marker === point + 1) width += 1
        exponent = -exponent
      } else {
        if (point >= 0 && precision === 0 && fraction !== 0) width -= 1
        exponent -= Math.min(fraction, exponent)
      }
      width += exponent
    }
  }
  return { value, width, precision }
}

// GNU seq's get_default_format: `%.PRECf` with the operands' widest
// precision, zero-padded to the wider of FIRST and LAST under `-w`, and `%g`
// once any operand is no fixed-point number. Mirrors Python's
// default_format.
export function defaultFormat(
  first: SeqOperand,
  step: SeqOperand,
  last: SeqOperand,
  equalWidth: boolean,
): SeqFormat {
  const plain = { prefix: '', flags: '', width: '', suffix: '' }
  if (first.precision === null || step.precision === null || last.precision === null) {
    return { ...plain, precision: null, conversion: 'g' }
  }
  const precision = Math.max(first.precision, step.precision)
  if (!equalWidth) return { ...plain, precision: String(precision), conversion: 'f' }
  let firstWidth = first.width + precision - first.precision
  let lastWidth = last.width + precision - last.precision
  if (last.precision !== 0 && precision === 0) lastWidth -= 1
  if (last.precision === 0 && precision !== 0) lastWidth += 1
  if (first.precision === 0 && precision !== 0) firstWidth += 1
  return {
    ...plain,
    flags: '0',
    width: String(Math.max(firstWidth, lastWidth)),
    precision: String(precision),
    conversion: 'f',
  }
}

// `numerator / denominator` rounded half to even, for a dividend that is not
// negative and a positive divisor.
function nearest(numerator: bigint, denominator: bigint): bigint {
  let kept = numerator / denominator
  const rest = numerator % denominator
  if (2n * rest > denominator || (2n * rest === denominator && kept % 2n === 1n)) kept += 1n
  return kept
}

// `units / 10**drop` rounded half to even, exact for a negative drop.
function rounded(units: bigint, drop: number): bigint {
  if (drop <= 0) return units * 10n ** BigInt(-drop)
  return nearest(units, 10n ** BigInt(drop))
}

// A finite magnitude in `%f` style; `#` keeps a bare point.
function fixedText(value: SeqNumber, precision: number, alternate: boolean): string {
  const digits = rounded(value.units, value.scale - precision)
    .toString()
    .padStart(precision + 1, '0')
  if (precision > 0) return `${digits.slice(0, -precision)}.${digits.slice(-precision)}`
  return digits + (alternate ? '.' : '')
}

// A finite magnitude in `%e` style; `#` keeps a bare point.
function exponentText(value: SeqNumber, precision: number, alternate: boolean): string {
  let exponent = 0
  let digits = '0'.repeat(precision + 1)
  if (value.units !== 0n) {
    exponent = value.units.toString().length - 1 - value.scale
    let kept = rounded(value.units, value.scale + exponent - precision)
    if (kept === 10n ** BigInt(precision + 1)) {
      kept /= 10n
      exponent += 1
    }
    digits = kept.toString()
  }
  const point = precision > 0 || alternate ? '.' : ''
  const mark = exponent < 0 ? '-' : '+'
  const power = String(Math.abs(exponent)).padStart(2, '0')
  return `${digits.slice(0, 1)}${point}${digits.slice(1)}e${mark}${power}`
}

// A finite magnitude in `%g` style: `%e` when the exponent is under -4 or
// reaches the precision, `%f` otherwise, and trailing zeros dropped unless
// `#` is given.
function generalText(value: SeqNumber, precision: number, alternate: boolean): string {
  const significant = precision === 0 ? 1 : precision
  let exponent = 0
  if (value.units !== 0n) {
    exponent = value.units.toString().length - 1 - value.scale
    const drop = value.scale + exponent - significant + 1
    if (rounded(value.units, drop) === 10n ** BigInt(significant)) exponent += 1
  }
  const text =
    -4 <= exponent && exponent < significant
      ? fixedText(value, significant - 1 - exponent, alternate)
      : exponentText(value, significant - 1, alternate)
  if (alternate) return text
  const at = text.indexOf('e')
  let mantissa = at < 0 ? text : text.slice(0, at)
  const power = at < 0 ? '' : text.slice(at)
  if (mantissa.includes('.')) mantissa = mantissa.replace(/0+$/, '').replace(/\.$/, '')
  return mantissa + power
}

// The sign printf writes ahead of a number: `-`, or what `+` or a space flag
// asks for a positive one.
function signText(value: SeqNumber, flags: string): string {
  if (value.negative) return '-'
  return flags.includes('+') ? '+' : flags.includes(' ') ? ' ' : ''
}

// `value` through a `%e`, `%f` or `%g` directive, as printf renders it. The
// digits round half to even on the exact value. GNU rounds its long double,
// so a number that sits exactly halfway at the last printed digit (`seq -f
// %.1f 0.05 0.1 0.45`) may round the other way there, and differently on
// x86-64 and arm64.
function floatText(value: SeqNumber, spec: SeqFormat): string {
  const flags = spec.flags
  const sign = signText(value, flags)
  let zero = flags.includes('0') && !flags.includes('-')
  let body: string
  if (value.kind !== NumberKind.FINITE) {
    body = value.kind === NumberKind.NAN ? 'nan' : 'inf'
    zero = false
  } else {
    const precision = spec.precision === null ? 6 : Number(spec.precision || '0')
    const alternate = flags.includes('#')
    const kind = spec.conversion.toLowerCase()
    if (kind === 'f') body = fixedText(value, precision, alternate)
    else if (kind === 'e') body = exponentText(value, precision, alternate)
    else body = generalText(value, precision, alternate)
  }
  if (spec.conversion === spec.conversion.toUpperCase()) body = body.toUpperCase()
  const width = spec.width === '' ? 0 : Number(spec.width)
  if (flags.includes('-')) return (sign + body).padEnd(width)
  if (zero) return sign + body.padStart(width - sign.length, '0')
  return (sign + body).padStart(width)
}

// A finite, nonzero number as a binary128 long double holds it, in hex: the
// lead digit, the 28 fraction digits and the binary exponent. The value rounds
// half to even to 113 significant bits, or to the subnormal grid under
// 2**-16382, which glibc writes with a lead digit of 0 and that least exponent
// (`0x0.00004p-16382`). Mirrors Python's _quad_digits.
function quadDigits(value: SeqNumber): [string, string, number] {
  const places = QUAD_FRACTION_BITS / 4
  const denominator = 10n ** BigInt(value.scale)
  let exponent = value.units.toString(2).length - denominator.toString(2).length
  const left = value.units << BigInt(Math.max(-exponent, 0))
  if (left < denominator << BigInt(Math.max(exponent, 0))) exponent -= 1
  exponent = Math.max(exponent, QUAD_MIN_EXPONENT)
  const shift = QUAD_FRACTION_BITS - exponent
  let mantissa =
    shift >= 0
      ? nearest(value.units << BigInt(shift), denominator)
      : nearest(value.units, denominator << BigInt(-shift))
  if (mantissa === 0n) return ['0', '0'.repeat(places), 0]
  if (mantissa >> BigInt(QUAD_FRACTION_BITS + 1) !== 0n) {
    mantissa >>= 1n
    exponent += 1
  }
  const fraction = mantissa & ((1n << BigInt(QUAD_FRACTION_BITS)) - 1n)
  const lead = mantissa >> BigInt(QUAD_FRACTION_BITS)
  return [lead.toString(16), fraction.toString(16).padStart(places, '0'), exponent]
}

// `value` through a `%a` directive, as glibc renders it. The value is the
// binary128 long double nearest it. The hex digits round half to even at the
// precision without renormalizing (`%.0a` of 3 is `0x2p+1`), `#` keeps the
// point and `0` pads after `0x`. GNU sums in long double while these sums are
// exact, so a printed sum can differ in its last bit (`seq -f %a 0.1 0.1 0.3`
// stops after 0.2 in GNU, whose third sum overshoots 0.3). Mirrors Python's
// _hex_float.
function hexFloat(value: SeqNumber, spec: SeqFormat): string {
  const flags = spec.flags
  const sign = signText(value, flags)
  let zero = false
  let body: string
  if (value.kind !== NumberKind.FINITE) {
    body = value.kind === NumberKind.NAN ? 'nan' : 'inf'
  } else {
    const quad: [string, string, number] = value.units === 0n ? ['0', '', 0] : quadDigits(value)
    let [lead, digits] = quad
    const exponent = quad[2]
    if (spec.precision === null) {
      digits = digits.replace(/0+$/, '')
    } else {
      const places = Number(spec.precision || '0')
      if (places >= digits.length) {
        digits = digits.padEnd(places, '0')
      } else {
        let kept = BigInt(`0x${lead}${digits.slice(0, places)}`)
        const rest = BigInt(`0x${digits.slice(places)}`)
        const half = 8n << BigInt(4 * (digits.length - places - 1))
        if (rest > half || (rest === half && kept % 2n === 1n)) kept += 1n
        const text = kept.toString(16).padStart(places + 1, '0')
        lead = text.slice(0, text.length - places)
        digits = text.slice(text.length - places)
      }
    }
    const point = digits !== '' || flags.includes('#') ? '.' : ''
    const mark = exponent < 0 ? '-' : '+'
    body = `0x${lead}${point}${digits}p${mark}${String(Math.abs(exponent))}`
    zero = flags.includes('0') && !flags.includes('-')
  }
  if (spec.conversion === 'A') body = body.toUpperCase()
  const width = spec.width === '' ? 0 : Number(spec.width)
  if (flags.includes('-')) return (sign + body).padEnd(width)
  if (zero) return sign + body.slice(0, 2) + body.slice(2).padStart(width - sign.length - 2, '0')
  return (sign + body).padStart(width)
}

// One number through a seq format, as C's printf renders it. Mirrors
// Python's render.
export function render(spec: SeqFormat, value: SeqNumber): string {
  const body = 'aA'.includes(spec.conversion) ? hexFloat(value, spec) : floatText(value, spec)
  return spec.prefix.replaceAll('%%', '%') + body + spec.suffix.replaceAll('%%', '%')
}

// A finite number's units with its sign.
function signed(value: SeqNumber): bigint {
  return value.negative ? -value.units : value.units
}

// -1 for minus infinity, 1 for infinity, 0 for a finite number.
function rank(value: SeqNumber): number {
  if (value.kind === NumberKind.FINITE) return 0
  return value.negative ? -1 : 1
}

// `a < b` as C compares two long doubles: never true for a NaN.
function less(a: SeqNumber, b: SeqNumber): boolean {
  if (a.kind === NumberKind.NAN || b.kind === NumberKind.NAN) return false
  if (a.kind === NumberKind.INFINITE || b.kind === NumberKind.INFINITE) return rank(a) < rank(b)
  const scale = Math.max(a.scale, b.scale)
  const left = signed(a) * 10n ** BigInt(scale - a.scale)
  return left < signed(b) * 10n ** BigInt(scale - b.scale)
}

// Whether a printed number reads back as LAST. GNU cuts the format's own text
// from both ends and reads the rest with strtold, so a number padded on the
// right never reads back.
function readsAs(text: string, spec: SeqFormat, last: SeqNumber): boolean {
  const head = spec.prefix.replaceAll('%%', '%').length
  const tail = spec.suffix.replaceAll('%%', '%').length
  const found = strtodWhole(text.slice(head, text.length - tail))
  const value = found === null ? null : readNumber(found)
  if (value === null || value.kind === NumberKind.NAN) return false
  return !less(value, last) && !less(last, value)
}

// FIRST + i * INCREMENT for i from 1 on, without end. Exact sums for finite
// numbers; with an infinity in either, the sum is the same for every i, and a
// NaN when they are opposite.
function* values(first: SeqNumber, step: SeqNumber): Generator<SeqNumber> {
  if (first.kind === NumberKind.FINITE && step.kind === NumberKind.FINITE) {
    const scale = Math.max(first.scale, step.scale)
    let units = signed(first) * 10n ** BigInt(scale - first.scale)
    const delta = signed(step) * 10n ** BigInt(scale - step.scale)
    for (;;) {
      units += delta
      yield seqNumber(units < 0n, units < 0n ? -units : units, scale)
    }
  }
  let tail = first
  if (first.kind === NumberKind.FINITE) tail = step
  else if (step.kind === NumberKind.INFINITE && step.negative !== first.negative) {
    tail = seqNumber(false, 0n, 0, NumberKind.NAN)
  }
  for (;;) yield tail
}

// The whole numbers after FIRST, printed plainly: GNU's seq_fast. Their digits
// are exact, so the number past LAST never reads back as LAST and the print
// loop's last test has nothing to add. LAST is one FIRST does not pass.
function* integers(first: SeqNumber, step: SeqNumber, last: SeqNumber): Generator<string> {
  const delta = signed(step)
  let units = signed(first) + delta
  if (last.kind === NumberKind.INFINITE) {
    for (; ; units += delta) yield units.toString()
  }
  const denominator = 10n ** BigInt(last.scale)
  const bound = signed(last)
  let whole = bound / denominator
  const rest = bound % denominator
  if (rest !== 0n && delta < 0n !== rest < 0n) whole += delta < 0n ? 1n : -1n
  for (; delta > 0n ? units <= whole : units >= whole; units += delta) yield units.toString()
}

// GNU seq's print_numbers: each number as printed, FIRST to LAST. The number
// past LAST is printed too when it reads back as LAST and prints differently
// from the one before it. GNU added that against rounding in its long double
// sums; exact sums reach it only through a format with fewer digits than the
// operands (`seq -f %.1f 0 0.34 1` ends in 1.0).
function* lines(
  first: SeqNumber,
  step: SeqNumber,
  last: SeqNumber,
  spec: SeqFormat,
): Generator<string> {
  const descending = step.negative
  const past = (value: SeqNumber): boolean => (descending ? less(value, last) : less(last, value))
  if (past(first)) return
  let previous = render(spec, first)
  yield previous
  const plain = (Object.keys(PLAIN) as (keyof SeqFormat)[]).every((key) => spec[key] === PLAIN[key])
  if (
    plain &&
    first.kind === NumberKind.FINITE &&
    step.kind === NumberKind.FINITE &&
    first.scale === 0 &&
    step.scale === 0
  ) {
    yield* integers(first, step, last)
    return
  }
  for (const value of values(first, step)) {
    const text = render(spec, value)
    if (past(value)) {
      if (text !== previous && readsAs(text, spec, last)) yield text
      return
    }
    yield text
    previous = text
  }
}

// The lines joined by SEPARATOR and ended by a newline, chunk by chunk, and
// nothing at all when there is no line. The chunks are lazy, so an endless
// sequence (`seq inf`) stops when the reader stops.
async function* stream(lines: Iterable<string>, separator: string): AsyncGenerator<Uint8Array> {
  const budget = new YieldBudget()
  let batch: string[] = []
  let size = 0
  let started = false
  for (const line of lines) {
    batch.push(line)
    size += line.length + separator.length
    if (size >= OUTPUT_CHUNK) {
      yield encodeText((started ? separator : '') + batch.join(separator))
      started = true
      batch = []
      size = 0
      await budget.run()
    }
  }
  if (batch.length > 0) yield encodeText((started ? separator : '') + batch.join(separator) + '\n')
  else if (started) yield encodeText('\n')
}

function seqCommand(
  _accessor: Accessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): CommandFnResult {
  if (texts.length === 0) throw missingOperandError(CommandName.SEQ, null)
  if (texts.length > 3) throw extraOperandError(CommandName.SEQ, texts[3] ?? '')
  const fl = new FlagView(opts.flags, specOf('seq'))
  const typed = fl.asStr('format') ?? null
  const equalWidth = fl.asBool('equal_width')
  let spec = typed === null ? null : parseFormat(typed)
  if (spec !== null && equalWidth) {
    throw refuse('format string may not be specified when printing equal width strings')
  }
  let last = scanOperand(texts[0] ?? '')
  let first = ONE
  let step = ONE
  if (texts.length > 1) {
    first = last
    last = scanOperand(texts[1] ?? '')
  }
  if (texts.length > 2) {
    step = last
    if (step.value.kind === NumberKind.FINITE && step.value.units === 0n) {
      throw refuse(`invalid Zero increment value: '${quoteText(texts[1] ?? '')}'`)
    }
    last = scanOperand(texts[2] ?? '')
  }
  spec ??= defaultFormat(first, step, last, equalWidth)
  const separator = fl.asStr('separator') ?? '\n'
  return [stream(lines(first.value, step.value, last.value, spec), separator), new IOResult()]
}

export const GENERAL_SEQ = command({
  name: 'seq',
  vfs: null,
  spec: specOf('seq'),
  fn: seqCommand,
})
