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

import { parseShell } from '../../rs/shell.ts'
import { VERBATIM_TYPES } from './constants.ts'
import { dropChars, dropSourceChars, rebaseSource } from './heredoc/lower.ts'
import { HeredocNode } from './heredoc/node.ts'
import { ProgramNode } from './program.ts'
import type { ShellNode, TSNodeLike } from '../types.ts'

function verbatimSpans(root: ShellNode): [number, number][] {
  const spans: [number, number][] = []
  const stack: ShellNode[] = [root]
  for (;;) {
    const node = stack.pop()
    if (node === undefined) break
    if (VERBATIM_TYPES.has(node.type)) {
      spans.push([node.startIndex, node.endIndex])
      continue
    }
    for (const child of node.children) stack.push(child)
  }
  return spans.sort((a, b) => a[0] - b[0])
}

/**
 * Offsets of the characters bash's reader deletes as line continuations.
 *
 * The reader removes `\<newline>` before a token is read, so the halves it
 * joins are one word (`a\<newline>b` is `ab`, `$\<newline>{x}` an
 * expansion); tree-sitter reads the pair as whitespace instead.
 * Single-quoted and ANSI-C text and a comment keep theirs, and an escaped
 * backslash continues nothing: only an odd-length run of backslashes
 * before the newline ends in a live one. A live backslash ending the
 * input continues onto nothing and goes too: `echo a\` runs `echo a`. A
 * heredoc body is lowered into a quoted word before this runs, where
 * every backslash it holds is escaped, so no body loses a character here.
 */
export function continuationIndices(
  text: string,
  aliases: ReadonlySet<string> = new Set(),
): number[] {
  if (!text.includes('\\\n') && !text.endsWith('\\')) return []
  const spans = verbatimSpans(parseShell(text, aliases).rootNode)
  const dropped: number[] = []
  let at = 0
  let index = text.indexOf('\\')
  while (index >= 0) {
    let end = index
    while (end < text.length && text[end] === '\\') end += 1
    while (at < spans.length && (spans[at]?.[1] ?? 0) <= end - 1) at += 1
    const verbatim = at < spans.length && (spans[at]?.[0] ?? 0) <= end - 1
    if ((end - index) % 2 === 1 && !verbatim && (end === text.length || text[end] === '\n')) {
      dropped.push(end - 1)
      if (end < text.length) dropped.push(end)
    }
    index = text.indexOf('\\', end)
  }
  return dropped
}

/**
 * Where each char of the source `parse` read sits in `command`. `parse`
 * deletes line continuations and lowers heredocs, so a node's offsets index
 * the source it read rather than the line as typed; indexed by one of them,
 * this gives the char of `command` it came from, and an inserted char gives
 * the char after it. Mirrors Python's source_offsets.
 */
export function sourceOffsets(
  command: string,
  root: TSNodeLike,
  aliases: ReadonlySet<string> = new Set(),
): readonly number[] {
  if (root instanceof ProgramNode && root.program.original === command) return root.program.offsets
  if (root instanceof HeredocNode) return root.offsets
  const source = dropSourceChars(
    {
      original: command,
      source: command,
      offsets: Array.from({ length: command.length + 1 }, (_, i) => i),
      documents: [],
      closes: [],
    },
    continuationIndices(command, aliases),
  )
  return rebaseSource(source, source.source.slice(0, root.startIndex ?? 0) + root.text).offsets
}

/** The line as bash's reader hands it on, continuations removed. */
export function joinContinuations(
  command: string,
  aliases: ReadonlySet<string> = new Set(),
): string {
  return dropChars(command, continuationIndices(command, aliases))
}
