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

import { BINARY_OPS, UNARY_OPS } from './constants.ts'
import type { FlatBinary, FlatFail, FlatNode, FlatUnary } from './types.ts'

/**
 * test's own reading of its words, by bash's arity rules: which words each
 * operator takes, and where a grammar error stands. `name` is the test's
 * name, for its diagnostics; `words` its words, brackets excluded.
 *
 * The evaluator runs this reading and the gate reads a test's file
 * operands off it (`fileOperands`), so both give each word the one role
 * test gives it: in `test -e -o yes` the `-o` joins two strings, and only
 * the word after a file operator it takes is a file.
 */
export function flatShape(name: string, words: readonly string[]): FlatNode {
  const n = words.length
  if (n === 0) return null
  if (n === 1) return { kind: 'string', at: 0 }
  if (n === 2) return two(name, words, 0)
  if (n === 3) return three(name, words, 0)
  if (n === 4) return four(name, words)
  return new Shape(name, words).run()
}

/** The operator tests of a reading, in the order they are reached. */
export function* flatLeaves(node: FlatNode): Generator<FlatUnary | FlatBinary> {
  if (node === null) return
  if (node.kind === 'unary' || node.kind === 'binary') {
    yield node
  } else if (node.kind === 'not') {
    yield* flatLeaves(node.inner)
  } else if (node.kind === 'and' || node.kind === 'or') {
    for (const term of node.terms) yield* flatLeaves(term)
  }
}

/** Two-argument rule: `!` or a unary operator, the two beginning at `at`. */
function two(name: string, words: readonly string[], at: number): FlatNode {
  const first = words[at] ?? ''
  if (first === '!') return { kind: 'not', inner: { kind: 'string', at: at + 1 } }
  if (UNARY_OPS.has(first)) return { kind: 'unary', op: first, at: at + 1 }
  return { kind: 'fail', message: `${name}: ${first}: unary operator expected` }
}

/**
 * Three-argument rule: binary op, `-a`/`-o`, `!`, or parens, the three
 * beginning at `at`.
 */
function three(name: string, words: readonly string[], at: number): FlatNode {
  const mid = words[at + 1] ?? ''
  if (mid === '-a') {
    return {
      kind: 'and',
      terms: [
        { kind: 'string', at },
        { kind: 'string', at: at + 2 },
      ],
    }
  }
  if (mid === '-o') {
    return {
      kind: 'or',
      terms: [
        { kind: 'string', at },
        { kind: 'string', at: at + 2 },
      ],
    }
  }
  if (BINARY_OPS.has(mid)) return { kind: 'binary', left: at, op: mid, right: at + 2 }
  const first = words[at]
  if (first === '!') return { kind: 'not', inner: two(name, words, at + 1) }
  if (first === '(' && words[at + 2] === ')') return { kind: 'string', at: at + 1 }
  return { kind: 'fail', message: `${name}: ${mid}: binary operator expected` }
}

/** Four-argument rule: leading `!` or parens, else the expr parser. */
function four(name: string, words: readonly string[]): FlatNode {
  if (words[0] === '!') return { kind: 'not', inner: three(name, words, 1) }
  if (words[0] === '(' && words[3] === ')') return two(name, words, 1)
  return new Shape(name, words).run()
}

/**
 * Recursive-descent `test` expression parser (>4 args, GNU expr grammar:
 * or -> and -> term with `!` and parentheses). A grammar error ends the
 * reading where it stands, after the terms before it, which test evaluates
 * before it meets the error.
 */
class Shape {
  private pos = 0
  private failed = false

  constructor(
    private readonly name: string,
    private readonly words: readonly string[],
  ) {}

  private peek(offset = 0): string | null {
    return this.words[this.pos + offset] ?? null
  }

  private fail(message: string): FlatFail {
    this.failed = true
    return { kind: 'fail', message: `${this.name}: ${message}` }
  }

  run(): FlatNode {
    const node = this.orExpr()
    if (!this.failed && this.pos !== this.words.length) {
      return { kind: 'and', terms: [node, this.fail('too many arguments')] }
    }
    return node
  }

  private orExpr(): FlatNode {
    const first = this.andExpr()
    const terms = [first]
    while (!this.failed && this.peek() === '-o') {
      this.pos += 1
      terms.push(this.andExpr())
    }
    return terms.length === 1 ? first : { kind: 'or', terms }
  }

  private andExpr(): FlatNode {
    const first = this.term()
    const terms = [first]
    while (!this.failed && this.peek() === '-a') {
      this.pos += 1
      terms.push(this.term())
    }
    return terms.length === 1 ? first : { kind: 'and', terms }
  }

  private term(): FlatNode {
    const tok = this.peek()
    if (tok === null) return this.fail('argument expected')
    if (tok === '!') {
      this.pos += 1
      return { kind: 'not', inner: this.term() }
    }
    if (tok === '(') {
      this.pos += 1
      const inner = this.orExpr()
      if (this.failed) return inner
      if (this.peek() !== ')') return { kind: 'and', terms: [inner, this.fail("`)' expected")] }
      this.pos += 1
      return inner
    }
    const nxt = this.peek(1)
    if (nxt !== null && BINARY_OPS.has(nxt) && this.peek(2) !== null) {
      const binary: FlatBinary = { kind: 'binary', left: this.pos, op: nxt, right: this.pos + 2 }
      this.pos += 3
      return binary
    }
    if (UNARY_OPS.has(tok) && nxt !== null && nxt !== '-a' && nxt !== '-o') {
      const unary: FlatUnary = { kind: 'unary', op: tok, at: this.pos + 1 }
      this.pos += 2
      return unary
    }
    this.pos += 1
    return { kind: 'string', at: this.pos - 1 }
  }
}
