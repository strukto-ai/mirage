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

import type { EvaluationContext } from '../evaluation.ts'
import type { SessionView } from '../../view/types.ts'
import type { CallStack } from '../../shell/call_stack.ts'
import { NodeType as NT } from '../../shell/types.ts'
import type { CondNode } from '../executor/builtins/condition/index.ts'
import type { TSNodeLike } from '../../shell/types.ts'
import type { ExecuteFn } from '../expand/types.ts'
import { expandChunks, expandNode } from '../expand/node.ts'
import { expandPattern } from '../expand/pattern.ts'
import { splitFields } from '../expand/fields.ts'
import { ifsValue } from '../expand/variable.ts'
import { unmarkGlobs } from '../../utils/glob_walk.ts'
import {
  CondParser,
  CondSyntax,
  type CondTree,
  type ExprToken,
  condTokens,
  flatTokens,
} from './test_tokens.ts'

const COND_OP_TOKENS = new Set(['=', '==', '!=', '=~', '<', '>', '&&', '||'])

/**
 * Expand a test_command `[ ... ]` into flat argv, tokens in source order.
 *
 * The parser nests `-a`/`-o` chains by its own precedence, so the shape is
 * discarded: every operator token and expanded operand is re-serialized
 * and the flat bash arity rules take over. Unquoted expansions
 * word-split like bash (an empty one drops out of argv).
 */
export async function expandTestExpr(
  node: TSNodeLike,
  context: EvaluationContext,
  executeFn: ExecuteFn,
  cs: CallStack | null,
  view?: SessionView,
): Promise<string[]> {
  const session = context.session
  const result: string[] = []
  for (const token of flatTokens(node)) {
    if (token.op !== null) {
      result.push(token.op)
    } else if (token.negative) {
      result.push('-' + (await expandNode(token.operand, context, executeFn, cs, view)))
    } else {
      const chunks = await expandChunks(token.operand, context, executeFn, cs, view)
      for (const word of splitFields(chunks, ifsValue(session, cs))) result.push(unmarkGlobs(word))
    }
  }
  return result
}

/**
 * Build a structured condition tree from a `[[ ... ]]` node.
 *
 * The parser nests the expression by its own precedence (`=~` looser than
 * `||`, `!` tighter than `=~`), so its tokens are read again as bash parses
 * them; a shape that reading refuses keeps the parser's tree.
 */
export async function expandDoubleBracket(
  node: TSNodeLike,
  context: EvaluationContext,
  executeFn: ExecuteFn,
  cs: CallStack | null,
  view?: SessionView,
): Promise<CondNode> {
  const first = node.namedChildren[0]
  if (first === undefined) return { kind: 'word', value: '' }
  let tree: CondTree
  try {
    tree = new CondParser(condTokens(node)).parse()
  } catch (error) {
    if (!(error instanceof CondSyntax)) throw error
    console.debug(`[[ ]] keeps the parser's reading: ${String(error)}`)
    return buildCond(first, context, executeFn, cs, view)
  }
  return condNode(tree, context, executeFn, cs, view)
}

/** Expand one parsed `[[ ]]` tree into a CondNode. */
async function condNode(
  tree: CondTree,
  context: EvaluationContext,
  executeFn: ExecuteFn,
  cs: CallStack | null,
  view?: SessionView,
): Promise<CondNode> {
  switch (tree.kind) {
    case 'and':
    case 'or': {
      // Expansion is part of evaluating an operand, so skipped branches cannot
      // run substitutions or observe state before the left side.
      const { left, right } = tree
      const first: CondNode = {
        kind: 'lazy',
        expand: () => condNode(left, context, executeFn, cs, view),
      }
      const second: CondNode = {
        kind: 'lazy',
        expand: () => condNode(right, context, executeFn, cs, view),
      }
      return { kind: tree.kind, left: first, right: second }
    }
    case 'not':
      return { kind: 'not', inner: await condNode(tree.inner, context, executeFn, cs, view) }
    case 'group':
      return condNode(tree.inner, context, executeFn, cs, view)
    case 'unary':
      return {
        kind: 'unary',
        op: tree.op,
        operand: await tokenText(tree.operand, context, executeFn, cs, view),
      }
    case 'binary': {
      const leftText = await tokenText(tree.left, context, executeFn, cs, view)
      const right = tree.right
      if (right.negative || right.operand === null) {
        const rightText = await tokenText(right, context, executeFn, cs, view)
        return {
          kind: 'binary',
          left: leftText,
          op: tree.op,
          right: rightText,
          rightLiteral: false,
        }
      }
      return comparison(tree.op, leftText, right.operand, context, executeFn, cs, view)
    }
    case 'word':
      return { kind: 'word', value: await tokenText(tree.operand, context, executeFn, cs, view) }
  }
}

async function tokenText(
  token: ExprToken,
  context: EvaluationContext,
  executeFn: ExecuteFn,
  cs: CallStack | null,
  view?: SessionView,
): Promise<string> {
  if (token.operand === null) return ''
  const text = await expandNode(token.operand, context, executeFn, cs, view)
  return token.negative ? '-' + text : text
}

/** Recursively translate one expression node into a CondNode. */
async function buildCond(
  node: TSNodeLike,
  context: EvaluationContext,
  executeFn: ExecuteFn,
  cs: CallStack | null,
  view?: SessionView,
): Promise<CondNode> {
  const ntype = node.type
  if (ntype === NT.PARENTHESIZED_EXPRESSION) {
    const inner = node.namedChildren[0]
    if (inner === undefined) return { kind: 'word', value: '' }
    return buildCond(inner, context, executeFn, cs, view)
  }
  if (ntype === NT.UNARY_EXPRESSION || ntype === NT.NEGATION_EXPRESSION) {
    return buildUnary(node, context, executeFn, cs, view)
  }
  if (ntype === NT.BINARY_EXPRESSION) {
    return buildBinary(node, context, executeFn, cs, view)
  }
  return { kind: 'word', value: await expandNode(node, context, executeFn, cs, view) }
}

/** Translate a unary/negation expression node. */
async function buildUnary(
  node: TSNodeLike,
  context: EvaluationContext,
  executeFn: ExecuteFn,
  cs: CallStack | null,
  view?: SessionView,
): Promise<CondNode> {
  const negated = node.children.some((c) => c.type === '!')
  let op: string | null = null
  let operandNode: TSNodeLike | null = null
  for (const child of node.children) {
    if (child.type === NT.TEST_OPERATOR) {
      op = child.text
    } else if (child.isNamed === true) {
      operandNode = child
    }
  }
  if (op === null && operandNode !== null && negated) {
    return { kind: 'not', inner: await buildCond(operandNode, context, executeFn, cs, view) }
  }
  if (op === null) {
    const value =
      operandNode === null ? '' : await expandNode(operandNode, context, executeFn, cs, view)
    const word: CondNode = { kind: 'word', value }
    return negated ? { kind: 'not', inner: word } : word
  }
  const operand =
    operandNode === null ? '' : await expandNode(operandNode, context, executeFn, cs, view)
  const unary: CondNode = { kind: 'unary', op, operand }
  return negated ? { kind: 'not', inner: unary } : unary
}

/** Translate a binary expression node (logical or comparison). */
async function buildBinary(
  node: TSNodeLike,
  context: EvaluationContext,
  executeFn: ExecuteFn,
  cs: CallStack | null,
  view?: SessionView,
): Promise<CondNode> {
  let op: string | null = null
  const operands: TSNodeLike[] = []
  for (const child of node.children) {
    if (child.isNamed !== true) {
      if (COND_OP_TOKENS.has(child.type)) op = child.type
      continue
    }
    if (child.type === NT.TEST_OPERATOR && op === null && operands.length > 0) {
      op = child.text
      continue
    }
    operands.push(child)
  }
  const left = operands[0]
  const right = operands[1]
  if ((op === '&&' || op === '||') && left !== undefined && right !== undefined) {
    // Expansion is part of evaluating an operand, so skipped branches cannot
    // run substitutions or observe state before the left side.
    const leftCond: CondNode = {
      kind: 'lazy',
      expand: () => buildCond(left, context, executeFn, cs, view),
    }
    const rightCond: CondNode = {
      kind: 'lazy',
      expand: () => buildCond(right, context, executeFn, cs, view),
    }
    return op === '&&'
      ? { kind: 'and', left: leftCond, right: rightCond }
      : { kind: 'or', left: leftCond, right: rightCond }
  }
  if (op === null || left === undefined || right === undefined) {
    const textParts: string[] = []
    for (const operand of operands) {
      textParts.push(await expandNode(operand, context, executeFn, cs, view))
    }
    return { kind: 'word', value: textParts.join(' ') }
  }
  const leftText = await expandNode(left, context, executeFn, cs, view)
  return comparison(op, leftText, right, context, executeFn, cs, view)
}

/** A binary test, its right operand expanded as `op` reads it. */
async function comparison(
  op: string,
  leftText: string,
  right: TSNodeLike,
  context: EvaluationContext,
  executeFn: ExecuteFn,
  cs: CallStack | null,
  view?: SessionView,
): Promise<CondNode> {
  if (op === '=~' && right.type === NT.REGEX) {
    const raw = right.text
    // After =~ the parser lexes even a quoted operand as one regex
    // token; quoted means bash matches it literally.
    const singleQuoted = raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")
    const doubleQuoted = raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')
    if (singleQuoted || doubleQuoted) {
      return { kind: 'binary', left: leftText, op, right: raw.slice(1, -1), rightLiteral: true }
    }
    return { kind: 'binary', left: leftText, op, right: raw, rightLiteral: false }
  }
  if (op === '=' || op === '==' || op === '!=') {
    // The right side of a glob comparison is a pattern word; the shared
    // expander renders its quoting into the matcher's dialect per
    // segment (quoted literal, unquoted globs live), so the evaluator
    // fnmatches unconditionally. A wholly-literal pattern matches
    // exactly itself, which is what the equality the old whole-node
    // boolean spelled out reduced to.
    const pattern = await expandPattern(right, context, executeFn, cs, view)
    return { kind: 'binary', left: leftText, op, right: pattern, rightLiteral: false }
  }
  const rightText = await expandNode(right, context, executeFn, cs, view)
  return { kind: 'binary', left: leftText, op, right: rightText, rightLiteral: false }
}
