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
import type { CondNode } from '../executor/builtins/condition/index.ts'
import type { TSNodeLike } from '../../shell/types.ts'
import type { ExecuteFn } from '../expand/types.ts'
import { expandChunks, expandNode } from '../expand/node.ts'
import { expandPattern, expandRegex } from '../expand/pattern.ts'
import { splitFields } from '../expand/fields.ts'
import { ifsValue } from '../expand/variable.ts'
import { unmarkGlobs } from '../../utils/glob_walk.ts'
import { CondParser, type CondTree, PATTERN_OPS, condTokens, flatTokens } from './test_tokens.ts'

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
 * them.
 */
export async function expandDoubleBracket(
  node: TSNodeLike,
  context: EvaluationContext,
  executeFn: ExecuteFn,
  cs: CallStack | null,
  view?: SessionView,
): Promise<CondNode> {
  return condNode(new CondParser(condTokens(node)).parse(), context, executeFn, cs, view)
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
        operand: await expandNode(tree.operand, context, executeFn, cs, view),
      }
    case 'binary': {
      const leftText = await expandNode(tree.left, context, executeFn, cs, view)
      return comparison(tree.op, leftText, tree.right, context, executeFn, cs, view)
    }
    case 'word':
      return { kind: 'word', value: await expandNode(tree.operand, context, executeFn, cs, view) }
  }
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
  if (PATTERN_OPS.has(op)) {
    // The right side of a match is a pattern word; the shared expander
    // renders its quoting into the matcher's dialect per segment (quoted
    // literal, unquoted live), so the evaluator matches unconditionally. A
    // wholly-literal pattern matches exactly itself.
    const expand = op === '=~' ? expandRegex : expandPattern
    const pattern = await expand(right, context, executeFn, cs, view)
    return { kind: 'binary', left: leftText, op, right: pattern }
  }
  const rightText = await expandNode(right, context, executeFn, cs, view)
  return { kind: 'binary', left: leftText, op, right: rightText }
}
