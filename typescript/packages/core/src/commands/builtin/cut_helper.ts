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

import { materialize } from '../../io/types.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

export const CUT_OPEN_END = Number.MAX_SAFE_INTEGER

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

export function parseCutRanges(spec: string): [number, number][] {
  const ranges: [number, number][] = []
  for (const part of spec.split(',')) {
    if (part.includes('-')) {
      const [loStr, hiStr] = part.split('-', 2) as [string, string]
      const lo = loStr === '' ? 1 : Number.parseInt(loStr, 10)
      const hi = hiStr === '' ? CUT_OPEN_END : Number.parseInt(hiStr, 10)
      ranges.push([lo, hi])
    } else {
      const val = Number.parseInt(part, 10)
      ranges.push([val, val])
    }
  }
  return ranges
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

function splitRecords(raw: Uint8Array, separator: number): Uint8Array[] {
  const records: Uint8Array[] = []
  let start = 0
  for (let index = 0; index < raw.byteLength; index++) {
    if (raw[index] === separator) {
      records.push(raw.subarray(start, index))
      start = index + 1
    }
  }
  if (start < raw.byteLength) records.push(raw.subarray(start))
  return records
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

export function cutBytes(rec: Uint8Array, options: CutOptions): Uint8Array {
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
  const raw = await materialize(source)
  const separator = options.zeroTerminated ? 0 : 0x0a
  for (const rec of splitRecords(raw, separator)) {
    const selected = cutRecord(rec, options)
    if (selected === null) continue
    const out = new Uint8Array(selected.byteLength + 1)
    out.set(selected)
    out[selected.byteLength] = separator
    yield out
  }
}
