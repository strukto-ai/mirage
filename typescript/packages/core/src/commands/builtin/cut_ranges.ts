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

import { AsyncLineIterator } from '../../io/async_line_iterator.ts'
import { recordSeparator } from './utils/lines.ts'
import { boundedDecimal } from './utils/strtol.ts'
import { quoteText } from '../quote.ts'
import { usageHint } from '../spec/usage.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

// Python's cut_ranges.py uses 2**31 - 1; the two must agree so an open-ended
// range clamps identically in both languages.
const OPEN_END = 2 ** 31 - 1

const CUT_TRY = usageHint('cut')

export interface CutOptions {
  ranges: [number, number][]
  mode: 'bytes' | 'characters' | 'fields'
  delimiter: string
  complement: boolean
  onlyDelimited: boolean
  whitespace: 'default' | 'trimmed' | null
  noPartial: boolean
  outputDelimiter: string | null
  zeroTerminated: boolean
}

interface WhitespaceFields {
  fields: string[]
  hasDelimiter: boolean
  sourceEmpty: boolean
}

function cutError(message: string): string {
  return `cut: ${message}\n${CUT_TRY}\n`
}

interface CutListWords {
  value: string
  range: string
  zero: string
  large: string
}

// GNU words the two modes differently and never shares a string between
// them; only "invalid decreasing range" and "invalid range with no
// endpoint: -" carry no mode noun.
function listWords(mode: CutOptions['mode']): CutListWords {
  if (mode === 'fields') {
    return {
      value: 'invalid field value',
      range: 'invalid field range',
      zero: 'fields are numbered from 1',
      large: 'field number',
    }
  }
  // The two range strings are worded differently from each other on
  // purpose: the position one joins the nouns with a slash, the range one
  // spells out ' or '. Both are byte-exact against coreutils 9.4.
  return {
    value: 'invalid byte/character position',
    range: 'invalid byte or character range',
    zero: 'byte/character positions are numbered from 1',
    large: 'byte/character offset',
  }
}

// GNU 9.7 refuses a number at or past 2**64 - 1, quoting its digits as
// typed: `-f 18446744073709551614` is accepted, `-f 0018446744073709551615`
// reports "field number '0018446744073709551615' is too large".
const TOO_LARGE = 2n ** 64n - 1n

// What may sit between two list elements: a comma, a space or a TAB. NOT a
// newline, which is an invalid character here -- `cut -f $'1\n2'` is refused
// and quotes `'\n2'`, where `-f '1\t2'` selects fields 1 and 2.
const SEPARATORS = new Set([',', ' ', '\t'])

// The bound's value (null when no digit was typed) and where its digits end.
function readBound(
  spec: string,
  start: number,
  words: CutListWords,
): [bigint | null, number] | string {
  let end = start
  while (/[0-9]/.test(spec.charAt(end))) end++
  if (end === start) return [null, end]
  const typed = spec.slice(start, end)
  const value = boundedDecimal(typed, TOO_LARGE)
  if (value === null) return cutError(`${words.large} '${quoteText(typed)}' is too large`)
  return [value, end]
}

function closedElement(
  low: bigint | null,
  isRange: boolean,
  high: bigint | null,
  words: CutListWords,
): [number, number] | string {
  if (!isRange) {
    if (low === null || low === 0n) return cutError(words.zero)
    return [Number(low), Number(low)]
  }
  if (low === null && high === null) return cutError('invalid range with no endpoint: -')
  const first = low ?? 1n
  if (high === null) return [Number(first), OPEN_END]
  if (high < first) return cutError('invalid decreasing range')
  return [Number(first), Number(high)]
}

/**
 * Read a `-b`/`-c`/`-f` list into [first, last] pairs, in the order typed.
 * Failure returns the two stderr lines to print (exit 1), never a partially
 * parsed list.
 *
 * Each element is `N`, `N-M`, `N-` or `-M`, and elements are split by a
 * comma, a space or a TAB; an empty element counts as position 0, which is
 * why `-f '2 '`, `-f 1,` and `-f ''` all report "numbered from 1". The first
 * refusal met reading left to right wins, so `-f 0,x` is the zero message
 * while `-f 0x` names `'x'`, and a low bound of 0 is refused at its dash
 * (`-f 0-x` is the zero message too). A refused character quotes the rest of
 * the spec from there: `-f 2-3x` and `-f 1,2x` both report `'x'`, `-f abc`
 * reports `'abc'`. `-b` and `-c` differ from each other only in wording,
 * which GNU keeps distinct from `-f`'s.
 */
export function parseRanges(spec: string, mode: CutOptions['mode']): [number, number][] | string {
  const words = listWords(mode)
  const ranges: [number, number][] = []
  let cursor = 0
  for (;;) {
    const lowBound = readBound(spec, cursor, words)
    if (typeof lowBound === 'string') return lowBound
    const low = lowBound[0]
    cursor = lowBound[1]
    const isRange = spec.charAt(cursor) === '-'
    let high: bigint | null = null
    if (isRange) {
      if (low === 0n) return cutError(words.zero)
      const highBound = readBound(spec, cursor + 1, words)
      if (typeof highBound === 'string') return highBound
      high = highBound[0]
      cursor = highBound[1]
      if (spec.charAt(cursor) === '-') return cutError(words.range)
    }
    if (cursor < spec.length && !SEPARATORS.has(spec.charAt(cursor))) {
      return cutError(`${words.value} '${quoteText(spec.slice(cursor))}'`)
    }
    const element = closedElement(low, isRange, high, words)
    if (typeof element === 'string') return element
    ranges.push(element)
    if (cursor === spec.length) return ranges
    cursor++
  }
}

function selectPositions(
  ranges: readonly [number, number][],
  n: number,
  complement: boolean,
): number[] {
  const inSet = new Set<number>()
  for (const [lo, hi] of ranges) {
    const start = Math.max(1, lo)
    const end = Math.min(hi, n)
    for (let position = start; position <= end; position++) inSet.add(position)
  }
  const out: number[] = []
  for (let position = 1; position <= n; position++) {
    if (complement ? !inSet.has(position) : inSet.has(position)) out.push(position)
  }
  return out
}

function concat(parts: readonly Uint8Array[], delimiter: Uint8Array): Uint8Array {
  const size = parts.reduce((total, part) => total + part.byteLength, 0)
  const out = new Uint8Array(size + Math.max(0, parts.length - 1) * delimiter.byteLength)
  let offset = 0
  parts.forEach((part, index) => {
    if (index > 0) {
      out.set(delimiter, offset)
      offset += delimiter.byteLength
    }
    out.set(part, offset)
    offset += part.byteLength
  })
  return out
}

function joinPositionGroups(
  units: readonly Uint8Array[],
  positions: readonly number[],
  outputDelimiter: Uint8Array | null,
): Uint8Array {
  if (positions.length === 0) return new Uint8Array()
  const groups: Uint8Array[][] = [[]]
  let previous = positions[0] ?? 0
  for (const [index, position] of positions.entries()) {
    if (index > 0 && position !== previous + 1) groups.push([])
    const unit = units[position - 1]
    if (unit !== undefined) groups[groups.length - 1]?.push(unit)
    previous = position
  }
  const joined = groups.map((group) => concat(group, new Uint8Array()))
  return concat(joined, outputDelimiter ?? new Uint8Array())
}

function isCutWhitespace(text: string, index: number): boolean {
  const code = text.charCodeAt(index)
  return code === 32 || code === 9
}

function splitWhitespaceFields(text: string, trimmed: boolean): WhitespaceFields {
  const fields: string[] = []
  let index = 0
  let fieldStart = 0
  let hasDelimiter = false
  let sourceEmpty = true
  if (trimmed) {
    while (index < text.length && isCutWhitespace(text, index)) {
      hasDelimiter = true
      index += 1
    }
    fieldStart = index
  }
  while (index < text.length) {
    if (!isCutWhitespace(text, index)) {
      sourceEmpty = false
      index += 1
      continue
    }
    hasDelimiter = true
    fields.push(text.slice(fieldStart, index))
    while (index < text.length && isCutWhitespace(text, index)) index += 1
    fieldStart = index
  }
  if (!trimmed || fieldStart < text.length) fields.push(text.slice(fieldStart))
  if (fields.length === 0) fields.push('')
  return { fields, hasDelimiter, sourceEmpty }
}

function cutBytes(rec: Uint8Array, options: CutOptions): Uint8Array {
  const positions = selectPositions(options.ranges, rec.byteLength, options.complement)
  const outputDelimiter =
    options.outputDelimiter === null ? null : ENC.encode(options.outputDelimiter)
  if (!options.noPartial) {
    const units = Array.from(rec, (byte) => Uint8Array.of(byte))
    return joinPositionGroups(units, positions, outputDelimiter)
  }
  const selected = new Set(positions)
  const groups: Uint8Array[][] = [[]]
  let offset = 0
  let previousEnd = 0
  for (const char of Array.from(DEC.decode(rec))) {
    const bytes = ENC.encode(char)
    const end = offset + bytes.byteLength
    if (selected.has(end)) {
      if (offset !== previousEnd && groups[groups.length - 1]?.length !== 0) groups.push([])
      groups[groups.length - 1]?.push(rec.subarray(offset, end))
      previousEnd = end
    }
    offset = end
  }
  return concat(
    groups.filter((group) => group.length > 0).map((group) => concat(group, new Uint8Array())),
    outputDelimiter ?? new Uint8Array(),
  )
}

function cutRecord(rec: Uint8Array, options: CutOptions): Uint8Array | null {
  if (options.mode === 'bytes') return cutBytes(rec, options)
  const text = DEC.decode(rec)
  if (options.mode === 'characters') {
    const chars = Array.from(text)
    const positions = selectPositions(options.ranges, chars.length, options.complement)
    return joinPositionGroups(
      chars.map((char) => ENC.encode(char)),
      positions,
      options.outputDelimiter === null ? null : ENC.encode(options.outputDelimiter),
    )
  }
  let fields: string[]
  let hasDelimiter: boolean
  let defaultOutput: string
  if (options.whitespace !== null) {
    const whitespaceFields = splitWhitespaceFields(text, options.whitespace === 'trimmed')
    hasDelimiter = whitespaceFields.hasDelimiter
    fields = whitespaceFields.fields
    defaultOutput = '\t'
    if (options.whitespace === 'trimmed' && whitespaceFields.sourceEmpty && options.onlyDelimited)
      return null
  } else {
    hasDelimiter = text.includes(options.delimiter)
    fields = text.split(options.delimiter)
    defaultOutput = options.delimiter
  }
  if (!hasDelimiter) return options.onlyDelimited ? null : rec
  const positions = selectPositions(options.ranges, fields.length, options.complement)
  const delimiter = options.outputDelimiter ?? defaultOutput
  return ENC.encode(positions.map((position) => fields[position - 1] ?? '').join(delimiter))
}

export async function* cutStream(
  source: AsyncIterable<Uint8Array>,
  options: CutOptions,
): AsyncIterable<Uint8Array> {
  const separator = recordSeparator(options.zeroTerminated)
  const reader = new AsyncLineIterator(source)
  try {
    for (;;) {
      const rec = await reader.readline(undefined, separator)
      if (rec === null) return
      const selected = cutRecord(rec, options)
      if (selected === null) continue
      const out = new Uint8Array(selected.byteLength + 1)
      out.set(selected)
      out[selected.byteLength] = separator
      yield out
    }
  } finally {
    await reader.discard()
  }
}
