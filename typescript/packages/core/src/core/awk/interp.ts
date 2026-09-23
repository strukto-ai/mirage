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

import { RedirKind } from './nodes.ts'

import {
  charLength,
  indexOf,
  matchPosition,
  nextRandom,
  safeExp,
  safeFmod,
  safeLog,
  safePow,
  safeSqrt,
  safeTrig,
  splitRecord,
  sprintf,
  substitute,
  substr,
} from './builtins.ts'
import { AwkRuntimeError } from './errors.ts'
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
  type IncDec,
  type Logical,
  type Print,
  type Printf,
  type Program,
  type Rule,
  type Stmt,
  type While,
} from './nodes.ts'
import { compileEre, searchFrom } from './regex.ts'
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
  tolower: 1,
  toupper: 1,
}

const STDOUT_NAMES: ReadonlySet<string> = new Set(['/dev/stdout', '-'])
const STDERR_NAME = '/dev/stderr'

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

export class Interpreter {
  private readonly program: Program
  private readonly globals = new Map<string, Value>()
  private readonly tables = new Map<string, AwkArray>()
  private readonly frames: Frame[] = []
  private output: [string | null, string, boolean][] = []
  private readonly openFiles = new Set<string>()
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
  skipFile = false
  exitCode = 0

  constructor(program: Program, assignments: Readonly<Record<string, string>> = {}) {
    this.program = program
    for (const [name, value] of Object.entries(SCALAR_DEFAULTS)) this.globals.set(name, text(value))
    for (const [name, raw] of Object.entries(assignments)) this.globals.set(name, strnum(raw))
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
  startFile(name: string): void {
    this.globals.set('FILENAME', text(name))
    this.fnr = 0
    this.skipFile = false
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

  private subscript(subs: readonly Expr[]): string {
    return subs.map((s) => toStr(this.eval(s), this.convfmt())).join(this.special('SUBSEP'))
  }

  private regexSource(node: Expr): string {
    if (node.type === 'Regex') return node.pattern
    return toStr(this.eval(node), this.convfmt())
  }

  private found(pattern: string, subject: string): boolean {
    return searchFrom(compileEre(pattern), subject, 0) !== null
  }

  private eval(node: Expr): Value {
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
        return this.getField(toIndex(toNum(this.eval(node.index))))
      case 'ArrayRef': {
        const array = this.getArray(node.name)
        const key = this.subscript(node.subscripts)
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
        const value = toNum(this.eval(node.operand))
        return num(node.op === '-' ? -value : value)
      }
      case 'Not':
        return num(isTrue(this.eval(node.operand)) ? 0 : 1)
      case 'Concat': {
        const left = toStr(this.eval(node.left), this.convfmt())
        const right = toStr(this.eval(node.right), this.convfmt())
        return text(left + right)
      }
      case 'Compare':
        return this.evalCompare(node)
      case 'MatchOp': {
        const subject = toStr(this.eval(node.left), this.convfmt())
        const hit = this.found(this.regexSource(node.right), subject)
        return num(hit !== node.negated ? 1 : 0)
      }
      case 'Logical':
        return this.evalLogical(node)
      case 'Ternary':
        return this.eval(isTrue(this.eval(node.cond)) ? node.then : node.other)
      case 'IncDec':
        return this.evalIncDec(node)
      case 'InArray':
        return num(this.getArray(node.name).has(this.subscript(node.subscripts)) ? 1 : 0)
      case 'BuiltinCall':
        return this.evalBuiltin(node)
      case 'Call':
        return this.callFunction(node)
      case 'Getline':
        throw new AwkRuntimeError('awk: getline is not supported in mirage')
    }
  }

  private evalLogical(node: Logical): Value {
    const left = isTrue(this.eval(node.left))
    if (node.op === '&&') {
      if (!left) return num(0)
      return num(isTrue(this.eval(node.right)) ? 1 : 0)
    }
    if (left) return num(1)
    return num(isTrue(this.eval(node.right)) ? 1 : 0)
  }

  private evalCompare(node: Compare): Value {
    const order = compare(this.eval(node.left), this.eval(node.right), this.convfmt())
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

  private evalBinary(node: Binary): Value {
    const lhs = toNum(this.eval(node.left))
    const rhs = toNum(this.eval(node.right))
    return num(this.arith(node.op, lhs, rhs, ''))
  }

  private assignTo(target: Expr, value: Value): Value {
    if (target.type === 'Var') {
      this.setVar(target.name, value)
      return value
    }
    if (target.type === 'Field') {
      const index = toIndex(toNum(this.eval(target.index)))
      this.setField(index, toStr(value, this.convfmt()))
      return value
    }
    if (target.type === 'ArrayRef') {
      this.getArray(target.name).set(this.subscript(target.subscripts), value)
      return value
    }
    throw new AwkRuntimeError('awk: assignment to a non-lvalue')
  }

  private evalAssign(node: Assign): Value {
    if (node.op === '=') return this.assignTo(node.target, this.eval(node.value))
    const current = toNum(this.eval(node.target))
    const operand = toNum(this.eval(node.value))
    return this.assignTo(node.target, num(this.arith(node.op.slice(0, -1), current, operand, '=')))
  }

  private evalIncDec(node: IncDec): Value {
    const current = toNum(this.eval(node.target))
    const updated = current + (node.op === '++' ? 1 : -1)
    this.assignTo(node.target, num(updated))
    return num(node.pre ? updated : current)
  }

  private arg(args: readonly Expr[], position: number): Expr {
    const node = args[position]
    if (node === undefined) throw new AwkRuntimeError('awk: missing function argument')
    return node
  }

  private numArg(args: readonly Expr[], position: number): number {
    return toNum(this.eval(this.arg(args, position)))
  }

  private strArg(args: readonly Expr[], position: number): string {
    return toStr(this.eval(this.arg(args, position)), this.convfmt())
  }

  private evalBuiltin(node: BuiltinCall): Value {
    const name = node.name
    const args = node.args
    if (name === 'length') return this.builtinLength(args)
    const arity = ARITY[name]
    if (arity !== undefined && args.length < arity) {
      throw new AwkRuntimeError(`awk: not enough arguments to ${name}`)
    }
    if (name === 'sin' || name === 'cos') return num(safeTrig(this.numArg(args, 0), name))
    if (name === 'exp') return num(safeExp(this.numArg(args, 0)))
    if (name === 'sqrt') return num(safeSqrt(this.numArg(args, 0)))
    if (name === 'log') return num(safeLog(this.numArg(args, 0)))
    if (name === 'int') return num(Math.trunc(this.numArg(args, 0)))
    if (name === 'atan2') return num(Math.atan2(this.numArg(args, 0), this.numArg(args, 1)))
    if (name === 'rand') {
      const [state, drawn] = nextRandom(this.randState)
      this.randState = state
      return num(drawn)
    }
    if (name === 'srand') {
      const previous = this.seed
      this.seed = args.length > 0 ? toIndex(this.numArg(args, 0)) : 0
      this.randState = Number(BigInt.asUintN(32, BigInt(this.seed)))
      return num(previous)
    }
    if (name === 'index') return num(indexOf(this.strArg(args, 0), this.strArg(args, 1)))
    if (name === 'substr') {
      const subject = this.strArg(args, 0)
      const start = this.numArg(args, 1)
      const span = args.length > 2 ? this.numArg(args, 2) : null
      return text(substr(subject, start, span))
    }
    if (name === 'toupper') return text(this.strArg(args, 0).toUpperCase())
    if (name === 'tolower') return text(this.strArg(args, 0).toLowerCase())
    if (name === 'sprintf') {
      const fmt = this.strArg(args, 0)
      const rest = args.slice(1).map((a) => this.eval(a))
      return text(sprintf(fmt, rest, this.convfmt()))
    }
    if (name === 'match') {
      const subject = this.strArg(args, 0)
      const [start, length] = matchPosition(this.regexSource(this.arg(args, 1)), subject)
      this.globals.set('RSTART', num(start))
      this.globals.set('RLENGTH', num(length))
      return num(start)
    }
    if (name === 'sub' || name === 'gsub') return this.builtinSub(node, name === 'gsub')
    if (name === 'split') return this.builtinSplit(args)
    if (name === 'close') return num(this.openFiles.delete(this.strArg(args, 0)) ? 0 : -1)
    if (name === 'fflush') return num(0)
    if (name === 'system') throw new AwkRuntimeError('awk: system() is not supported in mirage')
    throw new AwkRuntimeError(`awk: calling undefined function ${name}`)
  }

  private builtinLength(args: readonly Expr[]): Value {
    const target = args[0]
    if (target === undefined) return num(charLength(this.ensureRecord()))
    if (target.type === 'Var') {
      const frame = this.frame()
      const known = frame?.params.has(target.name) === true ? frame.tables : this.tables
      const array = known.get(target.name)
      if (array !== undefined) return num(array.size)
    }
    return num(charLength(toStr(this.eval(target), this.convfmt())))
  }

  private builtinSub(node: BuiltinCall, globally: boolean): Value {
    const args = node.args
    const pattern = this.regexSource(this.arg(args, 0))
    const template = this.strArg(args, 1)
    const target: Expr = args[2] ?? { type: 'Field', index: { type: 'Num', value: 0 } }
    const subject = toStr(this.eval(target), this.convfmt())
    const [count, result] = substitute(pattern, template, subject, globally)
    if (count > 0) this.assignTo(target, text(result))
    return num(count)
  }

  private builtinSplit(args: readonly Expr[]): Value {
    const subject = this.strArg(args, 0)
    const holder = this.arg(args, 1)
    if (holder.type !== 'Var' && holder.type !== 'ArrayRef') {
      throw new AwkRuntimeError('awk: split() needs an array')
    }
    const array = this.getArray(holder.name)
    array.clear()
    const third = args[2]
    const separator = third !== undefined ? this.regexSource(third) : this.special('FS')
    const parts = splitRecord(subject, separator)
    parts.forEach((part, position) => array.set(String(position + 1), strnum(part)))
    return num(parts.length)
  }

  private callFunction(node: Call): Value {
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
    definition.params.forEach((param, position) => {
      const argument = node.args[position]
      if (argument === undefined) return
      if (argument.type === 'Var' && this.isArrayName(argument.name)) {
        frame.tables.set(param, this.getArray(argument.name))
      } else {
        frame.scalars.set(param, this.eval(argument))
      }
    })
    this.frames.push(frame)
    try {
      this.execStmt(definition.body)
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

  private write(body: string, node: Print | Printf): void {
    const redirect = node.redirect
    if (redirect === null) {
      this.output.push([null, body, false])
      return
    }
    const name = toStr(this.eval(redirect.target), this.convfmt())
    if (redirect.kind === RedirKind.PIPE) {
      throw new AwkRuntimeError('awk: output pipes are not supported in mirage')
    }
    if (STDOUT_NAMES.has(name)) {
      this.output.push([null, body, false])
      return
    }
    if (name === STDERR_NAME) {
      this.output.push([STDERR_NAME, body, false])
      return
    }
    const append = this.openFiles.has(name) || redirect.kind === RedirKind.APPEND
    this.openFiles.add(name)
    this.output.push([name, body, append])
  }

  private execStmt(node: Stmt): void {
    switch (node.type) {
      case 'Block':
        for (const inner of node.body) this.execStmt(inner)
        return
      case 'ExprStmt':
        this.eval(node.expr)
        return
      case 'Print':
        this.execPrint(node)
        return
      case 'Printf': {
        const values = node.args.map((a) => this.eval(a))
        const head = values[0]
        if (head === undefined) throw new AwkRuntimeError('awk: printf needs a format')
        this.write(sprintf(toStr(head, this.convfmt()), values.slice(1), this.convfmt()), node)
        return
      }
      case 'If':
        if (isTrue(this.eval(node.cond))) this.execStmt(node.then)
        else if (node.other !== null) this.execStmt(node.other)
        return
      case 'While':
        this.execWhile(node)
        return
      case 'DoWhile':
        this.execDoWhile(node)
        return
      case 'For':
        this.execFor(node)
        return
      case 'ForIn':
        this.execForIn(node)
        return
      case 'Delete':
        this.execDelete(node)
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
        throw new ReturnValue(node.value !== null ? this.eval(node.value) : UNINIT)
      case 'Exit':
        if (node.value !== null) this.exitCode = toIndex(toNum(this.eval(node.value)))
        throw new ExitProgram(this.exitCode)
    }
  }

  private execPrint(node: Print): void {
    const body =
      node.args.length > 0
        ? node.args.map((a) => this.outStr(this.eval(a))).join(this.special('OFS'))
        : this.ensureRecord()
    this.write(body + this.special('ORS'), node)
  }

  // Runs a loop body; false means the loop was broken out of.
  private runBody(body: Stmt): boolean {
    try {
      this.execStmt(body)
    } catch (err) {
      if (err instanceof BreakLoop) return false
      if (!(err instanceof ContinueLoop)) throw err
    }
    return true
  }

  private execWhile(node: While): void {
    while (isTrue(this.eval(node.cond))) {
      if (!this.runBody(node.body)) return
    }
  }

  private execDoWhile(node: DoWhile): void {
    for (;;) {
      if (!this.runBody(node.body)) return
      if (!isTrue(this.eval(node.cond))) return
    }
  }

  private execFor(node: For): void {
    if (node.init !== null) this.execStmt(node.init)
    while (node.cond === null || isTrue(this.eval(node.cond))) {
      if (!this.runBody(node.body)) return
      if (node.post !== null) this.execStmt(node.post)
    }
  }

  private execForIn(node: ForIn): void {
    const array = this.getArray(node.array)
    for (const key of [...array.keys()]) {
      this.setVar(node.var, strnum(key))
      if (!this.runBody(node.body)) return
    }
  }

  private execDelete(node: Delete): void {
    const array = this.getArray(node.name)
    if (node.subscripts === null) {
      array.clear()
      return
    }
    array.delete(this.subscript(node.subscripts))
  }

  private matchesRule(rule: Rule, index: number): boolean {
    if (rule.kind === RuleKind.ALWAYS) return true
    if (rule.pattern === null) return false
    if (rule.kind === RuleKind.PATTERN) return isTrue(this.eval(rule.pattern))
    if (rule.patternEnd === null) return false
    if (this.rangeActive.get(index) === true) {
      if (isTrue(this.eval(rule.patternEnd))) this.rangeActive.set(index, false)
      return true
    }
    if (isTrue(this.eval(rule.pattern))) {
      this.rangeActive.set(index, !isTrue(this.eval(rule.patternEnd)))
      return true
    }
    return false
  }

  // BEGIN and END run with no current record, so `next` has no meaning.
  private runEdge(kind: RuleKind): void {
    try {
      for (const rule of this.program.rules) {
        if (rule.kind === kind && rule.action !== null) this.execStmt(rule.action)
      }
    } catch (err) {
      if (err instanceof NextRecord || err instanceof NextFileSignal) {
        throw new AwkRuntimeError(`awk: next used in a ${kind} action`)
      }
      throw err
    }
  }

  runBegin(): void {
    this.runEdge(RuleKind.BEGIN)
  }

  /** Run the main rules against one input record, separator stripped. */
  runRecord(line: string): void {
    this.nr += 1
    this.fnr += 1
    this.setRecord(line)
    try {
      this.program.rules.forEach((rule, index) => {
        if (rule.kind === RuleKind.BEGIN || rule.kind === RuleKind.END) return
        if (!this.matchesRule(rule, index)) return
        if (rule.action === null) this.write(this.ensureRecord() + this.special('ORS'), PLAIN_PRINT)
        else this.execStmt(rule.action)
      })
    } catch (err) {
      if (err instanceof NextRecord) return
      if (err instanceof NextFileSignal) {
        // nextfile abandons the rest of the current operand, not just
        // the current record; the driver reads the flag and moves on.
        this.skipFile = true
        return
      }
      throw err
    }
  }

  runEnd(): void {
    this.runEdge(RuleKind.END)
  }

  /** Whether any rule needs input records. */
  hasMainRules(): boolean {
    return this.program.rules.some((r) => r.kind !== RuleKind.BEGIN)
  }

  /** Take everything buffered for stdout since the last drain. */
  drain(): string {
    const out = this.output
      .filter(([name]) => name === null)
      .map(([, body]) => body)
      .join('')
    this.output = this.output.filter(([name]) => name !== null)
    return out
  }

  drainErr(): string {
    const out = this.output
      .filter(([name]) => name === STDERR_NAME)
      .map(([, body]) => body)
      .join('')
    this.output = this.output.filter(([name]) => name !== STDERR_NAME)
    return out
  }

  drainOutput(): [string | null, string, boolean][] {
    const pending = this.output
    this.output = []
    return pending
  }
}
