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

import { IOResult } from '../../io/types.ts'
import { encodeText } from '../bytes.ts'
import type { TSNodeLike } from '../types.ts'

import {
  BASH_KEYWORDS,
  CASE_TERMINATORS,
  SEPARATOR_TOKENS,
  STRUCTURAL_TOKENS,
} from './constants.ts'

/** Locate an open quote only in erroneous AST regions, leaving complete
 * strings, comments and heredoc bodies opaque. Mirrors Python. */
export function findUnterminatedQuote(node: TSNodeLike): string | null {
  const stack: [TSNodeLike, boolean][] = [[node, false]]
  for (let entry = stack.pop(); entry !== undefined; entry = stack.pop()) {
    const [current, visited] = entry
    if (visited) {
      // Diagnose an ERROR span only after its children, as before.
      if (current.children.length === 0 && current.text.startsWith("'")) return "'"
      if (current.children.filter((child) => child.type === '"').length % 2 !== 0) return '"'
      continue
    }
    if (current.isMissing && (current.type === "'" || current.type === '"')) return current.type
    if (current.type === 'ansi_c_string') {
      const before = current.text.slice(0, -1)
      const slashes = /\\+$/.exec(before)?.[0].length ?? 0
      if (slashes % 2 !== 0) return "'"
      continue
    }
    if (current.type === 'ERROR') stack.push([current, true])
    const children = current.children
    for (let i = children.length - 1; i >= 0; i -= 1) {
      const child = children[i]
      if (child !== undefined) stack.push([child, false])
    }
  }
  return null
}

/** Exit 2 with the bash-style diagnostic for an unparsable line. */
export function syntaxErrorResult(offending: string, node: TSNodeLike): IOResult {
  const quote = findUnterminatedQuote(node)
  const snippet = offending.trim()
  const message =
    quote !== null
      ? 'mirage: unexpected EOF while looking for matching `' + quote + "'\n"
      : snippet.length > 0
        ? `mirage: syntax error near '${snippet}'\n`
        : 'mirage: syntax error in command\n'
  return new IOResult({ exitCode: 2, stderr: encodeText(message) })
}

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
 * Each `;;` / `;&` / `;;&` token outside a case item, with its start. The
 * grammar takes them as ordinary statement separators, so `true;;s`
 * parses cleanly and would run `s`; bash refuses the line at the token.
 */
function* strayCaseTerminators(node: TSNodeLike): Generator<[number, string]> {
  const stack: TSNodeLike[] = [node]
  for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
    for (const child of current.children) {
      if (CASE_TERMINATORS.has(child.type) && current.type !== 'case_item') {
        yield [child.startIndex ?? 0, child.text || child.type]
      }
      stack.push(child)
    }
  }
}

const BODY_OPENERS = new Set(['do', '{', 'then', 'else'])
const BODY_CLOSERS = new Set(['done', '}', 'fi', 'elif', 'else'])
const BODY_NODES = new Set(['do_group', 'compound_statement', 'if_statement'])

/**
 * Each token closing a compound list that holds no command, with its start.
 * bash requires a command in every `do`, `then`, `else` and brace body (5.2:
 * `for x in a; do done` is a syntax error near `done`); the grammar accepts
 * an empty one, comments aside. Mirrors Python's _empty_compounds.
 */
function* emptyCompounds(node: TSNodeLike): Generator<[number, string]> {
  const stack: TSNodeLike[] = [node]
  for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
    stack.push(...current.children)
    if (!BODY_NODES.has(current.type)) continue
    let opened = false
    for (const kid of current.children.flatMap((child) =>
      child.type === 'elif_clause' || child.type === 'else_clause' ? [...child.children] : [child],
    )) {
      if (opened && BODY_CLOSERS.has(kid.type)) yield [kid.startIndex ?? 0, kid.text]
      if (BODY_OPENERS.has(kid.type)) opened = true
      else if (kid.isNamed && kid.type !== 'comment') opened = false
    }
  }
}

// Reserved words that close or continue a compound command; quoted, escaped,
// after an assignment or a redirect, or named as an alias the shell would
// expand there, they are plain words.
const RESERVED_CLOSERS = new Set([
  'do',
  'done',
  'elif',
  'else',
  'esac',
  'fi',
  'in',
  'then',
  '}',
  ']]',
])

/**
 * Each reserved word a command starts with, where none may stand, with its
 * start. The grammar reads `echo hi; fi` as two commands and would run both;
 * bash 5.2 refuses the line at `fi`, as it does `done`, `then` and the rest
 * when they stand where a command starts. Inside `$(...)` and a process
 * substitution, bash 5.2 takes such a word as reserved even when an alias
 * spells it. `own` maps each alias whose own text the line opens with to
 * the span of the line that text covers, and `offsets` gives where each char
 * the parser read sits in that line; a word spelled like the alias starting
 * inside its span is reserved, since an alias never expands within its own
 * text. Mirrors Python's _stray_reserved_words.
 */
function* strayReservedWords(
  node: TSNodeLike,
  aliases: ReadonlySet<string>,
  own: ReadonlyMap<string, readonly [number, number]>,
  offsets: readonly number[] | undefined,
): Generator<[number, string]> {
  const stack: [TSNodeLike, ReadonlySet<string>][] = [[node, aliases]]
  for (let top = stack.pop(); top !== undefined; top = stack.pop()) {
    const [current, inherited] = top
    const names =
      current.type === 'process_substitution' ||
      (current.type === 'command_substitution' && !current.text.startsWith('`'))
        ? new Set<string>()
        : inherited
    for (const child of current.children) stack.push([child, names])
    if (current.type !== 'command') continue
    const name = current.children[0]
    if (name?.type !== 'command_name') continue
    if (!RESERVED_CLOSERS.has(name.text)) continue
    const start = name.startIndex ?? 0
    const span = own.get(name.text)
    const at = offsets === undefined ? start : (offsets[start] ?? start)
    if (!names.has(name.text) || (span !== undefined && span[0] <= at && at < span[1])) {
      yield [start, name.text]
    }
  }
}

function* walkNamed(node: TSNodeLike): Generator<TSNodeLike> {
  // Malformed input can still contain deeply nested valid subtrees.
  const stack = [node]
  for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
    yield current
    const children = current.namedChildren
    for (let i = children.length - 1; i >= 0; i -= 1) {
      const child = children[i]
      if (child !== undefined) stack.push(child)
    }
  }
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
 * Bash accepts that one recovery. A reserved word among `aliases`, the names
 * the shell would expand where a command starts, is a command there, except
 * inside the own text of an alias in `own`. Of the tokens the grammar
 * accepts and bash refuses, the first on the line is the one reported, as
 * bash stops there.
 *
 * Returns the offending region's text, or `null` if the AST is clean.
 */
export function findSyntaxError(
  node: TSNodeLike,
  parse?: (command: string) => TSNodeLike,
  aliases: ReadonlySet<string> = new Set(),
  own: ReadonlyMap<string, readonly [number, number]> = new Map(),
  offsets?: readonly number[],
): string | null {
  // Expansion and the `[` builtin own their argument grammar.
  if (node.type === 'expansion') {
    return node.children.some((child) => child.isMissing && child.type === '}') ? '' : null
  }
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
  let stray: [number, string] | null = null
  for (const hit of [
    ...strayCaseTerminators(node),
    ...emptyCompounds(node),
    ...strayReservedWords(node, aliases, own, offsets),
  ]) {
    if (stray === null || hit[0] < stray[0]) stray = hit
  }
  if (stray !== null) return stray[1]
  if (!node.hasError) return findUnterminatedQuote(node)
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
      const nested = findSyntaxError(child, parse, aliases, own, offsets)
      if (nested !== null) return nested
    }
    if (child.isNamed) previous = child
  }
  return null
}
