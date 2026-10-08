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

import type { WrappedNode } from '../engine.ts'
import type { ShellNode } from '../../types.ts'
import type { Heredoc, HeredocSource } from './types.ts'

export class HeredocNode implements WrappedNode {
  constructor(
    private readonly node: ShellNode,
    private readonly source: HeredocSource,
  ) {}
  get inner(): ShellNode {
    return this.node
  }
  get childCount(): number {
    return this.node.childCount
  }
  child(index: number): HeredocNode | null {
    return this.wrap(this.node.child(index))
  }
  get type(): string {
    return this.node.type
  }
  get text(): string {
    return this.node.text
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
    return this.node.startPosition
  }
  get endPosition() {
    return this.node.endPosition
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
  get children(): HeredocNode[] {
    return this.node.children.map((node) => new HeredocNode(node, this.source))
  }
  get namedChildren(): HeredocNode[] {
    return this.node.namedChildren.map((node) => new HeredocNode(node, this.source))
  }
  private wrap(node: ShellNode | null): HeredocNode | null {
    return node === null ? null : new HeredocNode(node, this.source)
  }
  get parent(): HeredocNode | null {
    return this.wrap(this.node.parent)
  }
  get previousSibling(): HeredocNode | null {
    return this.wrap(this.node.previousSibling)
  }
  get nextSibling(): HeredocNode | null {
    return this.wrap(this.node.nextSibling)
  }
  childForFieldName(name: string): HeredocNode | null {
    return this.wrap(this.node.childForFieldName(name))
  }
  get heredoc(): Heredoc | undefined {
    if (this.type !== 'file_redirect') return undefined
    return this.source.documents.find(([start]) =>
      this.node.children.some((child) => child.type === '<' && child.startIndex === start),
    )?.[1]
  }
  get offsets(): readonly number[] {
    return this.source.offsets
  }
  /** The node's own text in the line as typed: its heredoc bodies included
   * where they sit inside it, not those it carries out. */
  get sourceText(): string {
    if (this.node.parent === null) return this.source.original
    if (!this.source.documents.some(([start]) => this.startIndex <= start && start < this.endIndex))
      return this.node.text
    if (this.endIndex <= this.startIndex) return ''
    const first = this.source.offsets[this.startIndex] ?? 0
    const last = this.source.offsets[this.endIndex - 1] ?? first
    return this.source.original.slice(first, last + 1)
  }
  /** The node's own text with each heredoc body the line reads after a
   * substitution in it moved inside that substitution, just before its `)`,
   * and out of the node's text where it sat there: the same command to bash,
   * and what a substitution's line runs as, carrying no heredoc out of itself.
   * A body the input ended inside gets its terminator on a line of its own.
   * `undefined` when no substitution in the node carries one out. */
  get inlined(): string | undefined {
    if (this.node.parent === null || this.endIndex <= this.startIndex) return undefined
    const first = this.source.offsets[this.startIndex] ?? 0
    const last = this.source.offsets[this.endIndex - 1] ?? first
    const closes = this.source.closes.filter(([close]) => first <= close && close <= last)
    if (closes.length === 0) return undefined
    const docs = new Map(this.source.documents.map(([, doc]) => [doc.operatorStart, doc]))
    const edits: [number, number, string][] = []
    for (const [close, opened] of closes) {
      let bodies = '\n'
      for (const at of opened) {
        const doc = docs.get(at)
        if (doc === undefined) continue
        const body = this.source.original.slice(doc.bodyStart, doc.end)
        bodies += body
        if (!bodies.endsWith('\n')) bodies += '\n'
        if (!doc.terminated) {
          const line = body.endsWith('\n') ? body.slice(0, -1) : body
          const trailing = line.length - line.replace(/\\+$/, '').length
          if (!doc.quoted && trailing % 2 === 1) bodies += '\n'
          bodies += `${doc.delimiter}\n`
        }
        if (first <= doc.bodyStart && doc.end <= last + 1)
          edits.push([doc.bodyStart - first, doc.end - first, ''])
      }
      edits.push([close - first, close - first, bodies])
    }
    let out = this.sourceText
    for (const [start, end, replacement] of edits.sort((a, b) => b[0] - a[0] || b[1] - a[1]))
      out = out.slice(0, start) + replacement + out.slice(end)
    return out
  }
  /** What bash warns of while it reads the line's heredocs, in the order it
   * reads them: a substitution closing with bodies still to read, on the line
   * its reader stands on then, and a body the input ends inside. */
  get warnings(): string {
    const original = this.source.original
    const lineOf = (offset: number) => original.slice(0, offset).split('\n').length
    const closes = new Map(this.source.closes.map((close) => [close[1][0], close]))
    let out = ''
    let previous: Heredoc | null = null
    for (const doc of this.source.documents
      .map(([, doc]) => doc)
      .sort((a, b) => a.bodyStart - b.bodyStart)) {
      const close = closes.get(doc.operatorStart)
      if (close !== undefined) {
        let line = lineOf(close[0])
        if (previous !== null) line = Math.max(line, lineOf(previous.end - 1))
        const count = close[1].length
        out += `mirage: line ${String(line)}: warning: command substitution: ${String(count)} unterminated here-document${count > 1 ? 's' : ''}\n`
      }
      if (!doc.terminated)
        out += `mirage: line ${String(doc.eofLine)}: warning: here-document at line ${String(doc.line)} delimited by end-of-file (wanted \`${doc.delimiter}')\n`
      previous = doc
    }
    return out
  }
}
