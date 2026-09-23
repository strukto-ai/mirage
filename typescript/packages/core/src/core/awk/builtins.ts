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

import { applyPad } from '../../workspace/executor/builtins/printf/format.ts'
import { AwkRuntimeError } from './errors.ts'
import { compileEre, searchFrom, splitPattern } from './regex.ts'
import {
  ValueKind,
  formatFloat,
  stripBlanks,
  toIndex,
  toInt,
  toNum,
  toStr,
  type Value,
} from './value.ts'

const FLAG_CHARS = '-+ #0'
const INT_CONVS = 'diouxX'
const FLOAT_CONVS = 'eEfFgGaA'
const DIGITS = '0123456789'
const BLANK_RUN = /[ \t\n]+/
const UINT64_MASK = (1n << 64n) - 1n
const MAX_CODE_POINT = 0x10ffff
const SURROGATE_MIN = 0xd800
const SURROGATE_MAX = 0xdfff
const SURROGATE = /[\ud800-\udfff]/
const RAND_SCALE = 4294967296

/** The string as code points, which is what awk counts and indexes. */
export function chars(subject: string): string[] {
  return SURROGATE.test(subject) ? Array.from(subject) : subject.split('')
}

export function charLength(subject: string): number {
  return SURROGATE.test(subject) ? Array.from(subject).length : subject.length
}

/**
 * Take an awk substring. Positions are 1-based and truncated toward
 * zero. A start below 1 is clamped to 1 and the requested length is
 * still honoured in full, so substr("hello", -1, 3) is "hel": what gawk
 * and onetrueawk both do; mawk counts the span from the original start.
 */
export function substr(subject: string, start: number, length: number | null): string {
  const begin = Math.max(toIndex(start), 1)
  const units = chars(subject)
  if (length === null) return units.slice(begin - 1).join('')
  const span = toIndex(length)
  if (span <= 0) return ''
  return units.slice(begin - 1, begin - 1 + span).join('')
}

/** 1-based code point position of `needle`, 0 when absent. */
export function indexOf(haystack: string, needle: string): number {
  const at = haystack.indexOf(needle)
  if (at === -1) return 0
  return charLength(haystack.slice(0, at)) + 1
}

/**
 * Expand `&` in a sub/gsub replacement. `\&` is a literal ampersand and
 * `\\&` is a backslash followed by the match; any other backslash is
 * itself, which is what gawk, mawk and onetrueawk all do.
 */
export function expandReplacement(template: string, matched: string): string {
  let out = ''
  let idx = 0
  while (idx < template.length) {
    const ch = template.charAt(idx)
    if (ch === '\\' && idx + 1 < template.length) {
      const nxt = template.charAt(idx + 1)
      if (nxt === '&') {
        out += '&'
        idx += 2
        continue
      }
      if (nxt === '\\' && template.charAt(idx + 2) === '&') {
        out += '\\' + matched
        idx += 3
        continue
      }
      out += ch
      idx += 1
      continue
    }
    out += ch === '&' ? matched : ch
    idx += 1
  }
  return out
}

function charEnd(subject: string, at: number): number {
  const code = subject.codePointAt(at)
  return at + (code !== undefined && code > 0xffff ? 2 : 1)
}

/** awk sub/gsub: the replacement count and the new string. */
export function substitute(
  pattern: string,
  template: string,
  subject: string,
  globally: boolean,
): [number, string] {
  const compiled = compileEre(pattern)
  let out = ''
  let count = 0
  let pos = 0
  let lastEnd = -1
  while (pos <= subject.length) {
    const found = searchFrom(compiled, subject, pos)
    if (found === null) break
    out += subject.slice(pos, found.start)
    const empty = found.end === found.start
    // An empty match touching the previous match is not a match:
    // gsub(/l*/, "-") turns "hello" into "-h-e-o-", not "-h-e--o-".
    if (!(empty && found.start === lastEnd)) {
      out += expandReplacement(template, found.text)
      count += 1
    }
    if (empty) {
      // An empty match must still advance, or gsub would spin on
      // patterns like /a*/ forever.
      const next = charEnd(subject, found.start)
      if (found.start < subject.length) out += subject.slice(found.start, next)
      pos = next
    } else {
      pos = found.end
      lastEnd = pos
    }
    if (!globally) break
  }
  out += pos <= subject.length ? subject.slice(pos) : ''
  return [count, out]
}

/** RSTART (1-based, 0 on failure) and RLENGTH (-1 on failure). */
export function matchPosition(pattern: string, subject: string): [number, number] {
  const found = searchFrom(compileEre(pattern), subject, 0)
  if (found === null) return [0, -1]
  return [charLength(subject.slice(0, found.start)) + 1, charLength(found.text)]
}

export function safeLog(value: number): number {
  return Math.log(value)
}

export function safeSqrt(value: number): number {
  return Math.sqrt(value)
}

export function safeExp(value: number): number {
  return Math.exp(value)
}

export function safeTrig(value: number, fn: string): number {
  return fn === 'sin' ? Math.sin(value) : Math.cos(value)
}

/** C pow's edges, the ones Python's math.pow raises on instead. */
export function safePow(base: number, exponent: number): number {
  if (exponent === 0 || base === 1) return 1
  if (base === -1 && !Number.isFinite(exponent) && !Number.isNaN(exponent)) return 1
  return Math.pow(base, exponent)
}

export function safeFmod(left: number, right: number): number {
  return left % right
}

/**
 * Advance the mulberry32 generator behind rand(). Both hosts run the
 * same 32-bit generator, so a seeded program prints the same numbers
 * under Python and TypeScript.
 */
export function nextRandom(state: number): [number, number] {
  const next = (state + 0x6d2b79f5) >>> 0
  let mixed = Math.imul(next ^ (next >>> 15), next | 1)
  mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
  return [next, ((mixed ^ (mixed >>> 14)) >>> 0) / RAND_SCALE]
}

interface Spec {
  readonly flags: string
  readonly width: string
  readonly precision: string
  readonly conv: string
  readonly next: number
}

/** Read one printf conversion starting after its `%`. */
function readSpec(fmt: string, start: number): Spec {
  let idx = start
  let flags = ''
  while (idx < fmt.length && FLAG_CHARS.includes(fmt.charAt(idx))) {
    flags += fmt.charAt(idx)
    idx += 1
  }
  let width = ''
  if (fmt.charAt(idx) === '*') {
    width = '*'
    idx += 1
  } else {
    while (idx < fmt.length && DIGITS.includes(fmt.charAt(idx))) {
      width += fmt.charAt(idx)
      idx += 1
    }
  }
  let precision = ''
  if (fmt.charAt(idx) === '.') {
    precision = '.'
    idx += 1
    if (fmt.charAt(idx) === '*') {
      precision = '.*'
      idx += 1
    } else {
      while (idx < fmt.length && DIGITS.includes(fmt.charAt(idx))) {
        precision += fmt.charAt(idx)
        idx += 1
      }
    }
  }
  return { flags, width, precision, conv: fmt.charAt(idx), next: idx + 1 }
}

/**
 * Render a value for %c: a number becomes the character with that code,
 * a string contributes its first character.
 */
function renderChar(value: Value, convfmt: string): string {
  if (value.kind === ValueKind.NUM) {
    const code = toIndex(value.num)
    if (code < 0 || code > MAX_CODE_POINT) return ''
    if (code >= SURROGATE_MIN && code <= SURROGATE_MAX) return ''
    return String.fromCodePoint(code)
  }
  return chars(toStr(value, convfmt))[0] ?? ''
}

/**
 * gawk, mawk and onetrueawk all treat a format with more conversions
 * than arguments as fatal rather than padding with empties.
 */
function takeArg(pending: Value[], fmt: string): Value {
  const arg = pending.shift()
  if (arg === undefined) {
    throw new AwkRuntimeError(`awk: not enough arguments to satisfy format string '${fmt}'`)
  }
  return arg
}

function widthOf(width: string): number | null {
  return width === '' ? null : Number(width)
}

function precisionOf(precision: string): number | null {
  return precision === '' ? null : Number(precision.slice(1) || '0')
}

/**
 * One integer conversion with C's flag rules. `%d` keeps the exact
 * integer; `%o %u %x %X` read a negative number as its 64-bit two's
 * complement, the way C does.
 */
function renderInt(
  flags: string,
  width: string,
  precision: string,
  conv: string,
  value: bigint,
): string {
  let prefix = ''
  let digits: string
  if (conv === 'd' || conv === 'i') {
    digits = (value < 0n ? -value : value).toString()
    if (value < 0n) prefix = '-'
    else if (flags.includes('+')) prefix = '+'
    else if (flags.includes(' ')) prefix = ' '
  } else {
    const wrapped = value & UINT64_MASK
    if (conv === 'o') digits = wrapped.toString(8)
    else if (conv === 'x' || conv === 'X') digits = wrapped.toString(16)
    else digits = wrapped.toString()
  }
  const wanted = precisionOf(precision)
  if (wanted !== null) {
    if (wanted === 0 && /^0*$/.test(digits)) digits = ''
    else digits = digits.padStart(wanted, '0')
  }
  const nonzero = /[^0]/.test(digits)
  if (flags.includes('#')) {
    if (conv === 'x' && nonzero) prefix = '0x'
    else if (conv === 'X' && nonzero) prefix = '0X'
    else if (conv === 'o' && !digits.startsWith('0')) digits = '0' + digits
  }
  if (conv === 'X') digits = digits.toUpperCase()
  return applyPad(prefix, digits, flags, widthOf(width), wanted === null)
}

function renderOne(
  flags: string,
  width: string,
  precision: string,
  conv: string,
  arg: Value,
  convfmt: string,
): string {
  if (conv === 'c' || conv === 's') {
    let body = conv === 'c' ? renderChar(arg, convfmt) : toStr(arg, convfmt)
    const limit = precisionOf(precision)
    if (conv === 's' && limit !== null) body = chars(body).slice(0, limit).join('')
    const gap = (widthOf(width) ?? 0) - charLength(body)
    if (gap <= 0) return body
    return flags.includes('-') ? body + ' '.repeat(gap) : ' '.repeat(gap) + body
  }
  if (INT_CONVS.includes(conv)) return renderInt(flags, width, precision, conv, toInt(toNum(arg)))
  const target = conv === 'a' ? 'g' : conv === 'A' ? 'G' : conv
  return formatFloat(target, toNum(arg), flags, widthOf(width), precisionOf(precision))
}

/** Format values the way awk's printf and sprintf do. */
export function sprintf(fmt: string, args: readonly Value[], convfmt: string): string {
  let out = ''
  const pending = [...args]
  let idx = 0
  while (idx < fmt.length) {
    const ch = fmt.charAt(idx)
    if (ch !== '%') {
      out += ch
      idx += 1
      continue
    }
    if (fmt.startsWith('%%', idx)) {
      out += '%'
      idx += 2
      continue
    }
    const spec = readSpec(fmt, idx + 1)
    idx = spec.next
    let { flags, width, precision } = spec
    if (spec.conv === '') {
      out += '%'
      continue
    }
    if (width === '*') {
      const star = toInt(toNum(takeArg(pending, fmt)))
      if (star < 0n) flags += '-'
      width = (star < 0n ? -star : star).toString()
    }
    if (precision === '.*') {
      const star = toInt(toNum(takeArg(pending, fmt)))
      precision = star >= 0n ? '.' + star.toString() : ''
    }
    if (!'cs'.includes(spec.conv) && !(INT_CONVS + FLOAT_CONVS).includes(spec.conv)) {
      out += '%' + flags + width + precision + spec.conv
      continue
    }
    out += renderOne(flags, width, precision, spec.conv, takeArg(pending, fmt), convfmt)
  }
  return out
}

/** Split a record into fields; a null pattern is the blank-run default. */
function splitFields(record: string, pattern: RegExp | null): string[] {
  if (pattern === null) {
    const trimmed = stripBlanks(record)
    return trimmed === '' ? [] : trimmed.split(BLANK_RUN)
  }
  if (record === '') return []
  const fields: string[] = []
  let start = 0
  let pos = 0
  while (pos <= record.length) {
    const found = searchFrom(pattern, record, pos)
    if (found === null) break
    if (found.end === found.start) {
      // A separator that matches nothing separates nothing.
      pos = found.start + 1
      continue
    }
    fields.push(record.slice(start, found.start))
    start = found.end
    pos = start
  }
  fields.push(record.slice(start))
  return fields
}

/**
 * Split a record using an FS value. An empty FS makes every character
 * its own field; gawk, mawk and onetrueawk all agree on that even though
 * POSIX leaves it undefined. A record read in paragraph mode also splits
 * at each newline when FS is a single character, as in gawk and
 * onetrueawk; a regex FS and split() do not.
 */
export function splitRecord(record: string, separator: string, paragraph = false): string[] {
  if (separator === '') return chars(record)
  if (paragraph && charLength(separator) === 1) {
    return splitFields(record.replaceAll('\n', separator), splitPattern(separator))
  }
  return splitFields(record, splitPattern(separator))
}

/** Hand out what is left of the input as its last record. */
function takeTail(buffer: string, start: number, final: boolean): [string | null, number] {
  if (final && start < buffer.length) return [buffer.slice(start), buffer.length]
  return [null, start]
}

/**
 * Cut the next record in paragraph mode, where RS is empty. Records are
 * separated by blank lines, and leading or trailing newlines never make
 * an empty record. The whole run of newlines is the separator, so a run
 * that reaches the end of the buffer waits for more input before the
 * record is handed out.
 */
function takeParagraph(buffer: string, from: number, final: boolean): [string | null, number] {
  let start = from
  while (start < buffer.length && buffer.charAt(start) === '\n') start += 1
  const end = buffer.indexOf('\n\n', start)
  if (end >= 0) {
    let stop = end + 2
    while (stop < buffer.length && buffer.charAt(stop) === '\n') stop += 1
    if (stop < buffer.length || final) return [buffer.slice(start, end), stop]
    return [null, start]
  }
  if (!final || start === buffer.length) return [null, start]
  const last = buffer.endsWith('\n') ? buffer.length - 1 : buffer.length
  return [buffer.slice(start, last), buffer.length]
}

/**
 * Cut the next record out of `buffer` with an RS value. A single
 * character RS separates records literally and an empty RS is paragraph
 * mode. A longer RS is an ERE, as in gawk, mawk and onetrueawk, where a
 * match of nothing separates nothing. Until the input is exhausted a
 * separator that reaches the end of the buffer could still grow, so that
 * record waits for more input. Returns the record, or null when `buffer`
 * holds no complete one, and where the next record starts.
 */
export function takeRecord(
  buffer: string,
  start: number,
  separator: string,
  final: boolean,
): [string | null, number] {
  if (separator === '') return takeParagraph(buffer, start, final)
  if (charLength(separator) === 1) {
    const end = buffer.indexOf(separator, start)
    if (end >= 0) return [buffer.slice(start, end), end + separator.length]
    return takeTail(buffer, start, final)
  }
  const pattern = compileEre(separator)
  let pos = start
  while (pos <= buffer.length) {
    const found = searchFrom(pattern, buffer, pos)
    if (found === null) break
    if (found.end === found.start) {
      pos = found.start + 1
      continue
    }
    if (found.end === buffer.length && !final) return [null, start]
    return [buffer.slice(start, found.start), found.end]
  }
  return takeTail(buffer, start, final)
}
