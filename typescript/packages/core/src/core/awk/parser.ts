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

import { AwkSyntaxError } from './errors.ts'
import { TokKind, tokenize, type Token } from './lexer.ts'
import {
  GetlineKind,
  RedirKind,
  RuleKind,
  isLvalue,
  type Block,
  type Expr,
  type FuncDef,
  type Program,
  type Redirect,
  type Rule,
  type Stmt,
} from './nodes.ts'
import { compileEre } from './regex.ts'

const P_ASSIGN = 1
const P_TERNARY = 2
const P_OR = 3
const P_AND = 4
const P_IN = 5
const P_GETLINE_PIPE = 6
const P_MATCH = 7
const P_COMPARE = 8
const P_CONCAT = 9
const P_ADD = 10
const P_MUL = 11
const P_UNARY = 12
const P_POW = 13

const ASSIGN_OPS: ReadonlySet<string> = new Set(['=', '+=', '-=', '*=', '/=', '%=', '^='])
const COMPARE_OPS: ReadonlySet<string> = new Set(['<', '<=', '>', '>=', '==', '!='])
const ADD_OPS: ReadonlySet<string> = new Set(['+', '-'])
const MUL_OPS: ReadonlySet<string> = new Set(['*', '/', '%'])

const CONCAT_START_KINDS: ReadonlySet<TokKind> = new Set([
  TokKind.NUMBER,
  TokKind.STRING,
  TokKind.ERE,
  TokKind.NAME,
  TokKind.FUNC_NAME,
  TokKind.BUILTIN,
])

const CONCAT_START_OPS: ReadonlySet<string> = new Set(['$', '(', '++', '--', '!'])

export class Parser {
  private readonly toks: Token[]
  private pos = 0
  private readonly funcs = new Map<string, FuncDef>()
  private loopDepth = 0
  private inFunction = false

  constructor(tokens: Token[]) {
    this.toks = tokens
  }

  private peek(ahead = 0): Token {
    const tok = this.toks[this.pos + ahead] ?? this.toks[this.toks.length - 1]
    if (tok === undefined) throw new AwkSyntaxError('awk: syntax error: empty token stream')
    return tok
  }

  private nextToken(): Token {
    const tok = this.peek()
    if (tok.kind !== TokKind.EOF) this.pos += 1
    return tok
  }

  private error(message: string): AwkSyntaxError {
    const tok = this.peek()
    const near = tok.kind !== TokKind.EOF ? tok.text : 'end of program'
    return new AwkSyntaxError(`awk: syntax error at '${near}': ${message}`)
  }

  private atOp(...texts: string[]): boolean {
    const tok = this.peek()
    return tok.kind === TokKind.OP && texts.includes(tok.text)
  }

  private atKeyword(...words: string[]): boolean {
    const tok = this.peek()
    return tok.kind === TokKind.KEYWORD && words.includes(tok.text)
  }

  private eatOp(text: string): void {
    if (!this.atOp(text)) throw this.error(`expected '${text}'`)
    this.pos += 1
  }

  private eatKeyword(word: string): void {
    if (!this.atKeyword(word)) throw this.error(`expected '${word}'`)
    this.pos += 1
  }

  private skipNewlines(): void {
    while (this.peek().kind === TokKind.NEWLINE) this.pos += 1
  }

  private skipTerminators(): void {
    while (this.peek().kind === TokKind.NEWLINE || this.atOp(';')) this.pos += 1
  }

  private atStmtEnd(): boolean {
    const tok = this.peek()
    return (
      tok.kind === TokKind.NEWLINE ||
      tok.kind === TokKind.EOF ||
      (tok.kind === TokKind.OP && (tok.text === '}' || tok.text === ';'))
    )
  }

  parseProgram(): Program {
    const rules: Rule[] = []
    this.skipTerminators()
    while (this.peek().kind !== TokKind.EOF) {
      if (this.atKeyword('function', 'func')) this.parseFunction()
      else rules.push(this.parseRule())
      this.skipTerminators()
    }
    return { rules, functions: this.funcs }
  }

  private parseFunction(): void {
    this.nextToken()
    const nameTok = this.nextToken()
    if (nameTok.kind !== TokKind.NAME && nameTok.kind !== TokKind.FUNC_NAME) {
      throw this.error('expected function name')
    }
    this.eatOp('(')
    const params: string[] = []
    this.skipNewlines()
    while (!this.atOp(')')) {
      const tok = this.nextToken()
      if (tok.kind !== TokKind.NAME) throw this.error('expected parameter name')
      params.push(tok.text)
      this.skipNewlines()
      if (this.atOp(',')) {
        this.pos += 1
        this.skipNewlines()
      }
    }
    this.eatOp(')')
    this.skipNewlines()
    this.inFunction = true
    const body = this.parseBlock()
    this.inFunction = false
    this.funcs.set(nameTok.text, { name: nameTok.text, params, body })
  }

  private parseRule(): Rule {
    if (this.atKeyword('BEGIN')) {
      this.pos += 1
      this.skipNewlines()
      return { kind: RuleKind.BEGIN, pattern: null, patternEnd: null, action: this.parseBlock() }
    }
    if (this.atKeyword('END')) {
      this.pos += 1
      this.skipNewlines()
      return { kind: RuleKind.END, pattern: null, patternEnd: null, action: this.parseBlock() }
    }
    if (this.atOp('{')) {
      return { kind: RuleKind.ALWAYS, pattern: null, patternEnd: null, action: this.parseBlock() }
    }
    const pattern = this.parseExpr(P_ASSIGN)
    if (this.atOp(',')) {
      this.pos += 1
      this.skipNewlines()
      const patternEnd = this.parseExpr(P_ASSIGN)
      const action = this.atOp('{') ? this.parseBlock() : null
      return { kind: RuleKind.RANGE, pattern, patternEnd, action }
    }
    const action = this.atOp('{') ? this.parseBlock() : null
    return { kind: RuleKind.PATTERN, pattern, patternEnd: null, action }
  }

  private parseBlock(): Block {
    this.eatOp('{')
    const body: Stmt[] = []
    this.skipTerminators()
    while (!this.atOp('}')) {
      if (this.peek().kind === TokKind.EOF) {
        throw this.error("unexpected end of program, expected '}'")
      }
      body.push(this.parseStatement())
      this.skipTerminators()
    }
    this.eatOp('}')
    return { type: 'Block', body }
  }

  private parseSimpleOrBlock(): Stmt {
    this.skipNewlines()
    if (this.atOp('{')) return this.parseBlock()
    return this.parseStatement()
  }

  private parseLoopBody(): Stmt {
    this.loopDepth += 1
    const body = this.parseSimpleOrBlock()
    this.loopDepth -= 1
    return body
  }

  private parseStatement(): Stmt {
    if (this.atOp('{')) return this.parseBlock()
    if (this.atOp(';')) {
      this.pos += 1
      return { type: 'Block', body: [] }
    }
    const tok = this.peek()
    if (tok.kind === TokKind.KEYWORD) {
      if (tok.text === 'if') return this.parseIf()
      if (tok.text === 'while') return this.parseWhile()
      if (tok.text === 'do') return this.parseDoWhile()
      if (tok.text === 'for') return this.parseFor()
      if (tok.text === 'print' || tok.text === 'printf') return this.parsePrint()
      if (tok.text === 'delete') return this.parseDelete()
      if (['break', 'continue', 'next', 'nextfile'].includes(tok.text)) {
        if ((tok.text === 'break' || tok.text === 'continue') && this.loopDepth === 0) {
          throw this.error(`${tok.text} outside a loop`)
        }
        this.pos += 1
        return simpleJump(tok.text)
      }
      if (tok.text === 'exit' || tok.text === 'return') {
        if (tok.text === 'return' && !this.inFunction) {
          throw this.error('return outside a function')
        }
        this.pos += 1
        const value = this.atStmtEnd() ? null : this.parseExpr(P_ASSIGN)
        return tok.text === 'exit' ? { type: 'Exit', value } : { type: 'Return', value }
      }
    }
    return { type: 'ExprStmt', expr: this.parseExpr(P_ASSIGN) }
  }

  private parseIf(): Stmt {
    this.eatKeyword('if')
    this.eatOp('(')
    const cond = this.parseExpr(P_ASSIGN)
    this.eatOp(')')
    const then = this.parseSimpleOrBlock()
    const save = this.pos
    this.skipTerminators()
    if (this.atKeyword('else')) {
      this.pos += 1
      return { type: 'If', cond, then, other: this.parseSimpleOrBlock() }
    }
    this.pos = save
    return { type: 'If', cond, then, other: null }
  }

  private parseWhile(): Stmt {
    this.eatKeyword('while')
    this.eatOp('(')
    const cond = this.parseExpr(P_ASSIGN)
    this.eatOp(')')
    return { type: 'While', cond, body: this.parseLoopBody() }
  }

  private parseDoWhile(): Stmt {
    this.eatKeyword('do')
    const body = this.parseLoopBody()
    this.skipTerminators()
    this.eatKeyword('while')
    this.eatOp('(')
    const cond = this.parseExpr(P_ASSIGN)
    this.eatOp(')')
    return { type: 'DoWhile', body, cond }
  }

  private parseFor(): Stmt {
    this.eatKeyword('for')
    this.eatOp('(')
    const ahead = this.peek(1)
    if (
      this.peek().kind === TokKind.NAME &&
      ahead.kind === TokKind.KEYWORD &&
      ahead.text === 'in'
    ) {
      const name = this.nextToken().text
      this.pos += 1
      const array = this.nextToken()
      if (array.kind !== TokKind.NAME) throw this.error('expected array name')
      this.eatOp(')')
      return { type: 'ForIn', var: name, array: array.text, body: this.parseLoopBody() }
    }
    const init = this.atOp(';') ? null : this.parseStatement()
    this.eatOp(';')
    this.skipNewlines()
    const cond = this.atOp(';') ? null : this.parseExpr(P_ASSIGN)
    this.eatOp(';')
    this.skipNewlines()
    const post = this.atOp(')') ? null : this.parseStatement()
    this.eatOp(')')
    return { type: 'For', init, cond, post, body: this.parseLoopBody() }
  }

  private parseDelete(): Stmt {
    this.eatKeyword('delete')
    const name = this.nextToken()
    if (name.kind !== TokKind.NAME && name.kind !== TokKind.FUNC_NAME) {
      throw this.error('expected array name')
    }
    if (this.atOp('[')) {
      this.pos += 1
      const subscripts = this.parseExprList(']')
      this.eatOp(']')
      return { type: 'Delete', name: name.text, subscripts }
    }
    if (this.atOp('(')) {
      this.pos += 1
      const subscripts = this.parseExprList(')')
      this.eatOp(')')
      return { type: 'Delete', name: name.text, subscripts }
    }
    return { type: 'Delete', name: name.text, subscripts: null }
  }

  private parseExprList(closer: string): Expr[] {
    const items: Expr[] = []
    this.skipNewlines()
    if (this.atOp(closer)) return items
    items.push(this.parseExpr(P_ASSIGN))
    while (this.atOp(',')) {
      this.pos += 1
      this.skipNewlines()
      items.push(this.parseExpr(P_ASSIGN))
    }
    return items
  }

  private parsePrint(): Stmt {
    const word = this.nextToken().text
    let args: Expr[] = []
    if (!this.atStmtEnd() && !this.atOp('>', '>>', '|')) args = this.parsePrintArgs()
    const redirect = this.parseRedirect()
    return word === 'print' ? { type: 'Print', args, redirect } : { type: 'Printf', args, redirect }
  }

  // `print (a, b)` is tried first and backtracked when the parentheses
  // turn out to group one expression instead of the whole list.
  private parsePrintArgs(): Expr[] {
    if (this.atOp('(')) {
      const save = this.pos
      this.pos += 1
      const grouped = this.tryExprList(')')
      if (grouped !== null && grouped.length > 1 && this.atOp(')')) {
        this.pos += 1
        if (this.atStmtEnd() || this.atOp('>', '>>', '|')) return grouped
      }
      this.pos = save
    }
    const items: Expr[] = [this.parseExpr(P_ASSIGN, true)]
    while (this.atOp(',')) {
      this.pos += 1
      this.skipNewlines()
      items.push(this.parseExpr(P_ASSIGN, true))
    }
    return items
  }

  private tryExprList(closer: string): Expr[] | null {
    try {
      return this.parseExprList(closer)
    } catch (err) {
      if (err instanceof AwkSyntaxError) return null
      throw err
    }
  }

  private parseRedirect(): Redirect | null {
    if (this.atOp('>')) {
      this.pos += 1
      return { kind: RedirKind.FILE, target: this.parseExpr(P_CONCAT) }
    }
    if (this.atOp('>>')) {
      this.pos += 1
      return { kind: RedirKind.APPEND, target: this.parseExpr(P_CONCAT) }
    }
    if (this.atOp('|')) {
      this.pos += 1
      return { kind: RedirKind.PIPE, target: this.parseExpr(P_CONCAT) }
    }
    return null
  }

  // Precedence climbing; with `noGt` the `>`, `>>` and `|` of a print
  // redirection end the expression instead of comparing.
  private parseExpr(minBp: number, noGt = false): Expr {
    return this.parseInfix(this.parseUnary(noGt), minBp, noGt)
  }

  private parseUnary(noGt: boolean): Expr {
    if (this.atOp('!')) {
      this.pos += 1
      return { type: 'Not', operand: this.parseExpr(P_UNARY, noGt) }
    }
    if (this.atOp('-')) {
      this.pos += 1
      return { type: 'Unary', op: '-', operand: this.parseExpr(P_UNARY, noGt) }
    }
    if (this.atOp('+')) {
      this.pos += 1
      return { type: 'Unary', op: '+', operand: this.parseExpr(P_UNARY, noGt) }
    }
    if (this.atOp('++', '--')) {
      const op = this.nextToken().text
      const target = this.parseUnary(noGt)
      if (!isLvalue(target)) throw this.error(`${op} needs an lvalue`)
      return { type: 'IncDec', pre: true, op, target }
    }
    return this.parsePostfix(this.parsePrimary(noGt))
  }

  private parsePostfix(start: Expr): Expr {
    let node = start
    while (this.atOp('++', '--') && isLvalue(node)) {
      const op = this.nextToken().text
      node = { type: 'IncDec', pre: false, op, target: node }
    }
    return node
  }

  private parsePrimary(noGt: boolean): Expr {
    const tok = this.peek()
    if (tok.kind === TokKind.NUMBER) {
      this.pos += 1
      return { type: 'Num', value: Number(tok.value) }
    }
    if (tok.kind === TokKind.STRING) {
      this.pos += 1
      return { type: 'Str', value: tok.value }
    }
    if (tok.kind === TokKind.ERE) {
      this.pos += 1
      compileEre(tok.value)
      return { type: 'Regex', pattern: tok.value }
    }
    if (tok.kind === TokKind.OP && tok.text === '$') {
      this.pos += 1
      return { type: 'Field', index: this.parseFieldIndex(noGt) }
    }
    if (tok.kind === TokKind.OP && tok.text === '(') return this.parseGrouping()
    if (tok.kind === TokKind.KEYWORD && tok.text === 'getline') return this.parseGetline(null)
    if (tok.kind === TokKind.BUILTIN) {
      this.pos += 1
      if (this.atOp('(')) {
        this.pos += 1
        const args = this.parseExprList(')')
        this.eatOp(')')
        return { type: 'BuiltinCall', name: tok.text, args }
      }
      return { type: 'BuiltinCall', name: tok.text, args: [] }
    }
    if (tok.kind === TokKind.FUNC_NAME) {
      this.pos += 1
      this.eatOp('(')
      const args = this.parseExprList(')')
      this.eatOp(')')
      return { type: 'Call', name: tok.text, args }
    }
    if (tok.kind === TokKind.NAME) {
      this.pos += 1
      if (this.atOp('[')) {
        this.pos += 1
        const subscripts = this.parseExprList(']')
        this.eatOp(']')
        return { type: 'ArrayRef', name: tok.text, subscripts }
      }
      return { type: 'Var', name: tok.text }
    }
    throw this.error('expected an expression')
  }

  // `$` binds tighter than every binary operator, so `$NF-1` is
  // ($NF)-1 and only a parenthesised index can be compound.
  private parseFieldIndex(noGt: boolean): Expr {
    if (this.atOp('(')) return this.parseGrouping()
    if (this.atOp('$')) {
      this.pos += 1
      return { type: 'Field', index: this.parseFieldIndex(noGt) }
    }
    if (this.atOp('++', '--')) {
      const op = this.nextToken().text
      const target = this.parseFieldIndex(noGt)
      if (!isLvalue(target)) throw this.error(`${op} needs an lvalue`)
      return { type: 'IncDec', pre: true, op, target }
    }
    if (this.atOp('-')) {
      this.pos += 1
      return { type: 'Unary', op: '-', operand: this.parseFieldIndex(noGt) }
    }
    return this.parsePostfix(this.parsePrimary(noGt))
  }

  private parseGrouping(): Expr {
    this.eatOp('(')
    const items = this.parseExprList(')')
    this.eatOp(')')
    const only = items[0]
    if (items.length === 1 && only !== undefined) return only
    if (this.atKeyword('in')) {
      this.pos += 1
      const name = this.nextToken()
      if (name.kind !== TokKind.NAME) throw this.error("expected array name after 'in'")
      return { type: 'InArray', subscripts: items, name: name.text }
    }
    throw this.error('unexpected expression list')
  }

  private parseGetline(source: Expr | null): Expr {
    this.eatKeyword('getline')
    let target: Expr | null = null
    const tok = this.peek()
    if (tok.kind === TokKind.NAME || (tok.kind === TokKind.OP && tok.text === '$')) {
      const candidate = this.parsePrimary(true)
      if (!isLvalue(candidate)) throw this.error('getline needs an lvalue')
      target = candidate
    }
    if (source !== null) return { type: 'Getline', kind: GetlineKind.CMD, target, source }
    if (this.atOp('<')) {
      this.pos += 1
      return {
        type: 'Getline',
        kind: GetlineKind.FILE,
        target,
        source: this.parseExpr(P_CONCAT),
      }
    }
    return { type: 'Getline', kind: GetlineKind.PLAIN, target, source: null }
  }

  private startsConcat(): boolean {
    const tok = this.peek()
    if (CONCAT_START_KINDS.has(tok.kind)) return true
    if (tok.kind === TokKind.OP) return CONCAT_START_OPS.has(tok.text)
    if (tok.kind === TokKind.KEYWORD) return tok.text === 'getline'
    return false
  }

  private parseInfix(start: Expr, minBp: number, noGt: boolean): Expr {
    let left = start
    for (;;) {
      const tok = this.peek()
      if (tok.kind === TokKind.KEYWORD && tok.text === 'in') {
        if (P_IN < minBp) return left
        this.pos += 1
        const name = this.nextToken()
        if (name.kind !== TokKind.NAME) throw this.error("expected array name after 'in'")
        left = { type: 'InArray', subscripts: [left], name: name.text }
        continue
      }
      if (tok.kind !== TokKind.OP) {
        if (this.startsConcat() && P_CONCAT >= minBp) {
          left = { type: 'Concat', left, right: this.parseExpr(P_CONCAT + 1, noGt) }
          continue
        }
        return left
      }
      const op = tok.text
      if (ASSIGN_OPS.has(op)) {
        if (P_ASSIGN < minBp || !isLvalue(left)) return left
        this.pos += 1
        this.skipNewlines()
        return { type: 'Assign', target: left, op, value: this.parseExpr(P_ASSIGN, noGt) }
      }
      if (op === '?') {
        if (P_TERNARY < minBp) return left
        this.pos += 1
        this.skipNewlines()
        const then = this.parseExpr(P_ASSIGN, noGt)
        this.eatOp(':')
        this.skipNewlines()
        left = { type: 'Ternary', cond: left, then, other: this.parseExpr(P_TERNARY, noGt) }
        continue
      }
      if (op === '||' || op === '&&') {
        const bp = op === '||' ? P_OR : P_AND
        if (bp < minBp) return left
        this.pos += 1
        this.skipNewlines()
        left = { type: 'Logical', op, left, right: this.parseExpr(bp + 1, noGt) }
        continue
      }
      if (op === '~' || op === '!~') {
        if (P_MATCH < minBp) return left
        this.pos += 1
        left = {
          type: 'MatchOp',
          negated: op === '!~',
          left,
          right: this.parseExpr(P_MATCH + 1, noGt),
        }
        continue
      }
      if (op === '|') {
        if (noGt || P_GETLINE_PIPE < minBp) return left
        const ahead = this.peek(1)
        if (!(ahead.kind === TokKind.KEYWORD && ahead.text === 'getline')) return left
        this.pos += 1
        left = this.parseGetline(left)
        continue
      }
      if (COMPARE_OPS.has(op)) {
        if ((noGt && op === '>') || P_COMPARE < minBp) return left
        this.pos += 1
        left = { type: 'Compare', op, left, right: this.parseExpr(P_COMPARE + 1, noGt) }
        continue
      }
      if (ADD_OPS.has(op)) {
        if (P_ADD < minBp) return left
        this.pos += 1
        left = { type: 'Binary', op, left, right: this.parseExpr(P_ADD + 1, noGt) }
        continue
      }
      if (MUL_OPS.has(op)) {
        if (P_MUL < minBp) return left
        this.pos += 1
        left = { type: 'Binary', op, left, right: this.parseExpr(P_MUL + 1, noGt) }
        continue
      }
      if (op === '^') {
        if (P_POW < minBp) return left
        this.pos += 1
        left = { type: 'Binary', op: '^', left, right: this.parseExpr(P_POW, noGt) }
        continue
      }
      if (CONCAT_START_OPS.has(op)) {
        if (P_CONCAT < minBp) return left
        left = { type: 'Concat', left, right: this.parseExpr(P_CONCAT + 1, noGt) }
        continue
      }
      return left
    }
  }
}

function simpleJump(word: string): Stmt {
  if (word === 'break') return { type: 'Break' }
  if (word === 'continue') return { type: 'Continue' }
  if (word === 'next') return { type: 'Next' }
  return { type: 'NextFile' }
}

export function parse(src: string): Program {
  return new Parser(tokenize(src)).parseProgram()
}
