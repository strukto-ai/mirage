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

import type { TSNodeLike } from '../../types.ts'
import { heredocBodies } from './body.ts'
import { HEREDOC_BODY, HEREDOC_START, SKIPPED_BLANKS } from './constants.ts'
import { heredocOperators } from './shield.ts'

/** The root of the tree `node` belongs to. */
export function treeRoot(node: TSNodeLike): TSNodeLike {
  let root = node
  while (root.parent !== null && root.parent !== undefined) root = root.parent
  return root
}

/**
 * The opening characters of a body that tree-sitter left out of its node.
 *
 * The scanner starts heredoc_body at the first character it keeps,
 * dropping every empty line before it and, when the shield could not
 * run, the first kept line's indentation; bash keeps all of that. Where
 * bash starts the body is what heredocBodies says over the whole tree, so
 * a later heredoc on the same operator line is measured from the line
 * after the earlier body's terminator rather than from the newline the
 * two operators share, innermost-first, which is the order the parser's
 * source keeps a line's bodies in (see relayout). What lies between that start and the body node is
 * exactly the dropped run when it is blank, and is body text nowhere
 * else, so a gap holding anything but blanks and newlines yields nothing.
 * The tree's text begins at its root, which sits past any blanks before
 * the first token, so offsets are taken from there. Returns the empty
 * string when the node starts where bash starts the body.
 */
export function bodyPrefix(redirectNode: TSNodeLike): string {
  let start: TSNodeLike | null = null
  let body: TSNodeLike | null = null
  for (const child of redirectNode.children) {
    if (child.type === HEREDOC_START) start = child
    else if (child.type === HEREDOC_BODY) body = child
  }
  if (start === null || body === null) return ''
  if (start.startIndex === undefined || body.startIndex === undefined) return ''
  const root = treeRoot(redirectNode)
  const origin = root.startIndex
  if (origin === undefined) return ''
  const text = root.text
  const operators = heredocOperators(root).map((operator) => ({
    ...operator,
    wordStart: operator.wordStart - origin,
    wordEnd: operator.wordEnd - origin,
  }))
  const wordStart = start.startIndex - origin
  const index = operators.findIndex((operator) => operator.wordStart === wordStart)
  const span = index < 0 ? null : heredocBodies(text, operators, true)[index]
  if (span === null || span === undefined) return ''
  const gap = text.slice(span[0], body.startIndex - origin)
  if (gap === '') return ''
  for (const char of gap) {
    if (!SKIPPED_BLANKS.has(char)) return ''
  }
  return gap
}
