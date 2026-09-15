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

import { cacheAwareStreamEager } from '../../../cache/read_through.ts'
import { guardInput } from '../utils/limit.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { fsErrorLine, isFsError } from '../../../utils/errors.ts'
import { resolveSource } from '../utils/stream.ts'
import { formatRecords } from '../utils/output.ts'
import type { FlagValue } from '../../spec/types.ts'
import { advanceColumn, isSpace } from '../../../utils/width.ts'

const ENC = new TextEncoder()

type Stream = (p: PathSpec) => AsyncIterable<Uint8Array>

export interface WcRow {
  values: number[]
  label: string | null
}

interface WcCounts {
  lines: number
  words: number
  bytes: number
  chars: number
  maxLineLength: number
}

export interface WcFlags {
  lines: boolean
  words: boolean
  bytes: boolean
  chars: boolean
  maxLineLength: boolean
  total: 'auto' | 'always' | 'only' | 'never'
}

export function parseFlags(flags: Record<string, FlagValue>): WcFlags | string {
  const rawTotal = typeof flags.total === 'string' ? flags.total : 'auto'
  if (!['auto', 'always', 'only', 'never'].includes(rawTotal)) {
    return `wc: invalid argument '${rawTotal}' for '--total'\n`
  }
  return {
    lines: flags.lines === true,
    words: flags.words === true,
    bytes: flags.bytes === true,
    chars: flags.chars === true,
    maxLineLength: flags.max_line_length === true,
    total: rawTotal as WcFlags['total'],
  }
}

// Word splitting and column geometry are separate questions about the same
// character: `\t` both ends a word and jumps to the next tab stop, while a
// combining mark ends nothing and occupies nothing. maxLineLength is a
// running maximum rather than a per-line one because carriage return and form
// feed rewind the column without ending the line -- which is why the old
// `split(/\r?\n/)` could not express it. Mirrors Python's `_scan_text`.
async function countsOf(source: ByteSource, opts: CommandOpts, flags: WcFlags): Promise<WcCounts> {
  const byteCountsOnly =
    (flags.lines || flags.bytes) && !flags.words && !flags.chars && !flags.maxLineLength
  if (byteCountsOnly) {
    let lines = 0
    let bytes = 0
    for await (const chunk of guardInput(source, opts)) {
      bytes += chunk.byteLength
      if (flags.lines) for (let i = 0; i < chunk.byteLength; i++) if (chunk[i] === 0x0a) lines++
    }
    return { lines, words: 0, bytes, chars: 0, maxLineLength: 0 }
  }
  const decoder = new TextDecoder('utf-8', { fatal: false })
  let bytes = 0
  let lines = 0
  let words = 0
  let chars = 0
  let inWord = false
  let column = 0
  let maxLineLength = 0
  const scan = (text: string): void => {
    for (const ch of text) {
      const cp = ch.codePointAt(0) ?? 0
      chars += 1
      if (isSpace(cp)) {
        if (inWord) {
          words += 1
          inWord = false
        }
      } else {
        inWord = true
      }
      if (cp === 0x0a) {
        lines += 1
        if (column > maxLineLength) maxLineLength = column
        column = 0
        continue
      }
      column = advanceColumn(column, cp)
      if (column > maxLineLength) maxLineLength = column
    }
  }
  for await (const chunk of guardInput(source, opts)) {
    bytes += chunk.byteLength
    scan(decoder.decode(chunk, { stream: true }))
  }
  scan(decoder.decode())
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- scan mutates inWord across decoded chunks.
  if (inWord) words += 1
  return { lines, words, bytes, chars, maxLineLength }
}

function selectedValues(counts: WcCounts, flags: WcFlags): number[] {
  const selected = flags.lines || flags.words || flags.bytes || flags.chars || flags.maxLineLength
  if (!selected) return [counts.lines, counts.words, counts.bytes]
  const values: number[] = []
  if (flags.lines) values.push(counts.lines)
  if (flags.words) values.push(counts.words)
  if (flags.chars) values.push(counts.chars)
  if (flags.bytes) values.push(counts.bytes)
  if (flags.maxLineLength) values.push(counts.maxLineLength)
  return values
}

function addCounts(total: WcCounts, counts: WcCounts): void {
  total.lines += counts.lines
  total.words += counts.words
  total.bytes += counts.bytes
  total.chars += counts.chars
  total.maxLineLength = Math.max(total.maxLineLength, counts.maxLineLength)
}

// GNU wc layout: counts right-aligned to a shared width and space-separated;
// a single count for a single operand prints unpadded, and a default-mode
// stdin read uses GNU's width 7 for unknown sizes. Divergence from GNU: the
// width is the widest printed number, while GNU derives it from operand file
// sizes; the two are identical in the default mode, where the byte count is
// the widest column.
export function formatWcLines(rows: WcRow[]): string[] {
  const first = rows[0]
  if (rows.length === 1 && first?.values.length === 1) {
    const body = String(first.values[0])
    return [first.label === null ? body : `${body} ${first.label}`]
  }
  let width = 1
  if (rows.length === 1 && first?.label === null) {
    width = 7
  } else {
    for (const row of rows) {
      for (const n of row.values) width = Math.max(width, String(n).length)
    }
  }
  return rows.map((row) => {
    const body = row.values.map((n) => String(n).padStart(width)).join(' ')
    return row.label === null ? body : `${body} ${row.label}`
  })
}

// Append the `total` row --total asks for and render the report. `only`
// prints the grand total alone and unlabeled; `auto` prints one when more
// than one operand was counted. Returns null when there is nothing to print.
export function formatCountRows(
  rows: WcRow[],
  totalValues: number[],
  operandCount: number,
  total: WcFlags['total'],
): ByteSource | null {
  if (total === 'only') return ENC.encode(`${totalValues.join(' ')}\n`)
  const out = [...rows]
  if (total === 'always' || (total === 'auto' && operandCount > 1)) {
    out.push({ values: totalValues, label: 'total' })
  }
  if (out.length === 0) return null
  return formatRecords(formatWcLines(out))
}

export async function wcGeneric(
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
  stream: Stream,
): Promise<CommandFnResult> {
  stream = cacheAwareStreamEager(stream)
  const parsed = parseFlags(opts.flags)
  if (typeof parsed === 'string') {
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(parsed) })]
  }
  if (paths.length > 0) {
    const rows: WcRow[] = []
    const total: WcCounts = { lines: 0, words: 0, bytes: 0, chars: 0, maxLineLength: 0 }
    let err = ''
    for (const p of paths) {
      let counts: WcCounts
      try {
        counts = await countsOf(stream(p), opts, parsed)
      } catch (e) {
        if (!isFsError(e)) throw e
        err += fsErrorLine('wc', p, e)
        continue
      }
      rows.push({ values: selectedValues(counts, parsed), label: p.rawPath })
      addCounts(total, counts)
    }
    const io = new IOResult({
      exitCode: err === '' ? 0 : 1,
      stderr: err === '' ? null : ENC.encode(err),
    })
    return [formatCountRows(rows, selectedValues(total, parsed), paths.length, parsed.total), io]
  }
  let source: AsyncIterable<Uint8Array>
  try {
    source = resolveSource(opts.stdin, 'wc: missing operand')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(`${msg}\n`) })]
  }
  const counts = await countsOf(source, opts, parsed)
  const values = selectedValues(counts, parsed)
  if (parsed.total === 'only') {
    return [ENC.encode(`${values.join(' ')}\n`), new IOResult()]
  }
  const rows: WcRow[] = [{ values, label: null }]
  if (parsed.total === 'always') rows.push({ values, label: 'total' })
  return [formatRecords(formatWcLines(rows)), new IOResult()]
}
