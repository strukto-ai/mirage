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

import { operatorLineEnd } from './line.ts'
import type { HeredocOperator } from './types.ts'

/**
 * Offset where the line closing the body starts, or null when no line
 * does. Bash ends a body at the first line that equals the delimiter,
 * with leading tabs stripped first under `<<-`.
 */
export function terminatorLine(
  text: string,
  bodyStart: number,
  delimiter: string,
  allowsIndent: boolean,
): number | null {
  let position = bodyStart
  while (position <= text.length) {
    const newline = text.indexOf('\n', position)
    const lineEnd = newline < 0 ? text.length : newline
    let line = text.slice(position, lineEnd)
    if (allowsIndent) line = line.replace(/^\t+/, '')
    if (line === delimiter) return position
    if (newline < 0) return null
    position = newline + 1
  }
  return null
}

/**
 * Offset of the line after the one starting at `lineStart`, or null when
 * that line is the last one and has no newline.
 */
export function nextLine(text: string, lineStart: number): number | null {
  const newline = text.indexOf('\n', lineStart)
  return newline < 0 ? null : newline + 1
}

/**
 * The body span of every operator, read the way bash reads them.
 *
 * Bash gathers bodies at the newline that ends an operator's logical
 * line, one after another in the order the operators appear on it, so the
 * second body of `cat <<A <<B` starts on the line after `A`'s terminator.
 * A body is every line strictly between where it starts and the line
 * holding its delimiter; when no line holds it, the body runs to the end
 * of the source, which is how bash reads it too, under a warning that
 * names the delimiter it wanted. That makes the span a property of the
 * source text, not of any token the parser produced. An operator that
 * lies inside an earlier body is text, not syntax, and one whose turn
 * comes once the source has run out has no body. `nested` says one line's
 * bodies stand innermost-first, the order tree-sitter-bash's grammar
 * closes them in, rather than in the order bash gathers them: the source
 * the parser reads is kept in that order (see relayout), so the shield
 * and bodyPrefix read it, while relayout reads the typed source as bash
 * does; a line with one operator reads the same either way. Returns
 * `[bodyStart, bodyEnd]` per operator, in the order given; null when the
 * body never starts.
 */
export function heredocBodies(
  text: string,
  operators: readonly HeredocOperator[],
  nested: boolean,
): ([number, number] | null)[] {
  const spans: ([number, number] | null)[] = operators.map(() => null)
  const bodies: [number, number][] = []
  const lines = new Map<number, number[]>()
  const order = [...operators.keys()].sort(
    (a, b) => (operators[a]?.wordStart ?? 0) - (operators[b]?.wordStart ?? 0),
  )
  for (const index of order) {
    const operator = operators[index]
    if (operator === undefined) continue
    const lineEnd = operatorLineEnd(text, operator.wordEnd)
    if (lineEnd === null) continue
    const members = lines.get(lineEnd) ?? []
    members.push(index)
    lines.set(lineEnd, members)
  }
  for (const [lineEnd, members] of lines) {
    let cursor: number | null = lineEnd + 1
    for (const index of nested ? [...members].reverse() : members) {
      const operator = operators[index]
      if (operator === undefined) continue
      if (bodies.some(([begin, end]) => begin <= operator.wordStart && operator.wordStart < end)) {
        continue
      }
      if (cursor === null) continue
      const bodyEnd =
        terminatorLine(text, cursor, operator.delimiter, operator.allowsIndent) ?? text.length
      spans[index] = [cursor, bodyEnd]
      bodies.push([cursor, bodyEnd])
      cursor = nextLine(text, bodyEnd)
    }
  }
  return spans
}
