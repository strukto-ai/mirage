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
import { ParseTrees, type NativeParser, type WrappedNode } from './engine.ts'
import { VERBATIM_TYPES } from './constants.ts'
import { dropChars, dropSourceChars, rebaseSource } from './heredoc/lower.ts'
import { HeredocNode } from './heredoc/node.ts'
import { PrefixNode } from './timing.ts'
import type { ShellNode, TSNodeLike } from '../types.ts'

/**
 * A node of a shielded parse that reads the original text.
 *
 * Every shield keeps the source's width, so a span names the same text in
 * both. Text and row/column positions use the original source: pattern
 * shielding can hide a newline inside a word. Reparsing against the
 * shielded tree did the same until tree-sitter relexed a statement on its
 * own, which it does at a line's end. Mirrors Python's SourceNode.
 */
export class SourceNode implements WrappedNode {
  constructor(
    protected readonly node: ShellNode,
    protected readonly original: string,
    private readonly lines: readonly number[] = [
      0,
      ...Array.from(original.matchAll(/\n/g), (match) => match.index + 1),
    ],
  ) {}
  get inner(): ShellNode {
    return this.node
  }
  get type(): string {
    if (this.node.type === '$(' && (this.text === '<(' || this.text === '>(')) return this.text
    if (this.node.type === 'command_substitution' && /^(?:<|>)\(/.test(this.text))
      return 'process_substitution'
    return this.node.type
  }
  get text(): string {
    return this.original.slice(this.node.startIndex, this.node.endIndex)
  }
  get id(): number {
    return this.node.id
  }
  get startIndex(): number {
    return this.node.startIndex
  }
  get endIndex(): number {
    return this.node.endIndex
  }
  get startPosition() {
    return this.point(this.node.startIndex)
  }
  get endPosition() {
    return this.point(this.node.endIndex)
  }
  private point(at: number): { row: number; column: number } {
    let lo = 0
    let hi = this.lines.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if ((this.lines[mid] ?? 0) <= at) lo = mid + 1
      else hi = mid
    }
    const row = lo - 1
    return { row, column: at - (this.lines[row] ?? 0) }
  }
  get isNamed(): boolean {
    return this.node.isNamed
  }
  get isMissing(): boolean {
    return this.node.isMissing
  }
  get hasError(): boolean {
    return this.node.hasError
  }
  get childCount(): number {
    return this.node.childCount
  }
  child(index: number): SourceNode | null {
    return this.wrap(this.node.child(index))
  }
  get children(): SourceNode[] {
    return this.node.children.map((node) => this.wrap(node)).filter((node) => node !== null)
  }
  get namedChildren(): SourceNode[] {
    return this.node.namedChildren.map((node) => this.wrap(node)).filter((node) => node !== null)
  }
  protected wrap(node: ShellNode | null): SourceNode | null {
    return node === null ? null : new SourceNode(node, this.original, this.lines)
  }
  get parent(): SourceNode | null {
    return this.wrap(this.node.parent)
  }
  get previousSibling(): SourceNode | null {
    return this.wrap(this.node.previousSibling)
  }
  get nextSibling(): SourceNode | null {
    return this.wrap(this.node.nextSibling)
  }
  childForFieldName(name: string): SourceNode | null {
    return this.wrap(this.node.childForFieldName(name))
  }
}

/**
 * Spans whose backslashes escape nothing: comments and strings in single
 * quotes, ANSI-C ones included.
 */
function verbatimSpans(root: Node): [number, number][] {
  const spans: [number, number][] = []
  const stack: Node[] = [root]
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
export function continuationIndices(parser: NativeParser, text: string): number[] {
  if (!text.includes('\\\n') && !text.endsWith('\\')) return []
  if (!(parser instanceof ParseTrees)) {
    const trees = new ParseTrees(parser)
    try {
      return continuationIndices(trees, text)
    } finally {
      trees.release()
    }
  }
  const tree = parser.parse(text)
  if (tree === null) throw new Error('shell parse returned null')
  const spans = verbatimSpans(tree.rootNode)
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
 * deletes line continuations and inserts text to repair the grammar, so a
 * node's offsets index the source it read rather than the line as typed;
 * indexed by one of them, this gives the char of `command` it came from, and
 * an inserted char gives the char after it. Mirrors Python's source_offsets.
 */
export function sourceOffsets(
  parser: NativeParser,
  command: string,
  root: TSNodeLike,
): readonly number[] {
  if (root instanceof HeredocNode || root instanceof PrefixNode) return root.offsets
  const source = dropSourceChars(
    {
      original: command,
      source: command,
      offsets: Array.from({ length: command.length + 1 }, (_, i) => i),
      documents: [],
      closes: [],
    },
    continuationIndices(parser, command),
  )
  return rebaseSource(source, source.source.slice(0, root.startIndex ?? 0) + root.text).offsets
}

/** The line as bash's reader hands it on, continuations removed. */
export function joinContinuations(parser: NativeParser, command: string): string {
  return dropChars(command, continuationIndices(parser, command))
}
