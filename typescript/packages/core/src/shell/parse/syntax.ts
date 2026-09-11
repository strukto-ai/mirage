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

import type { Node } from 'web-tree-sitter'

import {
  BASH_KEYWORDS,
  CASE_TERMINATORS,
  SEPARATOR_TOKENS,
  STRUCTURAL_TOKENS,
} from './constants.ts'

// Locate a backtick substitution that is never closed. tree-sitter
// happily parses "echo `echo a" as a complete command, so the region has
// to be scanned directly. Quoting follows the shell reader: single quotes
// protect a backtick, double quotes do not, and once inside a
// substitution only a backslash escapes, which is why `"`echo '`'`"` is
// an error in bash rather than a quoted backtick.
export function findUnterminatedBacktick(command: string): string | null {
  let quote: string | null = null
  let dollarQuote = false
  let opened: number | null = null
  let lastDollar = -2
  let i = 0
  while (i < command.length) {
    const ch = command[i]
    if (quote === "'") {
      // $'...' takes backslash escapes, so \' does not close it; a
      // plain '...' treats every backslash literally.
      if (dollarQuote && ch === '\\') {
        i += 2
        continue
      }
      if (ch === "'") {
        quote = null
        dollarQuote = false
      }
      i += 1
      continue
    }
    if (ch === '\\') {
      i += 2
      continue
    }
    if (opened !== null) {
      if (ch === '`') opened = null
      i += 1
      continue
    }
    if (ch === '`') opened = i
    else if (ch === "'" && quote === null) {
      quote = "'"
      dollarQuote = lastDollar === i - 1
    } else if (ch === '"') quote = quote === '"' ? null : '"'
    else if (ch === '$') lastDollar = i
    i += 1
  }
  return opened !== null ? command.slice(opened) : null
}

/**
 * True if an ERROR node represents a real syntactic problem: it holds a
 * bash keyword, a bracket / quote token, a statement separator, or a
 * named subtree the parser tried to recover. A separator inside an ERROR
 * node has nothing to separate (`;s`, `| s`, `a ; ; b`, `a &; b`), and
 * GNU bash 5.2 refuses every such line with `syntax error near unexpected
 * token`; an earlier reading that bash accepts `& ;` was wrong.
 */
function isStructuralError(node: Node): boolean {
  for (const child of node.children) {
    if (child.isNamed) return true
    if (BASH_KEYWORDS.has(child.type)) return true
    if (STRUCTURAL_TOKENS.has(child.type)) return true
    if (SEPARATOR_TOKENS.has(child.type)) return true
  }
  return false
}

/**
 * The text of a `;;` / `;&` / `;;&` token outside a case item. The
 * grammar takes them as ordinary statement separators, so `true;;s`
 * parses cleanly and would run `s`; bash refuses the line at the token.
 */
function strayCaseTerminator(node: Node): string | null {
  const stack: Node[] = [node]
  for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
    for (const child of current.children) {
      if (CASE_TERMINATORS.has(child.type) && current.type !== 'case_item') {
        return child.text || child.type
      }
      stack.push(child)
    }
  }
  return null
}

function walkNamed(node: Node): Node[] {
  const out: Node[] = [node]
  for (const child of node.namedChildren) out.push(...walkNamed(child))
  return out
}

function isRecoveredQuotedHeredocEnd(previous: Node | null, error: Node): boolean {
  if (previous === null) return false
  const errorText = error.text.trim()
  if (errorText.length === 0) return false
  for (const candidate of walkNamed(previous)) {
    if (candidate.type !== 'heredoc_redirect') continue
    let start: string | null = null
    let end: string | null = null
    for (const child of candidate.namedChildren) {
      if (child.type === 'heredoc_start') start = child.text
      else if (child.type === 'heredoc_end') end = child.text
    }
    if (
      start !== null &&
      (start.includes("'") || start.includes('"')) &&
      (end === null || end.length === 0) &&
      start.replaceAll("'", '').replaceAll('"', '') === errorText
    ) {
      return true
    }
  }
  return false
}

/**
 * Locate a top-level structural syntax error in a parsed AST.
 *
 * Tree-sitter often recovers from minor anomalies (e.g. `for x in;`) by
 * producing a valid statement with an internal ERROR token. Bash accepts
 * those, so we only flag errors that surface as direct children of
 * `program` AND contain a bash keyword, a bracket / quote, a statement
 * separator, or a recovered named subtree (`isStructuralError`). A case
 * terminator outside a case item is flagged even when the tree carries no
 * ERROR at all, because the grammar accepts `;;` as a plain separator.
 *
 * Returns the offending region's text, or `null` if the AST is clean.
 */
export function findSyntaxError(node: Node): string | null {
  const stray = strayCaseTerminator(node)
  if (stray !== null) return stray
  if (!node.hasError) return null
  let previous: Node | null = null
  for (const child of node.children) {
    if (child.isMissing) return child.text
    if (child.type === 'ERROR' && isStructuralError(child)) {
      if (isRecoveredQuotedHeredocEnd(previous, child)) {
        previous = child
        continue
      }
      return child.text
    }
    if (child.isNamed) previous = child
  }
  return null
}
