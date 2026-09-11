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

import { REDIRECT_NODE_TYPES } from './helpers.ts'
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
  CFOR: 'cfor',
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
  VAR_ASSIGNS: 'var_assigns',
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
  [NT.VARIABLE_ASSIGNMENTS]: NodeKind.VAR_ASSIGNS,
  [NT.C_STYLE_FOR_STATEMENT]: NodeKind.CFOR,
})

interface KindNodeLike {
  type: string
  children?: readonly { type: string }[] | { type: string }[]
  namedChildren?: readonly KindNodeLike[] | KindNodeLike[]
}

// Statement kinds that are not pipelines of their own: they run other
// statements and report the last one's status, so `${PIPESTATUS[@]}`
// after them is whatever the last pipeline inside them left (bash:
// `{ false | true; }` keeps `1 0`, `! false | true` keeps `1 0`).
// Everything else, a simple command, a function call, a subshell, an
// assignment, a `(( ))`, is a pipeline of one segment and stamps its own
// status. A redirected statement is not here because it is as
// transparent as what it redirects (`pipelineTransparent` looks inside).
// A list is not here either: its left side is closed by the list handler
// and its right side by the list's own boundary, so `false | true && true`
// reports the `true`; a list that short-circuits carries its left
// pipeline to that boundary (`carryStatus`).
const PIPELINE_TRANSPARENT_KINDS: ReadonlySet<NodeKind> = new Set([
  NodeKind.COMPOUND,
  NodeKind.IF,
  NodeKind.FOR,
  NodeKind.CFOR,
  NodeKind.SELECT,
  NodeKind.WHILE,
  NodeKind.UNTIL,
  NodeKind.CASE,
  NodeKind.NEGATED,
  NodeKind.FUNCTION_DEF,
])

/**
 * Whether a statement leaves `PIPESTATUS` to the pipelines inside it
 * rather than stamping its own exit status.
 */
export function pipelineTransparent(node: KindNodeLike): boolean {
  const kind = nodeKind(node)
  if (kind === NodeKind.COMPOUND) {
    // `(( ))` parses as a compound statement too, and it is a command of
    // its own, not a group.
    return node.children?.[0]?.type !== NT.ARITH_OPEN
  }
  if (kind === NodeKind.REDIRECT) {
    // A redirected statement is as transparent as what it redirects:
    // `{ false | true; } >f` keeps the group's record, while `echo hi >f`
    // and `cat </missing` are a simple command's own one-segment status
    // whether or not the redirect opened. A bare redirect (`>f`) runs
    // the empty command, one segment too.
    const inner = node.namedChildren?.find((child) => !REDIRECT_NODE_TYPES.has(child.type))
    return inner !== undefined && pipelineTransparent(inner)
  }
  return PIPELINE_TRANSPARENT_KINDS.has(kind)
}

/**
 * Classify a tree-sitter node into the shared statement kind, or
 * UNSUPPORTED for node types neither walker implements (tree-sitter
 * ERROR nodes, future grammar additions).
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
