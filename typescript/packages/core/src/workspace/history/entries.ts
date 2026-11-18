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
  const nodes: TSNodeLike[] = []
  const pending = [node]
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    nodes.push(current)
    const children = current.children
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i]
      if (child !== undefined) pending.push(child)
    }
  }
  return nodes
}

class Spans {
  static upperBound(values: readonly number[], value: number, end = values.length): number {
    let start = 0
    while (start < end) {
      const middle = Math.floor((start + end) / 2)
      if ((values[middle] ?? Infinity) <= value) start = middle + 1
      else end = middle
    }
    return start
  }

  private readonly starts: number[] = []
  private readonly ends: number[] = []

  constructor(spans: [number, number][]) {
    spans.sort((a, b) => a[0] - b[0])
    let end = -1
    for (const [start, stop] of spans) {
      end = Math.max(end, stop)
      this.starts.push(start)
      this.ends.push(end)
    }
  }

  endAt(index: number): number {
    return this.ends[Spans.upperBound(this.starts, index) - 1] ?? -1
  }

  contains(index: number): boolean {
    return index < this.endAt(index)
  }
}

/** The rows of blanks among `rows`, each an entry no command starts. */
function blanks(rows: string): HistoryEntry[] {
  return rows
    .split('\n')
    .filter((row) => row !== '' && row.trim() === '')
    .map((text) => ({ text, at: null }))
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
  const textRead = root.text
  const source = root.sourceText ?? textRead
  const base = root.startIndex ?? 0
  const typed = (index: number): number => root.offsets?.[index] ?? index
  const breaks = new Map<number, number>()
  for (let i = 0; i < textRead.length; i++)
    if (textRead[i] === '\n') breaks.set(typed(base + i), base + i)
  let removed: Map<number, number> | undefined
  const before = (at: number): number => {
    if (removed === undefined) {
      const missing: number[] = []
      for (
        let newline = source.indexOf('\n');
        newline >= 0;
        newline = source.indexOf('\n', newline + 1)
      )
        if (!breaks.has(newline)) missing.push(newline)
      removed = new Map(missing.map((newline) => [newline, base]))
      let pending = missing.length
      // Reverse logical order preserves the last match even in a moved heredoc.
      for (let i = base + textRead.length - 1; i >= base && pending > 0; i--) {
        const original = typed(i) + 1
        if (original < (missing[pending - 1] ?? -1)) {
          const first = Spans.upperBound(missing, original, pending)
          for (let j = first; j < pending; j++) {
            const newline = missing[j]
            if (newline !== undefined) removed.set(newline, i)
          }
          pending = first
        }
      }
    }
    return removed.get(at) ?? base
  }
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
    const docSpans = new Spans(folded.map((doc) => [doc.startIndex ?? 0, doc.endIndex ?? 0]))
    const leaves = nodes.filter((node) => node.children.length === 0)
    const start = source.lastIndexOf('\n', typed(first.startIndex ?? 0) - 1) + 1
    const end = Math.max(
      ...leaves
        .filter((node) => docSpans.endAt(node.startIndex ?? 0) < (node.endIndex ?? 0))
        .map((node) => typed((node.endIndex ?? 0) - 1) + 1),
      ...folded.map((doc) => doc.heredoc?.end ?? 0),
    )
    const found = source.indexOf('\n', end - 1)
    const stop = found < 0 ? source.length : found
    entries.push(...blanks(source.slice(read, start)))
    read = stop + 1
    if (nodes.some((node) => node.type === NT.ERROR)) {
      entries.push({ text: source.slice(start, stop), at: typed(first.startIndex ?? 0) })
      continue
    }
    const newline = source.indexOf('\n', start)
    if (newline < 0 || newline >= stop) {
      const suffix = folded.some((doc) => (doc.heredoc?.end ?? 0) - 1 === stop) ? '\n' : ''
      entries.push({ text: source.slice(start, stop) + suffix, at: typed(first.startIndex ?? 0) })
      continue
    }
    const comments = new Set(
      nodes.filter((node) => node.type === NT.COMMENT).map((node) => typed(node.startIndex ?? 0)),
    )
    const words = new Spans(
      nodes
        .filter((node) => WORDS.has(node.type))
        .map((node) => [(node.startIndex ?? 0) + 1, node.endIndex ?? 0]),
    )
    const arrays = new Spans(
      nodes
        .filter((node) => node.type === NT.ARRAY)
        .map((node) => [(node.startIndex ?? 0) + 1, node.endIndex ?? 0]),
    )
    const docs = new Spans(
      folded.flatMap((node) =>
        node.heredoc === undefined ? [] : [[node.heredoc.wordEnd, node.heredoc.end]],
      ),
    )
    const nestedDocs = new Spans(
      folded.flatMap((node) =>
        node.heredoc === undefined || !words.contains(node.startIndex ?? 0)
          ? []
          : [[node.heredoc.wordEnd, node.heredoc.end]],
      ),
    )
    leaves.sort((a, b) => (a.endIndex ?? 0) - (b.endIndex ?? 0))
    const leafEnds = leaves.map((node) => node.endIndex ?? 0)
    const joint = (at: number): string => {
      const docEnd = docs.endAt(at)
      if (at < docEnd) {
        if (at !== docEnd - 1) return '\n'
        return nestedDocs.contains(at) ? '\n\n' : '\n '
      }
      const index = breaks.get(at)
      if (index === undefined) {
        return words.contains(before(at)) || source[at - 1] !== '\\' ? '\n' : ''
      }
      if (words.contains(index)) return '\n'
      if (arrays.contains(index)) return ' '
      const leaf = leaves[Spans.upperBound(leafEnds, index) - 1]
      if (leaf === undefined) return '; '
      if (leaf.type === NT.COMMENT) return '\n'
      if (leaf.isNamed !== true && OPENERS.has(leaf.type)) return ' '
      const pattern = leaf.parent?.type
      if (leaf.type === ')' && (pattern === NT.CASE_ITEM || pattern === NT.FUNCTION_DEFINITION))
        return ' '
      return '; '
    }
    const chunks: string[] = []
    let blank = false
    let comment = false
    for (let at = start; ;) {
      const next = source.indexOf('\n', at)
      const ends = next < 0 || next > stop ? stop : next
      const row = source.slice(at, ends)
      if (at === start) chunks.push(row)
      else {
        const between = joint(at - 1)
        const word = between.startsWith('\n')
        if (!word && comments.has(at + row.length - row.trimStart().length)) comment = true
        else {
          const joined = comment ? '\n' : blank && !word ? ' ' : between
          if (between === '') {
            while (chunks.at(-1) === '') chunks.pop()
            const last = chunks.pop()
            if (last !== undefined) chunks.push(last.slice(0, -1))
          }
          chunks.push(joined, row)
          blank = !word && row.trim() === ''
          comment = false
        }
      }
      if (ends >= stop) break
      at = ends + 1
    }
    if (folded.some((doc) => (doc.heredoc?.end ?? 0) - 1 === stop)) chunks.push('\n')
    entries.push({ text: chunks.join(''), at: typed(first.startIndex ?? 0) })
  }
  entries.push(...blanks(source.slice(read)))
  return entries
}
