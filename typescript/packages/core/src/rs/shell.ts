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

import type { Heredoc, ShellNode } from '../shell/types.ts'
import { decodeText, encodeText } from '../shell/bytes.ts'
import { moduleSync } from './stream.ts'

interface Exports {
  readonly memory: WebAssembly.Memory
  mirage_rs_args(len: number): number
  mirage_rs_shell_parse(len: number, aliasesLen: number, extglob: number): number
  mirage_rs_shell_table(): number
  mirage_rs_shell_error_at(): number
  mirage_rs_shell_status(): number
  mirage_rs_shell_message(): number
  mirage_rs_shell_message_len(): number
  mirage_rs_shell_names(): number
  mirage_rs_shell_names_len(): number
  mirage_rs_shell_extras(): number
  mirage_rs_shell_extras_len(): number
  mirage_rs_shell_text(): number
  mirage_rs_shell_text_len(): number
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

/** What a parse says of the line beyond its nodes. */
interface Extras {
  /** What the nodes read: the line with its heredoc bodies folded in and its line continuations dropped. */
  readonly source: string
  /** Where each UTF-16 unit of `source` came from in the line as typed, then its end. */
  readonly offsets: Uint32Array
  readonly heredocs: readonly Heredoc[]
  /** Per node index, its text with the heredoc bodies the line reads after a substitution in it moved inside it. */
  readonly inlined: ReadonlyMap<number, string>
  /** What bash warns of while it reads the line's heredocs. */
  readonly warnings: string
}

/** A shell program as mirage's own parser reads it. Mirrors Python's ShellTree. */
export class ShellTree {
  /** Unique per tree, so node ids differ across trees. */
  readonly serial = trees++

  constructor(
    /** The line as typed. */
    readonly original: string,
    readonly table: Uint32Array,
    /**
     * What bash reports of the line when it refuses it: where in the line as
     * typed, in UTF-16 units, the diagnostic lines as mirage prints them, and
     * the status.
     */
    readonly error: {
      readonly index: number
      readonly message: string
      readonly status: number
    } | null,
    private readonly extras: Extras,
  ) {}

  get rootNode(): ShellTreeNode {
    return new ShellTreeNode(this, 0)
  }

  get source(): string {
    return this.extras.source
  }

  get offsets(): Uint32Array {
    return this.extras.offsets
  }

  get heredocs(): readonly Heredoc[] {
    return this.extras.heredocs
  }

  get warnings(): string {
    return this.extras.warnings
  }

  inlined(index: number): string | undefined {
    return this.extras.inlined.get(index)
  }

  /**
   * The line as typed under nodes `start` to `end`, less the line continuations
   * the parser dropped: those no unit of the nodes came from, outside the
   * heredocs it folded. Mirrors the parser's `Tree::typed`.
   */
  typed(start: number, end: number): string {
    const { offsets, original } = this
    const to = Math.min((offsets[end - 1] ?? 0) + 1, original.length)
    const from = Math.min(offsets[start] ?? 0, to)
    const kept = new Uint8Array(to - from)
    const keep = (a: number, b: number): void => {
      for (let at = Math.max(a, from); at < Math.min(b, to); at++) kept[at - from] = 1
    }
    for (let index = start; index < end; index++) {
      const at = offsets[index] ?? 0
      keep(at, at + 1)
    }
    for (const heredoc of this.heredocs) {
      keep(heredoc.operatorStart, heredoc.wordEnd)
      keep(heredoc.bodyStart, heredoc.end)
    }
    let out = ''
    let chunk = from
    for (let at = from; at < to - 1; at++) {
      if (
        original[at] === '\\' &&
        original[at + 1] === '\n' &&
        kept[at - from] === 0 &&
        kept[at + 1 - from] === 0
      ) {
        out += original.slice(chunk, at)
        chunk = at + 2
        at++
      }
    }
    return out + original.slice(chunk, to)
  }
}

/**
 * One node of a ShellTree: the kinds, fields and spans tree-sitter-bash
 * gives, offsets and columns in UTF-16 units as a string index counts them.
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

  /** The field a child has in this node. */
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

  /** The heredoc a `file_redirect` was folded from. */
  get heredoc(): Heredoc | undefined {
    if (this.type !== 'file_redirect') return undefined
    const opens = this.children
      .filter((child) => child.type === '<')
      .map((child) => child.startIndex)
    return this.tree.heredocs.find((heredoc) => opens.includes(heredoc.at))
  }

  /** The node's text in the line as typed, the heredoc bodies it holds included. */
  get sourceText(): string {
    const { startIndex: start, endIndex: end, tree } = this
    if (this.parent === null) return tree.original
    if (!tree.heredocs.some((heredoc) => start <= heredoc.at && heredoc.at < end)) return this.text
    if (end <= start) return ''
    return tree.typed(start, end)
  }

  /** The node's text with the heredoc bodies the line reads after a substitution in it moved inside it. */
  get inlined(): string | undefined {
    return this.tree.inlined(this.index)
  }

  /** Where each UTF-16 unit of the tree's source came from in the line as typed, then its end. */
  get offsets(): Uint32Array {
    return this.tree.offsets
  }

  /** What bash warns of while it reads the tree's heredocs. */
  get warnings(): string {
    return this.tree.warnings
  }

  /** The tree's refusal, as `ShellTree.error` gives it. */
  get error(): ShellTree['error'] {
    return this.tree.error
  }
}

/**
 * Parse a shell program with mirage's own bash parser: tree-sitter-bash's
 * node kinds, fields and spans, bash's reading where that grammar misreads
 * bash. `aliases` are the names the shell expands as aliases: one is a
 * command where a command starts, never a reserved word. Mirrors Python's
 * parse_shell.
 */
export function parseShell(
  source: string,
  aliases: Iterable<string> = [],
  extglob = true,
): ShellTree {
  const wasm = instance()
  const bytes = encodeText(source)
  const names = encoder.encode([...aliases].map((name) => `${name}\0`).join(''))
  const args = wasm.mirage_rs_args(bytes.byteLength + names.byteLength)
  bytesAt(wasm, args, bytes.byteLength).set(bytes)
  bytesAt(wasm, args + bytes.byteLength, names.byteLength).set(names)
  const count = wasm.mirage_rs_shell_parse(bytes.byteLength, names.byteLength, extglob ? 1 : 0)
  const ptr = wasm.mirage_rs_shell_table()
  const table = new Uint32Array(wasm.memory.buffer, ptr, count * WORDS).slice()
  const at = wasm.mirage_rs_shell_error_at()
  let error: ShellTree['error'] = null
  if (at >= 0) {
    const message = wasm.mirage_rs_shell_message()
    error = {
      index: at,
      message: decodeText(bytesAt(wasm, message, wasm.mirage_rs_shell_message_len())),
      status: wasm.mirage_rs_shell_status(),
    }
  }
  const extras = readExtras(wasm)
  if (wasm.memory.buffer.byteLength > RECYCLE_BYTES) exports = undefined
  return new ShellTree(source, table, error, extras)
}

/** The parse's extras, laid out as `mirage_rs_shell_extras` describes them. */
function readExtras(wasm: Exports): Extras {
  const words = new Uint32Array(
    wasm.memory.buffer,
    wasm.mirage_rs_shell_extras(),
    wasm.mirage_rs_shell_extras_len(),
  ).slice()
  const text = bytesAt(wasm, wasm.mirage_rs_shell_text(), wasm.mirage_rs_shell_text_len()).slice()
  const [sourceBytes = 0, heredocCount = 0, inlinedCount = 0, warningBytes = 0] = words
  let at = sourceBytes
  const next = (bytes: number): string => decodeText(text.subarray(at, (at += bytes)))
  const source = decodeText(text.subarray(0, sourceBytes))
  let word = 4
  const offsets = words.subarray(word, (word += source.length + 1))
  const heredocs: Heredoc[] = []
  for (let index = 0; index < heredocCount; index += 1, word += 9) {
    const [atSource = 0, operatorStart = 0, wordEnd = 0, bodyStart = 0, end = 0, flags = 0] =
      words.subarray(word, word + 6)
    heredocs.push({
      at: atSource,
      operatorStart,
      wordEnd,
      bodyStart,
      end,
      word: next(words[word + 6] ?? 0),
      delimiter: next(words[word + 7] ?? 0),
      body: next(words[word + 8] ?? 0),
      quoted: (flags & 1) !== 0,
      terminated: (flags & 2) !== 0,
      dash: (flags & 4) !== 0,
    })
  }
  const inlined = new Map<number, string>()
  for (let index = 0; index < inlinedCount; index += 1, word += 2) {
    inlined.set(words[word] ?? 0, next(words[word + 1] ?? 0))
  }
  return { source, offsets, heredocs, inlined, warnings: next(warningBytes) }
}
