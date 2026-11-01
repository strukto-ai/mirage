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

import { isEisdir, isFsError } from '../../../errors/fs.ts'
import { fsErrorLine } from '../../../errors/render.ts'
import { IOResult, type ByteSource, type PathRecord } from '../../../io/types.ts'
import { openStreamSync, runStream } from '../../../rs/stream.ts'
import { byteView, decodeText, encodeText } from '../../../shell/bytes.ts'
import type { PathSpec, ReadStreamFn } from '../../../types.ts'
import { concat } from '../../../utils/bytes.ts'
import type { CommandFnResult, Context } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { type FlagValue } from '../../spec/types.ts'
import { wordRefusalError } from '../../spec/usage.ts'
import { matchWord } from '../../spec/word_choice.ts'
import { guardInput } from '../utils/limit.ts'
import { formatRecords } from '../utils/output.ts'
import { isStdin, resolveSource, stdinStream } from '../utils/stream.ts'

const decoder = new TextDecoder()

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

// The --total words in GNU's order, which is both the accepted set and what
// `--total=x` lists back. No aliases, so one per line.
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
  const match = matchWord(rawTotal, TOTAL_ARGS)
  if (!match.matched) {
    return (
      wordRefusalError('wc', '--total', rawTotal, TOTAL_ARGS, undefined, match.kind).message + '\n'
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

// GNU wc's counts, streamed through mirage-rs. Only -l and -c count without
// decoding; any other count decodes UTF-8, and a byte that decodes to no
// character is part of a word but no character and no column. Mirrors
// Python's wc.
async function wc(source: ByteSource, ctx: Context, flags: WcFlags): Promise<WcCounts> {
  const config = {
    lines: flags.lines,
    words: flags.words,
    bytes: flags.bytes,
    chars: flags.chars,
    max_line_length: flags.maxLineLength,
  }
  let report = ''
  for await (const part of runStream('wc', config, guardInput(source, ctx))) {
    report += decoder.decode(part)
  }
  const [lines = 0, words = 0, bytes = 0, chars = 0, maxLineLength = 0] = report
    .split(' ')
    .map((value) => Number(value))
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

export function formatWcLines(rows: WcRow[], width: number | null = null): string[] {
  const engine = openStreamSync('wc', {
    report: rows.map((row) => ({
      values: row.values,
      label: row.label === null ? null : byteView(row.label),
    })),
    width,
  })
  try {
    const output = [engine.finish()]
    while (engine.busy()) output.push(engine.drain())
    return decodeText(concat(output)).split('\n').slice(0, -1)
  } finally {
    engine.close()
  }
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

/**
 * Run wc over resolved operands, GNU semantics. Lines counted alone are asked
 * of `lineCount` first, so a mount that can count a file's lines on its own
 * (a `COUNT(*)` on a table) does not send it; null, or no `lineCount`, reads
 * the file. A row counted that way has no byte size, so the columns are as
 * wide as the printed numbers. Bytes counted alone are asked of `sizeOf`
 * first, as GNU takes a regular file's size from its stat. Mirrors Python's
 * `wc_generic` and `format_multi`.
 */
export async function wcGeneric(
  paths: PathSpec[],
  texts: string[],
  ctx: Context,
  stream: ReadStreamFn,
  lineCount?: (p: PathSpec) => Promise<number | null>,
  sizeOf?: (p: PathSpec) => Promise<number | null>,
): Promise<CommandFnResult> {
  stream = stdinStream(stream, ctx.stdin)
  const parsed = parseFlags(ctx.flags)
  if (typeof parsed === 'string') {
    return [null, new IOResult({ exitCode: 1, stderr: encodeText(parsed) })]
  }
  if (paths.length > 0) {
    const rows: WcRow[] = []
    const records: PathRecord[] = []
    const sizes: (number | null)[] = []
    const total: WcCounts = { lines: 0, words: 0, bytes: 0, chars: 0, maxLineLength: 0 }
    let err = ''
    const counted =
      parsed.lines &&
      !(parsed.words || parsed.bytes || parsed.chars || parsed.maxLineLength) &&
      lineCount !== undefined
        ? lineCount
        : null
    const sized =
      parsed.bytes &&
      !(parsed.lines || parsed.words || parsed.chars || parsed.maxLineLength) &&
      sizeOf !== undefined
        ? sizeOf
        : null
    let pushed = false
    for (const [run, p] of paths.entries()) {
      let counts: WcCounts
      try {
        const found = counted === null || isStdin(p) ? null : await counted(p)
        const size = sized === null || isStdin(p) ? null : await sized(p)
        if (found !== null) {
          counts = { lines: found, words: 0, bytes: 0, chars: 0, maxLineLength: 0 }
          pushed = true
        } else if (size !== null) {
          counts = { lines: 0, words: 0, bytes: size, chars: 0, maxLineLength: 0 }
        } else {
          counts = await wc(stream(p), ctx, parsed)
        }
      } catch (e) {
        if (!isFsError(e)) throw e
        err += fsErrorLine('wc', p, e)
        // GNU opens a directory and fails only to read it, so it prints a row
        // of zeros beside the error and pads as for a stream.
        if (isEisdir(e)) {
          const zero = { lines: 0, words: 0, bytes: 0, chars: 0, maxLineLength: 0 }
          rows.push({ values: selectedValues(zero, parsed), label: p.rawPath })
          records.push({ path: p, run, values: selectedValues(zero, parsed) })
          sizes.push(null)
        }
        continue
      }
      rows.push({ values: selectedValues(counts, parsed), label: p.rawPath })
      records.push({ path: p, run, values: selectedValues(counts, parsed) })
      sizes.push(isStdin(p) ? null : counts.bytes)
      addCounts(total, counts)
    }
    const width = pushed ? null : numberWidth(sizes, paths.length, shownCounts(parsed))
    const io = new IOResult({
      exitCode: err === '' ? 0 : 1,
      stderr: err === '' ? null : encodeText(err),
      records,
    })
    return [
      formatCountRows(rows, selectedValues(total, parsed), paths.length, parsed.total, width),
      io,
    ]
  }
  const counts = await wc(resolveSource(ctx.stdin), ctx, parsed)
  const values = selectedValues(counts, parsed)
  if (parsed.total === 'only') {
    return [encodeText(`${values.join(' ')}\n`), new IOResult()]
  }
  const rows: WcRow[] = [{ values, label: null }]
  if (parsed.total === 'always') rows.push({ values, label: 'total' })
  const width = numberWidth([null], 1, values.length)
  return [formatRecords(formatWcLines(rows, width)), new IOResult()]
}
