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
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { fsErrorLine, isFsError } from '../../../utils/errors.ts'
import { resolveSource } from '../utils/stream.ts'
import { formatRecords } from '../utils/output.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

type Stream = (p: PathSpec) => AsyncIterable<Uint8Array>

function countChar(text: string, ch: string): number {
  let n = 0
  for (const c of text) if (c === ch) n += 1
  return n
}

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

interface WcFlags {
  lines: boolean
  words: boolean
  bytes: boolean
  chars: boolean
  maxLineLength: boolean
  total: 'auto' | 'always' | 'only' | 'never'
}

function parseFlags(flags: Record<string, string | boolean | string[]>): WcFlags | string {
  const rawTotal = typeof flags.total === 'string' ? flags.total : 'auto'
  if (!['auto', 'always', 'only', 'never'].includes(rawTotal)) {
    return `wc: invalid argument '${rawTotal}' for '--total'\n`
  }
  return {
    lines: flags.args_l === true || flags.lines === true,
    words: flags.w === true || flags.words === true,
    bytes: flags.c === true || flags.bytes === true,
    chars: flags.m === true || flags.chars === true,
    maxLineLength: flags.L === true || flags.max_line_length === true,
    total: rawTotal as WcFlags['total'],
  }
}

function countsOf(data: Uint8Array): WcCounts {
  const text = DEC.decode(data)
  return {
    lines: countChar(text, '\n'),
    words: text.split(/\s+/u).filter((s) => s !== '').length,
    bytes: data.byteLength,
    chars: Array.from(text).length,
    maxLineLength: text
      .split(/\r?\n/u)
      .reduce((m, line) => Math.max(m, Array.from(line).length), 0),
  }
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
      let data: Uint8Array
      try {
        data = await materialize(stream(p))
      } catch (e) {
        if (!isFsError(e)) throw e
        err += fsErrorLine('wc', p, e)
        continue
      }
      const counts = countsOf(data)
      rows.push({ values: selectedValues(counts, parsed), label: p.rawPath })
      addCounts(total, counts)
    }
    const includeTotal = parsed.total === 'always' || (parsed.total === 'auto' && paths.length > 1)
    if (includeTotal || parsed.total === 'only') {
      rows.push({ values: selectedValues(total, parsed), label: 'total' })
    }
    const io = new IOResult({
      exitCode: err === '' ? 0 : 1,
      stderr: err === '' ? null : ENC.encode(err),
    })
    if (parsed.total === 'only') {
      const out = ENC.encode(`${selectedValues(total, parsed).join(' ')}\n`)
      return [out, io]
    }
    if (rows.length === 0) return [null, io]
    const out: ByteSource = formatRecords(formatWcLines(rows))
    return [out, io]
  }
  let source: AsyncIterable<Uint8Array>
  try {
    source = resolveSource(opts.stdin, 'wc: missing operand')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(`${msg}\n`) })]
  }
  const raw = await materialize(source)
  const counts = countsOf(raw)
  const values = selectedValues(counts, parsed)
  if (parsed.total === 'only') {
    return [ENC.encode(`${values.join(' ')}\n`), new IOResult()]
  }
  const rows: WcRow[] = [{ values, label: null }]
  if (parsed.total === 'always') rows.push({ values, label: 'total' })
  return [formatRecords(formatWcLines(rows)), new IOResult()]
}
