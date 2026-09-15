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
import type { ShellNode } from '../../types.ts'
import type { Heredoc, HeredocSource } from './types.ts'

export class HeredocNode implements ShellNode {
  constructor(
    private readonly node: Node,
    private readonly source: HeredocSource,
  ) {}
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
  private wrap(node: Node | null): HeredocNode | null {
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
  get sourceText(): string {
    if (this.node.parent === null) return this.source.original
    if (!this.source.documents.some(([start]) => this.startIndex <= start && start < this.endIndex))
      return this.node.text
    const positions = this.source.offsets.slice(this.startIndex, this.endIndex)
    if (positions.length === 0) return ''
    let start = this.source.original.length
    let end = 0
    for (const offset of positions) {
      start = Math.min(start, offset)
      end = Math.max(end, offset + 1)
    }
    return this.source.original.slice(start, end)
  }
  get warnings(): string {
    return this.source.documents
      .filter(([, doc]) => !doc.terminated)
      .map(
        ([, doc]) =>
          `mirage: line ${String(doc.eofLine)}: warning: here-document at line ${String(doc.line)} delimited by end-of-file (wanted \`${doc.delimiter}')\n`,
      )
      .join('')
  }
}
