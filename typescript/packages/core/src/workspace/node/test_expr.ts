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
import type { CondNode } from '../executor/builtins/condition/index.ts'
import type { TSNodeLike } from '../../shell/types.ts'
import type { ExecuteFn } from '../expand/node.ts'
import { expandNode } from '../expand/node.ts'
import { expandPattern } from '../expand/pattern.ts'
import type { Session } from '../session/session.ts'

const CONTAINER_TYPES = new Set<string>([
  NT.BINARY_EXPRESSION,
  NT.UNARY_EXPRESSION,
  NT.NEGATION_EXPRESSION,
  NT.PARENTHESIZED_EXPRESSION,
])
const FLAT_OP_TOKENS = new Set(['=', '==', '!=', '<', '>', '!', '(', ')'])
const COND_OP_TOKENS = new Set(['=', '==', '!=', '=~', '<', '>', '&&', '||'])
const SPLIT_TYPES = new Set<string>([NT.SIMPLE_EXPANSION, NT.EXPANSION])

/**
 * Expand a test_command `[ ... ]` into flat argv, tokens in source order.
 *
 * tree-sitter nests `-a`/`-o` chains unpredictably, so the shape is
 * discarded: every operator token and expanded operand is re-serialized
 * and the flat bash arity rules take over. Unquoted expansions
 * word-split like bash (an empty one drops out of argv).
 */
export async function expandTestExpr(
  node: TSNodeLike,
  session: Session,
  executeFn: ExecuteFn,
  cs: CallStack | null,
): Promise<string[]> {
  const result: string[] = []
  await flatten(node, result, session, executeFn, cs)
  return result
}

/**
 * Append the flat tokens of one test-expression node to `out`. Returns
 * false when a statement separator surfaced inside an ERROR recovery
 * node — tree-sitter swallowed the rest of the line into the test, so
 * everything after the break point is discarded.
 */
async function flatten(
  node: TSNodeLike,
  out: string[],
  session: Session,
  executeFn: ExecuteFn,
  cs: CallStack | null,
): Promise<boolean> {
  for (const child of node.children) {
    const ctype = child.type
    if (ctype === '[' || ctype === ']' || ctype === '[[' || ctype === ']]') continue
    if (ctype === NT.ERROR) {
      if (child.children.some((g) => g.isNamed !== true && g.type === ';')) return false
      if (!(await flatten(child, out, session, executeFn, cs))) return false
      continue
    }
    if (child.isNamed !== true) {
      if (FLAT_OP_TOKENS.has(ctype)) out.push(child.text)
      continue
    }
    if (CONTAINER_TYPES.has(ctype)) {
      const negative = negativeNumberChild(child)
      if (negative !== null) {
        out.push('-' + (await expandNode(negative, session, executeFn, cs)))
        continue
      }
      if (!(await flatten(child, out, session, executeFn, cs))) return false
      continue
    }
    if (ctype === NT.TEST_OPERATOR) {
      out.push(child.text)
      continue
    }
    const expanded = await expandNode(child, session, executeFn, cs)
    if (SPLIT_TYPES.has(ctype)) {
      out.push(...expanded.split(/\s+/).filter((w) => w !== ''))
      continue
    }
    out.push(expanded)
  }
  return true
}

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

/** Build a structured condition tree from a `[[ ... ]]` node. */
export async function expandDoubleBracket(
  node: TSNodeLike,
  session: Session,
  executeFn: ExecuteFn,
  cs: CallStack | null,
): Promise<CondNode> {
  const first = node.namedChildren[0]
  if (first === undefined) return { kind: 'word', value: '' }
  return buildCond(first, session, executeFn, cs)
}

/** Recursively translate one expression node into a CondNode. */
async function buildCond(
  node: TSNodeLike,
  session: Session,
  executeFn: ExecuteFn,
  cs: CallStack | null,
): Promise<CondNode> {
  const ntype = node.type
  if (ntype === NT.PARENTHESIZED_EXPRESSION) {
    const inner = node.namedChildren[0]
    if (inner === undefined) return { kind: 'word', value: '' }
    return buildCond(inner, session, executeFn, cs)
  }
  if (ntype === NT.UNARY_EXPRESSION || ntype === NT.NEGATION_EXPRESSION) {
    return buildUnary(node, session, executeFn, cs)
  }
  if (ntype === NT.BINARY_EXPRESSION) {
    return buildBinary(node, session, executeFn, cs)
  }
  return { kind: 'word', value: await expandNode(node, session, executeFn, cs) }
}

/** Translate a unary/negation expression node. */
async function buildUnary(
  node: TSNodeLike,
  session: Session,
  executeFn: ExecuteFn,
  cs: CallStack | null,
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
    return { kind: 'not', inner: await buildCond(operandNode, session, executeFn, cs) }
  }
  if (op === null) {
    const value = operandNode === null ? '' : await expandNode(operandNode, session, executeFn, cs)
    const word: CondNode = { kind: 'word', value }
    return negated ? { kind: 'not', inner: word } : word
  }
  const operand = operandNode === null ? '' : await expandNode(operandNode, session, executeFn, cs)
  const unary: CondNode = { kind: 'unary', op, operand }
  return negated ? { kind: 'not', inner: unary } : unary
}

/** Translate a binary expression node (logical or comparison). */
async function buildBinary(
  node: TSNodeLike,
  session: Session,
  executeFn: ExecuteFn,
  cs: CallStack | null,
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
    const leftCond = await buildCond(left, session, executeFn, cs)
    const rightCond = await buildCond(right, session, executeFn, cs)
    return op === '&&'
      ? { kind: 'and', left: leftCond, right: rightCond }
      : { kind: 'or', left: leftCond, right: rightCond }
  }
  if (op === null || left === undefined || right === undefined) {
    const textParts: string[] = []
    for (const operand of operands) {
      textParts.push(await expandNode(operand, session, executeFn, cs))
    }
    return { kind: 'word', value: textParts.join(' ') }
  }
  const leftText = await expandNode(left, session, executeFn, cs)
  if (op === '=~' && right.type === NT.REGEX) {
    const raw = right.text
    // After =~ tree-sitter lexes even a quoted operand as one regex
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
    const pattern = await expandPattern(right, session, executeFn, cs)
    return { kind: 'binary', left: leftText, op, right: pattern, rightLiteral: false }
  }
  const rightText = await expandNode(right, session, executeFn, cs)
  return { kind: 'binary', left: leftText, op, right: rightText, rightLiteral: false }
}
