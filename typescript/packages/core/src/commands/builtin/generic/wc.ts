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

import { isStdin, stdinStream } from '../utils/stream.ts'
import { cacheAwareStreamEager } from '../../../cache/read_through.ts'
import { guardInput } from '../utils/limit.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { fsErrorLine } from '../../../errors/render.ts'
import { isEisdir, isFsError } from '../../../errors/fs.ts'
import { resolveSource } from '../utils/stream.ts'
import { formatRecords } from '../utils/output.ts'
import { argmatchError } from '../../spec/usage.ts'
import { argmatch } from '../../spec/argmatch.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { type FlagValue } from '../../spec/types.ts'
import { specOf } from '../../spec/builtins.ts'
import { advanceColumn, isSpace } from '../../../utils/width.ts'
import { shellQuote } from '../../../utils/quote.ts'
import { encodeText } from '../../../shell/bytes.ts'

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

// GNU's `total_types` in declaration order, which is both the accepted set
// and what `--total=x` lists back. No aliases, so one per line.
const TOTAL_ARGS = ['auto', 'always', 'only', 'never'] as const

export interface WcFlags {
  lines: boolean
  words: boolean
  bytes: boolean
  chars: boolean
  maxLineLength: boolean
  total: 'auto' | 'always' | 'only' | 'never'
}

export function parseFlags(bag: Record<string, FlagValue>): WcFlags | string {
  const fl = new FlagView(bag, specOf('wc'))
  // `--total=` is NOT the default: GNU reads the empty word as a prefix of
  // every candidate and answers `ambiguous argument ''` (exit 1), which is
  // what the shared renderer words. Python read it as `auto` and exited 0,
  // the one py/ts split at this slot. `asStr` keeps the empty string (it
  // tests `typeof === 'string'`), so the empty word still reaches the
  // renderer rather than defaulting.
  const rawTotal = fl.asStr('total') ?? 'auto'
  const match = argmatch(rawTotal, TOTAL_ARGS)
  if (!match.matched) {
    return (
      argmatchError('wc', '--total', rawTotal, TOTAL_ARGS, undefined, match.kind).message + '\n'
    )
  }
  return {
    lines: fl.asBool('lines'),
    words: fl.asBool('words'),
    bytes: fl.asBool('bytes'),
    chars: fl.asBool('chars'),
    maxLineLength: fl.asBool('max_line_length'),
    total: match.word as WcFlags['total'],
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

/**
 * GNU wc's column width, which it takes from the operands.
 *
 * One operand, or stdin, shown with one count prints unpadded. Otherwise the
 * width is the digits of the regular files' total size, and at least 7 once
 * any operand is a stream or a directory, whose size GNU cannot know
 * (coreutils 9.7). A redirected file reaches mirage as a stream, so
 * `wc < file` pads to 7 where GNU pads to the file's size. `sizes` holds, per
 * operand that opened, a regular file's size or null for a stream or a
 * directory; `operands` counts the operands given, 1 for stdin. Mirrors
 * Python's number_width.
 */
export function numberWidth(
  sizes: readonly (number | null)[],
  operands: number,
  counts: number,
): number {
  if (operands <= 1 && counts === 1) return 1
  let total = 0
  for (const size of sizes) total += size ?? 0
  const width = String(total).length
  return sizes.includes(null) ? Math.max(width, 7) : width
}

// One report row under GNU's name rule (coreutils 9.7 wc.c): a name holding a
// newline is shell-quoted, as quotef does, so no row spans two lines; every
// other name, spaces included, prints as itself. Mirrors Python's labelled.
function labelled(body: string, label: string | null): string {
  if (label === null) return body
  return `${body} ${label.includes('\n') ? shellQuote(label) : label}`
}

// GNU wc layout: counts right-aligned to a shared width and space-separated.
// A caller that knows its operands passes GNU's width (numberWidth); one that
// holds only counts, such as a database push-down that never renders its
// files, gets the widest printed number, with a single count for a single
// operand unpadded and a lone unlabelled row at GNU's 7.
export function formatWcLines(rows: WcRow[], width: number | null = null): string[] {
  const first = rows[0]
  if (width === null && rows.length === 1 && first?.values.length === 1) {
    const body = String(first.values[0])
    return [labelled(body, first.label)]
  }
  let pad = width ?? 1
  if (width === null && rows.length === 1 && first?.label === null) {
    pad = 7
  } else if (width === null) {
    for (const row of rows) {
      for (const n of row.values) pad = Math.max(pad, String(n).length)
    }
  }
  return rows.map((row) => {
    const body = row.values.map((n) => String(n).padStart(pad)).join(' ')
    return labelled(body, row.label)
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
  width: number | null = null,
): ByteSource | null {
  if (total === 'only') return encodeText(`${totalValues.join(' ')}\n`)
  const out = [...rows]
  if (total === 'always' || (total === 'auto' && operandCount > 1)) {
    out.push({ values: totalValues, label: 'total' })
  }
  if (out.length === 0) return null
  return formatRecords(formatWcLines(out, width))
}

/** How many columns a row shows under these flags. */
export function shownCounts(flags: WcFlags): number {
  return selectedValues({ lines: 0, words: 0, bytes: 0, chars: 0, maxLineLength: 0 }, flags).length
}

export async function wcGeneric(
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
  stream: Stream,
): Promise<CommandFnResult> {
  stream = stdinStream(cacheAwareStreamEager(stream), opts.stdin)
  const parsed = parseFlags(opts.flags)
  if (typeof parsed === 'string') {
    return [null, new IOResult({ exitCode: 1, stderr: encodeText(parsed) })]
  }
  if (paths.length > 0) {
    const rows: WcRow[] = []
    const sizes: (number | null)[] = []
    const total: WcCounts = { lines: 0, words: 0, bytes: 0, chars: 0, maxLineLength: 0 }
    let err = ''
    for (const p of paths) {
      let counts: WcCounts
      try {
        counts = await countsOf(stream(p), opts, parsed)
      } catch (e) {
        if (!isFsError(e)) throw e
        err += fsErrorLine('wc', p, e)
        // GNU opens a directory and fails only to read it, so it prints a row
        // of zeros beside the error and pads as for a stream.
        if (isEisdir(e)) {
          const zero = { lines: 0, words: 0, bytes: 0, chars: 0, maxLineLength: 0 }
          rows.push({ values: selectedValues(zero, parsed), label: p.rawPath })
          sizes.push(null)
        }
        continue
      }
      rows.push({ values: selectedValues(counts, parsed), label: p.rawPath })
      sizes.push(isStdin(p) ? null : counts.bytes)
      addCounts(total, counts)
    }
    const width = numberWidth(sizes, paths.length, shownCounts(parsed))
    const io = new IOResult({
      exitCode: err === '' ? 0 : 1,
      stderr: err === '' ? null : encodeText(err),
      countedRuns: rows,
    })
    return [
      formatCountRows(rows, selectedValues(total, parsed), paths.length, parsed.total, width),
      io,
    ]
  }
  let source: AsyncIterable<Uint8Array>
  try {
    source = resolveSource(opts.stdin)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return [null, new IOResult({ exitCode: 1, stderr: encodeText(`${msg}\n`) })]
  }
  const counts = await countsOf(source, opts, parsed)
  const values = selectedValues(counts, parsed)
  if (parsed.total === 'only') {
    return [encodeText(`${values.join(' ')}\n`), new IOResult()]
  }
  const rows: WcRow[] = [{ values, label: null }]
  if (parsed.total === 'always') rows.push({ values, label: 'total' })
  const width = numberWidth([null], 1, values.length)
  return [formatRecords(formatWcLines(rows, width)), new IOResult()]
}
