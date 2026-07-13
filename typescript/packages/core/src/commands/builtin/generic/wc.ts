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

async function* wcLinesStream(source: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> {
  let count = 0
  for await (const chunk of source) {
    for (let i = 0; i < chunk.byteLength; i++) if (chunk[i] === 0x0a) count += 1
  }
  yield ENC.encode(`${String(count)}\n`)
}

function countChar(text: string, ch: string): number {
  let n = 0
  for (const c of text) if (c === ch) n += 1
  return n
}

export interface WcRow {
  values: number[]
  label: string | null
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
  const f = opts.flags
  const lFlag = f.args_l === true
  const wFlag = f.w === true
  const cFlag = f.c === true
  const mFlag = f.m === true
  const LFlag = f.L === true
  if (paths.length > 0) {
    const rows: WcRow[] = []
    let totalLines = 0
    let totalWords = 0
    let totalBytes = 0
    let totalMax = 0
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
      const text = DEC.decode(data)
      const lineCount = countChar(text, '\n')
      const wordCount = text.split(/\s+/).filter((s) => s !== '').length
      const byteCount = data.byteLength
      if (LFlag) {
        const maxLen = text.split(/\r?\n/).reduce((m, l) => Math.max(m, l.length), 0)
        rows.push({ values: [maxLen], label: p.rawPath })
        totalMax = Math.max(totalMax, maxLen)
      } else if (lFlag) {
        rows.push({ values: [lineCount], label: p.rawPath })
        totalLines += lineCount
      } else if (wFlag) {
        rows.push({ values: [wordCount], label: p.rawPath })
        totalWords += wordCount
      } else if (cFlag) {
        rows.push({ values: [byteCount], label: p.rawPath })
        totalBytes += byteCount
      } else if (mFlag) {
        const charCount = text.length
        rows.push({ values: [charCount], label: p.rawPath })
        totalBytes += charCount
      } else {
        rows.push({ values: [lineCount, wordCount, byteCount], label: p.rawPath })
        totalLines += lineCount
        totalWords += wordCount
        totalBytes += byteCount
      }
    }
    if (paths.length > 1) {
      // GNU wc totals the operands that resolved and still prints the row
      // when some (or all) operands failed: `0 total` when none resolved.
      if (LFlag) rows.push({ values: [totalMax], label: 'total' })
      else if (lFlag) rows.push({ values: [totalLines], label: 'total' })
      else if (wFlag) rows.push({ values: [totalWords], label: 'total' })
      else if (cFlag || mFlag) rows.push({ values: [totalBytes], label: 'total' })
      else rows.push({ values: [totalLines, totalWords, totalBytes], label: 'total' })
    }
    const io = new IOResult({
      exitCode: err === '' ? 0 : 1,
      stderr: err === '' ? null : ENC.encode(err),
    })
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
  if (lFlag) return [wcLinesStream(source), new IOResult()]
  const raw = await materialize(source)
  const text = DEC.decode(raw)
  const lc = countChar(text, '\n')
  const wcVal = text.split(/\s+/).filter((s) => s !== '').length
  const bc = raw.byteLength
  const cc = text.length
  if (LFlag) {
    const maxLen = text.split(/\r?\n/).reduce((m, l) => Math.max(m, l.length), 0)
    return [ENC.encode(`${String(maxLen)}\n`), new IOResult()]
  }
  if (wFlag) return [ENC.encode(`${String(wcVal)}\n`), new IOResult()]
  if (mFlag) return [ENC.encode(`${String(cc)}\n`), new IOResult()]
  if (cFlag) return [ENC.encode(`${String(bc)}\n`), new IOResult()]
  const line = formatWcLines([{ values: [lc, wcVal, bc], label: null }])[0] ?? ''
  return [ENC.encode(`${line}\n`), new IOResult()]
}
