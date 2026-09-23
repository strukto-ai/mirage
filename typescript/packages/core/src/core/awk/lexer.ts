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

export const TokKind = {
  NUMBER: 'NUMBER',
  STRING: 'STRING',
  ERE: 'ERE',
  NAME: 'NAME',
  FUNC_NAME: 'FUNC_NAME',
  BUILTIN: 'BUILTIN',
  KEYWORD: 'KEYWORD',
  NEWLINE: 'NEWLINE',
  EOF: 'EOF',
  OP: 'OP',
} as const
export type TokKind = (typeof TokKind)[keyof typeof TokKind]

export const KEYWORDS: ReadonlySet<string> = new Set([
  'BEGIN',
  'END',
  'function',
  'func',
  'break',
  'continue',
  'delete',
  'do',
  'else',
  'exit',
  'for',
  'getline',
  'if',
  'in',
  'next',
  'nextfile',
  'print',
  'printf',
  'return',
  'while',
])

export const BUILTIN_FUNCS: ReadonlySet<string> = new Set([
  'atan2',
  'close',
  'cos',
  'exp',
  'fflush',
  'gsub',
  'index',
  'int',
  'length',
  'log',
  'match',
  'rand',
  'sin',
  'split',
  'sprintf',
  'sqrt',
  'srand',
  'sub',
  'substr',
  'system',
  'tolower',
  'toupper',
])

const THREE_CHAR_OPS = ['**=']

const TWO_CHAR_OPS = [
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '^=',
  '==',
  '!=',
  '<=',
  '>=',
  '&&',
  '||',
  '!~',
  '++',
  '--',
  '>>',
  '**',
]

const ONE_CHAR_OPS = '{}()[],;+-*/%^!><|?:~$='

const STRING_ESCAPES: Readonly<Record<string, string>> = {
  '\\': '\\',
  '/': '/',
  '"': '"',
  a: '\x07',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
}

const OCTAL_DIGITS = '01234567'

const DIGITS = '0123456789'

const WORD_START = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_'

const WORD_CHARS = WORD_START + DIGITS

const ENDS_EXPRESSION_OPS: ReadonlySet<string> = new Set([')', ']', '$', '++', '--'])

export interface Token {
  readonly kind: TokKind
  readonly text: string
  readonly value: string
}

function token(kind: TokKind, text: string, value = ''): Token {
  return { kind, text, value }
}

export class Lexer {
  private readonly src: string
  private pos = 0
  private readonly tokens: Token[] = []

  constructor(src: string) {
    this.src = src
  }

  private error(message: string): AwkSyntaxError {
    return new AwkSyntaxError(`awk: syntax error: ${message}`)
  }

  private at(offset = 0): string {
    return this.src.charAt(this.pos + offset)
  }

  // POSIX reads `/` as division after something that can end an
  // expression and as the start of an ERE everywhere else.
  private prevEndsExpression(): boolean {
    const last = this.tokens[this.tokens.length - 1]
    if (last === undefined) return false
    if (
      last.kind === TokKind.NUMBER ||
      last.kind === TokKind.STRING ||
      last.kind === TokKind.NAME ||
      last.kind === TokKind.ERE ||
      last.kind === TokKind.BUILTIN
    ) {
      return true
    }
    if (last.kind === TokKind.OP) return ENDS_EXPRESSION_OPS.has(last.text)
    return false
  }

  private readString(): Token {
    this.pos += 1
    let out = ''
    while (this.pos < this.src.length) {
      const ch = this.at()
      if (ch === '"') {
        this.pos += 1
        return token(TokKind.STRING, out, out)
      }
      if (ch === '\n') throw this.error('newline in string')
      if (ch !== '\\') {
        out += ch
        this.pos += 1
        continue
      }
      this.pos += 1
      if (this.pos >= this.src.length) throw this.error('unterminated string')
      const esc = this.at()
      if (OCTAL_DIGITS.includes(esc)) {
        let digits = ''
        while (
          digits.length < 3 &&
          this.pos < this.src.length &&
          OCTAL_DIGITS.includes(this.at())
        ) {
          digits += this.at()
          this.pos += 1
        }
        out += String.fromCharCode(parseInt(digits, 8))
        continue
      }
      out += STRING_ESCAPES[esc] ?? '\\' + esc
      this.pos += 1
    }
    throw this.error('unterminated string')
  }

  private readEre(): Token {
    this.pos += 1
    let out = ''
    while (this.pos < this.src.length) {
      const ch = this.at()
      if (ch === '/') {
        this.pos += 1
        return token(TokKind.ERE, out, out)
      }
      if (ch === '\n') throw this.error('newline in regex')
      if (ch === '\\' && this.pos + 1 < this.src.length) {
        const nxt = this.at(1)
        // Only `\/` collapses here; every other escape belongs to the
        // ERE layer, which needs the backslash intact.
        out += nxt === '/' ? '/' : '\\' + nxt
        this.pos += 2
        continue
      }
      out += ch
      this.pos += 1
    }
    throw this.error('unterminated regex')
  }

  private isDigitAt(offset = 0): boolean {
    return this.pos + offset < this.src.length && DIGITS.includes(this.at(offset))
  }

  private readNumber(): Token {
    const start = this.pos
    let seenDot = false
    while (this.pos < this.src.length) {
      const ch = this.at()
      if (DIGITS.includes(ch)) {
        this.pos += 1
        continue
      }
      if (ch === '.' && !seenDot) {
        seenDot = true
        this.pos += 1
        continue
      }
      break
    }
    if (this.pos < this.src.length && 'eE'.includes(this.at())) {
      const save = this.pos
      this.pos += 1
      if (this.pos < this.src.length && '+-'.includes(this.at())) this.pos += 1
      if (this.isDigitAt()) {
        while (this.isDigitAt()) this.pos += 1
      } else {
        this.pos = save
      }
    }
    const text = this.src.slice(start, this.pos)
    return token(TokKind.NUMBER, text, text)
  }

  private readWord(): Token {
    const start = this.pos
    while (this.pos < this.src.length && WORD_CHARS.includes(this.at())) this.pos += 1
    const word = this.src.slice(start, this.pos)
    if (KEYWORDS.has(word)) return token(TokKind.KEYWORD, word, word)
    if (BUILTIN_FUNCS.has(word)) return token(TokKind.BUILTIN, word, word)
    // A NAME glued directly to `(` is a call; a space makes it
    // concatenation with a parenthesised expression instead.
    if (this.at() === '(') return token(TokKind.FUNC_NAME, word, word)
    return token(TokKind.NAME, word, word)
  }

  private readOperator(): Token {
    for (const op of THREE_CHAR_OPS) {
      if (this.src.startsWith(op, this.pos)) {
        this.pos += op.length
        return token(TokKind.OP, '^=')
      }
    }
    for (const op of TWO_CHAR_OPS) {
      if (this.src.startsWith(op, this.pos)) {
        this.pos += op.length
        return token(TokKind.OP, op === '**' ? '^' : op)
      }
    }
    const ch = this.at()
    if (!ONE_CHAR_OPS.includes(ch)) throw this.error(`unexpected character '${ch}'`)
    this.pos += 1
    return token(TokKind.OP, ch)
  }

  run(): Token[] {
    while (this.pos < this.src.length) {
      const ch = this.at()
      if (ch === '\\' && this.src.startsWith('\\\n', this.pos)) {
        this.pos += 2
        continue
      }
      if (ch === ' ' || ch === '\t' || ch === '\r') {
        this.pos += 1
        continue
      }
      if (ch === '#') {
        while (this.pos < this.src.length && this.at() !== '\n') this.pos += 1
        continue
      }
      if (ch === '\n') {
        this.pos += 1
        this.tokens.push(token(TokKind.NEWLINE, '\n'))
        continue
      }
      if (ch === '"') {
        this.tokens.push(this.readString())
        continue
      }
      if (ch === '/' && !this.prevEndsExpression()) {
        this.tokens.push(this.readEre())
        continue
      }
      if (DIGITS.includes(ch) || (ch === '.' && this.isDigitAt(1))) {
        this.tokens.push(this.readNumber())
        continue
      }
      if (WORD_START.includes(ch)) {
        this.tokens.push(this.readWord())
        continue
      }
      this.tokens.push(this.readOperator())
    }
    this.tokens.push(token(TokKind.EOF, ''))
    return this.tokens
  }
}

export function tokenize(src: string): Token[] {
  return new Lexer(src).run()
}
