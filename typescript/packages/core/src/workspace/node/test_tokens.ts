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
// A comparison's right side is a pattern the run renders in its matcher's
// dialect (quoted segments escaped, `=~`'s quotes kept apart), never the
// word a reader of the line holds.
export const PATTERN_OPS: ReadonlySet<string> = new Set(['=', '==', '!=', '=~'])

/** One token of a `[[ ]]` expression: an operator's text, or an operand node. */
export type ExprToken =
  | { readonly op: string; readonly operand: null }
  | { readonly op: null; readonly operand: TSNodeLike }

/** A parsed `[[ ]]` expression, its leaves holding their operand nodes. */
export type CondTree =
  | { kind: 'and' | 'or'; left: CondTree; right: CondTree }
  | { kind: 'not' | 'group'; inner: CondTree }
  | { kind: 'unary'; op: string; operand: TSNodeLike }
  | { kind: 'binary'; op: string; left: TSNodeLike; right: TSNodeLike }
  | { kind: 'word'; operand: TSNodeLike }

/** The tokens are no expression the `[[ ]]` grammar reads. */
export class CondSyntax extends Error {}

/**
 * The tokens of a `[[ ]]` node in source order, which its grammar
 * (`CondParser`) reads: every reader of the test reads these. The parser
 * splits the test into bash's words and operators, a `-x` an operator only
 * where bash reads one.
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
    if (ctype === '[[' || ctype === ']]' || ctype === NT.COMMENT) continue
    if (child.isNamed !== true && ctype !== '$') {
      out.push({ op: ctype, operand: null })
    } else if (ctype === NT.TEST_OPERATOR) {
      out.push({ op: child.text, operand: null })
    } else if (CONTAINER_TYPES.has(ctype)) {
      condInto(child, out)
    } else {
      // A lone `$` is the parser's anonymous token, and a word.
      out.push({ op: null, operand: child })
    }
  }
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

  private take(): TSNodeLike {
    const operand = this.tokens[this.at]?.operand
    if (operand === undefined || operand === null) throw new CondSyntax()
    this.at++
    return operand
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
