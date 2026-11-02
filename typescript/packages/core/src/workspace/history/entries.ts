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

import { sameLine } from '../../shell/helpers.ts'
import { NodeType as NT, type TSNodeLike } from '../../shell/types.ts'
import { OPENERS, WORDS } from './constants.ts'
import type { HistoryEntry } from './types.ts'

function descendants(node: TSNodeLike): TSNodeLike[] {
  return [node, ...node.children.flatMap(descendants)]
}

/**
 * The entries bash's history adds for an input it reads interactively:
 * one per command it reads, a command and what else is on the line it
 * ends on. A command spanning lines is one entry, its lines joined as
 * `cmdhist` joins them: a break inside a quoted word, a substitution or
 * a heredoc stays, a backslash's goes, and any other is a `; ` or, after
 * a token a command reads on after (`then`, `|`, `{`, a case pattern's
 * `)`), a space. A comment line inside a command is dropped, a line of
 * blanks is an entry of its own and an empty line none. Pinned against
 * Debian Bash 5.2.37 with `set +H`. Mirrors Python's history_entries.
 *
 * @param root the parsed input.
 */
export function historyEntries(root: TSNodeLike): HistoryEntry[] {
  const source = root.sourceText ?? root.text
  const base = root.startIndex ?? 0
  const typed = (index: number): number => root.offsets?.[index] ?? index
  const breaks = new Map<number, number>()
  for (let i = 0; i < root.text.length; i++)
    if (root.text[i] === '\n') breaks.set(typed(base + i), base + i)
  const groups: TSNodeLike[][] = []
  for (const child of root.children) {
    if (child.isNamed !== true) continue
    const group = groups[groups.length - 1]
    const last = group?.[group.length - 1]
    if (group !== undefined && last !== undefined && sameLine(root, last, child)) group.push(child)
    else groups.push([child])
  }
  const entries: HistoryEntry[] = []
  let read = 0
  for (const group of groups) {
    const first = group[0]
    if (first === undefined) continue
    const nodes = group.flatMap(descendants)
    const folded = nodes.filter((node) => node.heredoc !== undefined)
    const inside = (node: TSNodeLike): boolean =>
      folded.some(
        (doc) =>
          (doc.startIndex ?? 0) <= (node.startIndex ?? 0) &&
          (node.endIndex ?? 0) <= (doc.endIndex ?? 0),
      )
    const start = source.lastIndexOf('\n', typed(first.startIndex ?? 0) - 1) + 1
    const end = Math.max(
      ...nodes
        .filter((node) => node.children.length === 0 && !inside(node))
        .map((node) => typed((node.endIndex ?? 0) - 1) + 1),
      ...folded.map((doc) => doc.heredoc?.end ?? 0),
    )
    const found = source.indexOf('\n', end - 1)
    const stop = found < 0 ? source.length : found
    for (const row of source.slice(read, start).split('\n'))
      if (row !== '' && row.trim() === '') entries.push({ text: row, at: null })
    read = stop + 1
    if (nodes.some((node) => node.type === NT.ERROR)) {
      entries.push({ text: source.slice(start, stop), at: first.startIndex ?? 0 })
      continue
    }
    const comments = new Set(
      nodes.filter((node) => node.type === NT.COMMENT).map((node) => typed(node.startIndex ?? 0)),
    )
    const within = (index: number): boolean =>
      nodes.some(
        (node) =>
          WORDS.has(node.type) && (node.startIndex ?? 0) < index && index < (node.endIndex ?? 0),
      )
    const joint = (at: number): string => {
      const docs = folded.filter(
        (doc) => doc.heredoc !== undefined && doc.heredoc.wordEnd <= at && at < doc.heredoc.end,
      )
      if (docs.length > 0) {
        if (!docs.every((doc) => at === (doc.heredoc?.end ?? 0) - 1)) return '\n'
        return docs.some((doc) => within(doc.startIndex ?? 0)) ? '\n\n' : '\n '
      }
      const index = breaks.get(at)
      if (index === undefined) {
        let before = base
        for (let i = base; i < base + root.text.length; i++) if (typed(i) < at - 1) before = i
        return within(before) || source[at - 1] !== '\\' ? '\n' : ''
      }
      if (within(index)) return '\n'
      if (
        nodes.some(
          (node) =>
            node.type === NT.ARRAY &&
            (node.startIndex ?? 0) < index &&
            index < (node.endIndex ?? 0),
        )
      )
        return ' '
      let leaf: TSNodeLike | undefined
      for (const node of nodes)
        if (
          node.children.length === 0 &&
          (node.endIndex ?? 0) <= index &&
          (leaf === undefined || (node.endIndex ?? 0) >= (leaf.endIndex ?? 0))
        )
          leaf = node
      if (leaf === undefined) return '; '
      if (leaf.type === NT.COMMENT) return '\n'
      if (leaf.isNamed !== true && OPENERS.has(leaf.type)) return ' '
      const pattern = leaf.parent?.type
      if (leaf.type === ')' && (pattern === NT.CASE_ITEM || pattern === NT.FUNCTION_DEFINITION))
        return ' '
      return '; '
    }
    let text = ''
    let blank = false
    let comment = false
    for (let at = start; ;) {
      const next = source.indexOf('\n', at)
      const ends = next < 0 || next > stop ? stop : next
      const row = source.slice(at, ends)
      if (at === start) text = row
      else {
        const between = joint(at - 1)
        const word = between.startsWith('\n')
        if (!word && comments.has(at + row.length - row.trimStart().length)) comment = true
        else {
          const joined = comment ? '\n' : blank && !word ? ' ' : between
          text = (between === '' ? text.slice(0, -1) : text) + joined + row
          blank = !word && row.trim() === ''
          comment = false
        }
      }
      if (ends >= stop) break
      at = ends + 1
    }
    if (folded.some((doc) => (doc.heredoc?.end ?? 0) - 1 === stop)) text += '\n'
    entries.push({ text, at: first.startIndex ?? 0 })
  }
  return entries
}
