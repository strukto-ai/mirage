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

import {
  ARITH_ASSIGN_OPS,
  ARITH_BLANKS,
  ARITH_LITERAL,
  ARITH_MAX_DEPTH,
  ARITH_NAME,
  ARITH_OPERATOR,
  ARITH_PRECEDENCE,
  ARITH_UNARY_OPS,
} from './constants.ts'
import { ArithError, ReadonlyError, UnboundVariable } from './errors.ts'
import type { ArithResult, ArithTokenKind, ArithWrite, ElementOps } from './types.ts'

/**
 * Index of the `]` closing the `[` at `start`, quote-aware, or null when
 * it never closes. Quotes matter because an associative key may hold a
 * bracket (`m["a]b"]`); nesting matters because an indexed subscript may
 * hold another reference (`a[b[0]]`).
 */
function matchingBracket(expr: string, start: number): number | null {
  let depth = 0
  let i = start
  while (i < expr.length) {
    const ch = expr[i]
    if (ch === '"' || ch === "'") {
      const close = expr.indexOf(ch, i + 1)
      if (close === -1) return null
      i = close + 1
      continue
    }
    if (ch === '[') depth++
    else if (ch === ']') {
      depth--
      if (depth === 0) return i
    }
    i++
  }
  return null
}

/** `value` wrapped to a signed 64-bit integer, as bash's arithmetic wraps. */
export function wrapInt64(value: bigint): bigint {
  return BigInt.asIntN(64, value)
}

/** The value of one digit of a `base#digits` constant. */
function baseDigit(ch: string, base: number): number {
  if (ch >= '0' && ch <= '9') return ch.charCodeAt(0) - 48
  if (ch >= 'a' && ch <= 'z') return ch.charCodeAt(0) - 97 + 10
  if (ch >= 'A' && ch <= 'Z') return ch.charCodeAt(0) - 65 + (base <= 36 ? 10 : 36)
  if (ch === '@') return 62
  return 63
}

/**
 * The value of `digits` in `base` modulo 2**64, or null when one is too
 * great. Kept to 64 bits as it is read, so a constant thousands of digits
 * long stays linear to read.
 */
function digitsValue(digits: string, base: number): bigint | null {
  let value = 0n
  for (const ch of digits) {
    const digit = baseDigit(ch, base)
    if (digit >= base) return null
    value = BigInt.asUintN(64, value * BigInt(base) + BigInt(digit))
  }
  return value
}

/**
 * The value of an integer constant, or what bash says of a bad one:
 * decimal, octal after a leading `0`, hexadecimal after `0x` (bare `0x` is
 * 0), or `base#digits` for a base from 2 to 64 written as a constant
 * itself; the value wraps to 64 bits.
 */
function constant(text: string): bigint | string {
  let value: bigint | null
  const hash = text.indexOf('#')
  if (hash !== -1) {
    const base = constant(text.slice(0, hash))
    if (typeof base === 'string') return base
    if (base < 2n || base > 64n) return 'invalid arithmetic base'
    const digits = text.slice(hash + 1)
    if (digits === '' || digits.startsWith('#')) return 'invalid integer constant'
    if (digits.includes('#')) return 'invalid number'
    value = digitsValue(digits, Number(base))
  } else if (text.startsWith('0x') || text.startsWith('0X')) {
    value = digitsValue(text.slice(2), 16)
  } else if (text.startsWith('0')) {
    value = digitsValue(text, 8)
  } else {
    value = digitsValue(text, 10)
  }
  return value === null ? 'value too great for base' : wrapInt64(value)
}

/** One binary operator over 64-bit wrapping integers, `/` and `%` aside. */
function binop(op: string, a: bigint, b: bigint): bigint {
  switch (op) {
    case '+':
      return wrapInt64(a + b)
    case '-':
      return wrapInt64(a - b)
    case '*':
      return wrapInt64(a * b)
    case '<<':
      return wrapInt64(a << (b & 63n))
    case '>>':
      return a >> (b & 63n)
    case '&':
      return a & b
    case '|':
      return a | b
    case '^':
      return a ^ b
    case '==':
      return a === b ? 1n : 0n
    case '!=':
      return a !== b ? 1n : 0n
    case '<':
      return a < b ? 1n : 0n
    case '<=':
      return a <= b ? 1n : 0n
    case '>':
      return a > b ? 1n : 0n
    default:
      return a >= b ? 1n : 0n
  }
}

/** `base ** exponent` modulo 2**64, by squaring. */
function power(base: bigint, exponent: bigint): bigint {
  let result = 1n
  let factor = BigInt.asUintN(64, base)
  for (let e = exponent; e > 0n; e >>= 1n) {
    if ((e & 1n) === 1n) result = BigInt.asUintN(64, result * factor)
    factor = BigInt.asUintN(64, factor * factor)
  }
  return wrapInt64(result)
}

/**
 * Reads one arithmetic expression and evaluates it as it goes, as bash
 * does. A token is read only when the grammar needs it, and every value
 * is computed the moment its operands are, so an assignment before an
 * error has already been made (`x=7, 1+` leaves x at 7) and an error names
 * the text from the token the reader stood on (`tp`). Inside the branch
 * `&&`, `||` or `?:` skips (`skip`) nothing is read from a variable or
 * written to one and a zero divisor is no error, but the grammar is still
 * checked, an integer constant still judged and a negative exponent still
 * refused. Mirrors Python's _Reader.
 */
class Reader {
  private pos = 0
  private tp = 0
  private kind: ArithTokenKind = 'end'
  private tok = ''
  private value = 0n
  private skip = 0

  constructor(
    private readonly record: ArithRecord,
    private readonly text: string,
    private readonly depth: number,
    private readonly subscript: boolean,
  ) {}

  /** The error bash reports at the token the reader stands on, or at `at`. */
  private fail(reason: string, at: number = this.tp): ArithError {
    return new ArithError(reason, this.text, this.text.slice(at))
  }

  /**
   * Read the next token. `++` and `--` after a name are its postfix
   * operators, before a name (blanks between allowed) its prefix ones, and
   * anywhere else two signs (`1++2` is `1 + +2`). A name joined to a `[`
   * takes its subscript along unread. At the end the reader stays on the
   * last token, which an error then names.
   */
  private advance(): void {
    const text = this.text
    let pos = this.pos
    while (pos < text.length && ARITH_BLANKS.includes(text[pos] ?? '')) pos++
    const afterName = this.kind === 'name'
    if (pos >= text.length) {
      this.set(pos, 'end', '')
      return
    }
    this.tp = pos
    ARITH_NAME.lastIndex = pos
    if (ARITH_NAME.test(text)) {
      let end = ARITH_NAME.lastIndex
      if (text[end] === '[') {
        const close = matchingBracket(text, end)
        if (close === null) throw this.fail('bad array subscript')
        end = close + 1
      }
      this.set(end, 'name', text.slice(pos, end))
      return
    }
    ARITH_LITERAL.lastIndex = pos
    if (ARITH_LITERAL.test(text)) {
      const end = ARITH_LITERAL.lastIndex
      const literal = text.slice(pos, end)
      const value = constant(literal)
      if (typeof value === 'string') throw new ArithError(value, text.slice(0, end), literal)
      this.value = value
      this.set(end, 'num', literal)
      return
    }
    ARITH_OPERATOR.lastIndex = pos
    const operator = ARITH_OPERATOR.exec(text)
    if (operator === null) {
      this.set(pos + 1, 'bad', text[pos] ?? '')
      return
    }
    let op = operator[0]
    if (op === '++' || op === '--') {
      if (afterName) {
        this.set(pos + 2, 'post', op)
        return
      }
      let ahead = pos + 2
      while (ahead < text.length && ARITH_BLANKS.includes(text[ahead] ?? '')) ahead++
      ARITH_NAME.lastIndex = ahead
      if (ARITH_NAME.test(text)) {
        this.set(pos + 2, 'pre', op)
        return
      }
      op = op.charAt(0)
    }
    this.set(pos + op.length, 'op', op)
  }

  private set(pos: number, kind: ArithTokenKind, tok: string): void {
    this.pos = pos
    this.kind = kind
    this.tok = tok
  }

  private is(kind: ArithTokenKind): boolean {
    return this.kind === kind
  }

  private at(op: string): boolean {
    return this.kind === 'op' && this.tok === op
  }

  /** The error for a token where an operator or closer belongs. */
  private stray(reason: string): ArithError {
    if (this.is('bad')) return this.fail('syntax error: invalid arithmetic operator')
    return this.fail(reason)
  }

  run(): bigint {
    this.advance()
    if (this.is('end')) return 0n
    const value = this.comma()
    if (!this.is('end')) throw this.stray('syntax error in expression')
    return value
  }

  private comma(): bigint {
    let value = this.assign()
    while (this.at(',')) {
      this.advance()
      value = this.assign()
    }
    return value
  }

  private assign(): bigint {
    if (this.is('name')) {
      const [pos, tp, target] = [this.pos, this.tp, this.tok]
      this.advance()
      if (this.is('op') && ARITH_ASSIGN_OPS.has(this.tok)) return this.assignment(target, tp)
      this.set(pos, 'name', target)
      this.tp = tp
    }
    const value = this.ternary()
    if (this.is('op') && ARITH_ASSIGN_OPS.has(this.tok)) {
      throw this.fail('attempted assignment to non-variable')
    }
    return value
  }

  /**
   * An assignment to `target`, the reader on its operator. bash evaluates
   * a plain assignment's right side before it resolves the target's
   * subscript (`x=0, a[x++]=x++` stores 0 at index 1), and a compound one
   * reads its target before the right side. In a skipped branch nothing is
   * read or written, but a compound one still computes over 0, so its value
   * can refuse a negative exponent (`1 || 2**(x-=1)`). `at` is where the
   * name starts.
   */
  private assignment(target: string, at: number): bigint {
    const op = this.tok
    this.advance()
    const divisor = this.tp
    let key: string | null
    let value: bigint
    if (op === '=') {
      value = this.assign()
      if (this.skip > 0) return value
      key = this.record.keyOf(target, this.depth)
    } else if (this.skip > 0) {
      return this.apply(op.slice(0, -1), 0n, this.assign(), divisor)
    } else {
      let current: bigint
      ;[key, current] = this.lookup(target, at)
      value = this.apply(op.slice(0, -1), current, this.assign(), divisor)
    }
    this.record.writeTarget(target, key, value, this.subscript)
    return value
  }

  private ternary(): bigint {
    const cond = this.binary(1)
    if (!this.at('?')) return cond
    this.advance()
    if (this.is('end') || this.at(':')) throw this.fail('expression expected')
    const taken = cond !== 0n
    if (!taken) this.skip++
    const then = this.comma()
    if (!taken) this.skip--
    if (!this.at(':')) throw this.stray("`:' expected for conditional expression")
    this.advance()
    if (this.is('end')) throw this.fail('expression expected')
    if (taken) this.skip++
    const other = this.ternary()
    if (taken) this.skip--
    return taken ? then : other
  }

  /** Binary operators binding at least as tightly as `floor`. */
  private binary(floor: number): bigint {
    let left = this.unary()
    while (this.is('op')) {
      const op = this.tok
      const precedence = ARITH_PRECEDENCE.get(op) ?? 0
      if (precedence < floor) break
      this.advance()
      const divisor = this.tp
      if (op === '&&' || op === '||') {
        const skipped = (left === 0n) === (op === '&&')
        if (skipped) this.skip++
        const right = this.binary(precedence + 1)
        if (skipped) this.skip--
        const truth = op === '&&' ? left !== 0n && right !== 0n : left !== 0n || right !== 0n
        left = truth ? 1n : 0n
        continue
      }
      const right = this.binary(op === '**' ? precedence : precedence + 1)
      left = this.apply(op, left, right, divisor)
    }
    return left
  }

  /**
   * One binary operator over 64-bit wrapping integers; division truncates
   * toward zero and `%` takes the dividend's sign, as in C. `divisor` is
   * where the right operand starts, which a division by 0 names.
   */
  private apply(op: string, a: bigint, b: bigint, divisor: number): bigint {
    if (op === '/' || op === '%') {
      if (b === 0n) {
        if (this.skip > 0) return 0n
        throw this.fail('division by 0', divisor)
      }
      return wrapInt64(op === '/' ? a / b : a % b)
    }
    if (op === '**') {
      if (b < 0n) throw this.fail('exponent less than 0')
      return power(a, b)
    }
    return binop(op, a, b)
  }

  private unary(): bigint {
    if (this.is('op') && ARITH_UNARY_OPS.has(this.tok)) {
      const op = this.tok
      this.advance()
      const value = this.unary()
      if (op === '!') return value === 0n ? 1n : 0n
      if (op === '~') return wrapInt64(~value)
      if (op === '-') return wrapInt64(-value)
      return value
    }
    if (this.is('pre')) {
      const step = this.tok === '++' ? 1n : -1n
      this.advance()
      const [target, at] = [this.tok, this.tp]
      this.advance()
      const value = this.step(target, step, true, at)
      if (this.is('post')) throw this.fail(`${this.tok}: assignment requires lvalue`)
      return value
    }
    return this.primary()
  }

  /**
   * `++` or `--` on `target`: the new value before it, the old one after.
   * bash makes the write once it has read the token after the operand: a
   * prefix one after the token past the name (`++x 08` refuses the
   * constant and leaves x), a postfix one before the token past the
   * operator (`x++ 08` leaves x stepped). In a skipped branch it computes
   * over 0 without reading or writing. `at` is where the name starts.
   */
  private step(target: string, step: bigint, prefix: boolean, at: number): bigint {
    if (this.skip > 0) return prefix ? step : 0n
    const [key, value] = this.lookup(target, at)
    const stepped = wrapInt64(value + step)
    this.record.writeTarget(target, key, stepped, this.subscript)
    return prefix ? stepped : value
  }

  /**
   * The element key `target` names and the value it holds. A variable read
   * from an expression `ARITH_MAX_DEPTH` values deep is past the recursion
   * limit, which names this expression and the reference (`x='(x)'` is
   * `(x): expression recursion level exceeded (error token is "x)")`).
   */
  private lookup(target: string, at: number): [string | null, bigint] {
    if (this.depth >= ARITH_MAX_DEPTH) throw this.fail('expression recursion level exceeded', at)
    const record = this.record
    const key = record.keyOf(target, this.depth)
    return [key, record.readTarget(target, key, this.depth, this.subscript)]
  }

  private primary(): bigint {
    if (this.at('(')) {
      this.advance()
      const value = this.comma()
      if (!this.at(')')) throw this.stray("missing `)'")
      this.advance()
      return value
    }
    if (this.is('num')) {
      const value = this.value
      this.advance()
      return value
    }
    if (this.is('name')) {
      const [target, at] = [this.tok, this.tp]
      this.advance()
      if (this.is('post')) {
        const value = this.step(target, this.tok === '++' ? 1n : -1n, false, at)
        this.advance()
        return value
      }
      if (this.skip > 0) return 0n
      return this.lookup(target, at)[1]
    }
    throw this.fail('syntax error: operand expected')
  }
}

/** A target's name and its subscript, null for a bare name. */
function splitTarget(target: string): [string, string | null] {
  const bracket = target.indexOf('[')
  if (bracket === -1) return [target, null]
  return [target.slice(0, bracket), target.slice(bracket + 1, -1)]
}

/**
 * One evaluation: what it reads and every write it makes. Reads resolve
 * through `updates` first, then `env`; every write lands in `updates` (or
 * `elemUpdates` for an element) and in `writes`, the one ordered record
 * across both kinds, so the caller lands them in the order the expression
 * made them. A variable's value and an indexed subscript are expressions
 * of their own, read in this same record (`x='y=5'; $((x))` leaves y at 5)
 * one level deeper. A write to a name `frozen` holds stops the evaluation
 * there (`ReadonlyError`). Mirrors Python's _Record.
 */
class ArithRecord {
  readonly updates: Record<string, string> = {}
  readonly elemUpdates = new Map<string, string>()
  readonly writes: ArithWrite[] = []

  constructor(
    private readonly env: Readonly<Record<string, string>>,
    private readonly elements: ElementOps | null,
    private readonly readVar: ((name: string) => string | null) | null,
    private readonly wroteVar: ((name: string, value: string) => void) | null,
    private readonly nounset: boolean,
    private readonly frozen: ((name: string) => string | null) | null,
  ) {}

  /** The value of `text` read as an expression in this record. */
  evaluate(text: string, depth: number, subscript: boolean): bigint {
    let start = 0
    while (start < text.length && ARITH_BLANKS.includes(text[start] ?? '')) start++
    const expr = text.slice(start)
    try {
      return new Reader(this, expr, depth, subscript).run()
    } catch (err) {
      if (!(err instanceof RangeError)) throw err
      throw new ArithError('expression recursion level exceeded', expr, expr)
    }
  }

  /** A variable's value as a number: its text read as an expression. */
  private coerce(raw: string | null, depth: number, subscript: boolean): bigint {
    const text = raw ?? ''
    const number = text.replace(/^[ \t\n]+|[ \t\n]+$/g, '')
    if (/^[1-9][0-9]*$/.test(number)) {
      const value = digitsValue(number, 10)
      if (value !== null) return wrapInt64(value)
    }
    return this.evaluate(text, depth + 1, subscript)
  }

  private mergedEnv(): Record<string, string> {
    return { ...this.env, ...this.updates }
  }

  /**
   * The canonical element key a target names, null for a scalar. Resolved
   * once per reference: a compound assignment or a `++` reads and writes
   * the same element, and a subscript that draws (`a[RANDOM]+=1`) draws
   * once.
   */
  keyOf(target: string, depth: number): string | null {
    const [name, inner] = splitTarget(target)
    if (inner === null) return null
    const elements = this.elements
    if (elements === null) {
      throw new ArithError('syntax error: operand expected', target, target.slice(name.length))
    }
    if (elements.isAssoc?.(name) ?? true) return elements.resolve(name, inner, this.mergedEnv())
    const trimmed = inner.trim()
    let index: bigint
    if (/^-?\d+$/.test(trimmed)) index = BigInt(trimmed)
    else {
      try {
        index = this.evaluate(inner, depth + 1, true)
      } catch (err) {
        if (err instanceof ArithError) err.inSubscript = true
        throw err
      }
    }
    return elements.resolve(name, index.toString(), this.mergedEnv())
  }

  /**
   * The value a target holds. A bare name a dynamic reader answers
   * (`RANDOM`) is asked first, the pending writes next, then the
   * environment; an array's bare name reads element 0.
   */
  readTarget(target: string, key: string | null, depth: number, subscript: boolean): bigint {
    const [name] = splitTarget(target)
    if (key !== null) {
      const pending = this.elemUpdates.get(`${name} ${key}`)
      const raw = pending ?? (this.elements === null ? null : this.elements.read(name, key))
      return this.coerce(raw, depth, subscript)
    }
    const dynamic = this.readVar?.(name) ?? null
    if (dynamic !== null) return this.coerce(dynamic, depth, subscript)
    const pending = this.updates[name] ?? this.env[name]
    if (pending !== undefined) return this.coerce(pending, depth, subscript)
    const element = this.elements === null ? null : this.elements.read(name, '0')
    if (element === null && this.nounset && this.elements?.holdsArray?.(name) !== true) {
      throw new UnboundVariable(name)
    }
    return this.coerce(element, depth, subscript)
  }

  /** Record a write, or refuse one to a readonly name. */
  writeTarget(target: string, key: string | null, value: bigint, subscript: boolean): void {
    const [name] = splitTarget(target)
    const refused = this.frozen?.(name) ?? null
    if (refused !== null) throw new ReadonlyError(refused, subscript)
    const text = value.toString()
    this.writes.push({ name, key, value: text })
    if (key !== null) {
      this.elemUpdates.set(`${name} ${key}`, text)
      return
    }
    this.updates[name] = text
    this.wroteVar?.(name, text)
  }
}

/**
 * Evaluate a bash arithmetic expression.
 *
 * bash's grammar over 64-bit wrapping integers (BigInt), read and
 * evaluated in one pass as bash does (`Reader`): comma sequences,
 * assignment operators, the ternary, short-circuit `&&`/`||`, the bitwise,
 * comparison, shift and arithmetic operators, right-grouping `**`, unary
 * operators, `++`/`--`, and integer constants in any base from 2 to 64. A
 * variable whose value is not a plain number is read as an expression of
 * its own (`x="1+2"; $((x))` is 3). An error is worded as bash's line,
 * naming the innermost expression it happened in (`x='1+'; $((x+1))`
 * names `1+`). Element references (`a[i]`, `m[key]`) resolve and assign
 * through `elements`; with null every subscript is a syntax error, which
 * is what an evaluation with no session behind it can honestly say.
 * `nounset` is `set -u` for the names the expression reads: one that no
 * variable holds throws UnboundVariable instead of reading 0. `frozen`
 * names the readonly variable a write to a name reaches, through a
 * reference, or null: the evaluation stops there with ReadonlyError. An
 * ArithError or ReadonlyError carries the writes made before it. `added`
 * is a second expression read after `expr` in the same record and added to
 * it: an integer `+=`, whose held value and added text bash evaluates in
 * turn, the second seeing what the first assigned (`n='x=5'; n+=x` stores
 * 10), each error naming its own side.
 */
export function evaluateArith(
  expr: string,
  env: Readonly<Record<string, string>>,
  depth = 0,
  elements: ElementOps | null = null,
  readVar: ((name: string) => string | null) | null = null,
  wroteVar: ((name: string, value: string) => void) | null = null,
  nounset = false,
  frozen: ((name: string) => string | null) | null = null,
  added: string | null = null,
): ArithResult {
  const record = new ArithRecord(env, elements, readVar, wroteVar, nounset, frozen)
  let value: bigint
  try {
    value = record.evaluate(expr, depth, false)
    if (added !== null) value = wrapInt64(value + record.evaluate(added, depth, false))
  } catch (err) {
    if (err instanceof ArithError || err instanceof ReadonlyError) err.writes = [...record.writes]
    throw err
  }
  return { value, writes: record.writes }
}
