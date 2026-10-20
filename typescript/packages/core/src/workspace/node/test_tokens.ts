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

import { NodeType as NT, type TSNodeLike } from '../../shell/types.ts'

const CONTAINER_TYPES = new Set<string>([
  NT.BINARY_EXPRESSION,
  NT.UNARY_EXPRESSION,
  NT.NEGATION_EXPRESSION,
  NT.PARENTHESIZED_EXPRESSION,
])
// `[` is a command, so every operator the grammar folds into the test
// reaches it as an operand word for test to judge (`=~` and `+` are refused
// there, not dropped); `&&` and `||` end the command in bash.
const FLAT_SKIP_TOKENS = new Set(['&&', '||'])
const BRACKETS = new Set(['[', ']', '[[', ']]'])
// A comparison's right side is a pattern the run renders in its matcher's
// dialect (quoted segments escaped, `=~`'s quotes kept apart), never the
// word a reader of the line holds.
export const PATTERN_OPS: ReadonlySet<string> = new Set(['=', '==', '!=', '=~'])

/**
 * Detect a unary_expression that is really a negative number word.
 * tree-sitter parses `-1` inside a test as unary_expression with a bare
 * `-` token; the flat argv needs it back as one operand.
 */
function negativeNumberChild(node: TSNodeLike): TSNodeLike | null {
  if (node.type !== NT.UNARY_EXPRESSION) return null
  const children = node.children
  const first = children[0]
  const second = children[1]
  if (
    children.length === 2 &&
    first !== undefined &&
    second !== undefined &&
    first.isNamed !== true &&
    first.type === '-' &&
    second.isNamed === true &&
    second.type !== NT.TEST_OPERATOR
  ) {
    return second
  }
  return null
}

/**
 * One token of a test expression: an operator's text, or an operand node
 * (`negative` for a `-N` tree-sitter split into `-` and N).
 */
export type ExprToken =
  | { readonly op: string; readonly operand: null; readonly negative: false }
  | { readonly op: null; readonly operand: TSNodeLike; readonly negative: boolean }

/** A parsed `[[ ]]` expression. */
export type CondTree =
  | { kind: 'and' | 'or'; left: CondTree; right: CondTree }
  | { kind: 'not' | 'group'; inner: CondTree }
  | { kind: 'unary'; op: string; operand: ExprToken }
  | { kind: 'binary'; op: string; left: ExprToken; right: ExprToken }
  | { kind: 'word'; operand: ExprToken }

/** The tokens are no expression the `[[ ]]` grammar reads. */
export class CondSyntax extends Error {}

/**
 * The tokens of a `[[ ]]` node in source order, which its grammar
 * (`CondParser`) reads: every reader of the test reads these. Throws
 * `CondSyntax` where tree-sitter could not read it.
 */
export function condTokens(node: TSNodeLike): ExprToken[] {
  const out: ExprToken[] = []
  condInto(node, out)
  return out
}

/** Append the tokens of a `[[ ]]` node to `out` in source order. */
function condInto(node: TSNodeLike, out: ExprToken[]): void {
  for (const child of node.children) {
    const ctype = child.type
    if (ctype === '[[' || ctype === ']]') continue
    if (ctype === NT.ERROR) throw new CondSyntax()
    if (child.isNamed !== true) {
      out.push({ op: ctype, operand: null, negative: false })
    } else if (ctype === NT.TEST_OPERATOR) {
      out.push({ op: child.text, operand: null, negative: false })
    } else if (CONTAINER_TYPES.has(ctype)) {
      const negative = negativeNumberChild(child)
      if (negative !== null) out.push({ op: null, operand: negative, negative: true })
      else condInto(child, out)
    } else {
      out.push({ op: null, operand: child, negative: false })
    }
  }
}

/**
 * The tokens of a `[ ]` node in source order, the words `[` is given once
 * each operand is expanded: every reader of the test reads these.
 * tree-sitter nests `-a`/`-o` chains unpredictably, so the shape is
 * discarded and test's own arity rules read the words. A statement
 * separator inside an ERROR recovery node means tree-sitter swallowed the
 * rest of the line into the test, so the tokens end there.
 */
export function flatTokens(node: TSNodeLike): ExprToken[] {
  const out: ExprToken[] = []
  flatInto(node, out)
  return out
}

/**
 * Append the flat tokens of one test-expression node to `out`; false once
 * a statement separator ends them.
 */
function flatInto(node: TSNodeLike, out: ExprToken[]): boolean {
  for (const child of node.children) {
    const ctype = child.type
    if (BRACKETS.has(ctype)) continue
    if (ctype === NT.ERROR) {
      if (child.children.some((g) => g.isNamed !== true && g.type === ';')) return false
      if (!flatInto(child, out)) return false
      continue
    }
    if (child.isNamed !== true) {
      if (!FLAT_SKIP_TOKENS.has(ctype)) out.push({ op: child.text, operand: null, negative: false })
      continue
    }
    if (CONTAINER_TYPES.has(ctype)) {
      const negative = negativeNumberChild(child)
      if (negative !== null) {
        out.push({ op: null, operand: negative, negative: true })
        continue
      }
      if (!flatInto(child, out)) return false
      continue
    }
    if (ctype === NT.TEST_OPERATOR) {
      out.push({ op: child.text, operand: null, negative: false })
      continue
    }
    out.push({ op: null, operand: child, negative: false })
  }
  return true
}

/**
 * bash's `[[ ]]` grammar over the flat tokens, loosest first: `||`, `&&`,
 * then a term. A term is any run of `!` (each one toggles a single
 * inversion, so `! !` inverts nothing) before a parenthesized expression, a
 * unary test, a binary test or a word.
 */
const COND_BINARY_TOKENS = new Set(['=', '==', '!=', '=~', '<', '>'])

export class CondParser {
  private at = 0

  constructor(private readonly tokens: ExprToken[]) {}

  private op(ahead = 0): string | null {
    return this.tokens[this.at + ahead]?.op ?? null
  }

  private operand(ahead = 0): boolean {
    return this.tokens[this.at + ahead]?.op === null
  }

  private take(): ExprToken {
    const token = this.tokens[this.at]
    if (token === undefined) throw new CondSyntax()
    this.at++
    return token
  }

  parse(): CondTree {
    const tree = this.either()
    if (this.at !== this.tokens.length) throw new CondSyntax()
    return tree
  }

  private either(): CondTree {
    let tree = this.both()
    while (this.op() === '||') {
      this.at++
      tree = { kind: 'or', left: tree, right: this.both() }
    }
    return tree
  }

  private both(): CondTree {
    let tree = this.term()
    while (this.op() === '&&') {
      this.at++
      tree = { kind: 'and', left: tree, right: this.term() }
    }
    return tree
  }

  private term(): CondTree {
    let inverted = false
    while (this.op() === '!') {
      this.at++
      inverted = !inverted
    }
    let tree: CondTree
    if (this.op() === '(') {
      this.at++
      tree = { kind: 'group', inner: this.either() }
      if (this.op() !== ')') throw new CondSyntax()
      this.at++
    } else {
      tree = this.test()
    }
    return inverted ? { kind: 'not', inner: tree } : tree
  }

  private test(): CondTree {
    const op = this.op()
    if (op !== null && op.startsWith('-') && this.operand(1)) {
      this.at++
      return { kind: 'unary', op, operand: this.take() }
    }
    if (!this.operand()) throw new CondSyntax()
    const binary = this.op(1)
    if (
      binary !== null &&
      (COND_BINARY_TOKENS.has(binary) || binary.startsWith('-')) &&
      this.operand(2)
    ) {
      const left = this.take()
      this.at++
      return { kind: 'binary', op: binary, left, right: this.take() }
    }
    return { kind: 'word', operand: this.take() }
  }
}

/**
 * The tests of a parsed `[[ ]]` expression in source order: its unary,
 * binary and word leaves, each a test of its own.
 */
export function condLeaves(
  tree: CondTree,
): Extract<CondTree, { kind: 'unary' | 'binary' | 'word' }>[] {
  switch (tree.kind) {
    case 'and':
    case 'or':
      return [...condLeaves(tree.left), ...condLeaves(tree.right)]
    case 'not':
    case 'group':
      return condLeaves(tree.inner)
    default:
      return [tree]
  }
}
