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

import { BcParseError, BcRuntimeError, BcHalt, runtimeWarningLine } from './errors.ts'
import type { BcNumber, BcState } from './types.ts'
import { ZERO } from './numbers.ts'
import * as constants from './constants.ts'
import { readBaseNumber, truncateInt, applyBinary, callBuiltin } from './numbers.ts'
import { callFunction } from './math.ts'
import { renderNumber } from './render.ts'
import { stringEnd, unescape } from './lexer.ts'

export function assignable(name: string): boolean {
  if (constants.REGISTERS.has(name)) return true
  return name !== '' && !constants.RESERVED_WORDS.has(name)
}
export class Parser {
  private pos = 0
  constructor(
    private readonly src: string,
    private readonly state: BcState,
    private readonly writes: string[],
  ) {}

  private skipBlanks(): void {
    while (this.pos < this.src.length && constants.BLANKS.has(this.src.charAt(this.pos))) this.pos++
  }

  private peek(): string {
    this.skipBlanks()
    return this.src[this.pos] ?? ''
  }

  private consume(): string {
    const c = this.peek()
    this.pos++
    return c
  }

  private match(s: string): boolean {
    this.skipBlanks()
    if (this.src.startsWith(s, this.pos)) {
      this.pos += s.length
      return true
    }
    return false
  }

  unexpected(): BcParseError {
    const c = this.peek()
    if (c === constants.STRING_QUOTE && stringEnd(this.src, this.pos) < 0) {
      return new BcParseError(`${constants.ILLEGAL_CHARACTER}: ${c}`, false, this.pos)
    }
    if (c !== '' && !constants.LEGAL_CHARS.has(c)) {
      return new BcParseError(`${constants.ILLEGAL_CHARACTER}: ${c}`, false, this.pos)
    }
    return new BcParseError(constants.SYNTAX_ERROR, c === '', this.pos)
  }

  private readNumber(): BcNumber {
    const start = this.pos
    while (this.pos < this.src.length && constants.NUMBER_CHARS.has(this.src.charAt(this.pos)))
      this.pos++
    try {
      return readBaseNumber(this.src.slice(start, this.pos), this.state.ibase)
    } catch (err) {
      if (err instanceof BcParseError) throw new BcParseError(err.text, err.incomplete, start)
      throw err
    }
  }

  private readIdentifier(): string {
    if (this.pos >= this.src.length || !constants.NAME_START.has(this.src.charAt(this.pos)))
      return ''
    const start = this.pos
    this.pos++
    while (this.pos < this.src.length && constants.NAME_CHARS.has(this.src.charAt(this.pos)))
      this.pos++
    return this.src.slice(start, this.pos)
  }

  private emit(num: BcNumber): string {
    this.state.last = num
    return renderNumber(num, this.state.obase)
  }

  private readString(): string {
    this.skipBlanks()
    const start = this.pos
    const end = stringEnd(this.src, start)
    if (end < 0) throw this.unexpected()
    this.pos = end
    return this.src.slice(start + 1, end - 1)
  }

  private readTarget(): string {
    this.skipBlanks()
    const name = this.readIdentifier()
    if (name !== '') return name
    if (
      this.src.charAt(this.pos) === constants.LAST_ALIAS &&
      !constants.DIGIT_CHARS.has(this.src.charAt(this.pos + 1))
    ) {
      this.pos += 1
      return constants.LAST_ALIAS
    }
    return ''
  }

  parseStatement(): void {
    if (this.isHalt()) throw new BcHalt()
    if (this.peek() === constants.STRING_QUOTE) {
      this.writes.push(this.readString())
      return
    }
    if (this.isPrint()) {
      this.parsePrint()
      return
    }
    const probe = this.tryAssignment()
    if (probe === null) {
      this.writes.push(this.emit(this.parseExpr()))
      this.writes.push('\n')
      return
    }
    const [name, op] = probe
    this.assign(name, op, this.parseExpr())
  }

  private isPrint(): boolean {
    const mark = this.pos
    this.skipBlanks()
    if (this.readIdentifier() === constants.PRINT_NAME) return true
    this.pos = mark
    return false
  }

  private parsePrint(): void {
    for (;;) {
      if (this.peek() === constants.STRING_QUOTE) this.writes.push(unescape(this.readString()))
      else this.writes.push(this.emit(this.parseExpr()))
      if (!this.match(',')) return
    }
  }

  private isHalt(): boolean {
    const mark = this.pos
    this.skipBlanks()
    if (this.readIdentifier() === constants.HALT_NAME && this.done()) return true
    this.pos = mark
    return false
  }

  private tryAssignment(): [string, string] | null {
    const mark = this.pos
    const name = this.readTarget()
    if (!assignable(name)) {
      this.pos = mark
      return null
    }
    this.skipBlanks()
    const rest = this.src.slice(this.pos)
    for (const op of constants.COMPOUND_OPS) {
      if (rest.startsWith(`${op}=`)) {
        this.pos += 2
        return [name, op]
      }
    }
    if (rest.startsWith('=') && !rest.startsWith('==')) {
      this.pos += 1
      return [name, '']
    }
    this.pos = mark
    return null
  }

  private assign(name: string, op: string, rhs: BcNumber): BcNumber {
    const value = op === '' ? rhs : applyBinary(op, this.readValue(name), rhs, this.state)
    this.store(name, value)
    return this.readValue(name)
  }

  private readValue(name: string): BcNumber {
    const state = this.state
    if (name === constants.SCALE_NAME) return { coefficient: BigInt(state.scale), scale: 0 }
    if (name === constants.IBASE_NAME) return { coefficient: BigInt(state.ibase), scale: 0 }
    if (name === constants.OBASE_NAME) return { coefficient: BigInt(state.obase), scale: 0 }
    if (name === constants.LAST_NAME || name === constants.LAST_ALIAS) return state.last
    return state.variables.get(name) ?? ZERO
  }

  private store(name: string, num: BcNumber): void {
    const state = this.state
    let requested = truncateInt(num)
    if (name === constants.SCALE_NAME) {
      if (requested < 0n) {
        state.warnings.push(runtimeWarningLine(constants.NEGATIVE_SCALE))
        requested = 0n
      }
      state.scale = Number(
        requested > BigInt(constants.MAX_SCALE) ? BigInt(constants.MAX_SCALE) : requested,
      )
      return
    }
    if (name === constants.IBASE_NAME) {
      state.ibase = this.clampBase(requested, constants.MAX_IBASE, constants.IBASE_TOO_SMALL)
      return
    }
    if (name === constants.OBASE_NAME) {
      state.obase = this.clampBase(requested, constants.MAX_OBASE, constants.OBASE_TOO_SMALL)
      return
    }
    if (name === constants.LAST_NAME || name === constants.LAST_ALIAS) {
      state.last = num
      return
    }
    state.variables.set(name, num)
  }

  private clampBase(requested: bigint, ceiling: number, warning: string): number {
    if (requested < BigInt(constants.MIN_BASE)) {
      this.state.warnings.push(runtimeWarningLine(warning))
      return constants.MIN_BASE
    }
    return Number(requested > BigInt(ceiling) ? BigInt(ceiling) : requested)
  }

  parseExpr(): BcNumber {
    const probe = this.tryAssignment()
    if (probe === null) return this.parseAdditive()
    const [name, op] = probe
    return this.assign(name, op, this.parseExpr())
  }

  private parseAdditive(): BcNumber {
    let left = this.parseTerm()
    for (;;) {
      const c = this.peek()
      if (c !== '+' && c !== '-') return left
      if (this.src.startsWith(c + c, this.pos)) return left
      this.consume()
      left = applyBinary(c, left, this.parseTerm(), this.state)
    }
  }

  private parseTerm(): BcNumber {
    let left = this.parseUnary()
    for (;;) {
      const c = this.peek()
      if (c !== '*' && c !== '/' && c !== '%') return left
      this.consume()
      left = applyBinary(c, left, this.parseUnary(), this.state)
    }
  }

  private parseUnary(): BcNumber {
    if (this.match('++')) return this.parsePrefixStep(1)
    if (this.match('--')) return this.parsePrefixStep(-1)
    const c = this.peek()
    if (c === '-') {
      this.consume()
      const operand = this.parseUnary()
      return { coefficient: -operand.coefficient, scale: operand.scale }
    }
    return this.parsePower()
  }

  private parsePrefixStep(delta: number): BcNumber {
    const name = this.readTarget()
    if (!assignable(name)) throw this.unexpected()
    const old = this.readValue(name)
    this.store(name, applyBinary('+', old, { coefficient: BigInt(delta), scale: 0 }, this.state))
    return this.readValue(name)
  }

  private parsePower(): BcNumber {
    const base = this.parseAtom()
    if (this.peek() !== '^') return base
    this.consume()
    return applyBinary('^', base, this.parseUnary(), this.state)
  }

  private parseAtom(): BcNumber {
    const c = this.peek()
    if (c === '(') {
      this.consume()
      const val = this.parseExpr()
      if (!this.match(')')) throw this.unexpected()
      return val
    }
    if (c === constants.LAST_ALIAS) {
      if (constants.DIGIT_CHARS.has(this.src.charAt(this.pos + 1))) return this.readNumber()
      return this.parseName()
    }
    if (constants.DIGIT_CHARS.has(c)) return this.readNumber()
    if (constants.NAME_START.has(c)) return this.parseName()
    throw this.unexpected()
  }

  private parseName(): BcNumber {
    this.skipBlanks()
    const start = this.pos
    const name = this.readTarget()
    if (constants.BUILTIN_CALLS.has(name)) {
      if (this.peek() === '(') return this.parseBuiltinCall(name)
      if (name === constants.SCALE_NAME) return this.parsePostfix(name)
      throw new BcParseError(constants.SYNTAX_ERROR, this.peek() === '', start)
    }
    if (constants.REGISTERS.has(name)) return this.parsePostfix(name)
    if (constants.RESERVED_WORDS.has(name))
      throw new BcParseError(constants.SYNTAX_ERROR, false, start)
    if (this.match('(')) {
      const arg = this.parseExpr()
      if (!this.match(')')) throw this.unexpected()
      if (this.state.mathMode && constants.MATH_FUNCS.has(name)) {
        return callFunction(name, arg, this.state.scale)
      }
      throw new BcRuntimeError(`Function ${name} not defined.`)
    }
    return this.parsePostfix(name)
  }

  private parseBuiltinCall(name: string): BcNumber {
    this.consume()
    const arg = this.parseExpr()
    if (!this.match(')')) throw this.unexpected()
    return callBuiltin(name, arg, this.state.scale)
  }

  private parsePostfix(name: string): BcNumber {
    const value = this.readValue(name)
    if (this.match('++')) {
      this.store(name, applyBinary('+', value, { coefficient: 1n, scale: 0 }, this.state))
    } else if (this.match('--')) {
      this.store(name, applyBinary('-', value, { coefficient: 1n, scale: 0 }, this.state))
    }
    return value
  }

  done(): boolean {
    this.skipBlanks()
    return this.pos >= this.src.length
  }
}

export function evalStatement(text: string, state: BcState, writes: string[]): void {
  const parser = new Parser(text, state, writes)
  parser.parseStatement()
  if (!parser.done()) throw parser.unexpected()
}
