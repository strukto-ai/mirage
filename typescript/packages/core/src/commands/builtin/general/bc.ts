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

import type { PathSpec } from '../../../types.ts'
import type { Accessor } from '../../../accessor/base.ts'
import { IOResult } from '../../../io/types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { readStdinAsync } from '../utils/stream.ts'
import { pureProvision } from '../generic_bind/provision.ts'

const ENC = new TextEncoder()

// Minimal safe expression evaluator for `bc`. Supports:
//   - integers and decimals
//   - + - * / % and ^ (exponentiation; Python's bc uses ^)
//   - ( ) parentheses
//   - unary - and +
//   - math functions (with -l flag): s, c, a, l, e, sqrt
// Grammar (precedence low → high):
//   expr    := term   { (+|-) term }
//   term    := unary  { (*|/|%) unary }
//   unary   := (+|-) unary | power
//   power   := atom ^ unary | atom
//   atom    := number | '(' expr ')' | func '(' expr ')' | func atom
//   func    := s | c | a | l | e | sqrt

type MathFn = (x: number) => number

const MATH_FUNCS: Record<string, MathFn> = {
  s: Math.sin,
  c: Math.cos,
  a: Math.atan,
  l: Math.log,
  e: Math.exp,
  sqrt: Math.sqrt,
}

class Parser {
  private pos = 0
  constructor(
    private readonly src: string,
    private readonly mathMode: boolean,
  ) {}

  private peek(): string {
    while (this.pos < this.src.length && this.src[this.pos] === ' ') this.pos++
    return this.src[this.pos] ?? ''
  }

  private consume(): string {
    const c = this.peek()
    this.pos++
    return c
  }

  private match(s: string): boolean {
    while (this.pos < this.src.length && this.src[this.pos] === ' ') this.pos++
    if (this.src.startsWith(s, this.pos)) {
      this.pos += s.length
      return true
    }
    return false
  }

  private readNumber(): number {
    const start = this.pos
    while (this.pos < this.src.length) {
      const ch = this.src.charAt(this.pos)
      if (!/[0-9.]/.test(ch)) break
      this.pos++
    }
    const raw = this.src.slice(start, this.pos)
    const v = Number.parseFloat(raw)
    if (Number.isNaN(v)) throw new Error(`bc: invalid number: ${raw}`)
    return v
  }

  private readIdentifier(): string {
    const start = this.pos
    while (this.pos < this.src.length) {
      const ch = this.src.charAt(this.pos)
      if (!/[a-z]/.test(ch)) break
      this.pos++
    }
    return this.src.slice(start, this.pos)
  }

  parseExpr(): number {
    let left = this.parseTerm()
    for (;;) {
      const c = this.peek()
      if (c === '+') {
        this.consume()
        left += this.parseTerm()
      } else if (c === '-') {
        this.consume()
        left -= this.parseTerm()
      } else {
        break
      }
    }
    return left
  }

  private parseTerm(): number {
    let left = this.parseUnary()
    for (;;) {
      const c = this.peek()
      if (c === '*') {
        this.consume()
        left *= this.parseUnary()
      } else if (c === '/') {
        this.consume()
        left /= this.parseUnary()
      } else if (c === '%') {
        this.consume()
        left %= this.parseUnary()
      } else {
        break
      }
    }
    return left
  }

  private parseUnary(): number {
    const c = this.peek()
    if (c === '-') {
      this.consume()
      return -this.parseUnary()
    }
    if (c === '+') {
      this.consume()
      return this.parseUnary()
    }
    return this.parsePower()
  }

  private parsePower(): number {
    const base = this.parseAtom()
    if (this.peek() === '^') {
      this.consume()
      return base ** this.parseUnary()
    }
    return base
  }

  private parseAtom(): number {
    // whitespace skipped by peek()
    this.peek()
    const c = this.src[this.pos] ?? ''
    if (c === '(') {
      this.consume()
      const val = this.parseExpr()
      if (!this.match(')')) throw new Error('bc: missing )')
      return val
    }
    if (/[0-9.]/.test(c)) return this.readNumber()
    if (/[a-z]/.test(c)) {
      const name = this.readIdentifier()
      const fn = this.mathMode ? MATH_FUNCS[name] : undefined
      if (fn === undefined) {
        throw new Error(
          this.mathMode
            ? `bc: unknown function ${name}`
            : `bc: identifiers not allowed without -l flag`,
        )
      }
      if (this.match('(')) {
        const arg = this.parseExpr()
        if (!this.match(')')) throw new Error('bc: missing )')
        return fn(arg)
      }
      return fn(this.parseAtom())
    }
    throw new Error(`bc: unexpected character ${JSON.stringify(c)}`)
  }

  done(): boolean {
    while (this.pos < this.src.length && this.src[this.pos] === ' ') this.pos++
    return this.pos >= this.src.length
  }
}

function evalBc(expression: string, useMath: boolean): string {
  const expr = expression.trim()
  if (expr === '') return ''
  const parser = new Parser(expr, useMath)
  const result = parser.parseExpr()
  if (!parser.done()) throw new Error('bc: trailing input')
  if (Number.isFinite(result) && Math.trunc(result) === result) {
    return String(Math.trunc(result))
  }
  return String(result)
}

async function bcCommand(
  _accessor: Accessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const useMath = opts.flags.args_l === true || opts.flags.l === true
  const raw = (await readStdinAsync(opts.stdin)) ?? new Uint8Array(0)
  const lines = new TextDecoder().decode(raw).trim().split('\n')
  const results: string[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      results.push(evalBc(trimmed, useMath))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(`${msg}\n`) })]
    }
  }
  if (results.length === 0) return [null, new IOResult()]
  return [ENC.encode(results.join('\n') + '\n'), new IOResult()]
}

export const GENERAL_BC = command({
  name: 'bc',
  resource: null,
  spec: specOf('bc'),
  fn: bcCommand,
  provision: pureProvision,
})
