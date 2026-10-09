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
import * as constants from './constants.ts'
import { expansionSource } from './expansion.ts'
import { protectedSource } from './heredoc/index.ts'
import { delimiterEnd } from './heredoc/reader.ts'
import { SourceNode } from './source.ts'
import { patternSource } from './syntax.ts'
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
    if (constants.QUOTES.has(char)) {
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

/** Whether `text[at]` ends a word: the end of the text, a blank or an operator. */
function breaksWord(text: string, at: number): boolean {
  return at < 0 || at >= text.length || constants.WORD_BREAKS.has(text[at] ?? '')
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
    if (!part.isNamed && constants.LIST_TOKENS.has(part.type)) return true
    if (constants.TEST_PARTS.has(part.type)) stack.push(...part.children)
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
  if (text.search(constants.ESCAPED_BLANK) === -1) return []
  const spans: [number, number][] = [[text.length, text.length]]
  const stack: ShellNode[] = [root]
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (node.childCount > 0 && !constants.UNLEXED.has(node.type) && node.type !== 'string')
      stack.push(...node.children)
    else spans.push([node.startIndex, node.endIndex])
  }
  spans.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const offsets: number[] = []
  let at = 0
  for (const [lo, hi] of spans) {
    for (const match of text.slice(at, lo).matchAll(constants.ESCAPED_BLANK))
      offsets.push(at + match.index)
    at = Math.max(at, hi)
  }
  return offsets
}

/** One respelling pass of `operatorSource` over one parse. Mirrors Python's
 * _respelled. */
function respelled(text: string, root: ShellNode): string {
  const out = text.split('')
  for (const at of skippedEscapes(text, root)) {
    out[at] = '.'
    out[at + 1] = '.'
  }
  const stack: ShellNode[] = [root]
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (node.type === 'test_command' && bracketIsACommand(text, node)) out[node.startIndex] = '_'
    if (constants.UNLEXED.has(node.type)) continue
    stack.push(...node.children)
    for (const child of node.children) {
      if (child.isNamed) continue
      constants.LITERAL_DOLLAR.lastIndex = child.startIndex
      if (
        (constants.BARE_WORDS.has(child.type) &&
          (node.type === 'command' || node.type === 'ERROR')) ||
        (child.type === '$' && constants.LITERAL_DOLLAR.test(text))
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
      constants.LAST_CASE_ARM.test(text.slice(node.endIndex))
    ) {
      out[start] = ';'
      out[start + 1] = ';'
      if (node.type === ';;&') out[start + 2] = ' '
    }
    if (node.childCount > 0 || text[start] !== '0') continue
    if (start > 0 && !constants.WORD_START.includes(text[start - 1] ?? '')) continue
    constants.DIGIT_RUN.lastIndex = start
    const end = start + (constants.DIGIT_RUN.exec(text)?.[0].length ?? 0)
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
  const patterned = patternSource(text)
  const tree = parser.parse(patterned)
  if (tree === null) throw new Error('shell parse returned null')
  let shieldedText = expansionSource(
    (patterned.includes('<<') ? protectedSource(patterned, tree.rootNode) : null) ?? patterned,
    tree.rootNode,
  )
  shieldedText = operatorSource(parser, shieldedText, tree.rootNode)
  const original = patterned === text ? tree.rootNode : new SourceNode(tree.rootNode, text)
  if (shieldedText === patterned) return original
  const shielded = parser.parse(shieldedText)
  if (shielded === null) return original
  const originalErrors = errors(tree.rootNode)
  if (![...errors(shielded.rootNode)].every((span) => originalErrors.has(span))) return original
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
      if (child.type === constants.ARITH_OPEN_TOKEN && (errored || node.hasError)) {
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

/**
 * Quote a lone dash the grammar drops before a descriptor redirect.
 * tree-sitter-bash loses a bare `-` written right before an explicit
 * descriptor's redirect (`echo - 2>&1`). Only a dash standing alone in a gap
 * between two nodes is quoted, never text inside a word or a body, and the
 * repair stands only if the reparse has no error. Returns the tree and source
 * to run. Mirrors Python's repair_redirect_dashes.
 */
export function repairRedirectDashes(
  parser: NativeParser,
  root: ShellNode,
  text: string,
): [ShellNode, string] {
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

/**
 * The insertions that let each for or select header parse, as offset and
 * text: an omitted list becomes `in "$@"`, which bash iterates, and a
 * variable that is not a name moves into a list behind `0 in`, where the loop
 * refuses it at run time as bash does. Mirrors Python's _header_inserts.
 */
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
    const word = constants.HEADER_FOLLOWER.exec(text.slice(end))?.[1]
    const named = constants.HEADER_NAME.test(text.slice(start, end))
    if (end === start || (named && word === 'in')) continue
    const tail = word === 'do' ? ';' : ''
    if (named) inserts.push([end, ` in "$@"${tail}`])
    else inserts.push([start, '0 in '], [end, tail])
  }
  return inserts
}

/**
 * Repair for and select headers (`headerInserts`) until none is left: a
 * header inside a repaired one shows only on the reparse. The repair stands
 * only if it adds no error. Returns the tree and source to run. Mirrors
 * Python's repair_for_headers.
 */
export function repairForHeaders(
  parser: NativeParser,
  root: ShellNode,
  text: string,
): [ShellNode, string] {
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

/** The spans of a tree's error and missing nodes. Mirrors Python's _errors. */
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
    if (!constants.STATEMENT_NODES.has(node.type)) continue
    const children = node.children
    for (let i = 1; i < children.length; i += 1) {
      const left = children[i - 1]
      const right = children[i]
      if (left === undefined || right === undefined) continue
      const folded = text[right.startIndex] === '\n' ? 1 : 0
      const gap = text.slice(left.endIndex, right.startIndex + folded)
      if (gap.includes('\n') && gap.replace(constants.ESCAPED_BLANK, '').trim() === '')
        offsets.add(left.type === 'comment' ? left.startIndex : left.endIndex + gap.indexOf('\n'))
    }
  }
  for (const offset of [...offsets].sort((a, b) => b - a))
    text = text.slice(0, offset) + ';' + text.slice(offset)
  return text
}
