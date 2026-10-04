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

import { fromByteView } from '../../shell/bytes.ts'
import { GetlineKind, RedirKind } from './nodes.ts'

import {
  indexOf,
  matchPosition,
  nextRandom,
  safeExp,
  safeFmod,
  safeLog,
  safePow,
  safeSqrt,
  safeTrig,
  splitAssignment,
  splitRecord,
  sprintf,
  substitute,
  substr,
} from './builtins.ts'
import { AwkIOError, AwkRuntimeError } from './errors.ts'
import {
  RuleKind,
  type Assign,
  type Binary,
  type BuiltinCall,
  type Call,
  type Compare,
  type Delete,
  type DoWhile,
  type Expr,
  type For,
  type ForIn,
  type Getline,
  type IncDec,
  type Logical,
  type Print,
  type Printf,
  type Program,
  type Rule,
  type Stmt,
  type While,
} from './nodes.ts'
import { RecordReader } from './reader.ts'
import { compileEre, searchFrom } from './regex.ts'
import type { AwkHost } from './types.ts'
import {
  UNINIT,
  ValueKind,
  compare,
  formatNum,
  isTrue,
  num,
  strnum,
  text,
  toIndex,
  toNum,
  toStr,
  type Value,
} from './value.ts'
import { concat } from '../../io/cachable_iterator.ts'

const SCALAR_DEFAULTS: Readonly<Record<string, string>> = {
  FS: ' ',
  OFS: ' ',
  ORS: '\n',
  RS: '\n',
  SUBSEP: '\x1c',
  CONVFMT: '%.6g',
  OFMT: '%.6g',
  FILENAME: '',
  RSTART: '0',
  RLENGTH: '-1',
}

const COUNTERS: ReadonlySet<string> = new Set(['NR', 'FNR', 'NF'])

const ARITY: Readonly<Record<string, number>> = {
  close: 1,
  atan2: 2,
  cos: 1,
  exp: 1,
  index: 2,
  int: 1,
  log: 1,
  match: 2,
  sin: 1,
  split: 2,
  sprintf: 1,
  sqrt: 1,
  sub: 2,
  gsub: 2,
  substr: 2,
  system: 1,
  tolower: 1,
  toupper: 1,
}

const STDOUT_NAMES: ReadonlySet<string> = new Set(['/dev/stdout', '-'])
const STDERR_NAME = '/dev/stderr'
const PROGRAM_NAME = 'awk'

const MAX_CALL_DEPTH = 100

const PLAIN_PRINT: Print = { type: 'Print', args: [], redirect: null }

class NextRecord extends Error {}

class NextFileSignal extends Error {}

class BreakLoop extends Error {}

class ContinueLoop extends Error {}

class ReturnValue extends Error {
  readonly value: Value

  constructor(value: Value) {
    super()
    this.value = value
  }
}

export class ExitProgram extends Error {
  readonly code: number

  constructor(code: number) {
    super()
    this.code = code
  }
}

type AwkArray = Map<string, Value>

interface Frame {
  readonly params: ReadonlySet<string>
  readonly scalars: Map<string, Value>
  readonly tables: Map<string, AwkArray>
}

/** A `cmd | getline` stream: the command's output records and its exit status. */
export interface InputPipe {
  readonly reader: RecordReader
  readonly status: number
}

/**
 * Run one awk program against the streams its host opens. Every stream
 * the program names goes through `host`: the main input operands,
 * `getline < file`, output files and the command pipes. Output is
 * buffered the way mawk 1.3.4 buffers it: standard output waits while an
 * output pipe is open, since the pipe's command runs when it is closed
 * and what it prints comes first; running any command (a new pipe,
 * `system()`) flushes it, as mawk flushes before it forks. `argv` is the
 * operands as typed, ARGV[1] onward.
 */
export class Interpreter {
  private readonly program: Program
  private readonly host: AwkHost
  private readonly globals = new Map<string, Value>()
  private readonly tables = new Map<string, AwkArray>()
  private readonly frames: Frame[] = []
  private readonly out: Uint8Array[] = []
  private readonly held: Uint8Array[] = []
  private readonly err: Uint8Array[] = []
  private readonly outFiles = new Map<string, string[]>()
  private readonly outPipes = new Map<string, string[]>()
  private readonly inFiles = new Map<string, RecordReader>()
  private readonly inPipes = new Map<string, InputPipe>()
  private main: RecordReader | null = null
  private mainName = ''
  private argIndex = 0
  private readOperand = false
  private record = ''
  private recordFs = ' '
  private recordParagraph = false
  private fields: string[] | null = []
  private recordStale = false
  private nr = 0
  private fnr = 0
  private readonly rangeActive = new Map<number, boolean>()
  private randState = 0
  private seed = 0
  exitCode = 0

  constructor(
    program: Program,
    host: AwkHost,
    argv: readonly string[] = [],
    assignments: Readonly<Record<string, string>> = {},
  ) {
    this.program = program
    this.host = host
    for (const [name, value] of Object.entries(SCALAR_DEFAULTS)) this.globals.set(name, text(value))
    for (const [name, raw] of Object.entries(assignments)) this.globals.set(name, strnum(raw))
    const table: AwkArray = new Map([['0', text(PROGRAM_NAME)]])
    argv.forEach((operand, position) => table.set(String(position + 1), strnum(operand)))
    this.tables.set('ARGV', table)
    this.globals.set('ARGC', num(argv.length + 1))
  }

  special(name: string): string {
    return toStr(this.globals.get(name) ?? UNINIT, '%.6g')
  }

  private convfmt(): string {
    return this.special('CONVFMT')
  }

  // print renders a number with OFMT rather than CONVFMT.
  private outStr(value: Value): string {
    if (value.kind === ValueKind.NUM) return formatNum(value.num, this.special('OFMT'))
    return toStr(value, this.convfmt())
  }

  private ensureFields(): string[] {
    this.fields ??= splitRecord(this.record, this.recordFs, this.recordParagraph)
    return this.fields
  }

  private ensureRecord(): string {
    if (this.recordStale) {
      this.record = this.ensureFields().join(this.special('OFS'))
      this.recordStale = false
    }
    return this.record
  }

  // The record splits with the FS and RS in force when it arrived, so an
  // action that assigns either changes the next record, not this one.
  private setRecord(value: string): void {
    this.record = value
    this.recordFs = this.special('FS')
    this.recordParagraph = this.special('RS') === ''
    this.fields = null
    this.recordStale = false
  }

  private getField(index: number): Value {
    if (index === 0) return strnum(this.ensureRecord())
    if (index < 0) throw new AwkRuntimeError(`awk: trying to access field ${String(index)}`)
    const fields = this.ensureFields()
    if (index > fields.length) return text('')
    return strnum(fields[index - 1] ?? '')
  }

  private setField(index: number, value: string): void {
    if (index === 0) {
      this.setRecord(value)
      return
    }
    if (index < 0) throw new AwkRuntimeError(`awk: trying to access field ${String(index)}`)
    const fields = this.ensureFields()
    while (fields.length < index) fields.push('')
    fields[index - 1] = value
    this.recordStale = true
  }

  // Resizing the field list rebuilds $0 with OFS.
  private setNf(count: number): void {
    const fields = this.ensureFields()
    const target = Math.max(count, 0)
    while (fields.length < target) fields.push('')
    fields.length = target
    this.recordStale = true
  }

  /**
   * Begin a new input file: FILENAME is the operand as typed and FNR
   * restarts while NR keeps running, which range patterns keyed on FNR
   * depend on.
   */
  private startFile(name: string): void {
    this.globals.set('FILENAME', text(name))
    this.mainName = name
    this.fnr = 0
  }

  private reader(source: string, index: number | null): RecordReader {
    return new RecordReader(this.host.openInput(source, index), () => this.special('RS'))
  }

  /**
   * Advance the main input to the next operand that names a file. ARGV is
   * read as it stands when each operand is reached, as POSIX requires: an
   * emptied or deleted slot is skipped, a `var=value` slot is assigned
   * there, and a slot the program filled is read. With no file operand at
   * all the main input is stdin, named `-` in FILENAME (mawk 1.3.4).
   * Returns whether there was one more stream to read.
   */
  private openOperand(): boolean {
    const argv = this.getArray('ARGV')
    while (this.argIndex + 1 < toIndex(toNum(this.getVar('ARGC')))) {
      this.argIndex += 1
      const slot = argv.get(String(this.argIndex))
      if (slot === undefined) continue
      const operand = toStr(slot, this.convfmt())
      if (operand === '') continue
      const assignment = splitAssignment(operand)
      if (assignment !== null) {
        this.setVar(assignment[0], strnum(assignment[1]))
        continue
      }
      this.readOperand = true
      this.startFile(operand)
      this.main = this.reader(operand, this.argIndex)
      return true
    }
    if (this.readOperand) return false
    this.readOperand = true
    this.startFile('-')
    this.main = this.reader('-', null)
    return true
  }

  /**
   * Read the next main-input record, counting it in NR and FNR. This is
   * what the main loop and a plain `getline` both read, so a getline takes
   * the record the next cycle would have seen, and crosses into the next
   * operand the same way. An operand that cannot be opened ends the run
   * (mawk 1.3.4, exit 2).
   */
  async nextRecord(): Promise<string | null> {
    for (;;) {
      if (this.main !== null) {
        let record: string | null
        try {
          record = await this.main.next()
        } catch (err) {
          if (!(err instanceof AwkIOError)) throw err
          throw new AwkRuntimeError(`awk: cannot open "${this.mainName}" (${err.detail})`)
        }
        if (record !== null) {
          this.nr += 1
          this.fnr += 1
          return record
        }
        await this.main.close()
        this.main = null
      }
      if (!this.openOperand()) return null
    }
  }

  /** Abandon the rest of the current operand, as nextfile does. */
  private async skipFile(): Promise<void> {
    if (this.main === null) return
    await this.main.close()
    this.main = null
  }

  private frame(): Frame | null {
    return this.frames[this.frames.length - 1] ?? null
  }

  private getVar(name: string): Value {
    const frame = this.frame()
    if (frame?.params.has(name) === true) return frame.scalars.get(name) ?? UNINIT
    if (name === 'NF') return num(this.ensureFields().length)
    if (name === 'NR') return num(this.nr)
    if (name === 'FNR') return num(this.fnr)
    return this.globals.get(name) ?? UNINIT
  }

  setVar(name: string, value: Value): void {
    const frame = this.frame()
    if (frame?.params.has(name) === true) {
      frame.scalars.set(name, value)
      return
    }
    if (name === 'NF') {
      this.setNf(toIndex(toNum(value)))
      return
    }
    if (name === 'NR') {
      this.nr = toIndex(toNum(value))
      return
    }
    if (name === 'FNR') {
      this.fnr = toIndex(toNum(value))
      return
    }
    this.globals.set(name, value)
  }

  private getArray(name: string): AwkArray {
    const frame = this.frame()
    const home = frame?.params.has(name) === true ? frame.tables : this.tables
    let array = home.get(name)
    if (array === undefined) {
      array = new Map()
      home.set(name, array)
    }
    return array
  }

  private async subscript(subs: readonly Expr[]): Promise<string> {
    const keys: string[] = []
    for (const sub of subs)
      keys.push(toStr(this.leaf(sub) ?? (await this.eval(sub)), this.convfmt()))
    return keys.join(this.special('SUBSEP'))
  }

  private async regexSource(node: Expr): Promise<string> {
    if (node.type === 'Regex') return node.pattern
    return toStr(await this.eval(node), this.convfmt())
  }

  private found(pattern: string, subject: string): boolean {
    return searchFrom(compileEre(pattern), subject, 0) !== null
  }

  /**
   * The value of a node that cannot suspend (a constant, a variable, a
   * constant field), read without a round trip through the event loop;
   * undefined for any other node, which `eval` answers.
   */
  private leaf(node: Expr): Value | undefined {
    switch (node.type) {
      case 'Num':
        return num(node.value)
      case 'Str':
        return text(node.value)
      case 'Var':
        return this.getVar(node.name)
      case 'Field':
        return node.index.type === 'Num' ? this.getField(toIndex(node.index.value)) : undefined
      default:
        return undefined
    }
  }

  private async eval(node: Expr): Promise<Value> {
    switch (node.type) {
      case 'Num':
        return num(node.value)
      case 'Str':
        return text(node.value)
      case 'Regex':
        return num(this.found(node.pattern, this.ensureRecord()) ? 1 : 0)
      case 'Var':
        return this.getVar(node.name)
      case 'Field':
        return this.getField(toIndex(toNum(this.leaf(node.index) ?? (await this.eval(node.index)))))
      case 'ArrayRef': {
        const array = this.getArray(node.name)
        const key = await this.subscript(node.subscripts)
        const held = array.get(key)
        if (held !== undefined) return held
        array.set(key, UNINIT)
        return UNINIT
      }
      case 'Assign':
        return this.evalAssign(node)
      case 'Binary':
        return this.evalBinary(node)
      case 'Unary': {
        const value = toNum(await this.eval(node.operand))
        return num(node.op === '-' ? -value : value)
      }
      case 'Not':
        return num(isTrue(await this.eval(node.operand)) ? 0 : 1)
      case 'Concat': {
        const left = toStr(this.leaf(node.left) ?? (await this.eval(node.left)), this.convfmt())
        const right = toStr(this.leaf(node.right) ?? (await this.eval(node.right)), this.convfmt())
        return text(left + right)
      }
      case 'Compare':
        return this.evalCompare(node)
      case 'MatchOp': {
        const subject = toStr(await this.eval(node.left), this.convfmt())
        const hit = this.found(await this.regexSource(node.right), subject)
        return num(hit !== node.negated ? 1 : 0)
      }
      case 'Logical':
        return this.evalLogical(node)
      case 'Ternary':
        return this.eval(isTrue(await this.eval(node.cond)) ? node.then : node.other)
      case 'IncDec':
        return this.evalIncDec(node)
      case 'InArray':
        return num(this.getArray(node.name).has(await this.subscript(node.subscripts)) ? 1 : 0)
      case 'BuiltinCall':
        return this.evalBuiltin(node)
      case 'Call':
        return this.callFunction(node)
      case 'Getline':
        return this.evalGetline(node)
    }
  }

  /**
   * Read one record into $0 or a variable: 1, 0 at EOF, -1 on error. A
   * plain getline reads the main input and counts NR and FNR; a file or a
   * command does not, as in mawk 1.3.4, which leaves NR alone for
   * `cmd | getline` too. A file that cannot be opened or read answers -1
   * without a message.
   */
  private async evalGetline(node: Getline): Promise<Value> {
    let record: string | null
    if (node.kind === GetlineKind.PLAIN || node.source === null) {
      record = await this.nextRecord()
    } else {
      const name = toStr(await this.eval(node.source), this.convfmt())
      if (node.kind === GetlineKind.FILE) {
        let reader = this.inFiles.get(name)
        if (reader === undefined) {
          reader = this.reader(name, null)
          this.inFiles.set(name, reader)
        }
        try {
          record = await reader.next()
        } catch (err) {
          if (!(err instanceof AwkIOError)) throw err
          this.inFiles.delete(name)
          return num(-1)
        }
      } else {
        record = await (await this.inputPipe(name)).reader.next()
      }
    }
    if (record === null) return num(0)
    if (node.target === null) this.setRecord(record)
    else await this.assignTo(node.target, strnum(record))
    return num(1)
  }

  /** The stream `command | getline` reads, running the command on first use. */
  private async inputPipe(command: string): Promise<InputPipe> {
    let pipe = this.inPipes.get(command)
    if (pipe === undefined) {
      await this.beforeCommand()
      const run = await this.host.run(command, null)
      this.err.push(run.stderr)
      pipe = { reader: new RecordReader(run.stdout, () => this.special('RS')), status: run.status }
      this.inPipes.set(command, pipe)
    }
    return pipe
  }

  private async evalLogical(node: Logical): Promise<Value> {
    const left = isTrue(await this.eval(node.left))
    if (node.op === '&&') {
      if (!left) return num(0)
      return num(isTrue(await this.eval(node.right)) ? 1 : 0)
    }
    if (left) return num(1)
    return num(isTrue(await this.eval(node.right)) ? 1 : 0)
  }

  private async evalCompare(node: Compare): Promise<Value> {
    const left = this.leaf(node.left) ?? (await this.eval(node.left))
    const right = this.leaf(node.right) ?? (await this.eval(node.right))
    const order = compare(left, right, this.convfmt())
    let hit: boolean
    if (node.op === '<') hit = order < 0
    else if (node.op === '<=') hit = order <= 0
    else if (node.op === '>') hit = order > 0
    else if (node.op === '>=') hit = order >= 0
    else if (node.op === '==') hit = order === 0
    else hit = order !== 0
    return num(hit ? 1 : 0)
  }

  private arith(op: string, lhs: number, rhs: number, label: string): number {
    if (op === '+') return lhs + rhs
    if (op === '-') return lhs - rhs
    if (op === '*') return lhs * rhs
    if (op === '/') {
      if (rhs === 0) throw new AwkRuntimeError(`awk: division by zero${label && ' in /='}`)
      return lhs / rhs
    }
    if (op === '%') {
      if (rhs === 0) throw new AwkRuntimeError(`awk: division by zero in %${label}`)
      return safeFmod(lhs, rhs)
    }
    return safePow(lhs, rhs)
  }

  private async evalBinary(node: Binary): Promise<Value> {
    const lhs = toNum(this.leaf(node.left) ?? (await this.eval(node.left)))
    const rhs = toNum(this.leaf(node.right) ?? (await this.eval(node.right)))
    return num(this.arith(node.op, lhs, rhs, ''))
  }

  private async assignTo(target: Expr, value: Value): Promise<Value> {
    if (target.type === 'Var') {
      this.setVar(target.name, value)
      return value
    }
    if (target.type === 'Field') {
      const index = toIndex(toNum(this.leaf(target.index) ?? (await this.eval(target.index))))
      this.setField(index, toStr(value, this.convfmt()))
      return value
    }
    if (target.type === 'ArrayRef') {
      this.getArray(target.name).set(await this.subscript(target.subscripts), value)
      return value
    }
    throw new AwkRuntimeError('awk: assignment to a non-lvalue')
  }

  private async evalAssign(node: Assign): Promise<Value> {
    if (node.op === '=') {
      return this.assignTo(node.target, this.leaf(node.value) ?? (await this.eval(node.value)))
    }
    const current = toNum(this.leaf(node.target) ?? (await this.eval(node.target)))
    const operand = toNum(this.leaf(node.value) ?? (await this.eval(node.value)))
    return this.assignTo(node.target, num(this.arith(node.op.slice(0, -1), current, operand, '=')))
  }

  private async evalIncDec(node: IncDec): Promise<Value> {
    const current = toNum(this.leaf(node.target) ?? (await this.eval(node.target)))
    const updated = current + (node.op === '++' ? 1 : -1)
    await this.assignTo(node.target, num(updated))
    return num(node.pre ? updated : current)
  }

  private arg(args: readonly Expr[], position: number): Expr {
    const node = args[position]
    if (node === undefined) throw new AwkRuntimeError('awk: missing function argument')
    return node
  }

  private async numArg(args: readonly Expr[], position: number): Promise<number> {
    return toNum(await this.eval(this.arg(args, position)))
  }

  private async strArg(args: readonly Expr[], position: number): Promise<string> {
    return toStr(await this.eval(this.arg(args, position)), this.convfmt())
  }

  private async evalBuiltin(node: BuiltinCall): Promise<Value> {
    const name = node.name
    const args = node.args
    if (name === 'length') return this.builtinLength(args)
    const arity = ARITY[name]
    if (arity !== undefined && args.length < arity) {
      throw new AwkRuntimeError(`awk: not enough arguments to ${name}`)
    }
    if (name === 'sin' || name === 'cos') return num(safeTrig(await this.numArg(args, 0), name))
    if (name === 'exp') return num(safeExp(await this.numArg(args, 0)))
    if (name === 'sqrt') return num(safeSqrt(await this.numArg(args, 0)))
    if (name === 'log') return num(safeLog(await this.numArg(args, 0)))
    if (name === 'int') return num(Math.trunc(await this.numArg(args, 0)))
    if (name === 'atan2') {
      const left = await this.numArg(args, 0)
      return num(Math.atan2(left, await this.numArg(args, 1)))
    }
    if (name === 'rand') {
      const [state, drawn] = nextRandom(this.randState)
      this.randState = state
      return num(drawn)
    }
    if (name === 'srand') {
      const previous = this.seed
      this.seed = args.length > 0 ? toIndex(await this.numArg(args, 0)) : 0
      this.randState = Number(BigInt.asUintN(32, BigInt(this.seed)))
      return num(previous)
    }
    if (name === 'index') {
      const haystack = await this.strArg(args, 0)
      return num(indexOf(haystack, await this.strArg(args, 1)))
    }
    if (name === 'substr') {
      const subject = await this.strArg(args, 0)
      const start = await this.numArg(args, 1)
      const span = args.length > 2 ? await this.numArg(args, 2) : null
      return text(substr(subject, start, span))
    }
    if (name === 'toupper')
      return text((await this.strArg(args, 0)).replace(/[a-z]/g, (ch) => ch.toUpperCase()))
    if (name === 'tolower')
      return text((await this.strArg(args, 0)).replace(/[A-Z]/g, (ch) => ch.toLowerCase()))
    if (name === 'sprintf') {
      const fmt = await this.strArg(args, 0)
      const rest: Value[] = []
      for (const a of args.slice(1)) rest.push(await this.eval(a))
      return text(sprintf(fmt, rest, this.convfmt()))
    }
    if (name === 'match') {
      const subject = await this.strArg(args, 0)
      const [start, length] = matchPosition(await this.regexSource(this.arg(args, 1)), subject)
      this.globals.set('RSTART', num(start))
      this.globals.set('RLENGTH', num(length))
      return num(start)
    }
    if (name === 'sub' || name === 'gsub') return this.builtinSub(node, name === 'gsub')
    if (name === 'split') return this.builtinSplit(args)
    if (name === 'close') return num(await this.closeStream(await this.strArg(args, 0)))
    if (name === 'fflush') {
      return num(await this.fflush(args.length > 0 ? await this.strArg(args, 0) : null))
    }
    if (name === 'system') return num(await this.system(await this.strArg(args, 0)))
    throw new AwkRuntimeError(`awk: calling undefined function ${name}`)
  }

  private async builtinLength(args: readonly Expr[]): Promise<Value> {
    const target = args[0]
    if (target === undefined) return num(this.ensureRecord().length)
    if (target.type === 'Var') {
      const frame = this.frame()
      const known = frame?.params.has(target.name) === true ? frame.tables : this.tables
      const array = known.get(target.name)
      if (array !== undefined) return num(array.size)
    }
    return num(toStr(await this.eval(target), this.convfmt()).length)
  }

  private async builtinSub(node: BuiltinCall, globally: boolean): Promise<Value> {
    const args = node.args
    const pattern = await this.regexSource(this.arg(args, 0))
    const template = await this.strArg(args, 1)
    const target: Expr = args[2] ?? { type: 'Field', index: { type: 'Num', value: 0 } }
    const subject = toStr(await this.eval(target), this.convfmt())
    const [count, result] = substitute(pattern, template, subject, globally)
    if (count > 0) await this.assignTo(target, text(result))
    return num(count)
  }

  private async builtinSplit(args: readonly Expr[]): Promise<Value> {
    const subject = await this.strArg(args, 0)
    const holder = this.arg(args, 1)
    if (holder.type !== 'Var' && holder.type !== 'ArrayRef') {
      throw new AwkRuntimeError('awk: split() needs an array')
    }
    const array = this.getArray(holder.name)
    array.clear()
    const third = args[2]
    const separator = third !== undefined ? await this.regexSource(third) : this.special('FS')
    const parts = splitRecord(subject, separator)
    parts.forEach((part, position) => array.set(String(position + 1), strnum(part)))
    return num(parts.length)
  }

  private async callFunction(node: Call): Promise<Value> {
    const definition = this.program.functions.get(node.name)
    if (definition === undefined) {
      throw new AwkRuntimeError(`awk: calling undefined function ${node.name}`)
    }
    if (this.frames.length >= MAX_CALL_DEPTH) {
      throw new AwkRuntimeError(
        `awk: function ${node.name} nested deeper than ${String(MAX_CALL_DEPTH)} calls`,
      )
    }
    const frame: Frame = {
      params: new Set(definition.params),
      scalars: new Map(),
      tables: new Map(),
    }
    for (const [position, param] of definition.params.entries()) {
      const argument = node.args[position]
      if (argument === undefined) continue
      if (argument.type === 'Var' && this.isArrayName(argument.name)) {
        frame.tables.set(param, this.getArray(argument.name))
      } else {
        frame.scalars.set(param, await this.eval(argument))
      }
    }
    this.frames.push(frame)
    try {
      await this.execStmt(definition.body)
    } catch (err) {
      if (err instanceof ReturnValue) return err.value
      throw err
    } finally {
      this.frames.pop()
    }
    return UNINIT
  }

  // A name already holding an array is one; so is a name that has never
  // been used at all, since the callee may subscript it.
  private isArrayName(name: string): boolean {
    const frame = this.frame()
    if (frame?.params.has(name) === true) {
      if (frame.tables.has(name)) return true
      return !frame.scalars.has(name)
    }
    if (this.tables.has(name)) return true
    return !this.globals.has(name) && !COUNTERS.has(name)
  }

  /**
   * Buffer text for standard output. While an output pipe is open the
   * text waits, since the pipe's command prints ahead of it when it runs;
   * once held, later text waits behind it.
   */
  private stdout(body: string): void {
    if (this.outPipes.size > 0 || this.held.length > 0) this.held.push(fromByteView(body))
    else this.out.push(fromByteView(body))
  }

  /** Let held standard output go, as a flush of stdout does. */
  private release(): void {
    this.out.push(...this.held)
    this.held.length = 0
  }

  /** Write through the host, a failure ending the run. */
  private async writeFile(name: string, body: string, append: boolean): Promise<void> {
    try {
      await this.host.writeFile(name, body, append)
    } catch (err) {
      if (!(err instanceof AwkIOError)) throw err
      throw new AwkRuntimeError(`awk: cannot open "${name}" for output (${err.detail})`)
    }
  }

  private async flushFile(name: string): Promise<void> {
    const pending = this.outFiles.get(name)
    if (pending === undefined || pending.length === 0) return
    const body = pending.join('')
    pending.length = 0
    await this.writeFile(name, body, true)
  }

  private async flushFiles(): Promise<void> {
    for (const name of [...this.outFiles.keys()]) await this.flushFile(name)
  }

  /**
   * Flush what a command about to run must see: mawk flushes its output
   * before it forks, so the command reads the files awk wrote and prints
   * after awk's standard output.
   */
  private async beforeCommand(): Promise<void> {
    await this.flushFiles()
    this.release()
  }

  /**
   * Emit output to stdout or to a redirection target. A file opened with
   * `>` is emptied when it is opened, and what is printed to it is
   * buffered until a flush, a close or the end of the record, so reading
   * it back before closing it reads what was flushed.
   */
  private async write(body: string, node: Print | Printf): Promise<void> {
    const redirect = node.redirect
    if (redirect === null) {
      this.stdout(body)
      return
    }
    const name = toStr(await this.eval(redirect.target), this.convfmt())
    if (redirect.kind === RedirKind.PIPE) {
      let pipe = this.outPipes.get(name)
      if (pipe === undefined) {
        await this.beforeCommand()
        pipe = []
        this.outPipes.set(name, pipe)
      }
      pipe.push(body)
      return
    }
    if (STDOUT_NAMES.has(name)) {
      this.stdout(body)
      return
    }
    if (name === STDERR_NAME) {
      this.err.push(fromByteView(body))
      return
    }
    let pending = this.outFiles.get(name)
    if (pending === undefined) {
      if (redirect.kind === RedirKind.FILE) await this.writeFile(name, '', false)
      pending = []
      this.outFiles.set(name, pending)
    }
    pending.push(body)
  }

  /** Run an output pipe's command on everything printed to it. */
  private async closeOutPipe(command: string): Promise<number> {
    const body = (this.outPipes.get(command) ?? []).join('')
    this.outPipes.delete(command)
    await this.flushFiles()
    const run = await this.host.run(command, fromByteView(body))
    this.out.push(run.stdout)
    this.err.push(run.stderr)
    return run.status
  }

  /**
   * Close whatever the program opened under a name: a command answers its
   * exit status, a file 0, and a name nothing is open under -1.
   */
  private async closeStream(name: string): Promise<number> {
    let status = -1
    if (this.outPipes.has(name)) status = await this.closeOutPipe(name)
    const pipe = this.inPipes.get(name)
    if (pipe !== undefined) {
      this.inPipes.delete(name)
      await pipe.reader.close()
      status = pipe.status
    }
    if (this.outFiles.has(name)) {
      await this.flushFile(name)
      this.outFiles.delete(name)
      status = 0
    }
    const reader = this.inFiles.get(name)
    if (reader !== undefined) {
      this.inFiles.delete(name)
      await reader.close()
      status = 0
    }
    return status
  }

  /**
   * Flush standard output and files (null or ""), or one named stream.
   * Output pipes run only when closed, so flushing one flushes nothing.
   */
  private async fflush(name: string | null): Promise<number> {
    if (name === null || name === '') {
      await this.beforeCommand()
      return 0
    }
    if (STDOUT_NAMES.has(name)) {
      this.release()
      return 0
    }
    if (this.outFiles.has(name)) {
      await this.flushFile(name)
      return 0
    }
    return this.outPipes.has(name) ? 0 : -1
  }

  /** Run a command line, its output landing after awk's own. */
  private async system(command: string): Promise<number> {
    await this.beforeCommand()
    const run = await this.host.run(command, null)
    this.out.push(run.stdout)
    this.err.push(run.stderr)
    return run.status
  }

  private async execStmt(node: Stmt): Promise<void> {
    switch (node.type) {
      case 'Block':
        for (const inner of node.body) await this.execStmt(inner)
        return
      case 'ExprStmt':
        await this.eval(node.expr)
        return
      case 'Print':
        await this.execPrint(node)
        return
      case 'Printf': {
        const values: Value[] = []
        for (const a of node.args) values.push(await this.eval(a))
        const head = values[0]
        if (head === undefined) throw new AwkRuntimeError('awk: printf needs a format')
        await this.write(
          sprintf(toStr(head, this.convfmt()), values.slice(1), this.convfmt()),
          node,
        )
        return
      }
      case 'If':
        if (isTrue(await this.eval(node.cond))) await this.execStmt(node.then)
        else if (node.other !== null) await this.execStmt(node.other)
        return
      case 'While':
        await this.execWhile(node)
        return
      case 'DoWhile':
        await this.execDoWhile(node)
        return
      case 'For':
        await this.execFor(node)
        return
      case 'ForIn':
        await this.execForIn(node)
        return
      case 'Delete':
        await this.execDelete(node)
        return
      case 'Next':
        throw new NextRecord()
      case 'NextFile':
        throw new NextFileSignal()
      case 'Break':
        throw new BreakLoop()
      case 'Continue':
        throw new ContinueLoop()
      case 'Return':
        throw new ReturnValue(node.value !== null ? await this.eval(node.value) : UNINIT)
      case 'Exit':
        if (node.value !== null) this.exitCode = toIndex(toNum(await this.eval(node.value)))
        throw new ExitProgram(this.exitCode)
    }
  }

  private async execPrint(node: Print): Promise<void> {
    let body: string
    if (node.args.length > 0) {
      const parts: string[] = []
      for (const a of node.args) parts.push(this.outStr(this.leaf(a) ?? (await this.eval(a))))
      body = parts.join(this.special('OFS'))
    } else body = this.ensureRecord()
    await this.write(body + this.special('ORS'), node)
  }

  // Runs a loop body; false means the loop was broken out of.
  private async runBody(body: Stmt): Promise<boolean> {
    try {
      await this.execStmt(body)
    } catch (err) {
      if (err instanceof BreakLoop) return false
      if (!(err instanceof ContinueLoop)) throw err
    }
    return true
  }

  private async execWhile(node: While): Promise<void> {
    while (isTrue(await this.eval(node.cond))) {
      if (!(await this.runBody(node.body))) return
    }
  }

  private async execDoWhile(node: DoWhile): Promise<void> {
    for (;;) {
      if (!(await this.runBody(node.body))) return
      if (!isTrue(await this.eval(node.cond))) return
    }
  }

  private async execFor(node: For): Promise<void> {
    if (node.init !== null) await this.execStmt(node.init)
    while (node.cond === null || isTrue(await this.eval(node.cond))) {
      if (!(await this.runBody(node.body))) return
      if (node.post !== null) await this.execStmt(node.post)
    }
  }

  private async execForIn(node: ForIn): Promise<void> {
    const array = this.getArray(node.array)
    for (const key of [...array.keys()]) {
      this.setVar(node.var, strnum(key))
      if (!(await this.runBody(node.body))) return
    }
  }

  private async execDelete(node: Delete): Promise<void> {
    const array = this.getArray(node.name)
    if (node.subscripts === null) {
      array.clear()
      return
    }
    array.delete(await this.subscript(node.subscripts))
  }

  private async matchesRule(rule: Rule, index: number): Promise<boolean> {
    if (rule.kind === RuleKind.ALWAYS) return true
    if (rule.pattern === null) return false
    if (rule.kind === RuleKind.PATTERN) return isTrue(await this.eval(rule.pattern))
    if (rule.patternEnd === null) return false
    if (this.rangeActive.get(index) === true) {
      if (isTrue(await this.eval(rule.patternEnd))) this.rangeActive.set(index, false)
      return true
    }
    if (isTrue(await this.eval(rule.pattern))) {
      this.rangeActive.set(index, !isTrue(await this.eval(rule.patternEnd)))
      return true
    }
    return false
  }

  // BEGIN and END run with no current record, so `next` has no meaning.
  private async runEdge(kind: RuleKind): Promise<void> {
    try {
      for (const rule of this.program.rules) {
        if (rule.kind === kind && rule.action !== null) await this.execStmt(rule.action)
      }
    } catch (err) {
      if (err instanceof NextRecord || err instanceof NextFileSignal) {
        throw new AwkRuntimeError(`awk: next used in a ${kind} action`)
      }
      throw err
    }
  }

  async runBegin(): Promise<void> {
    await this.runEdge(RuleKind.BEGIN)
  }

  /** Run the main rules against one record, as `nextRecord` returned it. */
  async runRecord(line: string): Promise<void> {
    this.setRecord(line)
    try {
      for (const [index, rule] of this.program.rules.entries()) {
        if (rule.kind === RuleKind.BEGIN || rule.kind === RuleKind.END) continue
        if (!(await this.matchesRule(rule, index))) continue
        if (rule.action === null) {
          await this.write(this.ensureRecord() + this.special('ORS'), PLAIN_PRINT)
        } else await this.execStmt(rule.action)
      }
    } catch (err) {
      if (err instanceof NextRecord) return
      if (err instanceof NextFileSignal) {
        await this.skipFile()
        return
      }
      throw err
    }
  }

  async runEnd(): Promise<void> {
    await this.runEdge(RuleKind.END)
  }

  /** Whether any rule needs input records. */
  hasMainRules(): boolean {
    return this.program.rules.some((r) => r.kind !== RuleKind.BEGIN)
  }

  /**
   * Close everything at exit, as awk does before it returns. The output
   * pipes run newest first, as mawk 1.3.4 closes them, and their output
   * lands ahead of any standard output still waiting; the files are
   * written out and the inputs let go.
   */
  async finish(): Promise<void> {
    for (const command of [...this.outPipes.keys()].reverse()) await this.closeOutPipe(command)
    await this.flushFiles()
    this.release()
    await this.closeInputs()
  }

  /** Let go of every input stream still open. */
  async closeInputs(): Promise<void> {
    const readers = [...this.inPipes.values()].map((pipe) => pipe.reader)
    readers.push(...this.inFiles.values())
    if (this.main !== null) readers.push(this.main)
    this.inPipes.clear()
    this.inFiles.clear()
    this.main = null
    for (const reader of readers) await reader.close()
  }

  /**
   * Take the output ready so far, standard output then stderr. Called
   * between records: the files are written out, and standard output held
   * for an output pipe stays held until the pipe closes.
   */
  async drain(): Promise<[Uint8Array, Uint8Array]> {
    await this.flushFiles()
    if (this.outPipes.size === 0) this.release()
    return this.take()
  }

  /**
   * Take what a run a fatal error ended leaves behind. What awk had
   * already printed stays, held text included, and so does what it had
   * printed to files, but no pipe command runs: mawk's exit flushes its
   * buffers and nothing else. The error is reported, and after it any
   * file that could not be written now.
   */
  async salvage(failure: Error): Promise<[Uint8Array, Uint8Array]> {
    this.err.push(fromByteView(`${failure.message}\n`))
    try {
      await this.flushFiles()
    } catch (err) {
      if (!(err instanceof AwkRuntimeError)) throw err
      this.err.push(fromByteView(`${err.message}\n`))
    }
    this.release()
    return this.take()
  }

  private take(): [Uint8Array, Uint8Array] {
    const out = concat(this.out)
    const err = concat(this.err)
    this.out.length = 0
    this.err.length = 0
    return [out, err]
  }
}
