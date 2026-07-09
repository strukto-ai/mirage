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

import type { CallStack } from '../../shell/call_stack.ts'
import { NodeType as NT } from '../../shell/types.ts'
import type { IOResult } from '../../io/types.ts'
import type { Session } from '../session/session.ts'
import { expandTilde } from '../../utils/path.ts'
import { homeDir } from '../session/shell_dirs.ts'
import { shlexSplit } from '../../utils/shlex.ts'
import { ARITH_DELIMITERS, ARITH_OPERATORS } from './constants.ts'
import { expandBraces, lookupVar, type TSNodeLike } from './variable.ts'

export type ExecuteFn = (command: string, opts: { sessionId: string }) => Promise<IOResult>

function unescapeUnquoted(text: string): string {
  if (!text.includes('\\')) return text
  const parts = shlexSplit(text)
  return parts[0] ?? text
}

export function safeEval(expr: string): number {
  const tokens = tokenizeArith(expr)
  const parser = new ArithParser(tokens)
  const result = parser.parseExpr()
  if (!parser.atEnd()) {
    throw new Error(`unsafe arithmetic: ${expr}`)
  }
  return Math.trunc(result)
}

async function expandArith(
  tsNode: TSNodeLike,
  session: Session,
  executeFn: ExecuteFn,
  callStack: CallStack | null,
): Promise<string> {
  const parts: string[] = []
  for (const child of tsNode.children) {
    if (ARITH_DELIMITERS.has(child.type)) continue
    if (
      child.type === NT.BINARY_EXPRESSION ||
      child.type === NT.UNARY_EXPRESSION ||
      child.type === NT.PARENTHESIZED_EXPRESSION ||
      child.type === NT.TERNARY_EXPRESSION
    ) {
      parts.push(await expandArith(child, session, executeFn, callStack))
    } else if (ARITH_OPERATORS.has(child.type)) {
      parts.push(child.text)
    } else if (child.type === NT.NUMBER) {
      parts.push(child.text)
    } else if (
      child.type === NT.SIMPLE_EXPANSION ||
      child.type === NT.EXPANSION ||
      child.type === NT.COMMAND_SUBSTITUTION
    ) {
      parts.push(await expandNode(child, session, executeFn, callStack))
    } else if (child.type === NT.VARIABLE_NAME) {
      parts.push(session.env[child.text] ?? '0')
    } else {
      parts.push(await expandNode(child, session, executeFn, callStack))
    }
  }
  return parts.join(' ')
}

export async function expandNode(
  tsNode: TSNodeLike,
  session: Session,
  executeFn: ExecuteFn,
  callStack: CallStack | null = null,
): Promise<string> {
  const ntype = tsNode.type

  if (ntype === NT.WORD) return expandTilde(unescapeUnquoted(tsNode.text), homeDir(session))
  if (ntype === NT.NUMBER) return tsNode.text
  if (ntype === NT.COMMAND_NAME) {
    // The name is a word like any other: $CMD, "quoted", $(sub) all
    // expand. A bare word has one named child (or none) and falls
    // through to its own expansion rule.
    const child = tsNode.namedChildren[0]
    if (child !== undefined) return expandNode(child, session, executeFn, callStack)
    return tsNode.text
  }

  if (ntype === NT.SIMPLE_EXPANSION) {
    const raw = tsNode.text
    const dollar = raw.lastIndexOf('$')
    const prefix = raw.slice(0, dollar)
    const variable = raw.slice(dollar + 1)
    return prefix + lookupVar(variable, session, callStack)
  }

  if (ntype === NT.EXPANSION) {
    return expandBraces(tsNode, session.env, callStack, session.arrays)
  }

  if (ntype === NT.COMMAND_SUBSTITUTION) {
    const innerCmds = tsNode.namedChildren.filter(
      (c) =>
        c.type === NT.COMMAND ||
        c.type === NT.PIPELINE ||
        c.type === NT.LIST ||
        c.type === NT.REDIRECTED_STATEMENT ||
        c.type === NT.SUBSHELL,
    )
    if (innerCmds.length === 0) return ''
    const inner = innerCmds[0]?.text ?? ''
    const io = await executeFn(inner, { sessionId: session.sessionId })
    return (await io.stdoutStr()).replace(/\n+$/, '')
  }

  if (ntype === NT.ARITHMETIC_EXPANSION) {
    const expr = await expandArith(tsNode, session, executeFn, callStack)
    try {
      return String(safeEval(expr))
    } catch {
      return tsNode.text
    }
  }

  if (ntype === NT.CONCATENATION) {
    const parts: string[] = []
    for (const child of tsNode.children) {
      parts.push(await expandNode(child, session, executeFn, callStack))
    }
    return parts.join('')
  }

  if (ntype === NT.STRING) {
    const parts: string[] = []
    for (const child of tsNode.children) {
      if (child.type === NT.DQUOTE) continue
      parts.push(await expandNode(child, session, executeFn, callStack))
    }
    return parts.join('')
  }

  if (ntype === NT.STRING_CONTENT) {
    const NUL = String.fromCharCode(0)
    let text = tsNode.text
    text = text.replaceAll('\\\\', NUL)
    text = text.replaceAll('\\"', '"')
    text = text.replaceAll('\\$', '$')
    text = text.replaceAll('\\`', '`')
    text = text.replaceAll('\\\n', '')
    text = text.replaceAll(NUL, '\\')
    return text
  }

  if (ntype === NT.RAW_STRING) {
    const raw = tsNode.text
    return raw.slice(1, -1)
  }

  if (ntype === NT.VARIABLE_ASSIGNMENT) {
    const raw = tsNode.text
    if (raw.includes('=')) {
      const eq = raw.indexOf('=')
      const key = raw.slice(0, eq)
      const valPart = raw.slice(eq + 1)
      const valNodes = tsNode.namedChildren.filter((c) => c.type !== NT.VARIABLE_NAME)
      if (valNodes.length > 0 && valNodes[0] !== undefined) {
        const expanded = await expandNode(valNodes[0], session, executeFn, callStack)
        return `${key}=${expanded}`
      }
      return `${key}=${valPart}`
    }
    return raw
  }

  return tsNode.text
}

type ArithToken = { kind: 'num'; value: number } | { kind: 'op'; value: string }

function tokenizeArith(expr: string): ArithToken[] {
  const tokens: ArithToken[] = []
  let i = 0
  const s = expr.trim()
  while (i < s.length) {
    const c = s[i]
    if (c === undefined) break
    if (c === ' ' || c === '\t') {
      i++
      continue
    }
    if (c >= '0' && c <= '9') {
      let j = i
      while (j < s.length && s[j] !== undefined && /[0-9]/.test(s[j] ?? '')) j++
      tokens.push({ kind: 'num', value: parseInt(s.slice(i, j), 10) })
      i = j
      continue
    }
    const two = s.slice(i, i + 2)
    if (
      two === '**' ||
      two === '==' ||
      two === '!=' ||
      two === '<=' ||
      two === '>=' ||
      two === '&&' ||
      two === '||'
    ) {
      tokens.push({ kind: 'op', value: two })
      i += 2
      continue
    }
    if ('+-*/%<>!?():'.includes(c)) {
      tokens.push({ kind: 'op', value: c })
      i++
      continue
    }
    throw new Error(`unsafe arithmetic: ${expr}`)
  }
  return tokens
}

const PRECEDENCE: Record<string, number> = {
  '||': 1,
  '&&': 2,
  '==': 3,
  '!=': 3,
  '<': 4,
  '>': 4,
  '<=': 4,
  '>=': 4,
  '+': 5,
  '-': 5,
  '*': 6,
  '/': 6,
  '%': 6,
  '**': 7,
}

class ArithParser {
  private pos = 0
  constructor(private readonly tokens: ArithToken[]) {}

  atEnd(): boolean {
    return this.pos >= this.tokens.length
  }

  private peek(): ArithToken | null {
    return this.tokens[this.pos] ?? null
  }

  private consume(): ArithToken {
    const t = this.tokens[this.pos]
    if (t === undefined) throw new Error('unexpected end of arithmetic expression')
    this.pos++
    return t
  }

  parseExpr(): number {
    return this.parseBinary(0)
  }

  private parseBinary(minPrec: number): number {
    let left = this.parseUnary()
    for (;;) {
      const t = this.peek()
      if (t?.kind !== 'op') break
      const prec = PRECEDENCE[t.value]
      if (prec === undefined || prec < minPrec) break
      this.consume()
      const rightAssoc = t.value === '**'
      const right = this.parseBinary(rightAssoc ? prec : prec + 1)
      left = applyBinary(t.value, left, right)
    }
    return left
  }

  private parseUnary(): number {
    const t = this.peek()
    if (t?.kind === 'op' && (t.value === '-' || t.value === '+' || t.value === '!')) {
      this.consume()
      const operand = this.parseUnary()
      if (t.value === '-') return -operand
      if (t.value === '!') return operand === 0 ? 1 : 0
      return operand
    }
    return this.parseAtom()
  }

  private parseAtom(): number {
    const t = this.consume()
    if (t.kind === 'num') return t.value
    if (t.value === '(') {
      const val = this.parseExpr()
      const close = this.consume()
      if (close.kind !== 'op' || close.value !== ')') {
        throw new Error('expected )')
      }
      return val
    }
    throw new Error(`unsafe arithmetic token: ${t.value}`)
  }
}

function applyBinary(op: string, a: number, b: number): number {
  switch (op) {
    case '+':
      return a + b
    case '-':
      return a - b
    case '*':
      return a * b
    case '/':
      if (b === 0) throw new Error('division by zero')
      return Math.trunc(a / b)
    case '%':
      if (b === 0) throw new Error('modulo by zero')
      return a % b
    case '**':
      return a ** b
    case '==':
      return a === b ? 1 : 0
    case '!=':
      return a !== b ? 1 : 0
    case '<':
      return a < b ? 1 : 0
    case '>':
      return a > b ? 1 : 0
    case '<=':
      return a <= b ? 1 : 0
    case '>=':
      return a >= b ? 1 : 0
    case '&&':
      return a !== 0 && b !== 0 ? 1 : 0
    case '||':
      return a !== 0 || b !== 0 ? 1 : 0
    default:
      throw new Error(`unsupported arithmetic op: ${op}`)
  }
}
