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

import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import type { FlagValue } from '../../spec/types.ts'
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { readStdinAsync } from '../utils/stream.ts'
import { joinFileBytes, splitLines } from '../utils/lines.ts'
import { advanceColumn, isSpace, textWidth } from '../../../utils/width.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

const DEFAULT_WIDTH = 80

function isBlank(line: string): boolean {
  for (const ch of line) if (!isSpace(ch.codePointAt(0) ?? 0)) return false
  return true
}

// The input lines util-linux `column` lays out: blank ones dropped.
function entries(text: string): string[] {
  return splitLines(text).filter((line) => !isBlank(line))
}

// `COLUMNS` when it is a positive number, else 80: stdout is no tty.
function outputWidth(env: Readonly<Record<string, string>> | undefined): number {
  const raw = env?.COLUMNS ?? ''
  return /^[0-9]+$/.test(raw) && Number(raw) > 0 ? Number(raw) : DEFAULT_WIDTH
}

/**
 * Lay entries down the columns, util-linux `column`'s default mode: each
 * column is the widest entry rounded up to the next tab stop, as many
 * columns as fit the width (at least one), and a gap is tabs to the next
 * column start. Mirrors Python's `_fill_columns`.
 */
function fillColumns(text: string, width: number): string {
  const items = entries(text)
  if (items.length === 0) return ''
  const stop = advanceColumn(
    items.reduce((widest, item) => Math.max(widest, textWidth(item)), 0),
    0x09,
  )
  const rows = Math.ceil(items.length / Math.max(1, Math.floor(width / stop)))
  const out: string[] = []
  for (let row = 0; row < rows; row++) {
    let line = ''
    let at = 0
    let end = stop
    for (let index = row; index < items.length; index += rows) {
      const item = items[index] ?? ''
      line += item
      at += textWidth(item)
      if (index + rows >= items.length) break
      while (advanceColumn(at, 0x09) <= end) {
        line += '\t'
        at = advanceColumn(at, 0x09)
      }
      end += stop
    }
    out.push(line)
  }
  return out.join('\n') + '\n'
}

function tableFormat(text: string, separator: string | null, outputSep: string): string {
  const rows = entries(text).map((line) =>
    separator !== null && separator !== ''
      ? line.split(separator)
      : line.split(/\s+/).filter((s) => s !== ''),
  )
  if (rows.length === 0) return ''
  const widths = new Array(rows.reduce((most, r) => Math.max(most, r.length), 0)).fill(
    0,
  ) as number[]
  for (const row of rows) {
    row.forEach((cell, idx) => {
      widths[idx] = Math.max(widths[idx] ?? 0, textWidth(cell))
    })
  }
  return (
    rows
      .map((row) =>
        row
          .map((cell, idx) =>
            idx < row.length - 1 ? cell + ' '.repeat((widths[idx] ?? 0) - textWidth(cell)) : cell,
          )
          .join(outputSep),
      )
      .join('\n') + '\n'
  )
}

interface ColumnFlags {
  readonly table: boolean
  readonly separator: string | null
  readonly outputSeparator: string | null
}

function parseFlags(bag: Record<string, FlagValue>): ColumnFlags {
  const fl = new FlagView(bag, specOf('column'))
  return {
    table: fl.asBool('t'),
    separator: fl.asStr('s') ?? null,
    outputSeparator: fl.asStr('o') ?? null,
  }
}

export async function columnGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
): Promise<CommandFnResult> {
  const parsed = parseFlags(opts.flags)
  let raw: Uint8Array
  if (paths.length > 0) {
    // Every operand is read, as one run of lines in which a file's last line
    // ends where the next file begins. Mirrors Python's column.
    const parts: Uint8Array[] = []
    for (const path of paths) parts.push(await materialize(stream(path)))
    raw = joinFileBytes(parts, 0x0a)
  } else {
    const stdinData = await readStdinAsync(opts.stdin)
    raw = stdinData ?? new Uint8Array(0)
  }
  const text = DEC.decode(raw)
  const output = parsed.table
    ? tableFormat(text, parsed.separator, parsed.outputSeparator ?? '  ')
    : fillColumns(text, outputWidth(opts.env))
  const result: ByteSource = ENC.encode(output)
  return [result, new IOResult()]
}
