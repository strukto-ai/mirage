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

import { NodeType as NT } from './types.ts'

/**
 * Statement kinds both tree walkers dispatch on.
 *
 * The executor and the provision planner walk the same tree-sitter
 * AST. This enum is the single classification both use, so a
 * construct cannot be supported by one walker and silently
 * unclassified by the other: `nodeKind` owns every tree-sitter
 * node-type check, including the lookahead that distinguishes
 * `select` from `for` and `until` from `while`.
 */
export const NodeKind = Object.freeze({
  COMMENT: 'comment',
  PROGRAM: 'program',
  COMMAND: 'command',
  PIPELINE: 'pipeline',
  LIST: 'list',
  REDIRECT: 'redirect',
  SUBSHELL: 'subshell',
  COMPOUND: 'compound',
  IF: 'if',
  FOR: 'for',
  SELECT: 'select',
  WHILE: 'while',
  UNTIL: 'until',
  CASE: 'case',
  FUNCTION_DEF: 'function_def',
  DECLARATION: 'declaration',
  UNSET: 'unset',
  TEST: 'test',
  NEGATED: 'negated',
  VAR_ASSIGN: 'var_assign',
  UNSUPPORTED: 'unsupported',
} as const)
export type NodeKind = (typeof NodeKind)[keyof typeof NodeKind]

const SIMPLE_KINDS: Readonly<Record<string, NodeKind>> = Object.freeze({
  [NT.COMMENT]: NodeKind.COMMENT,
  [NT.PROGRAM]: NodeKind.PROGRAM,
  [NT.COMMAND]: NodeKind.COMMAND,
  [NT.PIPELINE]: NodeKind.PIPELINE,
  [NT.LIST]: NodeKind.LIST,
  [NT.REDIRECTED_STATEMENT]: NodeKind.REDIRECT,
  [NT.SUBSHELL]: NodeKind.SUBSHELL,
  [NT.COMPOUND_STATEMENT]: NodeKind.COMPOUND,
  [NT.IF_STATEMENT]: NodeKind.IF,
  [NT.CASE_STATEMENT]: NodeKind.CASE,
  [NT.FUNCTION_DEFINITION]: NodeKind.FUNCTION_DEF,
  [NT.DECLARATION_COMMAND]: NodeKind.DECLARATION,
  [NT.UNSET_COMMAND]: NodeKind.UNSET,
  [NT.TEST_COMMAND]: NodeKind.TEST,
  [NT.NEGATED_COMMAND]: NodeKind.NEGATED,
  [NT.VARIABLE_ASSIGNMENT]: NodeKind.VAR_ASSIGN,
})

interface KindNodeLike {
  type: string
  children?: readonly { type: string }[] | { type: string }[]
}

/**
 * Classify a tree-sitter node into the shared statement kind, or
 * UNSUPPORTED for node types neither walker implements (c-style for,
 * arithmetic, ...).
 */
export function nodeKind(node: KindNodeLike): NodeKind {
  const ntype = node.type
  const simple = SIMPLE_KINDS[ntype]
  if (simple !== undefined) return simple
  if (ntype === NT.FOR_STATEMENT) {
    if (node.children?.[0]?.type === NT.SELECT) return NodeKind.SELECT
    return NodeKind.FOR
  }
  if (ntype === NT.WHILE_STATEMENT) {
    if (node.children?.[0]?.type === NT.UNTIL) return NodeKind.UNTIL
    return NodeKind.WHILE
  }
  return NodeKind.UNSUPPORTED
}
