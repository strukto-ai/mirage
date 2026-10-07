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

import type { SyntaxIssue } from './types.ts'

import { IOResult } from '../../io/types.ts'
import { encodeText } from '../bytes.ts'
import { NodeType as NT, type TSNodeLike } from '../types.ts'

import {
  ASSIGNMENT_OPERATORS,
  BASH_KEYWORDS,
  CASE_TERMINATORS,
  CLOSING_TOKENS,
  COMMAND_FOLLOWS,
  COMPOUND_CLOSERS,
  CONSTRUCT_CLOSERS,
  LIST_OPERATORS,
  NAME_FOLLOWS,
  OPENER_CLOSERS,
  QUOTE_TOKENS,
  SEPARATOR_TOKENS,
  STRUCTURAL_TOKENS,
} from './constants.ts'

/** Find what the input ended inside, only in erroneous AST regions: a quote,
 * or a substitution or expansion still waiting for its closer (an opener
 * token in an ERROR, or a closer the grammar marks missing). Complete
 * strings, comments and heredoc bodies stay opaque. Returns the character
 * bash reports it was looking for. Mirrors Python. */
export function findUnterminatedQuote(node: TSNodeLike): string | null {
  return unfinished(node)?.[0] ?? null
}

/** What the input ended inside, as `findUnterminatedQuote` reads it: the
 * character bash names for the innermost construct left open, and the kind
 * and start of the outermost one, which an unexpected token before it is
 * reported ahead of. Mirrors Python's _unfinished. */
function unfinished(node: TSNodeLike): [string, string, number] | null {
  const stack: [TSNodeLike, boolean, number | null][] = [[node, false, null]]
  for (let entry = stack.pop(); entry !== undefined; entry = stack.pop()) {
    const [current, visited, quoted] = entry
    const start = current.startIndex ?? 0
    if (visited) {
      // Diagnose an ERROR span only after its children, as before.
      if (current.children.length === 0 && current.text.startsWith("'")) return ["'", "'", start]
      const pending = unclosed(current.children)
      const [outer] = pending ?? []
      const inner = pending?.at(-1)
      if (outer !== undefined && inner !== undefined) return [inner[1], outer[2], outer[3]]
      continue
    }
    if (current.isMissing && QUOTE_TOKENS.has(current.type))
      return [current.type, current.type, current.parent?.startIndex ?? start]
    const closer = CONSTRUCT_CLOSERS.get(current.type)
    // Inside a double-quoted string, bash reads the string's own closing
    // quote into the construct, where it opens another.
    if (
      closer !== undefined &&
      current.children.some((child) => child.isMissing && CLOSING_TOKENS.has(child.type))
    )
      return quoted !== null ? ['"', NT.STRING, quoted] : [closer, current.type, start]
    if (current.type === 'ansi_c_string') {
      const before = current.text.slice(0, -1)
      const slashes = /\\+$/.exec(before)?.[0].length ?? 0
      if (slashes % 2 !== 0) return ["'", current.type, start]
      continue
    }
    if (current.type === 'ERROR') stack.push([current, true, quoted])
    const inner = quoted ?? (current.type === NT.STRING ? start : null)
    const children = current.children
    for (let i = children.length - 1; i >= 0; i -= 1) {
      const child = children[i]
      if (child !== undefined) stack.push([child, false, inner])
    }
  }
  return null
}

/** The constructs an ERROR's tokens leave open, outermost first: each one's
 * closing token, the character bash names for it, its opener and its
 * start. A double quote or a backtick nests inside a substitution as bash
 * reads it (`"$("` waits for a quote), a lone `)` inside `$((` groups rather
 * than closes, and a `(` right after an assignment's `=` or `+=` opens an
 * array. Any other closer that does not match the innermost opener is an
 * unexpected token rather than the end of input: null. Mirrors Python's
 * _unclosed. */
function unclosed(children: readonly TSNodeLike[]): [string, string, string, number][] | null {
  const pending: [string, string, string, number][] = []
  let previous: TSNodeLike | null = null
  for (const child of children) {
    const kind = child.type
    const start = child.startIndex ?? 0
    const opened = OPENER_CLOSERS.get(kind)
    if (kind === '"' || kind === '`') {
      if (pending.at(-1)?.[0] === kind) pending.pop()
      else pending.push([kind, kind, kind, start])
    } else if (opened !== undefined) pending.push([opened[0], opened[1], kind, start])
    else if (kind === '(' && previous !== null && ASSIGNMENT_OPERATORS.has(previous.type))
      pending.push([')', ')', NT.ARRAY, start])
    else if (CLOSING_TOKENS.has(kind) && pending.length > 0) {
      if (!(kind === ')' && pending.at(-1)?.[0] === '))')) {
        if (kind !== pending.at(-1)?.[0]) return null
        pending.pop()
      }
    }
    previous = child
  }
  return pending
}

/** Whether the input's first error is ending inside an array assignment's
 * `(`, the outermost construct it leaves open: bash's
 * `parse_compound_assignment` refuses that line with status 1 and discards
 * it, where the input ending inside any other construct is a syntax error
 * with status 2. A flagged span ending before the array opens (`issueEnd`)
 * is the error bash reports instead. Mirrors Python. */
export function endsInsideArray(node: TSNodeLike, issueEnd: number | null = null): boolean {
  const found = unfinished(node)
  return found !== null && found[1] === NT.ARRAY && (issueEnd === null || issueEnd > found[2])
}

/** Whether the input ends inside a compound command or after an operator.
 * bash reads such a line as unfinished when it took every token where it
 * stood and still wants more: the grammar marks the token it needed missing
 * at the end (`(echo a`, `echo a |`), or an ERROR reaching the end leaves a
 * compound open (`{ echo a`, `if true; then`, `case a in`). A token it could
 * not take (`if then`, `if ;`, `( then`) is the error bash reports instead;
 * a closing reserved word an alias spells is a command there. `aliases`,
 * `own` and `offsets` are `findSyntaxIssue`'s. Mirrors Python. */
export function endsInsideConstruct(
  node: TSNodeLike,
  aliases: ReadonlySet<string> = new Set(),
  own: ReadonlyMap<string, readonly [number, number]> = new Map(),
  offsets?: readonly number[],
): boolean {
  const stray = [
    ...strayCaseTerminators(node),
    ...emptyCompounds(node),
    ...strayReservedWords(node, aliases, own, offsets),
  ]
  if (stray.some(([, text]) => text !== '')) return false
  const end = (node.startIndex ?? 0) + node.text.trimEnd().length
  let unfinished = false
  const stack: [TSNodeLike, TSNodeLike | null][] = [[node, null]]
  for (let top = stack.pop(); top !== undefined; top = stack.pop()) {
    const [current, before] = top
    if (current.type === 'ERROR') {
      const opened = openCompound(current, before, aliases, own, offsets)
      if (opened === null) return false
      unfinished ||= opened && (current.endIndex ?? 0) >= end
    } else if (current.isMissing && (current.startIndex ?? 0) >= end) {
      unfinished = true
    }
    let previous: TSNodeLike | null = null
    for (const child of current.children) {
      stack.push([child, previous])
      previous = child
    }
  }
  return unfinished
}

/** Read an ERROR's tokens as bash does: whether they leave a compound open,
 * or null at the first token bash cannot take where it stands. A command
 * must follow the tokens in `COMMAND_FOLLOWS` and a word those in
 * `NAME_FOLLOWS`: a list operator there is unexpected, as is a closing
 * reserved word where a command starts, and a list operator right after
 * another. After a command's words (`before` is that command) a `(` is
 * unexpected unless `()` makes the command a function definition. Text the
 * grammar skipped is unexpected too. A nested ERROR's tokens are read in
 * line, as tokens the grammar could not group. A word in `aliases` is a
 * command where one starts, whatever it spells, except inside its own text
 * (`reservedHere`). Mirrors Python. */
function openCompound(
  error: TSNodeLike,
  before: TSNodeLike | null,
  aliases: ReadonlySet<string> = new Set(),
  own: ReadonlyMap<string, readonly [number, number]> = new Map(),
  offsets?: readonly number[],
): boolean | null {
  const origin = error.startIndex ?? 0
  const children = [...errorTokens(error)]
  let expect = before?.type === 'command' ? 'words' : ''
  const pending: string[] = []
  let cursor = origin
  for (const [i, child] of children.entries()) {
    const kind = child.type
    const start = child.startIndex ?? cursor
    const word = child.isNamed === true ? child.text : kind
    if (
      error.text.slice(cursor - origin, start - origin).trim() !== '' ||
      (['command', 'name', 'list'].includes(expect) && LIST_OPERATORS.has(kind)) ||
      (expect === 'command' &&
        RESERVED_CLOSERS.has(word) &&
        reservedHere(word, start, aliases, own, offsets))
    )
      return null
    const call = expect === 'words' && kind === '('
    if (call && children[i + 1]?.type !== ')') return null
    const closer = call ? undefined : COMPOUND_CLOSERS.get(kind)
    if (closer !== undefined) pending.push(closer)
    else if (pending.length > 0 && kind === pending.at(-1)) pending.pop()
    expect = COMMAND_FOLLOWS.has(kind)
      ? 'command'
      : NAME_FOLLOWS.has(kind)
        ? 'name'
        : LIST_OPERATORS.has(kind)
          ? 'list'
          : 'words'
    cursor = child.endIndex ?? start
  }
  if (error.text.slice(cursor - origin).trim() !== '') return null
  return pending.length > 0
}

/** An ERROR's children, a nested ERROR's read in line. */
function* errorTokens(error: TSNodeLike): Generator<TSNodeLike> {
  for (const child of error.children) {
    if (child.type === 'ERROR') yield* errorTokens(child)
    else yield child
  }
}

/** The bash-style diagnostic for an unparsable line: status 2, or 1 for an
 * array assignment it ends inside (`endsInsideArray`). `aliases`, `own` and
 * `offsets` are `findSyntaxIssue`'s; `issueEnd` is where the flagged span
 * ends in the parse. */
export function syntaxErrorResult(
  offending: string,
  node: TSNodeLike,
  aliases: ReadonlySet<string> = new Set(),
  own: ReadonlyMap<string, readonly [number, number]> = new Map(),
  offsets?: readonly number[],
  issueEnd: number | null = null,
): IOResult {
  const message = syntaxErrorMessage(offending, node, aliases, own, offsets, issueEnd)
  return new IOResult({
    exitCode: endsInsideArray(node, issueEnd) ? 1 : 2,
    stderr: encodeText(message),
  })
}

/** Format the diagnostic shared by parsed programs and execution results.
 * bash reports the first error it reads: input left open inside a quote or
 * construct is the error unless the flagged span ends before that construct
 * opens (`fi; echo "a` is the unexpected `fi`). */
export function syntaxErrorMessage(
  offending: string,
  node: TSNodeLike,
  aliases: ReadonlySet<string> = new Set(),
  own: ReadonlyMap<string, readonly [number, number]> = new Map(),
  offsets?: readonly number[],
  issueEnd: number | null = null,
): string {
  let found = unfinished(node)
  if (found !== null && issueEnd !== null && issueEnd <= found[2]) found = null
  const quote = found?.[0] ?? (findUnterminatedBacktick(offending) === null ? null : '`')
  const snippet = offending.trim()
  return quote !== null
    ? 'mirage: unexpected EOF while looking for matching `' + quote + "'\n"
    : endsInsideConstruct(node, aliases, own, offsets)
      ? 'mirage: syntax error: unexpected end of file\n'
      : snippet.length > 0
        ? `mirage: syntax error near '${snippet}'\n`
        : 'mirage: syntax error in command\n'
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
    if (reservedHere(name.text, start, names, own, offsets)) yield [start, name.text]
  }
}

/** Whether a closing word where a command starts is the reserved word: it
 * is unless an alias spells it, and an alias never expands inside its own
 * text. Mirrors Python's _reserved_here. */
function reservedHere(
  word: string,
  start: number,
  aliases: ReadonlySet<string>,
  own: ReadonlyMap<string, readonly [number, number]>,
  offsets: readonly number[] | undefined,
): boolean {
  if (!aliases.has(word)) return true
  const span = own.get(word)
  const at = offsets === undefined ? start : (offsets[start] ?? start)
  return span !== undefined && span[0] <= at && at < span[1]
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
  return findSyntaxIssue(node, parse, aliases, own, offsets)?.offending ?? null
}

function issue(node: TSNodeLike, offending: string | null): SyntaxIssue | null {
  return offending === null
    ? null
    : { offending, span: { start: node.startIndex ?? 0, end: node.endIndex ?? node.text.length } }
}

/** The first syntax error in the tree and the span it covers; `findSyntaxError`
 * keeps only its text. An error the walk finds only by reparsing a `$(...)`
 * body spans that substitution, since the reparse reads the body in its own
 * coordinates; one the walk sees directly, such as a stray `fi` inside the
 * body, keeps its own span. */
export function findSyntaxIssue(
  node: TSNodeLike,
  parse?: (command: string) => TSNodeLike,
  aliases: ReadonlySet<string> = new Set(),
  own: ReadonlyMap<string, readonly [number, number]> = new Map(),
  offsets?: readonly number[],
): SyntaxIssue | null {
  // Expansion and the `[` builtin own their argument grammar.
  if (node.type === 'expansion') {
    return node.children.some((child) => child.isMissing && child.type === '}')
      ? issue(node, '')
      : null
  }
  if (node.type === 'test_command' && node.children[0]?.type === '[')
    return issue(node, missingQuote(node))
  if (node.type === 'command_substitution') {
    const unclosed = findUnterminatedBacktick(node.text)
    if (unclosed !== null) return issue(node, unclosed)
  }
  if (
    node.type === 'command_substitution' &&
    parse !== undefined &&
    node.text.startsWith('$(') &&
    node.text.endsWith(')')
  ) {
    const nested = findSyntaxIssue(parse(node.text.slice(2, -1)), parse)
    return nested === null ? null : issue(node, nested.offending)
  }
  let stray: [number, string] | null = null
  for (const hit of [
    ...strayCaseTerminators(node),
    ...emptyCompounds(node),
    ...strayReservedWords(node, aliases, own, offsets),
  ]) {
    if (stray === null || hit[0] < stray[0]) stray = hit
  }
  if (stray !== null)
    return { offending: stray[1], span: { start: stray[0], end: stray[0] + stray[1].length } }
  if (!node.hasError) return issue(node, findUnterminatedQuote(node))
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
    if (child.isMissing) return issue(child, child.text)
    if (
      child.type === 'ERROR' &&
      isStructuralError(child) &&
      !(node.type === 'for_statement' && child.text.trim() === 'in')
    ) {
      if (isRecoveredQuotedHeredocEnd(previous, child)) {
        previous = child
        continue
      }
      return issue(child, child.text)
    }
    if (child.type !== 'ERROR') {
      const nested = findSyntaxIssue(child, parse, aliases, own, offsets)
      if (nested !== null) return nested
    }
    if (child.isNamed) previous = child
  }
  return null
}
