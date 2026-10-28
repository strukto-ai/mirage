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

import { callerSignal } from '../../context/session_context.ts'
import { YieldBudget } from '../../io/yield_budget.ts'
import { joinBytes } from '../../shell/bytes.ts'
import { IFS_DEFAULT } from '../../shell/constants.ts'
import { markGlobs, unmarkGlobs } from '../../utils/glob_walk.ts'
import { type Chunk, type Piece, fieldBreak, piece } from './types.ts'

/**
 * What `"$*"` joins the parameters with: the first character of IFS, a
 * space when IFS is unset (null) and nothing when it is empty.
 */
export function ifsJoiner(ifs: string | null): string {
  return ifs === null ? ' ' : ifs.slice(0, 1)
}

/**
 * An expansion's value as a piece of the word it sits in. Inside double
 * quotes the value is literal: its glob characters are marked and it
 * never splits. Unquoted, it splits and globs.
 */
export function valuePiece(text: string, quoted: boolean): Piece {
  return quoted ? piece(markGlobs(text)) : piece(text, true)
}

/**
 * The elements of a splat, a field boundary between each two. A long splat
 * yields between its elements, so a cancel or the line's deadline lands
 * mid-list.
 */
export async function splatChunks(
  elements: readonly string[],
  joiner: string,
  quoted: boolean,
): Promise<Chunk[]> {
  const out: Chunk[] = []
  const budget = new YieldBudget(callerSignal())
  for (const [index, element] of elements.entries()) {
    if (index > 0) out.push(fieldBreak(joiner))
    out.push(valuePiece(element, quoted))
    await budget.run()
  }
  return out
}

/**
 * The text of a word where no field splitting happens. An assignment, a
 * `case` word, `[[ ]]` and a here-string read the pieces as one string,
 * a splat boundary as its joiner.
 */
export function joinChunks(chunks: Iterable<Chunk>): string {
  let out = ''
  for (const c of chunks) out += c.kind === 'piece' ? c.text : c.joiner
  return joinBytes(out)
}

/** The literal text of a word's pieces, glob marks removed. */
export function chunksText(chunks: Iterable<Chunk>): string {
  return unmarkGlobs(joinChunks(chunks))
}

/**
 * Split a word's pieces into fields on IFS, as bash does.
 *
 * Only split pieces are split. An IFS whitespace run delimits a field
 * and is dropped at either end; any other IFS character, with the
 * whitespace around it, delimits exactly one field, so `a,,b` under
 * `IFS=,` is three fields and `a,` is one. A splat boundary always ends
 * a field. A field exists once literal or quoted text, or a non-empty
 * split, opened it, so an unquoted expansion that comes back empty is
 * no word at all while `""` is an empty one. `ifs` is null when unset. A
 * word of many pieces, or a value that splits into many fields, yields
 * between them, so a cancel or the line's deadline lands mid-split; a run
 * with no separator is found in one search.
 */
export async function splitFields(chunks: Iterable<Chunk>, ifs: string | null): Promise<string[]> {
  const separators = ifs ?? IFS_DEFAULT
  let blanks = ''
  for (const c of IFS_DEFAULT) if (separators.includes(c)) blanks += c
  const fields: string[] = []
  let current = ''
  let started = false
  const budget = new YieldBudget(callerSignal())
  const stop =
    separators === '' ? null : new RegExp(`[${separators.replace(/[\\\]^-]/g, '\\$&')}]`, 'g')
  for (const chunk of chunks) {
    await budget.run()
    if (chunk.kind === 'break') {
      if (started) fields.push(current)
      current = ''
      started = false
      continue
    }
    const text = chunk.text
    if (!chunk.split || stop === null) {
      current += text
      started = started || !chunk.split || text !== ''
      continue
    }
    let index = 0
    while (index < text.length) {
      stop.lastIndex = index
      let end = stop.exec(text)?.index ?? text.length
      if (end > index) {
        current += text.slice(index, end)
        started = true
        index = end
        continue
      }
      while (end < text.length && blanks.includes(text[end] ?? '')) end++
      const hard = end < text.length && separators.includes(text[end] ?? '')
      if (hard) {
        end++
        while (end < text.length && blanks.includes(text[end] ?? '')) end++
      }
      if (started || hard) {
        fields.push(current)
        await budget.run()
      }
      current = ''
      started = false
      index = end
    }
  }
  if (started) fields.push(current)
  return fields.map(joinBytes)
}
