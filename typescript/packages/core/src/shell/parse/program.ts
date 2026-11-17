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

import { ShellTreeNode } from '../../rs/shell.ts'
import type { ShellNode, TSNodeLike } from '../types.ts'

/** One parse of a line: its tree, where each of its chars sits in the line as
 * typed, and the references that keep it readable. Each node read has one
 * wrapper, kept until the final release. Mirrors Python's ParsedProgram. */
export class ParsedProgram {
  private parsedRoot: ProgramNode | undefined
  private nodes = new Map<number, ProgramNode>()
  references = 1
  readonly readRows = new Map<number, number>()
  readonly lineRows = new Map<number, number>()
  private released = false

  private sourceOffsets: Uint32Array | undefined

  constructor(
    private originalText: string,
    root: ShellTreeNode,
  ) {
    this.sourceOffsets = root.offsets
    this.parsedRoot = this.wrap(root)
  }

  get root(): ProgramNode {
    if (this.parsedRoot === undefined) throw new Error('parsed program is released')
    return this.parsedRoot
  }

  /** The one wrapper of a node of this program, built on its first read.
   * Mirrors Python's wrap. */
  wrap(node: ShellNode): ProgramNode {
    this.check()
    let wrapped = this.nodes.get(node.id)
    if (wrapped === undefined) {
      wrapped = new ProgramNode(node, this)
      this.nodes.set(node.id, wrapped)
    }
    return wrapped
  }

  get original(): string {
    return this.originalText
  }

  get offsets(): Uint32Array | undefined {
    return this.sourceOffsets
  }

  check(): void {
    if (this.references === 0) throw new Error('parsed program is released')
  }

  retain(): () => void {
    this.check()
    this.references += 1
    let released = false
    return () => {
      if (released) return
      released = true
      this.drop()
    }
  }

  release(): void {
    if (this.released) return
    this.released = true
    this.drop()
  }

  private drop(): void {
    this.references -= 1
    if (this.references === 0) {
      const borrowed = this.parsedRoot?.borrowed
      if (borrowed instanceof ShellTreeNode) borrowed.tree.dispose()
      for (const node of this.nodes.values()) node.forget()
      this.nodes = new Map()
      this.parsedRoot = undefined
      this.sourceOffsets = undefined
      this.originalText = ''
      this.newlines = null
      this.readRows.clear()
      this.lineRows.clear()
    }
  }

  private newlines: number[] | null = null

  /** The row a char of the line as typed is on: the newlines before it,
   * found once per parse. Mirrors Python's row. */
  row(at: number): number {
    this.check()
    if (this.newlines === null) {
      const found: number[] = []
      for (let i = this.original.indexOf('\n'); i !== -1; i = this.original.indexOf('\n', i + 1))
        found.push(i)
      this.newlines = found
    }
    let low = 0
    let high = this.newlines.length
    while (low < high) {
      const middle = (low + high) >> 1
      if ((this.newlines[middle] ?? 0) < at) low = middle + 1
      else high = middle
    }
    return low
  }
}

/** A node of a parsed program; every read checks the program is still held.
 * Its program builds it once (`ParsedProgram.wrap`), and the wrappers of its
 * parent and children are read once and kept, as in Python. */
export class ProgramNode implements ShellNode {
  private up: ProgramNode | null | undefined
  private all: ProgramNode[] | undefined
  private named: ProgramNode[] | undefined
  constructor(
    readonly borrowed: ShellNode,
    readonly program: ParsedProgram,
  ) {}
  private get node(): ShellNode {
    this.program.check()
    return this.borrowed
  }
  /** Drop the wrappers it keeps, as its program's final release does. */
  forget(): void {
    this.up = undefined
    this.all = undefined
    this.named = undefined
  }
  get heredoc() {
    return this.node.heredoc
  }
  warnings(head: string, first: number): string {
    return this.node.warnings?.(head, first) ?? ''
  }
  get offsets() {
    this.program.check()
    return this.program.offsets
  }
  get error() {
    return this.node.error ?? null
  }
  refusal(head: string, first: number, utf8: boolean): string {
    return this.node.refusal?.(head, first, utf8) ?? ''
  }
  get sourceText() {
    return this.node.sourceText ?? this.node.text
  }
  get inlined() {
    return this.node.inlined
  }
  rereadLines(): ReadonlyMap<number, readonly [number, number]> {
    return this.node.rereadLines?.() ?? new Map()
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
  child(index: number): ProgramNode | null {
    return this.wrap(this.node.child(index))
  }
  get children(): ProgramNode[] {
    const node = this.node
    this.all ??= node.children.map((child) => this.program.wrap(child))
    return [...this.all]
  }
  get namedChildren(): ProgramNode[] {
    const node = this.node
    this.named ??= node.namedChildren.map((child) => this.program.wrap(child))
    return [...this.named]
  }
  private wrap(node: ShellNode | null): ProgramNode | null {
    return node === null ? null : this.program.wrap(node)
  }
  get parent(): ProgramNode | null {
    const node = this.node
    if (this.up === undefined) this.up = this.wrap(node.parent)
    return this.up
  }
  get previousSibling(): ProgramNode | null {
    return this.wrap(this.node.previousSibling)
  }
  get nextSibling(): ProgramNode | null {
    return this.wrap(this.node.nextSibling)
  }
  childForFieldName(name: string): ProgramNode | null {
    return this.wrap(this.node.childForFieldName(name))
  }
}

/** The parser's own node a node reads, null for a synthetic one. Mirrors
 * Python's shell_node. */
export function shellNode(node: TSNodeLike): ShellTreeNode | null {
  if (node instanceof ProgramNode) {
    node.program.check()
    return shellNode(node.borrowed)
  }
  return node instanceof ShellTreeNode ? node : null
}

/** Retain each defining program once, including synthetic redirect wrappers. */
export function retainPrograms(nodes: readonly TSNodeLike[]): () => void {
  const programs = new Set<ParsedProgram>()
  const pending = [...nodes]
  while (pending.length > 0) {
    const node = pending.pop()
    if (node === undefined) break
    if (node instanceof ProgramNode) programs.add(node.program)
    else if (Array.isArray(node.children)) for (const child of node.children) pending.push(child)
  }
  const leases = [...programs].map((program) => program.retain())
  return () => {
    for (const release of leases) release()
  }
}
