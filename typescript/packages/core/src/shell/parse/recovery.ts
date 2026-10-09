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

import { type NativeParser } from './engine.ts'
import { scanParameter } from '../parameter.ts'
import { ARITH_OPEN_TOKEN, QUOTES } from './constants.ts'
import { expansionSource } from './expansion.ts'
import { protectedSource } from './heredoc/index.ts'
import { delimiterEnd } from './heredoc/reader.ts'
import { SourceNode } from './source.ts'
import type { ShellNode } from '../types.ts'

/**
 * Index just past the `)` closing the `(` at `start`.
 *
 * Parens inside quotes and backslash escapes do not count, so a command
 * substitution or a literal `")"` cannot throw off the depth. Returns
 * null when the parens never balance.
 */
function balancedEnd(text: string, start: number): number | null {
  let depth = 0
  let index = start
  let quote: string | null = null
  while (index < text.length) {
    const char = text[index] ?? ''
    if (quote !== null) {
      if (char === '\\' && quote === '"') {
        index += 2
        continue
      }
      if (char === quote) quote = null
      index += 1
      continue
    }
    if (QUOTES.has(char)) {
      quote = char
    } else if (char === '\\') {
      index += 2
      continue
    } else if (char === '(') {
      depth += 1
    } else if (char === ')') {
      depth -= 1
      if (depth === 0) return index + 1
    }
    index += 1
  }
  return null
}

/**
 * Whether the construct at `start` is a real arithmetic command.
 *
 * Decided by parsing the balanced span on its own: `((i++))` stands
 * alone cleanly, while `((echo x); echo $i)` does not. Judging each
 * opener separately is what keeps a valid `((i++))` safe when it shares
 * a line with a broken one, since tree-sitter's error region covers
 * both. An unbalanced span is assumed arithmetic and left alone.
 */
export function isArithmetic(parser: NativeParser, command: string, start: number): boolean {
  const end = balancedEnd(command, start)
  if (end === null) return true
  const span = parser.parse(command.slice(start, end))
  return !span?.rootNode.hasError
}

const UNLEXED = new Set([
  'test_command',
  'arithmetic_expansion',
  'string_content',
  'raw_string',
  'ansi_c_string',
  'expansion',
  'heredoc_content',
  'comment',
  'binary_expression',
  'unary_expression',
  'postfix_expression',
])

const WORD_START = ' \t\n;&|(){}'

const DIGITS = /\d+/y

const ESCAPED_BLANK = /\\[ \t]/g

const LAST_ARM = /^\s*esac(?![^\s;&|()<>])/

// Test operators the grammar lexes apart from a word in an argument list or
// an error region, where bash reads a word.
const BARE_WORDS: ReadonlySet<string> = new Set(['==', '=~'])

// A `$` that no name, digit, special parameter, brace, paren, bracket or
// quote follows, which bash reads as a literal `$`.
const LITERAL_DOLLAR = /\$(?![\w@*#?$!{(['"[-])/y

const WORD_BREAK = ' \t\n;&|()<>'

const LIST_TOKENS = new Set(['&&', '||', '|', '|&', ';', '&', ';;'])

const TEST_PARTS = new Set([
  'binary_expression',
  'unary_expression',
  'negation_expression',
  'parenthesized_expression',
  'ERROR',
])

/** Whether `text[at]` ends a word: the end of the text, a blank or an operator. */
function breaksWord(text: string, at: number): boolean {
  return at < 0 || at >= text.length || WORD_BREAK.includes(text[at] ?? '')
}

/**
 * Whether bash reads a `[ ... ]` the grammar built as a test as a command.
 *
 * `[` is a command to bash: its words end at the first list or pipe operator,
 * and the last of them has to be a `]` of its own. The grammar folds `&&`,
 * `||` and `|` into the expression, closes it at a `]` that bash reads inside
 * `]]` or `]x`, and builds one whose `]` is missing; bash runs the builtin on
 * each, which refuses with "[: missing `]'". Mirrors Python's
 * _bracket_is_a_command.
 */
function bracketIsACommand(text: string, node: ShellNode): boolean {
  const children = node.children
  if (children[0]?.type !== '[') return false
  const close = children[children.length - 1]
  if (close?.type !== ']' || close.isMissing) return true
  if (!breaksWord(text, close.endIndex)) return true
  const stack = children.slice(1, -1)
  for (let part = stack.pop(); part !== undefined; part = stack.pop()) {
    if (!part.isNamed && LIST_TOKENS.has(part.type)) return true
    if (TEST_PARTS.has(part.type)) stack.push(...part.children)
  }
  return false
}

/**
 * Spell operators the way the grammar can lex them.
 *
 * bash reads `<>` and `<<<` as one operator each, and a digit string that
 * starts a word and touches `<` or `>` as the descriptor. tree-sitter-bash
 * reads `<>` as `<` then `>`, `<<<` after a compound command or a
 * descriptor as `<<` then `<`, and a digit string with a leading zero
 * (`0<f`) as a number. The same-width spelling here hands it `>>`, `<  `
 * and a nonzero first digit; `SourceNode` reads the original text, so a
 * redirect whose text opens with `<<<` is the herestring it was. A last case
 * arm's `;&` or `;;&`, which the grammar refuses, ends it as `;;` does, there
 * being no arm after it, so it is spelled so. An argument of `==` or `=~`,
 * which the grammar reads as a test operator wanting an operand (so `echo ==`
 * is an error and `echo == x` drops it), and a `$` that opens no expansion
 * (`$\a`, `$,`, `$` before a blank) are words to bash, where the grammar errs
 * or reads an expansion missing its name; spelled as `_` filler they parse as
 * the words they are, and `SourceNode` gives back their text. So is the `[` of a test bash reads
 * as a `[` command (`bracketIsACommand`, or one an error region opens), which
 * then runs as the builtin, and so is a backslash-blank pair the grammar
 * skips as whitespace (`skippedEscapes`), spelled `..` so it opens its word
 * without joining a `$name` before it or making an assignment. An
 * operator inside an error region gets its own token only once the operators
 * before it are respelled, so the pass repeats on its own parse until nothing
 * changes. Mirrors Python's operator_source.
 */
export function operatorSource(parser: NativeParser, text: string, root: ShellNode): string {
  let current = text
  let lexed = respelled(current, root)
  while (lexed !== current) {
    current = lexed
    const tree = parser.parse(current)
    if (tree === null) return current
    lexed = respelled(current, tree.rootNode)
  }
  return current
}

/**
 * Offsets of each backslash-blank pair the grammar read as a blank.
 *
 * Outside quotes, bash reads a backslash before a space or a tab as that
 * blank escaped into the word it opens (`\ x` is the word ` x`). The grammar
 * skips the pair as whitespace, so the word loses its blank, and a line one
 * opens reads as more words of the line before. Only the text no token covers
 * is searched; a quoted or unlexed span counts as one token.
 */
function skippedEscapes(text: string, root: ShellNode): number[] {
  if (text.search(ESCAPED_BLANK) === -1) return []
  const spans: [number, number][] = [[text.length, text.length]]
  const stack: ShellNode[] = [root]
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (node.childCount > 0 && !UNLEXED.has(node.type) && node.type !== 'string')
      stack.push(...node.children)
    else spans.push([node.startIndex, node.endIndex])
  }
  spans.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const offsets: number[] = []
  let at = 0
  for (const [lo, hi] of spans) {
    for (const match of text.slice(at, lo).matchAll(ESCAPED_BLANK)) offsets.push(at + match.index)
    at = Math.max(at, hi)
  }
  return offsets
}

function respelled(text: string, root: ShellNode): string {
  const out = text.split('')
  for (const at of skippedEscapes(text, root)) {
    out[at] = '.'
    out[at + 1] = '.'
  }
  const stack: ShellNode[] = [root]
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (node.type === 'test_command' && bracketIsACommand(text, node)) out[node.startIndex] = '_'
    if (UNLEXED.has(node.type)) continue
    stack.push(...node.children)
    for (const child of node.children) {
      if (child.isNamed) continue
      LITERAL_DOLLAR.lastIndex = child.startIndex
      if (
        (BARE_WORDS.has(child.type) && (node.type === 'command' || node.type === 'ERROR')) ||
        (child.type === '$' && LITERAL_DOLLAR.test(text))
      ) {
        for (let i = child.startIndex; i < child.endIndex; i++) out[i] = '_'
      } else if (
        node.type === 'ERROR' &&
        child.type === '[' &&
        breaksWord(text, child.startIndex - 1) &&
        breaksWord(text, child.endIndex)
      ) {
        out[child.startIndex] = '_'
      }
    }
    const start = node.startIndex
    if (node.type === '<' && text.startsWith('<>', start)) out[start] = '>'
    else if ((node.type === '<<<' || node.type === '<<') && text.startsWith('<<<', start)) {
      out[start + 1] = ' '
      out[start + 2] = ' '
    } else if (
      (node.type === ';&' || node.type === ';;&') &&
      LAST_ARM.test(text.slice(node.endIndex))
    ) {
      out[start] = ';'
      out[start + 1] = ';'
      if (node.type === ';;&') out[start + 2] = ' '
    }
    if (node.childCount > 0 || text[start] !== '0') continue
    if (start > 0 && !WORD_START.includes(text[start - 1] ?? '')) continue
    DIGITS.lastIndex = start
    const end = start + (DIGITS.exec(text)?.[0].length ?? 0)
    if (text[end] === '<' || text[end] === '>') out[start] = '1'
  }
  return out.join('')
}

/**
 * Parse structure using same-width lexical shields. Heredoc bodies,
 * substring operands and redirect operators need word grammar where
 * tree-sitter otherwise rejects them. The shielded tree is read against the
 * original text (`SourceNode`). When shielding adds an error, keep the
 * original parse so structural errors still reach syntax validation.
 */
export function parseProtected(parser: NativeParser, text: string): ShellNode {
  const tree = parser.parse(text)
  if (tree === null) throw new Error('shell parse returned null')
  let shieldedText = expansionSource(
    (text.includes('<<') ? protectedSource(text, tree.rootNode) : null) ?? text,
    tree.rootNode,
  )
  shieldedText = operatorSource(parser, shieldedText, tree.rootNode)
  if (shieldedText === text) return tree.rootNode
  const shielded = parser.parse(shieldedText)
  if (shielded === null) return tree.rootNode
  const original = errors(tree.rootNode)
  if (![...errors(shielded.rootNode)].every((span) => original.has(span))) return tree.rootNode
  return new SourceNode(shielded.rootNode, text)
}

/**
 * Offsets of `((` tokens the parser could not make sense of.
 *
 * Only openers inside an ERROR subtree, or opening a construct that holds
 * one (`((exit 3) & a=$!; ...)` lexes as arithmetic up to the error), are
 * reported. A genuine `((i++))` parses as an arithmetic command with no
 * error in it, so it cannot be picked up here.
 */
export function failedArithOpeners(root: ShellNode): number[] {
  const offsets: number[] = []
  const stack: [ShellNode, boolean][] = [[root, false]]
  for (;;) {
    const entry = stack.pop()
    if (entry === undefined) break
    const [node, inError] = entry
    const errored = inError || node.type === 'ERROR'
    for (const child of node.children) {
      if (child.type === ARITH_OPEN_TOKEN && (errored || node.hasError)) {
        offsets.push(child.startIndex)
      }
      stack.push([child, errored])
    }
  }
  return offsets
}

/**
 * Offsets of literal `$` tokens cut off from their variable name.
 *
 * tree-sitter-bash 0.25.1 stops lexing a later unbraced expansion in a
 * word when a name-terminating character follows it, so
 * `> /api/$c/$id.json` parses as `/api/$c/$` plus a sibling word
 * `id.json`: the `$` lands in the tree as a literal token and the
 * expansion is gone. A literal `$` starting a recognized unbraced
 * parameter is a shape no correct bash lex produces (bash would have
 * read an expansion), so each one marks a mis-parse. The `$` opening a
 * simple_expansion is that expansion's own token and is skipped.
 */
function orphanedDollarOffsets(root: ShellNode, text: string): number[] {
  const offsets: number[] = []
  const stack: ShellNode[] = [root]
  for (;;) {
    const node = stack.pop()
    if (node === undefined) break
    for (const child of node.children) {
      if (
        !child.isNamed &&
        child.type === '$' &&
        node.type !== 'simple_expansion' &&
        text[child.endIndex] !== '{' &&
        scanParameter(text, child.startIndex) !== null
      ) {
        offsets.push(child.startIndex)
      }
      stack.push(child)
    }
  }
  return offsets
}

/**
 * Rewrite the expansion at `offset` into its braced spelling.
 *
 * `$id.json` becomes `${id}.json`, which says the same thing and is the
 * spelling the grammar reads correctly. Bash reads a single digit after
 * `$` as one positional parameter, so `$12` rebraces as `${1}2`.
 */
function rebraceDollar(text: string, offset: number): string {
  const ref = scanParameter(text, offset)
  if (ref === null) return text
  const [name, end] = ref
  return `${text.slice(0, offset)}\${${name}}${text.slice(end)}`
}

/**
 * Rebrace mis-lexed expansions and reparse until none remain.
 *
 * Every rebrace consumes one bare `$` and never writes a new one, so
 * the loop is bounded by the count of `$` characters. A retry that
 * parses worse than what it replaces is discarded.
 */
export function repairOrphanedDollars(
  parser: NativeParser,
  root: ShellNode,
  text: string,
): ShellNode {
  const bound = text.split('$').length - 1
  for (let i = 0; i < bound; i += 1) {
    const offsets = orphanedDollarOffsets(root, text)
    if (offsets.length === 0) break
    for (const offset of offsets.sort((a, b) => b - a)) {
      text = rebraceDollar(text, offset)
    }
    const retried = parseProtected(parser, text)
    if (retried.hasError) break
    root = retried
  }
  return root
}

export function repairRedirectDashes(
  parser: NativeParser,
  root: ShellNode,
  text: string,
): [ShellNode, string] {
  // Quote only an uncovered dash before a redirect, never word or heredoc text.
  const offsets: number[] = []
  const stack = [root]
  while (stack.length > 0) {
    const node = stack.pop()
    if (node === undefined) break
    let end = node.startIndex
    for (const child of node.children) {
      const gap = text.slice(end, child.startIndex)
      if (child.type === 'file_redirect' && gap.trim() === '-') {
        offsets.push(end + gap.indexOf('-'))
      }
      end = child.endIndex
      stack.push(child)
    }
  }
  if (offsets.length === 0) return [root, text]
  let repaired = text
  for (const offset of [...new Set(offsets)].sort((a, b) => b - a)) {
    repaired = `${repaired.slice(0, offset)}'-'${repaired.slice(offset + 1)}`
  }
  const retried = parseProtected(parser, repaired)
  return retried.hasError ? [root, text] : [retried, repaired]
}

const NAME = /^\w+$/

const FOLLOWER = /^\s*(in|do)(?![^\s;&|()<>])/

function headerInserts(root: ShellNode, text: string): [number, string][] {
  const heads: number[] = []
  const stack = [root]
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    stack.push(...node.children)
    if (node.type !== 'for_statement' && node.type !== 'ERROR') continue
    for (const kid of node.children) {
      if (kid.type === 'for' || kid.type === 'select') heads.push(kid.endIndex)
    }
  }
  const inserts: [number, string][] = []
  for (const head of heads) {
    const start = text.length - text.slice(head).replace(/^[ \t]+/, '').length
    const end = delimiterEnd(text, start) ?? start
    const word = FOLLOWER.exec(text.slice(end))?.[1]
    const named = NAME.test(text.slice(start, end))
    if (end === start || (named && word === 'in')) continue
    const tail = word === 'do' ? ';' : ''
    if (named) inserts.push([end, ` in "$@"${tail}`])
    else inserts.push([start, '0 in '], [end, tail])
  }
  return inserts
}

export function repairForHeaders(
  parser: NativeParser,
  root: ShellNode,
  text: string,
): [ShellNode, string] {
  // Encode invalid names for runtime validation and supply omitted "$@".
  // Repeat to expose nested headers; accept only repairs adding no errors.
  let [repaired, retried] = [text, root]
  for (let inserts = headerInserts(root, text); inserts.length > 0;) {
    for (const [offset, insert] of inserts.sort((a, b) => b[0] - a[0])) {
      repaired = repaired.slice(0, offset) + insert + repaired.slice(offset)
    }
    retried = parseProtected(parser, repaired)
    inserts = headerInserts(retried, repaired)
  }
  return retried === root || errors(retried).size > errors(root).size
    ? [root, text]
    : [retried, repaired]
}

function errors(root: ShellNode): Set<string> {
  const spans = new Set<string>()
  const stack = [root]
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    stack.push(...node.children)
    if (node.type === 'ERROR' || node.isMissing)
      spans.add(`${String(node.startIndex)}:${String(node.endIndex)}`)
  }
  return spans
}

/**
 * Make statement newlines swallowed between simple-command words explicit.
 * The grammar also folds one into the next word when a backslash opens that
 * word (`\ls`, the alias bypass), so the next line reads as more arguments.
 * Quoted newlines are inside a child, continuations were already removed, and
 * an escaped blank beside one is a word the grammar skipped (`skippedEscapes`).
 * Insertion preserves the source maps used by lowered heredocs. The separator
 * goes before a comment that ends the statement, since one after it would be
 * read as part of the comment.
 */
export function statementBoundaries(parser: NativeParser, text: string): string {
  if (!text.includes('\n')) return text
  const root = parser.parse(text)?.rootNode
  if (root === undefined) return text
  const offsets = new Set<number>()
  const stack = [root]
  while (stack.length > 0) {
    const node = stack.pop()
    if (node === undefined) break
    stack.push(...node.children)
    if (
      ![
        'command',
        'declaration_command',
        'file_redirect',
        'redirected_statement',
        'unset_command',
      ].includes(node.type)
    )
      continue
    const children = node.children
    for (let i = 1; i < children.length; i += 1) {
      const left = children[i - 1]
      const right = children[i]
      if (left === undefined || right === undefined) continue
      const folded = text[right.startIndex] === '\n' ? 1 : 0
      const gap = text.slice(left.endIndex, right.startIndex + folded)
      if (gap.includes('\n') && gap.replace(ESCAPED_BLANK, '').trim() === '')
        offsets.add(left.type === 'comment' ? left.startIndex : left.endIndex + gap.indexOf('\n'))
    }
  }
  for (const offset of [...offsets].sort((a, b) => b - a))
    text = text.slice(0, offset) + ';' + text.slice(offset)
  return text
}
