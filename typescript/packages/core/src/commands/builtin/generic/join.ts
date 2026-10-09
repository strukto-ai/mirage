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

import { specOf } from '../../spec/builtins.ts'
import { OPERAND, SPELLED } from '../../spec/constants.ts'
import { FlagView, spreadOperands } from '../../spec/flag_view.ts'
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { UsageError } from '../../errors.ts'
import { quoteText } from '../../quote.ts'
import { extraOperandError, missingOperandError } from '../../spec/usage.ts'
import { CommandName, type ParsedFlagValue } from '../../spec/types.ts'
import { byteView, fromByteView } from '../../../shell/bytes.ts'
import { stdinStream } from '../utils/stream.ts'

const IDX_MAX = (1n << 63n) - 1n
const INTMAX_MIN = -(1n << 63n)
const WHOLE_LINE = '\n'
const FIELD_RUN = /[^ \t\n]+/g
const INTEGER = /^[ \t\n\v\f\r]*([+-]?[0-9]+)$/
const OUTLIST_SEPARATOR = /[, \t]/
const ASCII_LOWER = /[a-z]+/g
const OPTIONS = [
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

/** join.c's `check_input_order`: whether disorder is diagnosed. */
export enum CheckOrder {
  DEFAULT = 'default',
  ENABLED = 'enabled',
  DISABLED = 'disabled',
}

/**
 * join's options once GNU's option loop has run, in join.c's terms. Every
 * byte-valued field is a byte view: one character per byte, so a string
 * comparison is join.c's memcmp. `files` says which operands are FILE1 and
 * FILE2, since the obsolete `-j1 FIELD`, `-j2 FIELD` and `-o LIST...` forms
 * take operands as option values. Mirrors JoinFlags in join.py.
 */
export interface JoinFlags {
  readonly field1: number
  readonly field2: number
  readonly tab: string | null
  readonly outputSeparator: string
  readonly unpairables1: boolean
  readonly unpairables2: boolean
  readonly pairables: boolean
  readonly emptyFiller: string | null
  readonly outlist: readonly (readonly [number, number])[]
  readonly autoformat: boolean
  readonly ignoreCase: boolean
  readonly eol: string
  readonly checkOrder: CheckOrder
  readonly header: boolean
  readonly files: readonly [number, number]
}

/** join.c's operand_status: what a filed operand may turn out to be. */
enum Status {
  MUST_BE_OPERAND = 'operand',
  MIGHT_BE_J1_ARG = 'j1',
  MIGHT_BE_J2_ARG = 'j2',
  MIGHT_BE_O_ARG = 'o',
}

interface Filed {
  readonly index: number
  readonly word: string
  readonly status: Status
}

// `xstrtoimax` with no valid suffix: the value, or null if invalid.
function strtoimax(text: string): bigint | null {
  const match = INTEGER.exec(text)
  return match === null ? null : BigInt(match[1] ?? '')
}

// join.c's `string_to_join_field`: a 1-based field, made 0-based.
function joinField(text: string): bigint {
  let value = strtoimax(text)
  if (value !== null && (value < INTMAX_MIN || value > IDX_MAX)) value = IDX_MAX
  if (value === null || value <= 0n) {
    throw new UsageError(`join: invalid field number: '${quoteText(text)}'`, 1)
  }
  return value - 1n
}

// The FILENUM of `-a` or `-v`: 1 or 2.
function fileNumber(text: string): 1 | 2 {
  const value = strtoimax(text)
  if (value === 1n) return 1
  if (value === 2n) return 2
  throw new UsageError(`join: invalid file number: '${quoteText(text)}'`, 1)
}

// join.c's `decode_field_spec`: one `-o` item as [file, field].
function fieldSpec(spec: string): [number, bigint] {
  const head = spec.slice(0, 1)
  if (head === '0') {
    if (spec.length > 1) {
      throw new UsageError(`join: invalid field specifier: '${quoteText(spec)}'`, 1)
    }
    return [0, 0n]
  }
  if (head === '1' || head === '2') {
    if (spec.slice(1, 2) !== '.') {
      throw new UsageError(`join: invalid field specifier: '${quoteText(spec)}'`, 1)
    }
    return [Number(head), joinField(spec.slice(2))]
  }
  throw new UsageError(`join: invalid file number in field spec: '${quoteText(spec)}'`, 1)
}

// join.c's `add_field_list`: items split at a comma or blank. A separator
// that ends the list closes it, which is why `-o 1.1,` is accepted while
// `-o 1.1,,2.1` names an empty item.
function fieldList(text: string): [number, bigint][] {
  const specs: [number, bigint][] = []
  let rest = text
  for (;;) {
    const match = OUTLIST_SEPARATOR.exec(rest)
    specs.push(fieldSpec(match === null ? rest : rest.slice(0, match.index)))
    if (match === null || match.index + 1 === rest.length) return specs
    rest = rest.slice(match.index + 1)
  }
}

function setJoinField(current: bigint | null, value: bigint): bigint {
  if (current !== null && current !== value) {
    throw new UsageError(`join: incompatible join fields ${String(current)}, ${String(value)}`, 1)
  }
  return value
}

// The state join.c's option loop builds, before it is frozen.
class Options {
  field1: bigint | null = null
  field2: bigint | null = null
  tab: string | null = null
  literalTab = false
  unpairables: [boolean, boolean] = [false, false]
  pairables = true
  emptyFiller: string | null = null
  outlist: [number, bigint][] = []
  autoformat = false
  ignoreCase = false
  zero = false
  checkOrder = CheckOrder.DEFAULT
  header = false
  files: Filed[] = []
  joptionCount: [number, number] = [0, 0]

  setTab(text: string): void {
    const raw = byteView(text)
    let tab = raw === '' ? WHOLE_LINE : raw
    if (raw.length > 1) {
      if (raw !== '\\0') {
        throw new UsageError(`join: multi-character tab '${quoteText(text)}'`, 1)
      }
      tab = '\0'
    }
    if (this.tab !== null && this.tab !== tab) throw new UsageError('join: incompatible tabs', 1)
    this.tab = tab
    this.literalTab ||= raw !== ''
  }

  // Take one option, and say what the next operand may be. `spelled` is
  // whether it was typed as a lone `-j1` or `-j2` (SPELLED_WORDS).
  apply(name: string, value: ParsedFlagValue, spelled: boolean): Status {
    const text = typeof value === 'string' ? value : ''
    if (name === 'j' && spelled) {
      const isJ2 = text === '2'
      this.joptionCount[isJ2 ? 1 : 0] += 1
      return isJ2 ? Status.MIGHT_BE_J2_ARG : Status.MIGHT_BE_J1_ARG
    }
    if (name === 'o' && text !== 'auto') {
      this.outlist.push(...fieldList(text))
      return Status.MIGHT_BE_O_ARG
    }
    if (name === 'a' || name === 'v') {
      if (name === 'v') this.pairables = false
      this.unpairables[fileNumber(text) - 1] = true
    } else if (name === 'e') {
      const raw = byteView(text)
      if (this.emptyFiller !== null && this.emptyFiller !== raw) {
        throw new UsageError('join: conflicting empty-field replacement strings', 1)
      }
      this.emptyFiller = raw
    } else if (name === 'args_1') {
      this.field1 = setJoinField(this.field1, joinField(text))
    } else if (name === '2') {
      this.field2 = setJoinField(this.field2, joinField(text))
    } else if (name === 'j') {
      const field = setJoinField(this.field1, joinField(text))
      this.field1 = field
      this.field2 = setJoinField(this.field2, field)
    } else if (name === 'o') {
      this.autoformat = true
    } else if (name === 't') {
      this.setTab(text)
    } else if (name === 'ignore_case') {
      this.ignoreCase = true
    } else if (name === 'zero_terminated') {
      this.zero = true
    } else if (name === 'check_order') {
      this.checkOrder = CheckOrder.ENABLED
    } else if (name === 'nocheck_order') {
      this.checkOrder = CheckOrder.DISABLED
    } else if (name === 'header') {
      this.header = true
    }
    return Status.MUST_BE_OPERAND
  }

  // join.c's add_file_name: file an operand, taking an earlier one as an
  // option's value when a third arrives, and say what the next operand may be.
  addFile(index: number, word: string, status: Status): Status {
    const [first, second] = this.files
    if (first !== undefined && second !== undefined) {
      const op0 = first.status === Status.MUST_BE_OPERAND
      const taken = op0 ? second : first
      if (taken.status === Status.MUST_BE_OPERAND) {
        throw extraOperandError(CommandName.JOIN, word)
      }
      if (taken.status === Status.MIGHT_BE_J1_ARG) {
        this.joptionCount[0] -= 1
        this.field1 = setJoinField(this.field1, joinField(taken.word))
      } else if (taken.status === Status.MIGHT_BE_J2_ARG) {
        this.joptionCount[1] -= 1
        this.field2 = setJoinField(this.field2, joinField(taken.word))
      } else {
        this.outlist.push(...fieldList(taken.word))
      }
      this.files.splice(op0 ? 1 : 0, 1)
    }
    this.files.push({ index, word, status })
    return status === Status.MIGHT_BE_O_ARG ? Status.MIGHT_BE_O_ARG : Status.MUST_BE_OPERAND
  }

  // A `-j1` or `-j2` no operand was taken for is `-j 1` or `-j 2`.
  settleJ(): void {
    for (const which of [0, 1] as const) {
      if (this.joptionCount[which] !== 0) {
        this.field1 = setJoinField(this.field1, BigInt(which))
        this.field2 = setJoinField(this.field2, BigInt(which))
      }
    }
  }

  freeze(): JoinFlags {
    const separator =
      this.tab !== null && (this.tab !== WHOLE_LINE || this.literalTab) ? this.tab : ' '
    return {
      field1: Number(this.field1 ?? 0n),
      field2: Number(this.field2 ?? 0n),
      tab: this.tab,
      outputSeparator: separator,
      unpairables1: this.unpairables[0],
      unpairables2: this.unpairables[1],
      pairables: this.pairables,
      emptyFiller: this.emptyFiller,
      outlist: this.outlist.map(([file, field]) => [file, Number(field)] as const),
      autoformat: this.autoformat,
      ignoreCase: this.ignoreCase,
      eol: this.zero ? '\0' : '\n',
      checkOrder: this.checkOrder,
      header: this.header,
      files:
        this.files[0] !== undefined && this.files[1] !== undefined
          ? [this.files[0].index, this.files[1].index]
          : [0, 1],
    }
  }
}

/**
 * Run join.c's option loop over the occurrences in typed order.
 *
 * Each option takes effect where it was typed, so `-a1 -a2` asks for both
 * files, the later of `--check-order` and `--nocheck-order` wins, and a
 * second `-1`, `-t` or `-e` that disagrees with the first is GNU's
 * refusal. The operands are read there too, as join's RETURN_IN_ORDER getopt
 * hands them over: a third one is refused where it stands, or turns an
 * earlier one into the value of an obsolete `-j1 FIELD`, `-j2 FIELD` or
 * `-o LIST...`. A glob's matches stand where it was typed once
 * `spreadOperands` has put them on the tape. Operands the tape does not
 * place, from a call that never went through the shell, follow the options,
 * as after `--`. `operands` null reads the options alone.
 * Mirrors parse_flags in join.py.
 */
export function parseFlags(
  flags: CommandOpts['flags'],
  operands: readonly string[] | null = null,
  argv: readonly string[] = [],
): JoinFlags {
  const options = new Options()
  const words = operands ?? []
  let tape = new FlagView(flags, specOf('join')).occurrences(...OPTIONS, OPERAND, SPELLED)
  if (tape.filter(([name]) => name === OPERAND).length !== words.length) {
    tape = tape.filter(([name]) => name !== OPERAND)
  }
  let status = Status.MUST_BE_OPERAND
  let spelled = false
  let afterDashes = false
  let index = 0
  for (const [name, value] of tape) {
    if (name === SPELLED) {
      afterDashes ||= value === '--'
      spelled = value !== '--'
    } else if (name === OPERAND) {
      const word = words[index] ?? ''
      if (afterDashes) options.addFile(index, word, Status.MUST_BE_OPERAND)
      else status = options.addFile(index, word, status)
      index += 1
    } else {
      status = options.apply(name, value, spelled)
      spelled = false
    }
  }
  for (let rest = index; rest < words.length; rest += 1) {
    options.addFile(rest, words[rest] ?? '', Status.MUST_BE_OPERAND)
  }
  if (operands !== null && options.files.length < 2) {
    throw missingOperandError(CommandName.JOIN, options.files.at(-1)?.word ?? null, argv)
  }
  options.settleJ()
  return options.freeze()
}

interface Line {
  readonly record: string
  readonly fields: readonly string[]
  readonly key: string
}

const BLANK: Line = { record: '', fields: [], key: '' }

function splitFields(record: string, tab: string | null): string[] {
  if (record === '') return []
  if (tab === null) return record.match(FIELD_RUN) ?? []
  if (tab === WHOLE_LINE) return [record]
  return record.split(tab)
}

function keycmp(left: string, right: string): number {
  if (left === '') return right === '' ? 0 : -1
  if (right === '') return 1
  return left < right ? -1 : left > right ? 1 : 0
}

function splitRecords(data: string, eol: string): string[] {
  const records = data.split(eol)
  if (records[records.length - 1] === '') records.pop()
  return records
}

/**
 * join.c's `join`: a merge of two inputs read one line at a time.
 *
 * Disorder is diagnosed as each line is read, against the previous line of
 * the same file: always under --check-order, which stops the run where it
 * stands, and by default only once an unpairable line has been seen, once
 * per file. Both are why the order check is read-driven rather than a
 * property of the whole input. Mirrors _Merge in join.py.
 */
class Merge {
  private readonly fields: readonly [number, number]
  private readonly read: [number, number] = [0, 0]
  private previous: [Line | null, Line | null] = [null, null]
  private readonly warned: [boolean, boolean] = [false, false]
  private seenUnpairable = false
  private fatal = false
  private autocount: [number, number] = [0, 0]
  private readonly out: string[] = []
  private readonly err: string[] = []

  constructor(
    private readonly flags: JoinFlags,
    private readonly names: readonly [string, string],
    private readonly inputs: readonly [string[], string[]],
  ) {
    this.fields = [flags.field1, flags.field2]
  }

  private getLine(which: 0 | 1): Line | null {
    const records = this.inputs[which]
    if (this.fatal || this.read[which] === records.length) return null
    const record = records[this.read[which]] ?? ''
    this.read[which] += 1
    const fields = splitFields(record, this.flags.tab)
    const key = fields[this.fields[which]] ?? ''
    const line: Line = {
      record,
      fields,
      key: this.flags.ignoreCase ? key.replace(ASCII_LOWER, (run) => run.toUpperCase()) : key,
    }
    const previous = this.previous[which]
    this.previous[which] = line
    return previous !== null && this.checkOrder(previous, line, which) ? null : line
  }

  // Diagnose LINE against PREVIOUS; whether the run stops here.
  private checkOrder(previous: Line, line: Line, which: 0 | 1): boolean {
    const mode = this.flags.checkOrder
    if (mode === CheckOrder.DISABLED || this.warned[which]) return false
    if (mode === CheckOrder.DEFAULT && !this.seenUnpairable) return false
    if (keycmp(previous.key, line.key) <= 0) return false
    const text = line.record.split('\0', 1)[0] ?? ''
    this.err.push(
      `join: ${this.names[which]}:${String(this.read[which])}: is not sorted: ${text}\n`,
    )
    if (mode === CheckOrder.ENABLED) this.fatal = true
    else this.warned[which] = true
    return this.fatal
  }

  private prfield(index: number, line: Line): string {
    const value = line.fields[index] ?? ''
    if (value !== '' || this.flags.emptyFiller === null) return value
    return this.flags.emptyFiller
  }

  private prfields(line: Line, which: 0 | 1): string[] {
    const count = this.flags.autoformat ? this.autocount[which] : line.fields.length
    const parts: string[] = []
    for (let i = 0; i < count; i += 1) {
      if (i !== this.fields[which]) parts.push(this.prfield(i, line))
    }
    return parts
  }

  private emit(line1: Line, line2: Line): void {
    if (this.fatal) return
    const key =
      line1 === BLANK ? this.prfield(this.fields[1], line2) : this.prfield(this.fields[0], line1)
    const parts =
      this.flags.outlist.length > 0
        ? this.flags.outlist.map(([file, index]) =>
            file === 0 ? key : this.prfield(index, file === 1 ? line1 : line2),
          )
        : [key, ...this.prfields(line1, 0), ...this.prfields(line2, 1)]
    this.out.push(parts.join(this.flags.outputSeparator) + this.flags.eol)
  }

  private first(which: 0 | 1): Line[] {
    const line = this.getLine(which)
    return line === null ? [] : [line]
  }

  // Read file WHICH while it matches OTHER; whether it hit EOF.
  private runOf(which: 0 | 1, run: Line[], other: Line): boolean {
    for (;;) {
      const line = this.getLine(which)
      if (line === null) return true
      run.push(line)
      if (keycmp(line.key, other.key) !== 0) return false
    }
  }

  // Finish the file left over once the other one ended. Its lines are
  // unpairable, printed under -a or -v, and still read for the order check
  // unless --nocheck-order, though they never count as unpairable for the
  // default check themselves.
  private tail(which: 0 | 1, run: readonly Line[]): void {
    const unpairables = which === 0 ? this.flags.unpairables1 : this.flags.unpairables2
    const checktail =
      this.flags.checkOrder !== CheckOrder.DISABLED && !(this.warned[0] && this.warned[1])
    let line = run[0] ?? null
    if (line === null || !(unpairables || checktail)) return
    while (line !== null) {
      if (unpairables) {
        if (which === 0) this.emit(line, BLANK)
        else this.emit(BLANK, line)
      }
      line = this.warned[which] && !unpairables ? null : this.getLine(which)
    }
  }

  run(): void {
    let seq1 = this.first(0)
    let seq2 = this.first(1)
    if (this.flags.autoformat) {
      this.autocount = [seq1[0]?.fields.length ?? 0, seq2[0]?.fields.length ?? 0]
    }
    if (this.flags.header && (seq1.length > 0 || seq2.length > 0)) {
      this.emit(seq1[0] ?? BLANK, seq2[0] ?? BLANK)
      this.previous = [null, null]
      if (seq1.length > 0) seq1 = this.first(0)
      if (seq2.length > 0) seq2 = this.first(1)
    }
    for (;;) {
      const head1 = seq1[0]
      const head2 = seq2[0]
      if (head1 === undefined || head2 === undefined) break
      const diff = keycmp(head1.key, head2.key)
      if (diff < 0) {
        if (this.flags.unpairables1) this.emit(head1, BLANK)
        seq1 = this.first(0)
        this.seenUnpairable = true
        continue
      }
      if (diff > 0) {
        if (this.flags.unpairables2) this.emit(BLANK, head2)
        seq2 = this.first(1)
        this.seenUnpairable = true
        continue
      }
      const eof1 = this.runOf(0, seq1, head2)
      const eof2 = this.runOf(1, seq2, head1)
      if (this.flags.pairables) {
        for (const line1 of eof1 ? seq1 : seq1.slice(0, -1)) {
          for (const line2 of eof2 ? seq2 : seq2.slice(0, -1)) this.emit(line1, line2)
        }
      }
      seq1 = eof1 ? [] : seq1.slice(-1)
      seq2 = eof2 ? [] : seq2.slice(-1)
    }
    this.tail(0, seq1)
    this.tail(1, seq2)
  }

  result(): [ByteSource, IOResult] {
    let stderr = this.err.join('')
    if (!this.fatal && (this.warned[0] || this.warned[1])) {
      stderr += 'join: input is not in sorted order\n'
    }
    return [
      fromByteView(this.out.join('')),
      new IOResult({
        stderr: stderr === '' ? null : fromByteView(stderr),
        exitCode: stderr === '' ? 0 : 1,
      }),
    ]
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
export async function join(paths: PathSpec[], io: JoinIO): Promise<[ByteSource | null, IOResult]> {
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
  const data1 = byteView(await materialize(stream(p1)))
  const data2 = byteView(await materialize(stream(p2)))
  const merge = new Merge(
    io.flags,
    [byteView(p1.rawPath), byteView(p2.rawPath)],
    [splitRecords(data1, io.flags.eol), splitRecords(data2, io.flags.eol)],
  )
  merge.run()
  return merge.result()
}

/**
 * The builder's entry point: parse the line's flags, then `join`. Each operand's
 * glob expands on its own, so the option loop sees its matches where the
 * word was typed (`join -j1 2 *.txt`). Mirrors join_generic in join.py.
 */
export async function joinGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  resolveGlob: (targets: PathSpec[]) => Promise<PathSpec[]>,
  read: (p: PathSpec) => AsyncIterable<Uint8Array>,
): Promise<CommandFnResult> {
  const groups: PathSpec[][] = []
  for (const path of paths) groups.push(await resolveGlob([path]))
  const resolved = groups.flat()
  const flags = spreadOperands(
    opts.flags,
    groups.map((group) => group.map((path) => path.rawPath)),
  )
  return join(resolved, {
    read,
    stdin: opts.stdin,
    flags: parseFlags(
      flags,
      resolved.map((path) => path.rawPath),
      opts.argv ?? [],
    ),
  })
}
