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

import { ARITH_ASSIGN_OPS, ARITH_MAX_DEPTH, ARITH_NAME, ARITH_TOKEN } from './constants.ts'
import { ArithError } from './errors.ts'

type ArithNode =
  | { kind: 'num'; value: bigint }
  | { kind: 'var'; name: string }
  | { kind: 'comma'; parts: ArithNode[] }
  | { kind: 'assign'; name: string; op: string; rhs: ArithNode }
  | { kind: 'ternary'; cond: ArithNode; then: ArithNode; other: ArithNode }
  | { kind: 'logic'; op: string; left: ArithNode; right: ArithNode }
  | { kind: 'binop'; op: string; left: ArithNode; right: ArithNode }
  | { kind: 'unary'; op: string; operand: ArithNode }
  | { kind: 'pre'; op: string; name: string }
  | { kind: 'post'; op: string; name: string }

function tokenize(expr: string): string[] {
  const tokens: string[] = []
  for (const match of expr.matchAll(ARITH_TOKEN)) {
    const [, num, name, op, ws, bad] = match
    if (ws !== undefined) continue
    if (bad !== undefined) throw new ArithError(`syntax error: invalid character "${bad}"`)
    const tok = num ?? name ?? op
    if (tok !== undefined) tokens.push(tok)
  }
  return tokens
}

function wrap(value: bigint): bigint {
  return BigInt.asIntN(64, value)
}

function parseLiteral(text: string): bigint {
  if (text.toLowerCase().startsWith('0x')) return BigInt(text)
  if (text.startsWith('0') && text !== '0') {
    if (!/^[0-7]+$/.test(text))
      throw new ArithError(`value too great for base (error token is "${text}")`)
    return BigInt(`0o${text.slice(1)}`)
  }
  if (!/^-?\d+$/.test(text)) throw new ArithError(`syntax error: unexpected token "${text}"`)
  return BigInt(text)
}

// Recursive-descent parser producing ArithNode trees. Grammar mirrors bash
// arithmetic precedence (comma, assignment, ternary, ||, &&, |, ^, &,
// equality, relational, shift, additive, multiplicative, **, unary,
// ++/--, primary). Evaluation is separate so &&/||/ternary can
// short-circuit side effects.
class ArithParser {
  private pos = 0
  constructor(private readonly tokens: string[]) {}

  private peek(): string | null {
    return this.tokens[this.pos] ?? null
  }

  private take(): string {
    const tok = this.tokens[this.pos]
    if (tok === undefined) throw new ArithError('syntax error: operand expected')
    this.pos++
    return tok
  }

  private expect(tok: string): void {
    if (this.take() !== tok) throw new ArithError(`syntax error: "${tok}" expected`)
  }

  parse(): ArithNode {
    const node = this.comma()
    if (this.peek() !== null)
      throw new ArithError(`syntax error: unexpected token "${String(this.peek())}"`)
    return node
  }

  private comma(): ArithNode {
    const parts = [this.assign()]
    while (this.peek() === ',') {
      this.take()
      parts.push(this.assign())
    }
    const first = parts[0]
    if (parts.length === 1 && first !== undefined) return first
    return { kind: 'comma', parts }
  }

  private assign(): ArithNode {
    const tok = this.peek()
    const next = this.tokens[this.pos + 1]
    if (tok !== null && ARITH_NAME.test(tok) && next !== undefined && ARITH_ASSIGN_OPS.has(next)) {
      const name = this.take()
      const op = this.take()
      return { kind: 'assign', name, op, rhs: this.assign() }
    }
    return this.ternary()
  }

  private ternary(): ArithNode {
    const cond = this.logicOr()
    if (this.peek() !== '?') return cond
    this.take()
    const then = this.assign()
    this.expect(':')
    const other = this.assign()
    return { kind: 'ternary', cond, then, other }
  }

  private logicOr(): ArithNode {
    let node = this.logicAnd()
    while (this.peek() === '||') {
      this.take()
      node = { kind: 'logic', op: '||', left: node, right: this.logicAnd() }
    }
    return node
  }

  private logicAnd(): ArithNode {
    let node = this.bitOr()
    while (this.peek() === '&&') {
      this.take()
      node = { kind: 'logic', op: '&&', left: node, right: this.bitOr() }
    }
    return node
  }

  private bitOr(): ArithNode {
    let node = this.bitXor()
    while (this.peek() === '|') {
      this.take()
      node = { kind: 'binop', op: '|', left: node, right: this.bitXor() }
    }
    return node
  }

  private bitXor(): ArithNode {
    let node = this.bitAnd()
    while (this.peek() === '^') {
      this.take()
      node = { kind: 'binop', op: '^', left: node, right: this.bitAnd() }
    }
    return node
  }

  private bitAnd(): ArithNode {
    let node = this.equality()
    while (this.peek() === '&') {
      this.take()
      node = { kind: 'binop', op: '&', left: node, right: this.equality() }
    }
    return node
  }

  private equality(): ArithNode {
    let node = this.relational()
    while (this.peek() === '==' || this.peek() === '!=') {
      const op = this.take()
      node = { kind: 'binop', op, left: node, right: this.relational() }
    }
    return node
  }

  private relational(): ArithNode {
    let node = this.shift()
    for (;;) {
      const tok = this.peek()
      if (tok !== '<' && tok !== '<=' && tok !== '>' && tok !== '>=') break
      const op = this.take()
      node = { kind: 'binop', op, left: node, right: this.shift() }
    }
    return node
  }

  private shift(): ArithNode {
    let node = this.additive()
    while (this.peek() === '<<' || this.peek() === '>>') {
      const op = this.take()
      node = { kind: 'binop', op, left: node, right: this.additive() }
    }
    return node
  }

  private additive(): ArithNode {
    let node = this.multiplicative()
    while (this.peek() === '+' || this.peek() === '-') {
      const op = this.take()
      node = { kind: 'binop', op, left: node, right: this.multiplicative() }
    }
    return node
  }

  private multiplicative(): ArithNode {
    let node = this.power()
    while (this.peek() === '*' || this.peek() === '/' || this.peek() === '%') {
      const op = this.take()
      node = { kind: 'binop', op, left: node, right: this.power() }
    }
    return node
  }

  private power(): ArithNode {
    const node = this.unary()
    if (this.peek() === '**') {
      this.take()
      return { kind: 'binop', op: '**', left: node, right: this.power() }
    }
    return node
  }

  private unary(): ArithNode {
    const tok = this.peek()
    if (tok === '!' || tok === '~' || tok === '-' || tok === '+') {
      this.take()
      return { kind: 'unary', op: tok, operand: this.unary() }
    }
    if (tok === '++' || tok === '--') {
      this.take()
      const name = this.take()
      if (!ARITH_NAME.test(name)) throw new ArithError(`syntax error: "${tok}" requires a variable`)
      return { kind: 'pre', op: tok, name }
    }
    return this.postfix()
  }

  private postfix(): ArithNode {
    const node = this.primary()
    const tok = this.peek()
    if ((tok === '++' || tok === '--') && node.kind === 'var') {
      this.take()
      return { kind: 'post', op: tok, name: node.name }
    }
    return node
  }

  private primary(): ArithNode {
    const tok = this.take()
    if (tok === '(') {
      const node = this.comma()
      this.expect(')')
      return node
    }
    if (ARITH_NAME.test(tok)) return { kind: 'var', name: tok }
    return { kind: 'num', value: parseLiteral(tok) }
  }
}

// Evaluates the ArithNode tree against an env, recording assignments.
// Reads resolve through `updates` first, then `env`; every write lands in
// `updates` so the caller decides what to apply to the session (bash
// arithmetic assignments are real assignments).
class ArithEvaluator {
  constructor(
    private readonly env: Readonly<Record<string, string>>,
    private readonly updates: Record<string, string>,
    private readonly depth: number,
  ) {}

  private lookup(name: string): bigint {
    const raw = (this.updates[name] ?? this.env[name] ?? '').trim()
    if (raw === '') return 0n
    try {
      return parseLiteral(raw)
    } catch {
      if (this.depth >= ARITH_MAX_DEPTH)
        throw new ArithError(`expression recursion level exceeded (error token is "${raw}")`)
      const { value } = evaluateArith(raw, { ...this.env, ...this.updates }, this.depth + 1)
      return value
    }
  }

  run(node: ArithNode): bigint {
    switch (node.kind) {
      case 'num':
        return node.value
      case 'var':
        return this.lookup(node.name)
      case 'comma': {
        let value = 0n
        for (const part of node.parts) value = this.run(part)
        return value
      }
      case 'assign': {
        const rhsVal = this.run(node.rhs)
        const value =
          node.op === '='
            ? rhsVal
            : this.applyBinop(node.op.slice(0, -1), this.lookup(node.name), rhsVal)
        this.updates[node.name] = value.toString()
        return value
      }
      case 'ternary':
        return this.run(node.cond) !== 0n ? this.run(node.then) : this.run(node.other)
      case 'logic': {
        const lval = this.run(node.left)
        if (node.op === '&&') return lval !== 0n && this.run(node.right) !== 0n ? 1n : 0n
        return lval !== 0n || this.run(node.right) !== 0n ? 1n : 0n
      }
      case 'binop':
        return this.applyBinop(node.op, this.run(node.left), this.run(node.right))
      case 'unary': {
        const value = this.run(node.operand)
        if (node.op === '!') return value !== 0n ? 0n : 1n
        if (node.op === '~') return wrap(~value)
        if (node.op === '-') return wrap(-value)
        return value
      }
      case 'pre': {
        const value = wrap(this.lookup(node.name) + (node.op === '++' ? 1n : -1n))
        this.updates[node.name] = value.toString()
        return value
      }
      case 'post': {
        const value = this.lookup(node.name)
        this.updates[node.name] = wrap(value + (node.op === '++' ? 1n : -1n)).toString()
        return value
      }
    }
  }

  private applyBinop(op: string, a: bigint, b: bigint): bigint {
    switch (op) {
      case '+':
        return wrap(a + b)
      case '-':
        return wrap(a - b)
      case '*':
        return wrap(a * b)
      case '/':
        if (b === 0n) throw new ArithError('division by 0')
        return wrap(a / b)
      case '%':
        if (b === 0n) throw new ArithError('division by 0')
        return wrap(a % b)
      case '**':
        if (b < 0n) throw new ArithError('exponent less than 0')
        return wrap(a ** b)
      case '<<':
        return wrap(a << (b & 63n))
      case '>>':
        return wrap(a >> (b & 63n))
      case '&':
        return wrap(a & b)
      case '|':
        return wrap(a | b)
      case '^':
        return wrap(a ^ b)
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
      case '>=':
        return a >= b ? 1n : 0n
      default:
        throw new ArithError(`unsupported operator "${op}"`)
    }
  }
}

/**
 * Evaluate a bash arithmetic expression.
 *
 * Implements bash's arithmetic grammar over 64-bit wrapping integers
 * (BigInt): comma sequences, assignment operators, the ternary,
 * short-circuit `&&`/`||`, bitwise/relational/shift/additive/
 * multiplicative operators, right-associative `**`, unary operators, and
 * prefix/postfix `++`/`--`. BigInt division/modulo already truncate
 * toward zero like C. A variable whose value is not a plain integer
 * literal is evaluated recursively like bash (`x="1+2"; $((x))` is 3).
 * `base#value` literals are not supported. Returns the value and the
 * assignments made (name to decimal string), for the caller to apply to
 * the session. Throws ArithError on syntax errors, division by zero, or
 * a negative exponent.
 */
export function evaluateArith(
  expr: string,
  env: Readonly<Record<string, string>>,
  depth = 0,
): { value: bigint; updates: Record<string, string> } {
  const tokens = tokenize(expr)
  if (tokens.length === 0) return { value: 0n, updates: {} }
  const node = new ArithParser(tokens).parse()
  const updates: Record<string, string> = {}
  const value = new ArithEvaluator(env, updates, depth).run(node)
  return { value, updates }
}
