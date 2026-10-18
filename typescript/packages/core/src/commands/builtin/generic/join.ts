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

import { AsyncLineIterator } from '../../../io/async_line_iterator.ts'
import { specOf } from '../../spec/builtins.ts'
import { OPERAND, SPELLED } from '../../spec/constants.ts'
import { FlagView, spreadOperands } from '../../spec/flag_view.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import type { CommandFnResult, Context } from '../../config.ts'
import { UsageError } from '../../errors.ts'
import { quoteText } from '../../quote.ts'
import { extraOperandError, missingOperandError } from '../../spec/usage.ts'
import { CommandName, type ParsedFlagValue } from '../../spec/types.ts'
import { byteView, fromByteView } from '../../../shell/bytes.ts'
import { unsignedDecimal } from '../utils/strtol.ts'
import { isStdin, neverOpened, stdinStream } from '../utils/stream.ts'
import { fsStrerror, isFsError } from '../../../errors/fs.ts'
import { fsErrorLine } from '../../../errors/render.ts'

// The largest field number join keeps; GNU 9.7 reads any larger one as this
// one, so `-1 99999999999999999999 -1 1` is refused as "incompatible join
// fields 9223372036854775806, 0".
const LARGEST_FIELD = (1n << 63n) - 1n
// Without -t a field is a run of bytes other than space and tab, and under -z
// a newline parts fields too (`printf '1\na\0'` is `1` and `a`). Every other
// byte, \v, \f and \r included, belongs to a field.
const BLANK_SPLIT = /[^ \t]+/g
const BLANK_SPLIT_NUL = /[^ \t\n]+/g
// The -t value that keeps each record whole: both `-t ''` and `-t $'\n'`
// select it, under -z as well, and they never conflict with each other.
const WHOLE_RECORD = '\n'
// One -o item from the next: a single comma, space or tab.
const COLUMN_BREAK = /[, \t]/
// The -o column standing for the join field.
const JOIN_COLUMN: Column = [0, 0]
// Output is handed on in pieces of about this size.
export const CHUNK = 1 << 16
const ASCII_LOWER = /[a-z]+/g
const OPTION_DESTS = [
  'a',
  'v',
  'e',
  'ignore_case',
  'args_1',
  '2',
  'j',
  'o',
  't',
  'zero_terminated',
  'check_order',
  'nocheck_order',
  'header',
]
const LONE_J_WORDS: Readonly<Record<string, number>> = { '-j1': 1, '-j2': 2 }

/**
 * What join does with a line whose key sorts before the one above it. WARN,
 * the default, names the first such line of each file, but only once some
 * line has gone unpaired, then finishes and exits 1 under `input is not in
 * sorted order`. FAIL (`--check-order`) names the first one and stops there.
 * OFF (`--nocheck-order`) never looks. Mirrors OrderCheck in join.py.
 */
export enum OrderCheck {
  WARN = 'warn',
  FAIL = 'fail',
  OFF = 'off',
}

/** A -o item: a file number and a field counted from 0; file 0 is the join field. */
export type Column = readonly [number, number]

/**
 * join's options as one line set them; every byte string is a byte view, one
 * character per byte. Mirrors JoinFlags in join.py.
 */
export interface JoinFlags {
  /** Each file's join field, counted from 0. */
  readonly keys: readonly [number, number]
  /** Whether each file's unpairable lines print (-a, -v). */
  readonly unpaired: readonly [boolean, boolean]
  /** Whether joined lines print; any -v clears it. */
  readonly paired: boolean
  /** The -e text for an empty field. */
  readonly filler: string | null
  /** The -o list. */
  readonly columns: readonly Column[]
  /** -o auto. */
  readonly autoColumns: boolean
  /** The -t byte; null parts fields at runs of blanks, WHOLE_RECORD keeps each record whole. */
  readonly delimiter: string | null
  /** What output fields are joined with. */
  readonly separator: string
  /** -i. */
  readonly foldCase: boolean
  /** What ends a record, NUL under -z. */
  readonly terminator: string
  /** What an unsorted line does. */
  readonly order: OrderCheck
  /** --header. */
  readonly header: boolean
  /** The operand positions of FILE1 and FILE2. */
  readonly files: readonly [number, number]
}

function refusal(message: string): UsageError {
  return new UsageError(`join: ${message}`, 1)
}

/**
 * A field number as join reads one, counted from 0: C blanks, one plus sign
 * and decimal digits, nothing after them, and never zero. `-1 ' 2'` and
 * `-1 +2` are field 2, `-1 '2 '` and `-1 0` are refused.
 */
function fieldIndex(text: string): bigint {
  const value = unsignedDecimal(text)
  if (value === null || value === 0n) {
    throw refusal(`invalid field number: '${quoteText(text)}'`)
  }
  return (value < LARGEST_FIELD ? value : LARGEST_FIELD) - 1n
}

/** The 1 or 2 that -a and -v take, read like a field number. */
function fileNumber(text: string): number {
  const value = unsignedDecimal(text)
  if (value !== 1n && value !== 2n) throw refusal(`invalid file number: '${quoteText(text)}'`)
  return Number(value)
}

/**
 * One -o item: `0` for the join field, else `FILE.FIELD`. GNU 9.7 sorts a bad
 * item by its first byte: one led by 0, 1 or 2 is an "invalid field
 * specifier" (`01.1`, `1`, `2x`), any other an "invalid file number in field
 * spec" (`3.1`, `.1`, `auto,1.1`), and the text after `1.` or `2.` must be a
 * field number.
 */
function column(item: string): Column {
  if (item === '0') return JOIN_COLUMN
  const lead = item.slice(0, 1)
  if ((lead === '1' || lead === '2') && item.slice(1, 2) === '.') {
    return [Number(lead), Number(fieldIndex(item.slice(2)))]
  }
  if (lead === '0' || lead === '1' || lead === '2') {
    throw refusal(`invalid field specifier: '${quoteText(item)}'`)
  }
  throw refusal(`invalid file number in field spec: '${quoteText(item)}'`)
}

/** A `-j1` or `-j2` typed as a word of its own. */
interface LoneJ {
  /** The 1 or 2 it spells. */
  file: number
  /** The operand after it was taken as its field. */
  claimed: boolean
}

/** An operand standing as a file name. */
interface Operand {
  /** Its place among the line's operands. */
  position: number
  /** The operand as typed. */
  word: string
  /** The lone -jN typed right before it, which may still take it as a field number. */
  lone: LoneJ | null
  /** It came straight after an -o list, or after an operand that did, so it may be more of it. */
  listed: boolean
}

/** The options read so far, in the order the line typed them. Mirrors _Reading in join.py. */
class Reading {
  seen = 0
  readonly names: Operand[] = []
  readonly lone: LoneJ[] = []
  readonly keys: (bigint | null)[] = [null, null]
  readonly unpaired: [boolean, boolean] = [false, false]
  paired = true
  filler: string | null = null
  readonly columns: Column[] = []
  autoColumns = false
  delimiter: string | null = null
  separator = ' '
  foldCase = false
  terminator = '\n'
  order = OrderCheck.WARN
  header = false

  constructor(private readonly words: readonly string[]) {}

  setKey(side: number, index: bigint): void {
    const held = this.keys[side] ?? null
    if (held !== null && held !== index) {
      throw refusal(`incompatible join fields ${String(held)}, ${String(index)}`)
    }
    this.keys[side] = index
  }

  /**
   * File one operand, making room when two are already filed. A third
   * operand gives the earliest filed one that could be an option's value to
   * that option: the field number of the lone -jN before it (`join -j1 2 a b`
   * is `-1 2 a b`), or more of the -o list (`join -o 1.1 2.2 a b` is
   * `-o 1.1,2.2 a b`), appended where the list then ends. With no such
   * operand it is an extra one.
   */
  operand(typed: string, lone: LoneJ | null, listed: boolean): void {
    const position = this.seen++
    const word = this.words[position] ?? typed
    if (this.names.length === 2) {
      const at = this.names.findIndex((name) => name.lone !== null || name.listed)
      const taken = this.names[at]
      if (taken === undefined) throw extraOperandError(CommandName.JOIN, word)
      this.names.splice(at, 1)
      if (taken.lone !== null) {
        taken.lone.claimed = true
        this.setKey(taken.lone.file - 1, fieldIndex(taken.word))
      } else {
        this.addItems(taken.word)
      }
    }
    this.names.push({ position, word, lone, listed })
  }

  option(name: string, value: ParsedFlagValue): void {
    if (value === false) return
    const text = value === true ? '' : String(value)
    switch (name) {
      case 'a':
      case 'v':
        this.unpaired[fileNumber(text) - 1] = true
        this.paired = this.paired && name === 'a'
        break
      case 'e': {
        const filler = byteView(text)
        if (this.filler !== null && this.filler !== filler) {
          throw refusal('conflicting empty-field replacement strings')
        }
        this.filler = filler
        break
      }
      case 'args_1':
      case '2':
        this.setKey(name === 'args_1' ? 0 : 1, fieldIndex(text))
        break
      case 'j': {
        const index = fieldIndex(text)
        this.setKey(0, index)
        this.setKey(1, index)
        break
      }
      case 'o':
        this.addColumns(text)
        break
      case 't':
        this.setDelimiter(text)
        break
      case 'ignore_case':
        this.foldCase = true
        break
      case 'zero_terminated':
        this.terminator = '\0'
        break
      case 'check_order':
      case 'nocheck_order':
        this.order = name === 'check_order' ? OrderCheck.FAIL : OrderCheck.OFF
        break
      case 'header':
        this.header = true
        break
    }
  }

  addColumns(text: string): void {
    // Only the whole value `auto` is auto.
    if (text === 'auto') this.autoColumns = true
    else this.addItems(text)
  }

  addItems(text: string): void {
    // One separator may close the list (`-o '1.1,'`); any other empty item
    // is refused.
    const items = text.split(COLUMN_BREAK)
    if (items.length > 1 && items.at(-1) === '') items.pop()
    for (const item of items) this.columns.push(column(item))
  }

  setDelimiter(text: string): void {
    // `-t ''` keeps records whole but leaves the output separator as it
    // was; `\0` is NUL; any other value must be one byte.
    const raw = byteView(text)
    let byte: string
    if (raw === '') byte = WHOLE_RECORD
    else if (raw === '\\0') byte = '\0'
    else if (raw.length === 1) byte = raw
    else throw refusal(`multi-character tab '${quoteText(text)}'`)
    if (this.delimiter !== null && this.delimiter !== byte) throw refusal('incompatible tabs')
    this.delimiter = byte
    if (raw !== '') this.separator = byte
  }

  /**
   * Check the operands, then apply the lone -jN words left. A lone -jN whose
   * operand stayed a file name is `-j N`, and GNU 9.7 applies those after
   * every other option, every -j1 before every -j2: `join -j2 a -j1 b` is
   * refused as "incompatible join fields 0, 1".
   */
  finish(argv: readonly string[]): JoinFlags {
    if (this.names.length < 2 && (this.seen > 0 || argv.length > 0)) {
      throw missingOperandError(CommandName.JOIN, this.names.at(-1)?.word ?? null, argv)
    }
    for (const number of [1, 2]) {
      if (this.lone.some((j) => j.file === number && !j.claimed)) {
        this.setKey(0, BigInt(number - 1))
        this.setKey(1, BigInt(number - 1))
      }
    }
    const [one, two] = this.names
    return {
      keys: [Number(this.keys[0] ?? 0n), Number(this.keys[1] ?? 0n)],
      unpaired: [this.unpaired[0], this.unpaired[1]],
      paired: this.paired,
      filler: this.filler,
      columns: [...this.columns],
      autoColumns: this.autoColumns,
      delimiter: this.delimiter,
      separator: this.separator,
      foldCase: this.foldCase,
      terminator: this.terminator,
      order: this.order,
      header: this.header,
      files: one !== undefined && two !== undefined ? [one.position, two.position] : [0, 1],
    }
  }
}

/**
 * Read join's options and operands in the order the line typed them. GNU join
 * meets its options and operands in one pass, so the first problem left to
 * right is the one reported: `join a b c -a 3` names the extra operand,
 * `join -a 3 a b c` the file number. A `-j1` or `-j2` typed as one word and
 * followed at once by an operand may be the obsolete `-j1 FIELD`, and the
 * operands right after an -o list may be more of it: such an operand is taken
 * as the value only when a third operand needs the room (`join -j1 2 a b`),
 * and stays a file name otherwise (`join -j1 a b` is `join -j 1 a b`).
 * `operands` are the operands as typed, read after every option when the
 * tape places none, and `argv` the line's words after `join`, which the
 * missing-operand line names the last of. Mirrors parse_flags in join.py.
 */
export function parseFlags(
  flags: Context['flags'],
  operands: readonly string[] = [],
  argv: readonly string[] = [],
): JoinFlags {
  const reading = new Reading(operands)
  let spelled: string | null = null
  let fresh: LoneJ | null = null
  let listing = false
  const tape = new FlagView(flags, specOf(CommandName.JOIN)).occurrences(
    OPERAND,
    SPELLED,
    ...OPTION_DESTS,
  )
  for (const [name, value] of tape) {
    const afterWord: string | null = spelled
    const afterLone: LoneJ | null = fresh
    const afterList: boolean = listing
    spelled = null
    fresh = null
    listing = false
    if (name === SPELLED) {
      spelled = String(value)
    } else if (name === OPERAND) {
      reading.operand(String(value), afterLone, afterList)
      listing = afterList
    } else if (name === 'j' && afterWord !== null && afterWord in LONE_J_WORDS) {
      fresh = { file: LONE_J_WORDS[afterWord] ?? 1, claimed: false }
      reading.lone.push(fresh)
    } else {
      reading.option(name, value)
      listing = name === 'o' && value !== 'auto'
    }
  }
  // A mapping with no tape (a direct call) places no operand: the operands it
  // was given then follow every option, as plain files.
  if (reading.seen === 0) for (const word of operands) reading.operand(word, null, false)
  return reading.finish(argv)
}

/** The run stops here; what it printed so far still goes out. */
class Halt extends Error {}

/** One record of an input, split into fields; every string is a byte view. */
interface Line {
  /** The record without its terminator. */
  text: string
  /** Its fields; an empty record has none. */
  fields: string[]
  /** Its join field, empty when the record is short. */
  key: string
  /** What it sorts by: the key, upper-cased in ASCII under -i (so `_` sorts after `A`). */
  rank: string
}

/** One of the two files and how far its order check has come. */
interface Input {
  /** The operand as typed, a byte view for diagnostics. */
  name: string
  path: PathSpec
  reader: AsyncLineIterator
  key: number
  /** Whether its unpairable lines print. */
  shown: boolean
  /** Records read so far, the header included. */
  count: number
  /** The rank of the record before, null while nothing is there to compare with. */
  last: string | null
  /** Its disorder has been reported. */
  reported: boolean
  /** The record in hand, null past the end. */
  line: Line | null
  /** The reader's latest chunk. */
  chunk: Uint8Array
  /** Where the next record begins in `chunk`. */
  start: number
  /** Where it ends, -1 while its terminator has not come. */
  cut: number
  /** The start of a record that began in earlier chunks, kept as it came so a long record is copied once. */
  held: Uint8Array[]
  /** The reader has nothing more to give. */
  drained: boolean
}

function upperAscii(view: string): string {
  return view.replace(ASCII_LOWER, (run) => run.toUpperCase())
}

/**
 * Walk two sorted inputs side by side and print what pairs up. `names` are
 * the operands as typed, as byte views. Mirrors _Join in join.py.
 */
class JoinRun {
  readonly sides: readonly [Input, Input]
  private readonly blanks: RegExp
  private layout: Column[] | null
  private out: string[] = []
  private outSize = 0
  private errors = ''
  private status = 0
  // Whether a line has gone unpaired yet; the default order check stays
  // quiet until then.
  private loneSeen = false

  constructor(
    private readonly flags: JoinFlags,
    names: readonly [string, string],
    readonly inputs: readonly [AsyncLineIterator, AsyncLineIterator],
    paths: readonly [PathSpec, PathSpec],
  ) {
    const side = (n: 0 | 1): Input => ({
      name: names[n],
      path: paths[n],
      reader: inputs[n],
      key: flags.keys[n],
      shown: flags.unpaired[n],
      count: 0,
      last: null,
      reported: false,
      line: null,
      chunk: new Uint8Array(0),
      start: 0,
      cut: -1,
      held: [],
      drained: false,
    })
    this.sides = [side(0), side(1)]
    this.blanks = flags.terminator === '\0' ? BLANK_SPLIT_NUL : BLANK_SPLIT
    this.layout = flags.columns.length > 0 ? [...flags.columns] : null
  }

  outcome(): IOResult {
    return new IOResult({ exitCode: this.status, stderr: fromByteView(this.errors) })
  }

  private take(): Uint8Array {
    const data = fromByteView(this.out.join(''))
    this.out = []
    this.outSize = 0
    return data
  }

  async *run(): AsyncIterable<Uint8Array> {
    // Every record is taken through inHand, and when one is not, refill
    // hands on what is printed before it waits for input.
    try {
      const [first, second] = this.sides
      await this.open()
      for (const side of this.sides) {
        if (!this.inHand(side)) yield* this.refill(side)
        this.advance(side)
      }
      if (this.flags.header && (first.line !== null || second.line !== null)) {
        // The header lines are printed even under -v, the lone one when the
        // other file is empty, and nothing after them is compared with them.
        this.settleLayout(first.line, second.line)
        this.printHeader(first.line, second.line)
        first.last = null
        second.last = null
        for (const side of this.sides) {
          if (!this.inHand(side)) yield* this.refill(side)
          this.advance(side)
        }
      } else {
        this.settleLayout(first.line, second.line)
      }
      while (first.line !== null && second.line !== null) {
        if (first.line.rank !== second.line.rank) {
          // The next line is read, and its order checked, before this one
          // counts as unpaired: in `join a b` over `a 1/c 2/b 3` and
          // `a x/z q`, `b 3` follows the first unpaired line and goes
          // unreported (GNU 9.7).
          const index = first.line.rank < second.line.rank ? 0 : 1
          const side = this.sides[index]
          if (side.shown) this.printAlone(index, index === 0 ? first.line : second.line)
          if (!this.inHand(side)) yield* this.refill(side)
          this.advance(side)
          this.loneSeen = true
        } else {
          const groups: Line[][] = []
          for (const side of this.sides) {
            const head = side.line
            if (head === null) break
            const group = [head]
            for (;;) {
              if (!this.inHand(side)) yield* this.refill(side)
              this.advance(side)
              if (side.line?.rank !== head.rank) break
              group.push(side.line)
            }
            groups.push(group)
          }
          // Two groups of n equal keys make n * n lines, so the output goes
          // on as it fills rather than per group.
          const [lefts = [], rights = []] = groups
          if (this.flags.paired) {
            for (const one of lefts) {
              for (const other of rights) {
                this.printPair(one, other)
                if (this.outSize >= CHUNK) yield this.take()
              }
            }
          }
        }
        if (this.outSize >= CHUNK) yield this.take()
      }
      // Once the other file has ended no line counts as unpaired: `join a b`
      // over `a 1` and `a x/c y/b z/a w` reports nothing.
      for (const index of [0, 1] as const) {
        const side = this.sides[index]
        while (side.line !== null && this.stillReading(index)) {
          if (side.shown) this.printAlone(index, side.line)
          if (!this.inHand(side)) yield* this.refill(side)
          this.advance(side)
          if (this.outSize >= CHUNK) yield this.take()
        }
      }
      if (this.flags.order === OrderCheck.WARN && this.sides.some((side) => side.reported)) {
        this.errors += 'join: input is not in sorted order\n'
      }
    } catch (error) {
      if (!(error instanceof Halt)) throw error
    }
    if (this.out.length > 0) yield this.take()
  }

  private async open(): Promise<void> {
    // GNU opens both files before it reads either: a missing FILE2 is
    // reported over a FILE1 that cannot be read (`join dir missing`).
    // Stdin is already open, so it is never read here: `join dir -` reports
    // the directory without waiting on input.
    let unreadable: [Input, unknown] | null = null
    for (const side of this.sides) {
      if (isStdin(side.path)) continue
      try {
        await side.reader.peek()
      } catch (error) {
        if (!isFsError(error)) throw error
        if (neverOpened(side.reader, side.path, error)) this.fail(side, error)
        unreadable ??= [side, error]
      }
    }
    if (unreadable !== null) this.fail(...unreadable)
  }

  private fail(side: Input, error: unknown): never {
    const line = neverOpened(side.reader, side.path, error)
      ? fsErrorLine(CommandName.JOIN, side.path, error)
      : `join: read error: ${fsStrerror(error) ?? String(error)}\n`
    this.errors += byteView(line)
    this.status = 1
    throw new Halt()
  }

  private stillReading(index: 0 | 1): boolean {
    // Past the other file's end a line is read only to print it or to look
    // at its order.
    const side = this.sides[index]
    const order = this.flags.order
    return side.shown || order === OrderCheck.FAIL || (order === OrderCheck.WARN && !side.reported)
  }

  /**
   * Whether the next record can be taken without waiting for input. Only the
   * latest chunk is searched: what `held` keeps has no terminator in it.
   */
  private inHand(side: Input): boolean {
    side.cut = side.chunk.indexOf(this.flags.terminator.charCodeAt(0), side.start)
    return side.cut >= 0 || side.drained
  }

  /**
   * Read on until a record is in hand, handing on what is printed before each
   * read that may wait: under `join -a1 - empty` a line reaches a reader
   * before the next one is typed. `side` has no record in hand.
   */
  private async *refill(side: Input): AsyncIterable<Uint8Array> {
    for (;;) {
      if (this.out.length > 0) yield this.take()
      // The unread tail is copied before the next read: a source may fill the
      // same memory again for its next chunk.
      if (side.start < side.chunk.length) side.held.push(side.chunk.slice(side.start))
      side.chunk = new Uint8Array(0)
      side.start = 0
      let chunk: Uint8Array | null
      try {
        chunk = await side.reader.readChunk()
      } catch (error) {
        if (!isFsError(error)) throw error
        this.fail(side, error)
      }
      if (chunk === null) {
        side.drained = true
        return
      }
      side.chunk = chunk
      if (this.inHand(side)) return
    }
  }

  /** Take the record `inHand` found as the input's current one, and check its order. */
  private advance(side: Input): void {
    let tail: Uint8Array
    if (side.cut >= 0) {
      tail = side.chunk.subarray(side.start, side.cut)
      side.start = side.cut + 1
    } else if (side.held.length > 0 || side.start < side.chunk.length) {
      // The last record, with no terminator after it.
      tail = side.chunk.subarray(side.start)
      side.start = side.chunk.length
    } else {
      side.line = null
      return
    }
    let text: string
    if (side.held.length > 0) {
      side.held.push(tail)
      text = side.held.map((piece) => byteView(piece)).join('')
      side.held = []
    } else {
      text = byteView(tail)
    }
    side.cut = -1
    side.count += 1
    const line = this.split(side, text)
    if (side.last !== null && line.rank < side.last && this.flags.order !== OrderCheck.OFF) {
      this.outOfOrder(side, line)
    }
    side.last = line.rank
    side.line = line
  }

  private outOfOrder(side: Input, line: Line): void {
    if (this.flags.order === OrderCheck.WARN && (side.reported || !this.loneSeen)) return
    // The line is named up to its first NUL, as GNU 9.7 prints it.
    const nul = line.text.indexOf('\0')
    const shown = nul < 0 ? line.text : line.text.slice(0, nul)
    this.errors += `join: ${side.name}:${String(side.count)}: is not sorted: ${shown}\n`
    this.status = 1
    side.reported = true
    if (this.flags.order === OrderCheck.FAIL) throw new Halt()
  }

  private split(side: Input, text: string): Line {
    const delimiter = this.flags.delimiter
    let fields: string[]
    if (text === '') fields = []
    else if (delimiter === null) fields = text.match(this.blanks) ?? []
    else if (delimiter === WHOLE_RECORD) fields = [text]
    else fields = text.split(delimiter)
    const key = fields[side.key] ?? ''
    return { text, fields, key, rank: this.flags.foldCase ? upperAscii(key) : key }
  }

  private settleLayout(left: Line | null, right: Line | null): void {
    // -o auto takes each file's field count from its first line, the header
    // when there is one; an empty file counts none.
    if (this.layout !== null || !this.flags.autoColumns) return
    const layout: Column[] = [JOIN_COLUMN]
    const firsts: [number, Line | null][] = [
      [1, left],
      [2, right],
    ]
    for (const [number, line] of firsts) {
      const skip = this.flags.keys[number - 1]
      const count = line?.fields.length ?? 0
      for (let i = 0; i < count; i++) if (i !== skip) layout.push([number, i])
    }
    this.layout = layout
  }

  private printHeader(left: Line | null, right: Line | null): void {
    if (left !== null && right !== null) this.printPair(left, right)
    else if (left !== null) this.printAlone(0, left)
    else if (right !== null) this.printAlone(1, right)
  }

  private print(values: string[]): void {
    const filler = this.flags.filler
    const shown = filler === null ? values : values.map((value) => (value === '' ? filler : value))
    const text = shown.join(this.flags.separator) + this.flags.terminator
    this.out.push(text)
    this.outSize += text.length
  }

  private others(line: Line, index: number): string[] {
    const skip = this.flags.keys[index]
    return line.fields.filter((_, i) => i !== skip)
  }

  private pick(item: Column, lines: readonly [Line | null, Line | null], key: string): string {
    const [number, index] = item
    if (number === 0) return key
    return lines[number - 1]?.fields[index] ?? ''
  }

  private printPair(left: Line, right: Line): void {
    // A joined line shows FILE1's spelling of the key, as -i joins `a` with `A`.
    if (this.layout === null) {
      this.print([left.key, ...this.others(left, 0), ...this.others(right, 1)])
    } else {
      const lines = [left, right] as const
      this.print(this.layout.map((item) => this.pick(item, lines, left.key)))
    }
  }

  private printAlone(index: 0 | 1, line: Line): void {
    if (this.layout === null) {
      this.print([line.key, ...this.others(line, index)])
    } else {
      const lines = index === 0 ? ([line, null] as const) : ([null, line] as const)
      this.print(this.layout.map((item) => this.pick(item, lines, line.key)))
    }
  }
}

export interface JoinIO {
  read: (p: PathSpec) => AsyncIterable<Uint8Array>
  stdin: ByteSource | null
  flags: JoinFlags
}

/**
 * GNU `join` of two files over already-parsed options: `paths` are the
 * operands, of which `flags.files` names the two files. Mirrors join in
 * join.py.
 */
export function join(paths: PathSpec[], io: JoinIO): [ByteSource | null, IOResult] {
  const p1 = paths[io.flags.files[0]]
  const p2 = paths[io.flags.files[1]]
  if (p1 === undefined || p2 === undefined) {
    throw missingOperandError(CommandName.JOIN, paths.at(-1)?.rawPath ?? null, [])
  }
  if (p1.rawPath === '-' && p2.rawPath === '-') {
    return [
      null,
      new IOResult({
        exitCode: 1,
        stderr: new TextEncoder().encode('join: both files cannot be standard input\n'),
      }),
    ]
  }
  const stream = stdinStream(io.read, io.stdin)
  const readers = [new AsyncLineIterator(stream(p1)), new AsyncLineIterator(stream(p2))] as const
  const merge = new JoinRun(io.flags, [byteView(p1.rawPath), byteView(p2.rawPath)], readers, [
    p1,
    p2,
  ])
  const result = new IOResult()
  return [joinStream(merge, result), result]
}

async function* joinStream(merge: JoinRun, io: IOResult): AsyncIterable<Uint8Array> {
  try {
    yield* merge.run()
  } finally {
    const result = merge.outcome()
    io.exitCode = result.exitCode
    io.stderr = result.stderr
    for (const reader of merge.inputs) await reader.discard()
  }
}

/**
 * The builder's entry point: parse the line's flags, then `join`. Each operand's
 * glob expands on its own, so the option loop sees its matches where the
 * word was typed (`join -j1 2 *.txt`). Mirrors join_generic in join.py.
 */
export async function joinGeneric(
  paths: PathSpec[],
  ctx: Context,
  resolveGlob: (targets: PathSpec[]) => Promise<PathSpec[]>,
  read: (p: PathSpec) => AsyncIterable<Uint8Array>,
): Promise<CommandFnResult> {
  const groups: PathSpec[][] = []
  for (const path of paths) groups.push(await resolveGlob([path]))
  const resolved = groups.flat()
  const flags = spreadOperands(
    ctx.flags,
    groups.map((group) => group.map((path) => path.rawPath)),
  )
  return join(resolved, {
    read,
    stdin: ctx.stdin,
    flags: parseFlags(
      flags,
      resolved.map((path) => path.rawPath),
      ctx.argv ?? [],
    ),
  })
}
