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

import type { TSNodeLike } from '../types.ts'

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
function isStructuralError(node: TSNodeLike): boolean {
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
function strayCaseTerminator(node: TSNodeLike): string | null {
  const stack: TSNodeLike[] = [node]
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

function walkNamed(node: TSNodeLike): TSNodeLike[] {
  const out: TSNodeLike[] = [node]
  for (const child of node.namedChildren) out.push(...walkNamed(child))
  return out
}

function isRecoveredQuotedHeredocEnd(previous: TSNodeLike | null, error: TSNodeLike): boolean {
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

function missingQuote(node: TSNodeLike): string | null {
  const stack = [node]
  for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
    if (current.isMissing && ["'", '"', '`'].includes(current.type)) return ''
    stack.push(...current.children)
  }
  return null
}

/**
 * Locate structural errors and missing tokens throughout a parsed AST.
 * The grammar recovers an empty for-list with an ERROR containing `in`;
 * Bash accepts that one recovery.
 *
 * Returns the offending region's text, or `null` if the AST is clean.
 */
export function findSyntaxError(
  node: TSNodeLike,
  parse?: (command: string) => TSNodeLike,
): string | null {
  // Expansion and the `[` builtin own their argument grammar.
  if (node.type === 'expansion') return null
  if (node.type === 'test_command' && node.children[0]?.type === '[') return missingQuote(node)
  if (node.type === 'command_substitution') {
    const unclosed = findUnterminatedBacktick(node.text)
    if (unclosed !== null) return unclosed
  }
  if (
    node.type === 'command_substitution' &&
    parse !== undefined &&
    node.text.startsWith('$(') &&
    node.text.endsWith(')')
  ) {
    return findSyntaxError(parse(node.text.slice(2, -1)), parse)
  }
  const stray = strayCaseTerminator(node)
  if (stray !== null) return stray
  if (!node.hasError) return null
  let previous: TSNodeLike | null = null
  for (const child of node.children) {
    // Bash permits unquoted spaces in associative subscripts. The grammar
    // recovers their earlier plain words as ERROR children.
    if (
      node.type === 'subscript' &&
      child.type === 'ERROR' &&
      child.children.length > 0 &&
      child.children.every((part) => part.type === 'word' && !part.hasError)
    )
      continue
    if (child.isMissing) return child.text
    if (
      child.type === 'ERROR' &&
      isStructuralError(child) &&
      !(node.type === 'for_statement' && child.text.trim() === 'in')
    ) {
      if (isRecoveredQuotedHeredocEnd(previous, child)) {
        previous = child
        continue
      }
      return child.text
    }
    if (child.type !== 'ERROR') {
      const nested = findSyntaxError(child, parse)
      if (nested !== null) return nested
    }
    if (child.isNamed) previous = child
  }
  return null
}
