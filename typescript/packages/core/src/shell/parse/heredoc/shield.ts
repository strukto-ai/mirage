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

import type { Node } from 'web-tree-sitter'
import type { TSNodeLike } from '../../types.ts'
import { heredocBodies } from './body.ts'
import {
  ALTERNATE_FILLER,
  DASH_ARROW,
  ESCAPE_PARTNERS,
  FILLER,
  HEREDOC_START,
  LINE_BLANKS,
} from './constants.ts'
import { cleanDelimiter } from './delimiter.ts'
import type { HeredocOperator } from './types.ts'

/**
 * Every heredoc operator under `root`, in source order.
 *
 * ERROR subtrees are walked too: a body the lexer mangled badly enough
 * leaves no heredoc_redirect behind, but its start token survives.
 * These are hints; the source reader validates delimiter word bounds.
 */
export function heredocOperators(root: TSNodeLike): HeredocOperator[] {
  const found: HeredocOperator[] = []
  const stack: TSNodeLike[] = [root]
  for (;;) {
    const node = stack.pop()
    if (node === undefined) break
    stack.push(...node.children)
    if (node.type !== HEREDOC_START) continue
    if (node.startIndex === undefined || node.endIndex === undefined) continue
    const delimiter = cleanDelimiter(node.text)
    found.push({
      wordStart: node.startIndex,
      wordEnd: node.endIndex,
      delimiter,
      allowsIndent: node.previousSibling?.type === DASH_ARROW,
    })
  }
  return found.sort((a, b) => a.wordStart - b.wordStart)
}

/** Offset of the first body line that is not empty. */
export function firstContentLine(text: string, bodyStart: number, bodyEnd: number): number | null {
  let position = bodyStart
  while (position < bodyEnd) {
    const newline = text.indexOf('\n', position)
    const lineEnd = newline < 0 || newline > bodyEnd ? bodyEnd : newline
    if (lineEnd > position) return position
    position = lineEnd + 1
  }
  return null
}

/**
 * One character per body line the scanner would close the body at.
 *
 * tree-sitter-bash compares a line's first `delimiter.length` characters,
 * after any leading blanks, with the delimiter and stops there, so
 * `EOFX`, `EOF;` and ` EOF` all end a body that bash reads on through:
 * bash wants the whole line to be the delimiter, leading tabs aside under
 * `<<-`. Writing a letter over one character of that prefix keeps the
 * scanner in the body. A `$`, backtick or backslash is passed over, so an
 * expansion opening the line keeps its shape in the masked copy. Returns
 * the offset to mask on each such line, in source order.
 */
export function terminatorLookalikes(
  text: string,
  span: readonly [number, number],
  delimiter: string,
): number[] {
  const offsets: number[] = []
  let position = span[0]
  while (position < span[1]) {
    const newline = text.indexOf('\n', position)
    const lineEnd = newline < 0 || newline > span[1] ? span[1] : newline
    let start = position
    while (start < lineEnd && LINE_BLANKS.has(text[start] ?? '')) start += 1
    if (start + delimiter.length <= lineEnd && text.startsWith(delimiter, start)) {
      for (let offset = start; offset < start + delimiter.length; offset++) {
        if (!ESCAPE_PARTNERS.has(text[offset] ?? '')) {
          offsets.push(offset)
          break
        }
      }
    }
    position = lineEnd + 1
  }
  return offsets
}

/**
 * `text` with every heredoc body made lexable as bash reads it.
 *
 * tree-sitter-bash decides where a heredoc body starts from the character
 * that follows the operator line, and gets it wrong for two shapes bash
 * reads fine: leading whitespace is skipped, and a line opening with a
 * backslash is lexed as more words of the operator line, so the line is
 * lost from the body and, worse, lands in whatever construct was open
 * (`tr a-z A-Z \first`), or breaks the parse outright once it holds an
 * apostrophe or a `;`. Replacing that one character (and the one a
 * backslash escapes, so `\$v` cannot surface as an expansion) with a
 * plain letter makes the scanner start the body exactly where bash does,
 * without moving a single offset; the caller then reads the body back
 * out of the untouched source. An empty line before the first kept one
 * has no character to mask without moving a row, so those are left to
 * bodyPrefix. It also ends a body one line early, at any line that merely
 * opens with the delimiter (see terminatorLookalikes); one character of
 * each such line is masked the same way. Bodies are read innermost-first
 * per line, the order the parser's source keeps them in (see relayout).
 * Returns null when every body already lexes as bash reads it.
 */
export function protectedSource(text: string, root: Node): string | null {
  let out = text
  const operators = heredocOperators(root)
  const spans = heredocBodies(text, operators, true)
  operators.forEach((operator, position) => {
    const span = spans[position]
    if (span === null || span === undefined) return
    for (const offset of terminatorLookalikes(text, span, operator.delimiter)) {
      const filler = text[offset] === FILLER ? ALTERNATE_FILLER : FILLER
      out = out.slice(0, offset) + filler + out.slice(offset + 1)
    }
    const line = firstContentLine(text, span[0], span[1])
    if (line === null) return
    const first = text[line] ?? ''
    if (!LINE_BLANKS.has(first) && first !== '\\') return
    const filler = operator.delimiter.startsWith(FILLER) ? ALTERNATE_FILLER : FILLER
    let masked = 1
    if (first === '\\' && line + 1 < span[1] && ESCAPE_PARTNERS.has(text[line + 1] ?? '')) {
      masked = 2
    }
    out = out.slice(0, line) + filler.repeat(masked) + out.slice(line + masked)
  })
  return out === text ? null : out
}

/** Whether two trees agree on every node's type and span. */
export function sameShape(left: Node, right: Node): boolean {
  const stack: [Node, Node][] = [[left, right]]
  for (;;) {
    const pair = stack.pop()
    if (pair === undefined) return true
    const [a, b] = pair
    if (
      a.type !== b.type ||
      a.startIndex !== b.startIndex ||
      a.endIndex !== b.endIndex ||
      a.childCount !== b.childCount
    ) {
      return false
    }
    const bChildren = b.children
    a.children.forEach((child, i) => {
      const other = bChildren[i]
      if (other !== undefined) stack.push([child, other])
    })
  }
}
