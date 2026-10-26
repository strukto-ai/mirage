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

import type { ShellNode } from '../shell/types.ts'
import { moduleSync } from './stream.ts'

interface Exports {
  readonly memory: WebAssembly.Memory
  mirage_rs_args(len: number): number
  mirage_rs_shell_parse(len: number): number
  mirage_rs_shell_table(): number
  mirage_rs_shell_error_at(): number
  mirage_rs_shell_message(): number
  mirage_rs_shell_message_len(): number
  mirage_rs_shell_names(): number
  mirage_rs_shell_names_len(): number
}

/** The `u32`s one node takes in a parse's table: kind | field << 16 | flags << 24, then spans and links. */
const WORDS = 10

// Linear memory only grows, so an instance a large parse grew is dropped and
// the next parse gets a fresh one.
const RECYCLE_BYTES = 32 * 1024 * 1024

const encoder = new TextEncoder()
const decoder = new TextDecoder()
let exports: Exports | undefined
let kinds: readonly (readonly [string, boolean])[] = []
let fields: readonly string[] = []
let trees = 0

// Each call into the instance may grow its memory, which detaches the old
// buffer: a view is taken only after the calls that fill it.
function bytesAt(wasm: Exports, ptr: number, len: number): Uint8Array {
  return new Uint8Array(wasm.memory.buffer, ptr, len)
}

function instance(): Exports {
  if (exports === undefined) {
    const wasm = new WebAssembly.Instance(moduleSync(), {}).exports as unknown as Exports
    if (kinds.length === 0) {
      const ptr = wasm.mirage_rs_shell_names()
      const names = decoder.decode(bytesAt(wasm, ptr, wasm.mirage_rs_shell_names_len())).split('\0')
      const end = names.indexOf('')
      kinds = names.slice(0, end).map((name) => [name.slice(1), name.startsWith('1')] as const)
      fields = names.slice(end + 1, -1)
    }
    exports = wasm
  }
  return exports
}

/** A shell program as mirage's own parser reads it. Mirrors Python's ShellTree. */
export class ShellTree {
  /** Unique per tree, so node ids differ across trees. */
  readonly serial = trees++

  constructor(
    readonly source: string,
    readonly table: Uint32Array,
    /** The first syntax error: where, in UTF-16 units, and bash's words for it. */
    readonly error: { readonly index: number; readonly message: string } | null,
  ) {}

  get rootNode(): ShellTreeNode {
    return new ShellTreeNode(this, 0)
  }
}

/**
 * One node of a ShellTree: the kinds, fields and spans tree-sitter-bash
 * gives, offsets and columns in UTF-16 units as web-tree-sitter counts them.
 */
export class ShellTreeNode implements ShellNode {
  constructor(
    readonly tree: ShellTree,
    readonly index: number,
  ) {}

  private word(offset: number): number {
    return this.tree.table[this.index * WORDS + offset] ?? 0
  }

  private at(index: number): ShellTreeNode {
    return new ShellTreeNode(this.tree, index)
  }

  get id(): number {
    return this.tree.serial * 0x1000000 + this.index
  }

  get type(): string {
    return kinds[this.word(0) & 0xffff]?.[0] ?? 'ERROR'
  }

  get isNamed(): boolean {
    return ((this.word(0) >>> 24) & 1) !== 0
  }

  /** Always false: the parser refuses a line instead of inventing a missing token. */
  readonly isMissing = false

  get hasError(): boolean {
    return ((this.word(0) >>> 24) & 2) !== 0
  }

  get startIndex(): number {
    return this.word(1)
  }

  get endIndex(): number {
    return this.word(2)
  }

  get startPosition(): { row: number; column: number } {
    return { row: this.word(3), column: this.word(4) }
  }

  get endPosition(): { row: number; column: number } {
    return { row: this.word(5), column: this.word(6) }
  }

  get text(): string {
    return this.tree.source.slice(this.startIndex, this.endIndex)
  }

  get childCount(): number {
    return this.word(9)
  }

  get children(): ShellTreeNode[] {
    const first = this.word(8)
    return Array.from({ length: this.childCount }, (_, offset) => this.at(first + offset))
  }

  get namedChildren(): ShellTreeNode[] {
    return this.children.filter((child) => child.isNamed)
  }

  get parent(): ShellTreeNode | null {
    const parent = this.word(7)
    return parent === 0xffffffff ? null : this.at(parent)
  }

  private sibling(step: number): ShellTreeNode | null {
    const parent = this.parent
    if (parent === null) return null
    const index = this.index + step
    const first = parent.word(8)
    return index >= first && index < first + parent.childCount ? this.at(index) : null
  }

  get nextSibling(): ShellTreeNode | null {
    return this.sibling(1)
  }

  get previousSibling(): ShellTreeNode | null {
    return this.sibling(-1)
  }

  child(index: number): ShellTreeNode | null {
    return index >= 0 && index < this.childCount ? this.at(this.word(8) + index) : null
  }

  /** The field a child has in this node, as web-tree-sitter's `fieldNameForChild`. */
  fieldNameForChild(index: number): string | null {
    const child = this.child(index)
    const field = child === null ? 0 : (child.word(0) >>> 16) & 0xff
    return field === 0 ? null : (fields[field - 1] ?? null)
  }

  childForFieldName(name: string): ShellTreeNode | null {
    const field = fields.indexOf(name) + 1
    if (field === 0) return null
    return this.children.find((child) => ((child.word(0) >>> 16) & 0xff) === field) ?? null
  }
}

/**
 * Parse a shell program with mirage's own bash parser: tree-sitter-bash's
 * node kinds, fields and spans, bash's reading where that grammar misreads
 * bash. Mirrors Python's parse_shell.
 */
export function parseShell(source: string): ShellTree {
  const wasm = instance()
  const bytes = encoder.encode(source)
  const args = wasm.mirage_rs_args(bytes.byteLength)
  bytesAt(wasm, args, bytes.byteLength).set(bytes)
  const count = wasm.mirage_rs_shell_parse(bytes.byteLength)
  const ptr = wasm.mirage_rs_shell_table()
  const table = new Uint32Array(wasm.memory.buffer, ptr, count * WORDS).slice()
  const at = wasm.mirage_rs_shell_error_at()
  let error: ShellTree['error'] = null
  if (at >= 0) {
    const message = wasm.mirage_rs_shell_message()
    error = {
      index: at,
      message: decoder.decode(bytesAt(wasm, message, wasm.mirage_rs_shell_message_len())),
    }
  }
  if (wasm.memory.buffer.byteLength > RECYCLE_BYTES) exports = undefined
  return new ShellTree(source, table, error)
}
