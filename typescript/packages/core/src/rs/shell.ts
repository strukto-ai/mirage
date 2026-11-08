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

import MIRAGE_SHELL_WASM from '#mirage-shell-wasm'
import { decodeText, encodeText } from '../shell/bytes.ts'
import type { Heredoc, ShellNode } from '../shell/types.ts'
import { compileSync } from './stream.ts'

interface Exports {
  readonly memory: WebAssembly.Memory
  mirage_rs_args(len: number): number
  mirage_rs_shell_parse(len: number, aliasesLen: number, extglob: number): number
  mirage_rs_shell_table(): number
  mirage_rs_shell_error_at(): number
  mirage_rs_shell_status(): number
  mirage_rs_shell_words(
    handle: number,
    what: number,
    headLen: number,
    first: number,
    utf8: number,
  ): number
  mirage_rs_shell_message(): number
  mirage_rs_shell_message_len(): number
  mirage_rs_shell_reread(handle: number, index: number): number
  mirage_rs_shell_reread_lines(): number
  mirage_rs_shell_names(): number
  mirage_rs_shell_names_len(): number
  mirage_rs_shell_extras(): number
  mirage_rs_shell_extras_len(): number
  mirage_rs_shell_text(): number
  mirage_rs_shell_text_len(): number
  mirage_rs_shell_tree(): number
  mirage_rs_shell_drop_tree(handle: number): void
  mirage_rs_engine(len: number): number
  mirage_rs_engine_output(): number
  mirage_rs_engine_output_len(): number
}

/** The `u32`s one node takes in a parse's table: kind | field << 16 | flags << 24, then spans and links. */
const WORDS = 10
/** `u32::MAX`: the extras' word for no value. */
const NONE = 0xffffffff

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

// One instance of the shell module (`#mirage-shell-wasm`: the parser and the
// evaluator, small enough to compile synchronously anywhere) holds every parse
// tree and every session's shell for the process's life, so it is never
// swapped for a fresh one.
function instance(): Exports {
  if (exports === undefined) {
    const imports = {
      mirage: {
        mirage_ids: drawId,
        mirage_ids_release: (source: number) => {
          idSources.delete(source)
        },
      },
    }
    const wasm = new WebAssembly.Instance(compileSync(MIRAGE_SHELL_WASM), imports)
      .exports as unknown as Exports
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

const kept = new FinalizationRegistry<number>((handle) => {
  instance().mirage_rs_shell_drop_tree(handle)
})

/** A shell program as mirage's own parser reads it. Mirrors Python's ShellTree. */
export class ShellTree {
  /** Unique per tree, so node ids differ across trees. */
  readonly serial = trees++

  constructor(
    /** The line as typed. */
    readonly original: string,
    readonly table: Uint32Array,
    /** The engine's own copy of the tree, which a shell's tasks expand nodes of. */
    readonly handle: number,
    /**
     * Where in the line as typed, in UTF-16 units, bash refuses it, and the
     * status.
     */
    readonly error: {
      readonly index: number
      readonly status: number
    } | null,
    private readonly extras: ReturnType<typeof readExtras>,
  ) {
    kept.register(this, handle)
  }

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

  /**
   * What bash warns of while it reads the tree's heredocs, each line led by
   * `head` and its line, the input's first row being `first`.
   */
  warnings(head: string, first: number): string {
    return this.words(1, head, first, false)
  }

  /**
   * The tree's refusal as bash prints it, each line led by `head` and its
   * line, the input's first row being `first`, under a UTF-8 locale or not
   * (`utf8`).
   */
  refusal(head: string, first: number, utf8: boolean): string {
    return this.error === null ? '' : this.words(0, head, first, utf8)
  }

  private words(what: number, head: string, first: number, utf8: boolean): string {
    const wasm = instance()
    const bytes = encodeText(head)
    bytesAt(wasm, wasm.mirage_rs_args(bytes.byteLength), bytes.byteLength).set(bytes)
    const len = wasm.mirage_rs_shell_words(this.handle, what, bytes.byteLength, first, utf8 ? 1 : 0)
    return decodeText(bytesAt(wasm, wasm.mirage_rs_shell_message(), len))
  }

  inlined(index: number): string | undefined {
    return this.extras.inlined.get(index)
  }

  /**
   * Each node under node `index`, a `$( )` body bash reads again as it prints
   * it, by id: the line `$LINENO` numbers it by and the line it ends on, from 0.
   */
  rereadLines(index: number): Map<number, readonly [number, number]> {
    const wasm = instance()
    const len = wasm.mirage_rs_shell_reread(this.handle, index)
    const numbers = new Uint32Array(wasm.memory.buffer, wasm.mirage_rs_shell_reread_lines(), len)
    const lines = new Map<number, readonly [number, number]>()
    for (let at = 0; at + 2 < len; at += 3) {
      lines.set(this.serial * 0x1000000 + (numbers[at] ?? 0), [
        numbers[at + 1] ?? 0,
        numbers[at + 2] ?? 0,
      ])
    }
    return lines
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

  /** Each node under this one as bash prints a `$( )` body it reads again (`ShellTree.rereadLines`). */
  rereadLines(): ReadonlyMap<number, readonly [number, number]> {
    return this.tree.rereadLines(this.index)
  }

  /** Where each UTF-16 unit of the tree's source came from in the line as typed, then its end. */
  get offsets(): Uint32Array {
    return this.tree.offsets
  }

  /** What bash warns of while it reads the tree's heredocs, as `ShellTree.warnings` words it. */
  warnings(head: string, first: number): string {
    return this.tree.warnings(head, first)
  }

  /** The tree's refusal, as `ShellTree.error` gives it. */
  get error(): ShellTree['error'] {
    return this.tree.error
  }

  /** The tree's refusal as bash prints it, as `ShellTree.refusal` words it. */
  refusal(head: string, first: number, utf8: boolean): string {
    return this.tree.refusal(head, first, utf8)
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
  if (at >= 0) error = { index: at, status: wasm.mirage_rs_shell_status() }
  const extras = readExtras(wasm)
  return new ShellTree(source, table, wasm.mirage_rs_shell_tree(), error, extras)
}

/** The parse's extras, laid out as `mirage_rs_shell_extras` describes them. */
/** What a parse says of the line beyond its nodes. */
export function readExtras(wasm: Exports) {
  const words = new Uint32Array(
    wasm.memory.buffer,
    wasm.mirage_rs_shell_extras(),
    wasm.mirage_rs_shell_extras_len(),
  ).slice()
  const text = bytesAt(wasm, wasm.mirage_rs_shell_text(), wasm.mirage_rs_shell_text_len()).slice()
  const [sourceBytes = 0, heredocCount = 0, inlinedCount = 0] = words
  let at = sourceBytes
  const next = (bytes: number): string => decodeText(text.subarray(at, (at += bytes)))
  const source = decodeText(text.subarray(0, sourceBytes))
  let word = 3
  const offsets = words.subarray(word, (word += source.length + 1))
  const heredocs: Heredoc[] = []
  for (let index = 0; index < heredocCount; index += 1, word += 11) {
    const [atSource = 0, operatorStart = 0, wordEnd = 0, bodyStart = 0, end = 0, flags = 0] =
      words.subarray(word, word + 6)
    const heredocWord = next(words[word + 6] ?? 0)
    const delimiter = next(words[word + 7] ?? 0)
    const bodyBytes = text.subarray(at, (at += words[word + 8] ?? 0))
    const failsAt = words[word + 9] ?? NONE
    heredocs.push({
      at: atSource,
      operatorStart,
      wordEnd,
      bodyStart,
      end,
      word: heredocWord,
      delimiter,
      body: decodeText(bodyBytes),
      quoted: (flags & 1) !== 0,
      terminated: (flags & 2) !== 0,
      dash: (flags & 4) !== 0,
      deferred:
        failsAt === NONE
          ? null
          : {
              at: decodeText(bodyBytes.subarray(0, failsAt)).length,
              row: words[word + 10] ?? 0,
            },
    })
  }
  const inlined = new Map<number, string>()
  for (let index = 0; index < inlinedCount; index += 1, word += 2) {
    inlined.set(words[word] ?? 0, next(words[word + 1] ?? 0))
  }
  return { source, offsets, heredocs, inlined }
}

/**
 * One item of the engine's layout (`rust/wasm/src/codec.rs`): text is shell
 * text, a `number` an integer that fits a float, a `bigint` one read exactly,
 * a `Uint8Array` raw bytes.
 */
export type Item =
  | null
  | boolean
  | number
  | bigint
  | string
  | Uint8Array
  | readonly Item[]
  | ReadonlyMap<Item, Item>

// A lone surrogate stands for a byte, which only `encodeText` writes.
const SURROGATE = /[\uD800-\uDFFF]/

let scratch = new Uint8Array(4096)
let used = 0

function room(len: number): void {
  if (used + len <= scratch.length) return
  const grown = new Uint8Array(Math.max(scratch.length * 2, used + len))
  grown.set(scratch.subarray(0, used))
  scratch = grown
}

function putWord(tag: number, value: number): void {
  room(5)
  scratch[used] = tag
  new DataView(scratch.buffer).setUint32(used + 1, value, true)
  used += 5
}

function putWide(tag: number, value: bigint): void {
  room(9)
  scratch[used] = tag
  new DataView(scratch.buffer).setBigInt64(used + 1, value, true)
  used += 9
}

function putBytes(tag: number, bytes: Uint8Array): void {
  putWord(tag, bytes.byteLength)
  room(bytes.byteLength)
  scratch.set(bytes, used)
  used += bytes.byteLength
}

function encodeItem(item: Item): void {
  if (item === null) {
    room(1)
    scratch[used++] = 0
  } else if (typeof item === 'boolean') {
    room(1)
    scratch[used++] = item ? 2 : 1
  } else if (typeof item === 'number') {
    putWide(3, BigInt(Math.trunc(item)))
  } else if (typeof item === 'bigint') {
    putWide(7, item)
  } else if (typeof item === 'string') {
    putBytes(4, SURROGATE.test(item) ? encodeText(item) : encoder.encode(item))
  } else if (item instanceof Uint8Array) {
    putBytes(8, item)
  } else if (item instanceof Map) {
    putWord(6, item.size)
    for (const [key, value] of item as ReadonlyMap<Item, Item>) {
      encodeItem(key)
      encodeItem(value)
    }
  } else {
    const items = item as readonly Item[]
    putWord(5, items.length)
    for (const element of items) encodeItem(element)
  }
}

function decodeItem(bytes: Uint8Array, view: DataView, at: { pos: number }): Item {
  const tag = bytes[at.pos++]
  const word = (): number => {
    const value = view.getUint32(at.pos, true)
    at.pos += 4
    return value
  }
  const wide = (): bigint => {
    const value = view.getBigInt64(at.pos, true)
    at.pos += 8
    return value
  }
  switch (tag) {
    case 0:
      return null
    case 1:
      return false
    case 2:
      return true
    case 3:
      return Number(wide())
    case 4:
    case 8: {
      const len = word()
      const body = bytes.subarray(at.pos, (at.pos += len))
      return tag === 4 ? decodeText(body) : body.slice()
    }
    case 5: {
      const count = word()
      const items: Item[] = []
      for (let index = 0; index < count; index++) items.push(decodeItem(bytes, view, at))
      return items
    }
    case 6: {
      const count = word()
      const map = new Map<Item, Item>()
      for (let index = 0; index < count; index++) {
        const key = decodeItem(bytes, view, at)
        map.set(key, decodeItem(bytes, view, at))
      }
      return map
    }
    case 7:
      return wide()
    default:
      throw new Error(`the engine replied with tag ${String(tag)}`)
  }
}

// The shells closed since the last request, dropped ahead of the next one
// rather than in calls of their own.
const closing: number[] = []

/** Run one engine request: its target, operation and arguments; its reply. */
function engine(target: 'shell' | 'task', op: string, args: readonly Item[]): Item {
  return batch([[target, op, ...args]])
}

/** Run engine requests in order in one call; the last one's reply. */
function batch(requests: readonly (readonly Item[])[]): Item {
  const all = [...closing.splice(0).map((handle) => ['shell', 'drop', handle]), ...requests]
  const [first, ...rest] = all
  return send(first !== undefined && rest.length === 0 ? first : all)
}

function send(request: Item): Item {
  const wasm = instance()
  used = 0
  encodeItem(request)
  const ptr = wasm.mirage_rs_args(used)
  bytesAt(wasm, ptr, used).set(scratch.subarray(0, used))
  const status = wasm.mirage_rs_engine(used)
  const out = bytesAt(wasm, wasm.mirage_rs_engine_output(), wasm.mirage_rs_engine_output_len())
  if (status !== 0) throw new Error(decoder.decode(out))
  return decodeItem(out, new DataView(out.buffer, out.byteOffset, out.byteLength), { pos: 0 })
}

// The id sources shells draw `$RANDOM`'s first seeds from, by the number the
// engine holds each under until the last shell drawing from it goes.
const idSources = new Map<number, () => number>()
let nextSource = 0

function idSource(ids: () => number): number {
  nextSource += 1
  idSources.set(nextSource, ids)
  return nextSource
}

/** The ids a source hands out, 0 once it threw: a seed is no failure. */
function drawId(source: number): number {
  try {
    return (idSources.get(source)?.() ?? 0) >>> 0
  } catch (error) {
    console.debug('id source failed, seeding from 0:', error)
    return 0
  }
}

/** A shell's value as the engine holds it: text, or an array's elements. */
export type RawValue = string | ReadonlyMap<bigint, string> | ReadonlyMap<string, string> | null

/** A managed variable's pointer: source, reference, key, eager. */
export type Managed = readonly [string, string, string, boolean]

/** A record: the value, null for declared but unset; the cluster `declare -p` prints; the pointer. */
export type ShellRecord = readonly [RawValue, string, Managed | null]

/** A request a running task waits on. */
export type Ask =
  | readonly [
      'substitute',
      Shell,
      string,
      ShellTreeNode,
      readonly [number, number] | null,
      readonly string[] | null,
    ]
  | readonly ['process', Shell, ShellTreeNode]
  | readonly ['gate', boolean, 'set' | 'unset', string, string | null, string | null, Shell]
  | readonly ['pause', Shell]

/** The state around a line that the shell reads, as `Shell.frame` takes it. */
export interface ShellFrame {
  readonly positional: readonly string[]
  readonly calls: readonly (readonly string[])[]
  readonly status: number
  readonly pid: number
  readonly lastJob: number | null
  readonly argv0: string
  readonly options: ReadonlyMap<string, boolean>
  readonly shopts: ReadonlyMap<string, boolean>
  readonly envLimit: number | null
  readonly outside: number
  readonly pipeStatus: readonly number[]
  readonly functionNames: readonly string[] | null
  readonly callLines: readonly number[]
  readonly paren: boolean
  readonly memoryRoom: number | null
  readonly line: number
  readonly bashPid: number
  readonly voice: string
}

/** The options of a gated write: whether a session policy listens. */
export interface Heard {
  readonly listens?: boolean
}

const shells = new FinalizationRegistry<number>((handle) => {
  engine('shell', 'drop', [handle])
})
const tasks = new FinalizationRegistry<number>((handle) => {
  engine('task', 'drop', [handle])
})

function asRecord(item: Item): ShellRecord | null {
  return item === null ? null : (item as unknown as ShellRecord)
}

function texts(items: Item): string[] {
  return items as string[]
}

/**
 * One session's shell: its variables, the positional parameters, the
 * special parameters and the options, held in mirage-rs. While a
 * `ShellTask` runs on it the shell is the task's, and any read of it throws
 * until the task finishes. Mirrors Python's mirage._rs.Shell.
 */
export class Shell {
  private closed = false
  // The frame `frame` set, sent with the next request rather than in one of
  // its own.
  private framed: ShellFrame | null = null
  // The positional arrays the engine last took.
  private sent: Pick<ShellFrame, 'positional' | 'calls'> | null = null

  private constructor(readonly handle: number) {
    shells.register(this, handle, this)
  }

  /** A new shell; `ids` returns the id a fresh `$RANDOM` generator seeds from. */
  static create(ids: () => number): Shell {
    return new Shell(engine('shell', 'new', [idSource(ids)]) as number)
  }

  /** The shell the engine made for a request, under `handle`. */
  static adopt(handle: number): Shell {
    return new Shell(handle)
  }

  /** Free the shell with the next request, rather than when it is collected. */
  close(): void {
    if (this.closed) return
    this.closed = true
    shells.unregister(this)
    closing.push(this.handle)
  }

  private call(op: string, ...args: Item[]): Item {
    const framed = this.framed
    if (framed === null) return engine('shell', op, [this.handle, ...args])
    this.framed = null
    const items = this.frameItems(framed)
    this.sent = null
    const answer = batch([
      ['shell', 'frame', this.handle, ...items],
      ['shell', op, this.handle, ...args],
    ])
    this.sent = { positional: framed.positional, calls: framed.calls }
    return answer
  }

  /**
   * A frame as the engine takes it, positional parameters it holds already
   * left out: the host replaces an array rather than change it.
   */
  private frameItems(frame: ShellFrame): Item[] {
    const sent = this.sent
    const sameCalls =
      sent !== null &&
      sent.calls.length === frame.calls.length &&
      sent.calls.every((call, i) => call === frame.calls[i])
    return [
      sent?.positional === frame.positional ? null : frame.positional,
      sameCalls ? null : frame.calls,
      frame.status,
      frame.pid,
      frame.lastJob,
      frame.argv0,
      frame.options as ReadonlyMap<Item, Item>,
      frame.shopts as ReadonlyMap<Item, Item>,
      frame.envLimit,
      frame.outside,
      frame.pipeStatus,
      frame.functionNames,
      frame.callLines,
      frame.paren,
      frame.memoryRoom,
      frame.line,
      frame.bashPid,
      frame.voice,
    ]
  }

  private task(op: string, tree: ShellTree | null, ...args: Item[]): ShellTask {
    const [handle, step] = this.call(op, ...args) as readonly [number, Item]
    return new ShellTask(handle, step, tree)
  }

  /** Draw `$RANDOM`'s first seeds from `ids` from now on. */
  useIds(ids: () => number): void {
    this.call('use_ids', idSource(ids))
  }

  /** The raw record a name holds, references not followed, hidden or not. */
  get(name: string): ShellRecord | null {
    return asRecord(this.call('get', name))
  }

  /** The record a name stands for, references followed; null when unset or hidden. */
  visible(name: string): ShellRecord | null {
    return asRecord(this.call('visible', name))
  }

  /** Replace a name's record, or drop it with null, returning the one it replaced. */
  place(name: string, record: ShellRecord | null): ShellRecord | null {
    return asRecord(this.call('place', name, record as Item))
  }

  /** The names a reader lists for one kind of value, sorted: each a lookup finds. */
  visibleNames(kind: 'scalar' | 'indexed' | 'assoc'): string[] {
    return texts(this.call('visible_names', kind))
  }

  /** What the value a name stands for is, references followed; null when unset or hidden. */
  kind(name: string): 'scalar' | 'indexed' | 'assoc' | null {
    return this.call('kind', name) as 'scalar' | 'indexed' | 'assoc' | null
  }

  /** An indexed array as `${a[@]}` reads it, `PIPESTATUS` and `FUNCNAME` from the frame. */
  indexed(name: string): ReadonlyMap<bigint, string> | null {
    return this.call('indexed', name) as ReadonlyMap<bigint, string> | null
  }

  /** What a `pre_session` rule is shown for a name's record; null when it is unset. */
  rendered(name: string): string | null {
    return this.call('rendered', name) as string | null
  }

  names(): string[] {
    return texts(this.call('names'))
  }

  /** Every record as `[name, record]`, in no order. */
  records(): (readonly [string, ShellRecord])[] {
    return this.call('records') as unknown as (readonly [string, ShellRecord])[]
  }

  get size(): number {
    return this.call('len') as number
  }

  has(name: string): boolean {
    return this.call('contains', name) as boolean
  }

  /** The bytes every record holds; while a task runs, what they held as it started. */
  held(): number {
    return this.call('held') as number
  }

  /** Hide the names a session's visibility lists, exactly or by glob. */
  hide(names: readonly string[], patterns: readonly string[]): void {
    this.call('hide', names, patterns)
  }

  hidden(name: string): boolean {
    return this.call('hidden', name) as boolean
  }

  namerefTarget(name: string): string | null {
    return this.call('nameref_target', name) as string | null
  }

  /** The variable a name stands for, references followed. */
  deref(name: string): string {
    return this.call('deref', name) as string
  }

  /**
   * A name as a diagnostic names it, under the shell's locale: as it is, or
   * `$'...'` when it does not show as it is.
   */
  shown(value: string): string {
    return this.call('shown', value) as string
  }

  /** Where a write to a name lands, references followed. */
  target(name: string): string {
    return this.call('target', name) as string
  }

  isReadonly(name: string, followRef: boolean): boolean {
    return this.call('is_readonly', name, followRef) as boolean
  }

  /** The stamp the records and the names hidden from them carry, fresh on every change. */
  stamp(): number {
    return Number(this.call('stamp'))
  }

  /** The exported scalars a child process inherits, hidden names left out. */
  exported(): (readonly [string, string])[] {
    return this.call('exported') as unknown as (readonly [string, string])[]
  }

  /** Write a value with no gate, as seeding a session does. */
  seed(name: string, value: RawValue, assoc = false): void {
    this.call('seed', name, value as Item, assoc)
  }

  /** Set or clear one attribute (its `declare` letter) with no gate. */
  setAttr(name: string, letter: string | null, on: boolean): void {
    this.call('set_attr', name, letter, on)
  }

  /**
   * Mark an array `declare -a` / `-A` just made as never assigned, which its
   * first write clears: bookkeeping, not a write.
   */
  unassigned(name: string): void {
    this.call('unassigned', name)
  }

  /**
   * Whether `name`'s record is one declared and never assigned, which a host
   * putting the record back marks again (`unassigned`).
   */
  isUnassigned(name: string): boolean {
    return this.call('is_unassigned', name) as boolean
  }

  /** The line `declare -p` prints for a name, `RANDOM` drawing; null for one unset or hidden. */
  declaration(name: string): string | null {
    return this.call('declaration', name) as string | null
  }

  /**
   * The lines a bare `declare -p` prints, sorted by name, narrowed by its option
   * `letters`, the running command's temporaries in `skip` left out.
   */
  listing(letters: string, skip: readonly string[]): string[] {
    return texts(this.call('listing', letters, skip))
  }

  /**
   * The variable lines a bare `set` prints, sorted by name, the running
   * command's temporaries in `skip` left out.
   */
  assignments(skip: readonly string[]): string[] {
    return texts(this.call('assignments', skip))
  }

  /** Open a function call's scope; the token closes it. */
  enter(): number | null {
    return this.call('enter') as number | null
  }

  leave(outer: number | null): void {
    this.call('leave', outer)
  }

  inFunction(): boolean {
    return this.call('in_function') as boolean
  }

  isLocal(name: string): boolean {
    return this.call('is_local', name) as boolean
  }

  /** The names the running function made local, sorted. */
  locals(): string[] {
    return this.call('locals') as string[]
  }

  /**
   * Set the caller's record aside before a `local` shadows it; with `inherit`
   * (`local -I`) a `LINENO` or `BASHPID` stays special.
   */
  shadow(name: string, inherit: boolean): void {
    this.call('shadow', name, inherit)
  }

  /** Open a prefix assignment's scope around a function call. */
  openTemp(): number {
    return this.call('open_temp') as number
  }

  saveTemp(index: number, name: string): void {
    this.call('save_temp', index, name)
  }

  closeTemp(index: number): void {
    this.call('close_temp', index)
  }

  /** Let a prefix assignment's value outlive the call. */
  outliveCall(name: string): void {
    this.call('outlive_call', name)
  }

  inCallEnv(name: string): boolean {
    return this.call('in_call_env', name) as boolean
  }

  /** `declare -g`: the names reach global scope until `unreach`. */
  reachGlobal(names: readonly string[]): void {
    this.call('reach_global', names)
  }

  unreach(): void {
    this.call('unreach')
  }

  /** One `$RANDOM` read: the draw, null once RANDOM is not special, or a seed's error. */
  nextRandom(): number | null | readonly Item[] {
    return this.call('next_random') as number | null | readonly Item[]
  }

  /** Set the frame the next operation reads, sent along with it. */
  frame(frame: ShellFrame): void {
    this.framed = frame
  }

  /**
   * Whether this shell holds the records `other` holds, value for value: a host
   * keeps a fork of what it saved and saves again only once they part.
   */
  sameVars(other: Shell): boolean {
    return this.call('same_vars', other.handle) as boolean
  }

  /** The scalar an array conversion keeps as element 0, or a seed's error. */
  conversionScalar(name: string): string | null | readonly Item[] {
    return this.call('conversion_scalar', name) as string | null | readonly Item[]
  }

  /** `$?` as the last operation left it. */
  /** A copy for a fork of the session: the same records, a fresh generator. */
  fork(): Shell {
    return new Shell(this.call('fork') as number)
  }

  /** A child shell's copy: the scopes too, `$RANDOM` starting anew. */
  subshell(): Shell {
    return new Shell(this.call('subshell') as number)
  }

  /** Expand `node` as `mode` says; `listens` when a session policy hears writes. */
  expand(node: ShellTreeNode, mode: string, listens: boolean): ShellTask {
    return this.task('expand', node.tree, node.tree.handle, node.index, mode, listens)
  }

  /** Set a variable through the gate. */
  set(
    name: string,
    value: RawValue,
    options: Heard & {
      readonly assoc?: boolean
      readonly followRef?: boolean
      readonly assigned?: readonly (bigint | string)[] | null
      readonly added?: string | null
      readonly warns?: boolean
    } = {},
  ): ShellTask {
    return this.task(
      'set',
      null,
      name,
      value as Item,
      options.assoc ?? false,
      options.followRef ?? true,
      options.assigned ?? null,
      options.added ?? null,
      options.listens ?? false,
      options.warns ?? true,
    )
  }

  unset(name: string, options: Heard & { readonly followRef?: boolean } = {}): ShellTask {
    return this.task('unset', null, name, options.followRef ?? true, options.listens ?? false)
  }

  /** Set or clear an attribute through the gate; no letter declares the name only. */
  mark(
    name: string,
    letter: string | null,
    on: boolean,
    options: Heard & { readonly followRef?: boolean } = {},
  ): ShellTask {
    return this.task(
      'mark',
      null,
      name,
      letter,
      on,
      options.followRef ?? true,
      options.listens ?? false,
    )
  }

  /** A subscript that is a plain decimal, read without evaluating; null when `index` has to. */
  plainIndex(subscript: string): bigint | null {
    return this.call('plain_index', subscript) as bigint | null
  }

  /** Resolve an indexed array's subscript, what it assigns landed. */
  index(subscript: string, options: Heard = {}): ShellTask {
    return this.task('index', null, subscript, options.listens ?? false)
  }

  /** Whether a `name` / `name[sub]` reference is set, as `test -v` asks; 1 or 0. */
  isSet(reference: string, options: Heard & { expanded?: boolean } = {}): ShellTask {
    return this.task('is_set', null, reference, options.expanded ?? false, options.listens ?? false)
  }

  /** Write one element, or a bare name: 0 landed, 1 hidden, 2 readonly, 3 no element. */
  element(
    name: string,
    subscript: string | null,
    value: string,
    options: Heard & { readonly append?: boolean; readonly warns?: boolean } = {},
  ): ShellTask {
    return this.task(
      'element',
      null,
      name,
      subscript,
      value,
      options.append ?? false,
      options.listens ?? false,
      options.warns ?? true,
    )
  }

  /** Append words at an indexed array's extent (`a+=(x y)`). */
  push(name: string, words: readonly string[], options: Heard = {}): ShellTask {
    return this.task('push', null, name, words, options.listens ?? false)
  }

  /**
   * Clear one element (`unset 'a[i]'`), or every one when `every`, a subscript
   * typed as `@` or `*`: 0 cleared, 3 no element, 4 not an array.
   */
  unsetElement(name: string, subscript: string, every = false, options: Heard = {}): ShellTask {
    return this.task('unset_element', null, name, subscript, every, options.listens ?? false)
  }

  /**
   * Evaluate an arithmetic command or `let` operand, its writes landed;
   * `expand` for a `let` operand, whose subscripts expand first.
   */
  arith(text: string, expand = false, options: Heard = {}): ShellTask {
    return this.task('arith', null, text, options.listens ?? false, expand)
  }

  /** Evaluate a value as an `-i` write coerces it; `added` is an integer `+=`'s text. */
  integer(text: string, added: string | null = null, options: Heard = {}): ShellTask {
    return this.task('integer', null, text, added, options.listens ?? false)
  }
}

/** How a task ended: `['ok', value]` or a fault, and its diagnostics. */
export type Finished = readonly [readonly Item[], (string | Uint8Array)[]]

/**
 * An operation running on a shell, driven by the host. Started, it has run to
 * its first request or its end: `step` returns the request it waits on, which
 * one `answer*` call answers, running it to the next, or null once it has
 * ended, when the shell is its owner's again and `finish` returns the result.
 * A long list of fields comes in slices: the first in `finish`, the rest from
 * `slice` while `more` says some are left. Mirrors Python's
 * mirage._rs.ShellTask.
 */
export class ShellTask {
  private asked: Ask | null = null
  private ended: Finished | null = null
  private left = false
  // Whether the engine still holds the task: until it ends, or until its
  // last slice is taken.
  private held = true

  constructor(
    readonly handle: number,
    step: Item,
    private readonly tree: ShellTree | null,
  ) {
    tasks.register(this, handle, this)
    this.land(step)
  }

  private call(op: string, ...args: Item[]): Item {
    return engine('task', op, [this.handle, ...args])
  }

  private node(index: Item): ShellTreeNode {
    if (this.tree === null) throw new Error('a write has no tree')
    return new ShellTreeNode(this.tree, index as number)
  }

  /** Keep where a run stopped: `['ask', request]` or `['done', result, said, more]`. */
  private land(step: Item): void {
    const stopped = step as readonly Item[]
    if (stopped[0] === 'ask') {
      this.asked = this.ask(stopped[1] as readonly Item[])
      return
    }
    this.asked = null
    this.ended = [stopped[1] as readonly Item[], stopped[2] as (string | Uint8Array)[]]
    this.left = stopped[3] === true
    if (!this.left) this.release()
  }

  private release(): void {
    if (!this.held) return
    this.held = false
    tasks.unregister(this)
  }

  /**
   * A span the engine counts in bytes of `node`'s text, in the code units
   * the host's strings count, as `segmentFrames` places a backtick pair.
   */
  private units(node: ShellTreeNode, span: readonly [number, number]): readonly [number, number] {
    const bytes = encodeText(node.text)
    return [
      decodeText(bytes.subarray(0, span[0])).length,
      decodeText(bytes.subarray(0, span[1])).length,
    ]
  }

  private ask(asked: readonly Item[]): Ask {
    switch (asked[0]) {
      case 'substitute': {
        const node = this.node(asked[3] ?? null)
        const span = (asked[4] ?? null) as readonly [number, number] | null
        return [
          'substitute',
          Shell.adopt(asked[1] as number),
          asked[2] as string,
          node,
          span === null ? null : this.units(node, span),
          (asked[5] ?? null) as readonly string[] | null,
        ]
      }
      case 'process':
        return ['process', Shell.adopt(asked[1] as number), this.node(asked[2] ?? null)]
      case 'gate':
        return [
          'gate',
          asked[1] as boolean,
          asked[2] as 'set' | 'unset',
          asked[3] as string,
          asked[4] as string | null,
          asked[5] as string | null,
          Shell.adopt(asked[6] as number),
        ]
      default:
        return ['pause', Shell.adopt(asked[1] as number)]
    }
  }

  /** The request the operation waits on, null once it has ended. */
  step(): Ask | null {
    return this.asked
  }

  answerSubstituted(stdout: Uint8Array, stderr: Uint8Array, status: number): void {
    this.land(this.call('answer_substituted', stdout, stderr, status))
  }

  answerPath(path: string): void {
    this.land(this.call('answer_path', path))
  }

  /** The gate's answer: null to let the write through, or the refused name and its record. */
  answerGate(denied: readonly [string, number] | null): void {
    this.land(this.call('answer_gate', denied))
  }

  /** The host has let others run; the operation goes on. */
  answerResumed(): void {
    this.land(this.call('answer_resumed'))
  }

  /** Whether a policy hears the session's writes from now on, told before each answer. */
  listen(listens: boolean): void {
    this.call('listen', listens)
  }

  /** The host could not do what was asked; the operation stops. */
  answerFailed(): void {
    this.land(this.call('answer_failed'))
  }

  /** The result once `step` has returned null; the shell is the owner's again. */
  finish(): Finished {
    if (this.ended === null) throw new Error('the task is running')
    return this.ended
  }

  /** Whether slices of a long list of fields are left to take. */
  more(): boolean {
    return this.left
  }

  /** The next slice of a long list of fields. */
  slice(): string[] {
    const [fields, more] = this.call('slice') as readonly [Item, boolean]
    this.left = more
    if (!more) this.release()
    return fields as string[]
  }

  /** Give the task up before the engine is done with it. */
  close(): void {
    if (!this.held) return
    this.release()
    this.call('drop')
  }
}
