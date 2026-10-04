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

import { Language, type Node, Parser } from 'web-tree-sitter'

import { scanParameter } from '../parameter.ts'
import { ARITH_OPEN_TOKEN, QUOTES, VERBATIM_TYPES } from './constants.ts'
import { expansionSource } from './expansion.ts'
import { heredocOperators, protectedSource } from './heredoc/index.ts'
import { PrefixNode, lowerTiming, wrapTiming, type TimingMark } from './timing.ts'
import { delimiterEnd, discoverHeredocs } from './heredoc/reader.ts'
import { dropChars, dropSourceChars, lowerHeredocs, rebaseSource } from './heredoc/lower.ts'
import { HeredocNode } from './heredoc/node.ts'
import type { ShellNode, TSNodeLike } from '../types.ts'

export interface ShellParserConfig {
  engineWasm: Uint8Array | ArrayBuffer
  grammarWasm: Uint8Array | ArrayBuffer
}

export interface ShellParser {
  parse(command: string): ShellNode
  /** Where each char of the source `parse` read sits in `command`. */
  sourceOffsets(command: string, root: TSNodeLike): readonly number[]
}

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
function isArithmetic(parser: Parser, command: string, start: number): boolean {
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
const LAST_ARM = /^\s*esac(?![^\s;&|()<>])/
// Tokens the grammar lexes apart from a word in an argument list, where
// bash reads a word, by the node they stand under. A bare `$` in a command
// is already kept as a word, and only an error region loses it; the `$`
// opening `$"..."` is the translation marker, never a word.
const BARE_WORDS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['command', new Set(['==', '=~'])],
  ['ERROR', new Set(['==', '=~', '$'])],
])
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
 * is an error and `echo == x` drops it), and a bare `$` before a terminator
 * are words to bash; spelled as `_` filler they parse as the words they are,
 * and `SourceNode` gives back their text. So is the `[` of a test bash reads
 * as a `[` command (`bracketIsACommand`, or one an error region opens), which
 * then runs as the builtin. An operator inside an error region gets its own
 * token only once the operators before it are respelled, so the pass repeats
 * on its own parse until nothing changes. Mirrors Python's _operator_source.
 */
function operatorSource(parser: Parser, text: string, root: ShellNode): string {
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

function respelled(text: string, root: ShellNode): string {
  const out = text.split('')
  const stack: ShellNode[] = [root]
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (node.type === 'test_command' && bracketIsACommand(text, node)) out[node.startIndex] = '_'
    if (UNLEXED.has(node.type)) continue
    stack.push(...node.children)
    const bare = BARE_WORDS.get(node.type)
    for (const child of node.children) {
      if (child.isNamed) continue
      if (bare?.has(child.type) === true) {
        if (child.type === '$' && text[child.endIndex] === '"') continue
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
 * A node of a shielded parse that reads the original text.
 *
 * Every shield keeps the source's width, so a span names the same text in
 * both and only `text` differs. Reparsing the original against the
 * shielded tree did the same until tree-sitter relexed a statement on its
 * own, which it does at a line's end. Mirrors Python's SourceNode.
 */
class SourceNode implements ShellNode {
  constructor(
    private readonly node: Node,
    private readonly original: string,
  ) {}
  get type(): string {
    return this.node.type
  }
  get text(): string {
    return this.original.slice(this.node.startIndex, this.node.endIndex)
  }
  get id(): number {
    return this.node.id
  }
  get startIndex(): number {
    return this.node.startIndex
  }
  get endIndex(): number {
    return this.node.endIndex
  }
  get startPosition() {
    return this.node.startPosition
  }
  get endPosition() {
    return this.node.endPosition
  }
  get isNamed(): boolean {
    return this.node.isNamed
  }
  get isMissing(): boolean {
    return this.node.isMissing
  }
  get hasError(): boolean {
    return this.node.hasError
  }
  get childCount(): number {
    return this.node.childCount
  }
  child(index: number): SourceNode | null {
    return this.wrap(this.node.child(index))
  }
  get children(): SourceNode[] {
    return this.node.children.map((node) => new SourceNode(node, this.original))
  }
  get namedChildren(): SourceNode[] {
    return this.node.namedChildren.map((node) => new SourceNode(node, this.original))
  }
  private wrap(node: Node | null): SourceNode | null {
    return node === null ? null : new SourceNode(node, this.original)
  }
  get parent(): SourceNode | null {
    return this.wrap(this.node.parent)
  }
  get previousSibling(): SourceNode | null {
    return this.wrap(this.node.previousSibling)
  }
  get nextSibling(): SourceNode | null {
    return this.wrap(this.node.nextSibling)
  }
  childForFieldName(name: string): SourceNode | null {
    return this.wrap(this.node.childForFieldName(name))
  }
}

/**
 * Parse structure using same-width lexical shields. Heredoc bodies,
 * substring operands and redirect operators need word grammar where
 * tree-sitter otherwise rejects them. The shielded tree is read against the
 * original text (`SourceNode`). When shielding adds an error, keep the
 * original parse so structural errors still reach syntax validation.
 */
function parseProtected(parser: Parser, text: string): ShellNode {
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
function failedArithOpeners(root: ShellNode): number[] {
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
 * Spans whose backslashes escape nothing: comments and strings in single
 * quotes, ANSI-C ones included.
 */
function verbatimSpans(root: Node): [number, number][] {
  const spans: [number, number][] = []
  const stack: Node[] = [root]
  for (;;) {
    const node = stack.pop()
    if (node === undefined) break
    if (VERBATIM_TYPES.has(node.type)) {
      spans.push([node.startIndex, node.endIndex])
      continue
    }
    for (const child of node.children) stack.push(child)
  }
  return spans.sort((a, b) => a[0] - b[0])
}

/**
 * Offsets of the characters bash's reader deletes as line continuations.
 *
 * The reader removes `\<newline>` before a token is read, so the halves it
 * joins are one word (`a\<newline>b` is `ab`, `$\<newline>{x}` an
 * expansion); tree-sitter reads the pair as whitespace instead.
 * Single-quoted and ANSI-C text and a comment keep theirs, and an escaped
 * backslash continues nothing: only an odd-length run of backslashes
 * before the newline ends in a live one. A live backslash ending the
 * input continues onto nothing and goes too: `echo a\` runs `echo a`. A
 * heredoc body is lowered into a quoted word before this runs, where
 * every backslash it holds is escaped, so no body loses a character here.
 */
function continuationIndices(parser: Parser, text: string): number[] {
  if (!text.includes('\\\n') && !text.endsWith('\\')) return []
  const tree = parser.parse(text)
  if (tree === null) throw new Error('shell parse returned null')
  const spans = verbatimSpans(tree.rootNode)
  const dropped: number[] = []
  let at = 0
  let index = text.indexOf('\\')
  while (index >= 0) {
    let end = index
    while (end < text.length && text[end] === '\\') end += 1
    while (at < spans.length && (spans[at]?.[1] ?? 0) <= end - 1) at += 1
    const verbatim = at < spans.length && (spans[at]?.[0] ?? 0) <= end - 1
    if ((end - index) % 2 === 1 && !verbatim && (end === text.length || text[end] === '\n')) {
      dropped.push(end - 1)
      if (end < text.length) dropped.push(end)
    }
    index = text.indexOf('\\', end)
  }
  return dropped
}

/**
 * Where each char of the source `parse` read sits in `command`. `parse`
 * deletes line continuations and inserts text to repair the grammar, so a
 * node's offsets index the source it read rather than the line as typed;
 * indexed by one of them, this gives the char of `command` it came from, and
 * an inserted char gives the char after it. Mirrors Python's source_offsets.
 */
function sourceOffsets(parser: Parser, command: string, root: TSNodeLike): readonly number[] {
  if (root instanceof HeredocNode || root instanceof PrefixNode) return root.offsets
  const source = dropSourceChars(
    {
      original: command,
      source: command,
      offsets: Array.from({ length: command.length + 1 }, (_, i) => i),
      documents: [],
    },
    continuationIndices(parser, command),
  )
  return rebaseSource(source, source.source.slice(0, root.startIndex ?? 0) + root.text).offsets
}

/** The line as bash's reader hands it on, continuations removed. */
export function joinContinuations(parser: Parser, command: string): string {
  return dropChars(command, continuationIndices(parser, command))
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
function repairOrphanedDollars(parser: Parser, root: ShellNode, text: string): ShellNode {
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

function repairRedirectDashes(parser: Parser, root: ShellNode, text: string): [ShellNode, string] {
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

function repairForHeaders(parser: Parser, root: ShellNode, text: string): [ShellNode, string] {
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

// `Parser.init` boots one wasm module for the whole process, so two callers
// that start at the same time used to race it: the second read the language
// out of a half-built module and threw "Incompatible language version 0".
// Every caller now awaits the same boot. A failed boot is not kept, or one bad
// start would poison every later parser.
let engineBoot: Promise<void> | null = null

/**
 * Make statement newlines swallowed between simple-command words explicit.
 * Quoted newlines are inside a child and continuations were already removed.
 * Insertion preserves the source maps used by lowered heredocs.
 */
function statementBoundaries(parser: Parser, text: string): string {
  if (!text.includes('\n')) return text
  const root = parser.parse(text)?.rootNode
  if (root === undefined) return text
  const offsets = new Set<number>()
  const stack = [root]
  while (stack.length > 0) {
    const node = stack.pop()
    if (node === undefined) break
    stack.push(...node.children)
    if (!['command', 'file_redirect', 'redirected_statement'].includes(node.type)) continue
    const children = node.children
    for (let i = 1; i < children.length; i += 1) {
      const left = children[i - 1]
      const right = children[i]
      if (left === undefined || right === undefined) continue
      const gap = text.slice(left.endIndex, right.startIndex)
      if (gap.includes('\n') && gap.trim() === '') offsets.add(left.endIndex + gap.indexOf('\n'))
    }
  }
  for (const offset of [...offsets].sort((a, b) => b - a))
    text = text.slice(0, offset) + ';' + text.slice(offset)
  return text
}

export async function createShellParser(config: ShellParserConfig): Promise<ShellParser> {
  engineBoot ??= Parser.init({ wasmBinary: toArrayBuffer(config.engineWasm) }).catch(
    (err: unknown) => {
      engineBoot = null
      throw err
    },
  )
  await engineBoot
  const language = await Language.load(toUint8(config.grammarWasm))
  const parser = new Parser()
  parser.setLanguage(language)
  return {
    /**
     * Parse shell structure after the source reader gathers heredocs.
     * Bodies become inline expansion words with reader-owned input metadata;
     * nodes retain their original source for nested evaluation.
     *
     * A leading `((` is lexed as the arithmetic opener and the lexer
     * cannot back out, so a subshell that immediately opens another
     * subshell (`((echo a); echo b)`) fails to parse. Bash resolves the
     * same ambiguity by trying the arithmetic command and reparsing as
     * nested subshells when that fails; this does the same, splitting
     * only openers that already sit inside an error and keeping the
     * retry only if it parses cleanly. Commands that parse today are
     * untouched, so no working command's offsets move.
     *
     * A later unbraced `$var` followed by a name-terminating character
     * is mis-lexed by the grammar, leaving a literal `$` token behind
     * (see orphanedDollarOffsets); those expansions are rebraced and
     * the line reparsed, so the returned tree can spell `$id` as
     * `${id}`.
     */
    parse(command: string): ShellNode {
      let hinted = command.includes('<<') ? (parser.parse(command)?.rootNode ?? null) : null
      if (hinted !== null) {
        // The operators are read off a tree that lexes `0<<EOF` as one.
        const lexed = operatorSource(parser, command, hinted)
        if (lexed !== command) hinted = parser.parse(lexed)?.rootNode ?? hinted
      }
      const documents = hinted === null ? [] : discoverHeredocs(command, heredocOperators(hinted))
      const lowered = documents.length > 0 ? lowerHeredocs(command, documents) : null
      let heredocs =
        lowered === null
          ? null
          : dropSourceChars(lowered, continuationIndices(parser, lowered.source))
      let input = heredocs?.source ?? joinContinuations(parser, command)
      let timingMarks: readonly TimingMark[] = []
      if (input.includes('time') || input.includes('!')) {
        heredocs ??= dropSourceChars(
          {
            original: command,
            source: command,
            offsets: Array.from({ length: command.length + 1 }, (_, i) => i),
            documents: [],
          },
          continuationIndices(parser, command),
        )
        ;[heredocs, timingMarks] = lowerTiming(parser, heredocs)
        input = heredocs.source
      }
      const source = statementBoundaries(parser, input)
      let root = parseProtected(parser, source)
      let text = source
      if (root.hasError) {
        // Sitting inside an ERROR is not evidence that an opener is
        // broken: tree-sitter's error region swallows neighbouring tokens,
        // so a valid `((i++))` next to a bad opener reports as errored
        // too. Splitting it would silently turn arithmetic into a subshell
        // running `i++`, which is a wrong parse rather than a rejected
        // one. Each opener is judged on its own span instead.
        const offsets = [...new Set(failedArithOpeners(root))].filter(
          (o) => !isArithmetic(parser, source, o),
        )
        if (offsets.length > 0) {
          let split = source
          for (const offset of offsets.sort((a, b) => b - a)) {
            split = `${split.slice(0, offset + 1)} ${split.slice(offset + 1)}`
          }
          const retried = parseProtected(parser, split)
          if (!retried.hasError) {
            root = retried
            text = split
          }
        }
      }
      ;[root, text] = repairRedirectDashes(parser, root, text)
      if (text.includes('for') || text.includes('select')) {
        ;[root, text] = repairForHeaders(parser, root, text)
      }
      if (text.includes('$')) {
        root = repairOrphanedDollars(parser, root, text)
      }
      if (heredocs === null) return root
      const mappedSource = rebaseSource(
        heredocs,
        heredocs.source.slice(0, root.startIndex) + root.text,
      )
      const mapped = new HeredocNode(root, mappedSource)
      return timingMarks.length === 0 ? mapped : wrapTiming(mapped, mappedSource, timingMarks)
    },
    sourceOffsets(command: string, root: TSNodeLike): readonly number[] {
      return sourceOffsets(parser, command, root)
    },
  }
}

function toArrayBuffer(bytes: Uint8Array | ArrayBuffer): ArrayBuffer {
  if (bytes instanceof ArrayBuffer) return bytes
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function toUint8(bytes: Uint8Array | ArrayBuffer): Uint8Array {
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
}
