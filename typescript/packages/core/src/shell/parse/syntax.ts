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

import type { SyntaxDiagnostic } from './types.ts'
import { cleanDelimiter, delimiterQuoted } from './heredoc/delimiter.ts'

import { IOResult } from '../../io/types.ts'
import { encodeText } from '../bytes.ts'
import type { TSNodeLike } from '../types.ts'

import {
  ARRAY_BUILTINS,
  BASH_KEYWORDS,
  BINARY_TESTS,
  CASE_TERMINATORS,
  CLOSING_WORDS,
  COMPOUND_OPENERS,
  EXTGLOB_OPENERS,
  MAX_NESTING,
  NAME_CHARS,
  NAME_START,
  NEAR_TEXT_STOPS,
  OPERATOR_CHARS,
  OPERATORS,
  READ_ARITH,
  READ_ARRAYS,
  READ_BODY,
  READ_COMMAND,
  READ_ELEMENT,
  READ_FOLLOW,
  READ_KEYS,
  READ_PREFIX,
  READ_START,
  READ_SUBSCRIPTS,
  READ_TEST,
  REDIRECTIONS,
  RESERVED_WORDS,
  SEPARATOR_TOKENS,
  STRUCTURAL_TOKENS,
  UNARY_TESTS,
  WORD_BREAKS,
} from './constants.ts'

interface Token {
  readonly kind: string
  readonly text: string
  readonly start: number
  readonly end: number
  readonly plain: boolean
  readonly assign: boolean
}

interface Heredoc {
  readonly at: number
  readonly delimiter: string
  readonly strip: boolean
  readonly quoted: boolean
}

function token(
  kind: string,
  text: string,
  start: number,
  end: number,
  plain = false,
  assign = false,
): Token {
  return { kind, text, start, end, plain, assign }
}

/** An error bash reports while reading a line, in its own words: the lines
 * without a prefix, the status it refuses the line with, the text it names
 * (empty at the end of input), where that text sits, and whether the input
 * ended inside a construct. */
class Refusal extends Error {
  constructor(
    readonly lines: string[],
    public status: number,
    readonly offending: string,
    readonly start: number,
    readonly end: number,
    readonly eof: boolean,
  ) {
    super(lines.join('\n'))
    this.name = 'Refusal'
  }
}

/** A `[[ ]]` expression bash refuses, before the line naming where: its own
 * diagnostic lines, the token it stopped at, and whether the input ended
 * inside the expression. */
class TestFailure extends Error {
  constructor(
    readonly lines: string[],
    readonly token: Token,
    readonly eof = false,
  ) {
    super(lines.join('\n'))
    this.name = 'TestFailure'
  }
}

/**
 * Read a line as bash 5.2 does and report what it refuses. A lexer and a
 * recursive-descent grammar written from POSIX's shell grammar, bash's manual
 * and pinned bash behavior: they stop at the first token bash cannot take
 * where it stands and name it as bash does. Status 2 is a syntax error.
 * Status 1 is an array assignment bash cannot read; bash discards that line
 * and reads on from the next, where a later error's status wins. Status 127
 * is a command or process substitution whose body bash cannot parse. A line
 * nested deeper than the reader goes (`MAX_NESTING` constructs, or the host's
 * own stack) is refused, as bash refuses one nested past its reader.
 *
 * `aliases` are the names the shell would expand where a command starts; a
 * closing reserved word among them is a command there. `own` maps each alias
 * whose own text the line opens with to the span of the line that text
 * covers, inside which its name stays reserved. Returns what bash prints and
 * its status, or `null` when bash reads the line.
 */
export function checkSyntax(
  command: string,
  aliases: ReadonlySet<string> = new Set(),
  own: ReadonlyMap<string, readonly [number, number]> = new Map(),
): SyntaxDiagnostic | null {
  let found: Refusal[]
  try {
    found = new LineReader(command, aliases, own).refusals()
  } catch (err) {
    if (!(err instanceof RangeError)) throw err
    found = [new Refusal(['syntax error: nesting too deep'], 2, '', 0, 0, false)]
  }
  const first = found[0]
  const last = found.at(-1)
  if (first === undefined || last === undefined) return null
  const message = found
    .flatMap((refusal) => refusal.lines)
    .map((line) => `${mirageWording(line)}\n`)
    .join('')
  return {
    offending: first.offending,
    span: { start: first.start, end: first.end },
    message,
    status: last.status,
  }
}

/** The result of a line that cannot run: its diagnostic and status. */
export function syntaxErrorResult(found: SyntaxDiagnostic): IOResult {
  return new IOResult({ exitCode: found.status, stderr: encodeText(found.message) })
}

/**
 * A structural error the grammar left in a line bash reads. `checkSyntax`
 * judges the line; this catches the lines it accepts that the grammar still
 * cannot build a tree for, which mirage then has nothing to run for; it is
 * worded as an unexpected token, status 2. Parameter syntax is judged as the
 * word expands (a bad substitution), a `[` test's arguments by that builtin,
 * and a `$(...)` body as the line it runs as; the words of an associative
 * subscript may hold blanks, and the grammar recovers a quoted heredoc's last
 * line and a `for` header's `in` as errors of its own, and the `;` it misses
 * between a compound command and the reserved word closing around it
 * (`{ { a; } }`) as a missing token.
 */
export function findSyntaxIssue(node: TSNodeLike): SyntaxDiagnostic | null {
  if (node.type === 'expansion' || !node.hasError) return null
  if (node.type === 'command_substitution' && node.text.startsWith('$(')) return null
  if (node.type === 'test_command' && node.children[0]?.type === '[') return null
  let previous: TSNodeLike | null = null
  for (const child of node.children) {
    if (
      node.type === 'subscript' &&
      child.type === 'ERROR' &&
      child.children.length > 0 &&
      child.children.every((part) => part.type === 'word' && !part.hasError)
    )
      continue
    if (child.isMissing && child.type !== ';') return issue(child)
    if (
      child.type === 'ERROR' &&
      isStructuralError(child) &&
      !(node.type === 'for_statement' && child.text.trim() === 'in')
    ) {
      if (isRecoveredQuotedHeredocEnd(previous, child)) {
        previous = child
        continue
      }
      return issue(child)
    }
    if (child.type !== 'ERROR') {
      const nested = findSyntaxIssue(child)
      if (nested !== null) return nested
    }
    if (child.isNamed) previous = child
  }
  return null
}

function issue(node: TSNodeLike): SyntaxDiagnostic {
  const snippet = node.text.trim()
  return {
    offending: node.text,
    span: { start: node.startIndex ?? 0, end: node.endIndex ?? node.text.length },
    message:
      snippet.length > 0
        ? `mirage: syntax error near '${snippet}'\n`
        : 'mirage: syntax error in command\n',
    status: 2,
  }
}

/** Whether an ERROR node holds a token that structures a line. */
function isStructuralError(node: TSNodeLike): boolean {
  return node.children.some(
    (child) =>
      child.isNamed === true ||
      BASH_KEYWORDS.has(child.type) ||
      STRUCTURAL_TOKENS.has(child.type) ||
      SEPARATOR_TOKENS.has(child.type),
  )
}

function* walkNamed(node: TSNodeLike): Generator<TSNodeLike> {
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

/** Whether an ERROR is a quoted heredoc's last line the grammar missed. */
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
    )
      return true
  }
  return false
}

/** One of bash's diagnostic lines as mirage prints it. */
function mirageWording(line: string): string {
  for (const opener of ['syntax error near unexpected token `', 'syntax error near `']) {
    if (line.startsWith(opener) && line.endsWith("'"))
      return `mirage: syntax error near '${line.slice(opener.length, -1)}'`
  }
  return `mirage: ${line}`
}

function isName(text: string): boolean {
  if (text.length === 0 || !NAME_START.has(text.charAt(0))) return false
  for (const c of text) if (!NAME_CHARS.has(c)) return false
  return true
}

/** Whether a heredoc line's text after its delimiter holds an unquoted `)`:
 * inside a substitution, such a line ends the document there. */
function closesSubstitution(rest: string): boolean {
  let quote = ''
  let i = 0
  while (i < rest.length) {
    const c = rest.charAt(i)
    if (quote !== '') {
      if (c === '\\' && quote === '"') i += 1
      else if (c === quote) quote = ''
    } else if (c === "'" || c === '"') quote = c
    else if (c === '\\') i += 1
    else if (c === ')') return true
    i += 1
  }
  return false
}

/** How many expressions an arithmetic `for` header's `;` divide. */
function semicolons(body: string): number {
  let count = 0
  let depth = 0
  let quote = ''
  let i = 0
  while (i < body.length) {
    const c = body.charAt(i)
    if (quote !== '') {
      if (c === '\\' && quote !== "'") i += 1
      else if (c === quote) quote = ''
    } else if (c === "'" || c === '"' || c === '`') quote = c
    else if (c === '\\') i += 1
    else if (body.startsWith('${', i)) {
      const close = body.indexOf('}', i)
      i = close < 0 ? body.length : close
    } else if (c === '(') depth += 1
    else if (c === ')') depth -= 1
    else if (c === ';' && depth === 0) count += 1
    i += 1
  }
  return count
}

function testText(tok: Token): string {
  if (tok.kind === 'newline') return 'newline'
  if (tok.kind === 'eof') return 'EOF'
  return tok.text
}

function isTestClose(tok: Token): boolean {
  return tok.kind === 'word' && tok.plain && tok.text === ']]'
}

function trailingBackslashes(text: string): number {
  let count = 0
  while (count < text.length && text.charAt(text.length - 1 - count) === '\\') count += 1
  return count
}

type ReaderState = readonly [
  number,
  readonly [number, number, Token] | null,
  readonly Heredoc[],
  number,
  boolean,
]

/**
 * bash's reader over one line: a lexer whose modes the grammar sets. The line
 * is read as bash reads its input: a newline ends the input if none does, a
 * trailing backslash quotes the end of it, and each heredoc body is skipped
 * after the newline that ends its command. `frames` tracks the arrays and
 * substitutions being read, which decide the status of an error inside them.
 */
class LineReader {
  private readonly n: number
  private readonly quotedEnd: boolean
  private pos = 0
  private ended = false
  private limit: number | null = null
  private floor = 0
  private frames: string[] = []
  private heredocs: readonly Heredoc[] = []
  private carried = 0
  private peeked: readonly [number, number, Token] | null = null
  private after = false
  private matching = false
  private depth = 0
  private nesting = 0
  private braces = 0
  private readonly subs = new Map<string, readonly [number, readonly Heredoc[]]>()

  constructor(
    private readonly text: string,
    private readonly aliases: ReadonlySet<string>,
    private readonly own: ReadonlyMap<string, readonly [number, number]>,
  ) {
    this.n = text.length
    this.quotedEnd = trailingBackslashes(text) % 2 === 1
    this.reset(0)
  }

  reset(pos: number): void {
    this.pos = pos
    this.ended = this.quotedEnd || this.text.endsWith('\n')
    this.limit = null
    this.floor = 0
    this.frames = []
    this.heredocs = []
    this.carried = 0
    this.peeked = null
    this.after = false
    this.matching = false
    this.depth = 0
    this.nesting = 0
    this.braces = 0
  }

  /** Every error bash reports for the line, in order. An array bash cannot
   * read discards the rest of its line only, so the next line is read on; an
   * end of input inside a quote then leaves the status as it was. */
  refusals(): Refusal[] {
    const found: Refusal[] = []
    for (;;) {
      try {
        this.program()
        return found
      } catch (err) {
        if (!(err instanceof Refusal)) throw err
        const previous = found.at(-1)
        if (previous !== undefined && this.matching) err.status = previous.status
        found.push(err)
        if (err.status !== 1 || err.eof) return found
        const next = this.text.indexOf('\n', err.end)
        if (next < 0) return found
        this.reset(next + 1)
      }
    }
  }

  // -- refusals ----------------------------------------------------------

  /** The status of an error here: 1 inside an array (for the end of input,
   * inside any), else 127 inside a substitution, else 2. */
  status(eof: boolean): number {
    if (eof) return this.frames.includes('array') ? 1 : 2
    const frame = this.frames.at(-1)
    if (frame === undefined) return 2
    return frame === 'array' ? 1 : 127
  }

  refuse(lines: string[], eof: boolean, offending: string, start: number, end: number): never {
    throw new Refusal(lines, this.status(eof), offending, start, end, eof)
  }

  /** Refuse the line at a token bash cannot take where it stands. */
  failToken(tok: Token): never {
    if (tok.kind === 'eof') this.failEof()
    if (tok.kind === 'redirvar') {
      const [start, end] = this.nearSpan(tok.end + 1)
      const word = this.text.slice(start, end)
      this.refuse([`syntax error near \`${word}'`], false, word, start, end)
    }
    let text = tok.text
    if (tok.kind === 'newline') text = 'newline'
    else if (tok.kind === 'arith') text = tok.text.slice(2, -2)
    else if (this.quotedEnd && tok.end >= this.n && text.endsWith('\\')) text += '\\'
    this.refuse([`syntax error near unexpected token \`${text}'`], false, text, tok.start, tok.end)
  }

  /** Refuse a line that ends inside a quote or expansion, naming the
   * character bash was looking for. */
  failMatch(closer: string, at: number): never {
    this.matching = true
    this.refuse([`unexpected EOF while looking for matching \`${closer}'`], true, '', at, at)
  }

  failEof(): never {
    if (this.limit !== null) this.failNear(this.limit)
    this.refuse([this.eofLine()], true, '', this.n, this.n)
  }

  eofLine(): string {
    return this.frames.includes('sub')
      ? "unexpected EOF while looking for matching `)'"
      : 'syntax error: unexpected end of file'
  }

  /** Where the text bash quotes back from where its reader stopped lies:
   * back over blanks, then to a blank or past one of `;&|`. */
  nearSpan(at: number): [number, number] {
    const text = this.text
    let end = Math.min(at, this.n)
    while (end > this.floor && ' \t\n'.includes(text.charAt(end - 1))) end -= 1
    let start = end
    while (start > this.floor) {
      const c = text.charAt(start - 1)
      if (' \t\n'.includes(c)) break
      start -= 1
      if (NEAR_TEXT_STOPS.has(c)) break
    }
    return [start, end]
  }

  /** Refuse the line with bash's `syntax error near `X'`, the text quoted
   * back from `at`; with `eof`, the status is the end of input's (1 in an
   * array, else 2) rather than the token's. */
  failNear(at: number, eof = true): never {
    this.limit = null
    this.floor = 0
    const [start, end] = this.nearSpan(at)
    if (start === end) this.failEof()
    const word = this.text.slice(start, end)
    this.refuse([`syntax error near \`${word}'`], eof, word, start, end)
  }

  // -- quotes and expansions -------------------------------------------------

  singleQuote(i: number): number {
    const k = this.text.indexOf("'", i + 1)
    if (k < 0) this.failMatch("'", i)
    return k + 1
  }

  ansiQuote(i: number): number {
    const text = this.text
    let j = i + 1
    while (j < this.n) {
      const c = text.charAt(j)
      if (c === '\\') j += 2
      else if (c === "'") return j + 1
      else j += 1
    }
    this.failMatch("'", i)
  }

  doubleQuote(i: number): number {
    const text = this.text
    let j = i + 1
    while (j < this.n) {
      const c = text.charAt(j)
      if (c === '"') return j + 1
      if (c === '\\') j += 2
      else if (c === '`') j = this.backtick(j)
      else if (c === '$') j = this.dollar(j, true)
      else j += 1
    }
    this.failMatch('"', i)
  }

  /** Skip a backquoted substitution, whose body bash parses only when it
   * runs. */
  backtick(i: number): number {
    const text = this.text
    let j = i + 1
    while (j < this.n) {
      const c = text.charAt(j)
      if (c === '\\') j += 2
      else if (c === '`') return j + 1
      else j += 1
    }
    this.failMatch('`', i)
  }

  /** Skip what a `$` opens: a substitution (parsed), arithmetic, an
   * expansion or a quote. `$((` is arithmetic when its parentheses close as
   * `))`, else a substitution matched as text. Inside double quotes `$'` and
   * `$"` open nothing. */
  dollar(i: number, quoted: boolean): number {
    const text = this.text
    const at = this.joined(i + 1)
    const next = text.charAt(at)
    if (next === '$') return at + 1
    if (next === '(') {
      const inner = this.joined(at + 1)
      if (text.charAt(inner) === '(') {
        const end = this.matched(inner + 1, i)
        if (text.charAt(end + 1) === ')') return end + 2
        return this.matched(at + 1, i) + 1
      }
      return this.substitution(i, at + 1)
    }
    if (next === '{') return this.brace(at + 1, i)
    if (next === '[') return this.matched(at + 1, i, '[', ']') + 1
    if (!quoted && next === "'") return this.ansiQuote(at)
    if (!quoted && next === '"') return this.doubleQuote(at)
    return i + 1
  }

  wordChar(j: number): number {
    const c = this.text.charAt(j)
    if (c === '\\') return j + 2
    if (c === "'") return this.singleQuote(j)
    if (c === '"') return this.doubleQuote(j)
    if (c === '`') return this.backtick(j)
    if (c === '$') return this.dollar(j, false)
    return j + 1
  }

  /** Skip `<(` or `>(`: parsed, unless `((` follows, which bash matches as
   * text. */
  processSubstitution(i: number): number {
    const at = this.joined(i + 1)
    if (this.charAt(at + 1) === '(') return this.matched(at + 1, i) + 1
    return this.substitution(i, at + 1)
  }

  /** Skip an expansion's `${...}`: the first unquoted `}` closes it. */
  brace(j: number, opened: number): number {
    const text = this.text
    while (j < this.n) {
      const c = text.charAt(j)
      if (c === '}') return j + 1
      if ((c === '<' || c === '>') && this.charAt(j + 1) === '(') {
        j = this.processSubstitution(j)
        continue
      }
      j = this.wordChar(j)
    }
    this.failMatch('}', opened)
  }

  /** Skip a subscript up to its `]`, nested brackets and blanks included. */
  bracket(j: number, opened: number): number {
    const text = this.text
    let depth = 1
    while (j < this.n) {
      const c = text.charAt(j)
      if (c === '[') depth += 1
      else if (c === ']') {
        depth -= 1
        if (depth === 0) return j + 1
      }
      j = this.wordChar(j)
    }
    this.failMatch(']', opened)
  }

  /** The index of the closer matching an opener, read as text: quotes and a
   * `$(` substitution are skipped, any other expansion is text. */
  matched(j: number, opened: number, left = '(', right = ')'): number {
    const text = this.text
    let depth = 1
    while (j < this.n) {
      const c = text.charAt(j)
      if (c === right) {
        depth -= 1
        if (depth === 0) return j
        j += 1
      } else if (c === left) {
        depth += 1
        j += 1
      } else if (c === '\\') j += 2
      else if (c === "'") j = this.singleQuote(j)
      else if (c === '"') j = this.doubleQuote(j)
      else if (c === '`') j = this.backtick(j)
      else if (c === '$' && this.charAt(j + 1) === '(') j = this.dollar(j, false)
      else j += 1
    }
    this.failMatch(right, opened)
  }

  // -- nested reads ------------------------------------------------------------

  save(): ReaderState {
    return [this.pos, this.peeked, this.heredocs, this.carried, this.after]
  }

  restore(state: ReaderState): void {
    ;[this.pos, this.peeked, this.heredocs, this.carried, this.after] = state
  }

  /** Parse a substitution's command list, opened at `opened` and starting at
   * `j`; the index past its `)`. Heredocs opened inside and still pending at
   * its `)` read their bodies after the line's next newline. A body read once
   * is not read again when its word is. */
  substitution(opened: number, j: number): number {
    const key = `${String(j)}:${String(this.limit)}`
    const known = this.subs.get(key)
    if (known !== undefined) {
      this.pend(known[1], true)
      return known[0]
    }
    if (this.nesting >= MAX_NESTING)
      this.failToken(token('op', this.text.slice(opened, j).replaceAll('\\\n', ''), opened, j))
    const state = this.save()
    this.pos = j
    this.peeked = null
    this.heredocs = []
    this.carried = 0
    this.frames.push('sub')
    this.nesting += 1
    this.linebreak()
    let tok: Token
    for (;;) {
      tok = this.peek(READ_COMMAND)
      if (tok.kind === 'op' && tok.text === ')') break
      if (tok.kind === 'eof') this.refuse([this.eofLine()], true, '', j, j)
      this.andOr()
      tok = this.peekAfter()
      if (tok.kind === 'op' && (tok.text === ';' || tok.text === '&')) {
        this.take(tok)
        this.linebreak()
      } else if (tok.kind === 'newline') this.linebreak()
      else if (tok.kind === 'op' && tok.text === ')') break
      else this.failToken(tok)
    }
    this.nesting -= 1
    this.frames.pop()
    const pending = this.heredocs
    this.restore(state)
    this.pend(pending, true)
    this.subs.set(key, [tok.end, pending])
    return tok.end
  }

  /** Read an array assignment's words; the index past its `)`. Only words
   * and newlines may stand inside: any other token is the error, status 1. A
   * newline inside reads the heredoc bodies pending there, which bash reads
   * again after the array; heredocs opened inside and pending at its `)` read
   * theirs after it.
   * `mode` is the assignment's `READ_*` flags: with `READ_BODY` the array
   * stands where a function body must, so a reserved word inside is one;
   * with `READ_KEYS` an element's `name[` reads a subscript. */
  array(i: number, mode: number): number {
    const state = this.save()
    this.pos = i + 1
    this.peeked = null
    this.frames.push('array')
    const element = READ_ELEMENT | ((mode & READ_KEYS) !== 0 ? READ_SUBSCRIPTS : 0)
    let tok: Token
    for (;;) {
      tok = this.peek(element)
      if (
        (mode & READ_BODY) !== 0 &&
        tok.kind === 'word' &&
        tok.plain &&
        RESERVED_WORDS.has(tok.text)
      )
        this.failToken(tok)
      if (tok.kind === 'newline' || tok.kind === 'word') {
        this.take(tok)
        continue
      }
      if (tok.kind === 'op' && tok.text === ')') break
      if (tok.kind === 'eof') this.failMatch(')', i)
      this.failToken(tok)
    }
    this.frames.pop()
    const opened = this.heredocs.filter((heredoc) => heredoc.at > i)
    this.restore(state)
    this.pend(opened, true)
    return tok.end
  }

  // -- tokens --------------------------------------------------------------------

  blankEnd(i: number): number {
    const text = this.text
    while (i < this.n) {
      const c = text.charAt(i)
      if (c === ' ' || c === '\t') i += 1
      else if (text.startsWith('\\\n', i)) i += 2
      else break
    }
    return i
  }

  /** The operator at `i`, continued lines joined, and its end. */
  operator(i: number): [string, number] | null {
    const text = this.text
    let spelled = ''
    const ends: number[] = []
    let j = i
    while (spelled.length < 3 && j < this.n) {
      if (text.startsWith('\\\n', j)) {
        j += 2
        continue
      }
      const c = text.charAt(j)
      if (!OPERATOR_CHARS.has(c)) break
      spelled += c
      j += 1
      ends.push(j)
    }
    for (const op of OPERATORS) {
      const end = ends[op.length - 1]
      if (spelled.startsWith(op) && end !== undefined) return [op, end]
    }
    return null
  }

  /** The next token, read in `mode` (the `READ_*` flags), without taking it. */
  peek(mode = 0): Token {
    const peeked = this.peeked
    if (peeked !== null && peeked[0] === this.pos && peeked[1] === mode) return peeked[2]
    const tok = this.lex(this.pos, mode)
    this.peeked = [this.pos, mode, tok]
    return tok
  }

  /** The token after a command. After a compound one it is read as where a
   * command starts: reserved words, arrays and arithmetic. */
  peekAfter(): Token {
    return this.peek(this.after ? READ_FOLLOW : 0)
  }

  take(tok: Token): void {
    this.peeked = null
    this.pos = tok.end
    if (tok.kind === 'newline') {
      if (tok.start === tok.end) this.ended = true
      else if (this.heredocs.length > 0) this.pos = this.heredocBodies(tok.end)
    }
  }

  /** Skip the bodies of the heredocs pending at a newline. A body ends at the
   * line equal to its delimiter, leading tabs stripped for `<<-`, and
   * continued lines joined unless the delimiter was quoted. Inside a
   * substitution a line that opens with the delimiter and has an unquoted `)`
   * after it ends the body there too. */
  heredocBodies(i: number): number {
    const text = this.text
    const n = this.n
    const nested = this.frames.includes('sub')
    for (const { delimiter, strip, quoted } of this.heredocs) {
      while (i < n) {
        let end = text.indexOf('\n', i)
        if (end < 0) end = n
        let line = text.slice(i, end)
        while (!quoted && end < n && trailingBackslashes(line) % 2 === 1) {
          let next = text.indexOf('\n', end + 1)
          if (next < 0) next = n
          line = line.slice(0, -1) + text.slice(end + 1, next)
          end = next
        }
        const body = strip ? line.replace(/^\t+/, '') : line
        if (body === delimiter) {
          i = Math.min(end + 1, n)
          break
        }
        if (
          nested &&
          body.startsWith(delimiter) &&
          closesSubstitution(body.slice(delimiter.length))
        ) {
          this.heredocs = []
          this.carried = 0
          return i + line.length - body.length + delimiter.length
        }
        i = Math.min(end + 1, n)
      }
    }
    this.heredocs = []
    this.carried = 0
    return i
  }

  /** Add heredocs whose bodies the next newline reads, each once: a word read
   * again in another mode opens the same ones again. bash reads the ones
   * `carried` out of a substitution first, in the order their substitutions
   * close, then the ones opened directly. */
  pend(heredocs: readonly Heredoc[], carried = false): void {
    const known = new Set(this.heredocs.map((heredoc) => heredoc.at))
    const added = heredocs.filter((heredoc) => !known.has(heredoc.at))
    if (!carried) {
      this.heredocs = [...this.heredocs, ...added]
      return
    }
    const at = this.carried
    this.heredocs = [...this.heredocs.slice(0, at), ...added, ...this.heredocs.slice(at)]
    this.carried += added.length
  }

  /** Where the next character is once continued lines are joined, as bash
   * joins them before it reads one. */
  joined(i: number): number {
    while (this.text.startsWith('\\\n', i)) i += 2
    return i
  }

  /** The character at `i` once continued lines are joined, or `''` at the
   * end of the line. */
  charAt(i: number): string {
    return this.text.charAt(this.joined(i))
  }

  /** Read the token at `i` in `mode`. */
  lex(i: number, mode: number): Token {
    const text = this.text
    const n = this.n
    for (;;) {
      i = this.blankEnd(i)
      if (i < n && text.charAt(i) === '#') {
        const end = text.indexOf('\n', i)
        i = end < 0 ? n : end
        continue
      }
      break
    }
    if (this.limit !== null && i >= this.limit) return token('eof', '', i, i)
    if (i >= n) {
      if (this.ended) return token('eof', '', n, n)
      return token('newline', '\n', n, n)
    }
    const c = text.charAt(i)
    if (c === '\n') return token('newline', '\n', i, i + 1)
    if ((mode & READ_ARITH) !== 0 && text.startsWith('((', i))
      return this.arithCommand(i, (mode & READ_START) !== 0)
    if ((c === '<' || c === '>') && this.charAt(i + 1) === '(') return this.word(i, 0)
    const op = this.operator(i)
    if (op !== null) return token('op', op[0], i, op[1])
    if (c === '{' && (mode & READ_TEST) === 0) {
      const close = text.indexOf('}', i)
      const after = text.charAt(close + 1)
      if (
        close > i &&
        isName(text.slice(i + 1, close)) &&
        (after === '<' || after === '>') &&
        text.charAt(close + 2) !== '('
      )
        return token('redirvar', text.slice(i, close + 1), i, close + 1)
    }
    if (c >= '0' && c <= '9' && (mode & READ_TEST) === 0) {
      let j = i
      while (j < n && text.charAt(j) >= '0' && text.charAt(j) <= '9') j += 1
      const after = text.charAt(j)
      if ((after === '<' || after === '>') && text.charAt(j + 1) !== '(')
        return token('number', text.slice(i, j), i, j)
    }
    return this.word(i, mode)
  }

  /** Read a word, and the assignment or array it may open. */
  word(i: number, mode: number): Token {
    const text = this.text
    const start = i
    let plain = true
    let state = (mode & READ_PREFIX) !== 0 ? 'start' : 'none'
    let assign = false
    if ((mode & READ_ELEMENT) !== 0 && text.charAt(i) === '[') {
      i = this.bracket(i + 1, i)
      plain = false
    }
    while (i < this.n) {
      if (this.limit !== null && i >= this.limit) break
      const c = text.charAt(i)
      if (c === '\\') {
        if (text.charAt(i + 1) === '\n') {
          i += 2
          continue
        }
        plain = false
        state = 'none'
        i += 2
        continue
      }
      if (WORD_BREAKS.has(c)) {
        if ((c === '<' || c === '>') && this.charAt(i + 1) === '(') {
          i = this.processSubstitution(i)
          plain = false
          state = 'none'
          continue
        }
        break
      }
      const equals = c === '=' || (c === '+' && this.charAt(i + 1) === '=')
      if (state === 'start' || state === 'name') {
        if (NAME_START.has(c) || (state === 'name' && NAME_CHARS.has(c))) state = 'name'
        else if (state === 'name' && c === '[') {
          const end = (mode & READ_SUBSCRIPTS) !== 0 ? this.bracket(i + 1, i) : this.subscriptEnd(i)
          if (end !== null) {
            i = end
            state = 'subscript'
            plain = false
            continue
          }
          state = 'none'
        } else if (state === 'name' && equals) state = 'equals'
        else state = 'none'
      } else if (state === 'subscript') state = equals ? 'equals' : 'none'
      if (state === 'equals') {
        assign = true
        state = 'none'
        i = (c === '=' ? i : this.joined(i + 1)) + 1
        const opener = this.joined(i)
        if ((mode & READ_ARRAYS) !== 0 && text.charAt(opener) === '(') {
          i = this.array(opener, mode)
          plain = false
        }
        continue
      }
      if (c === "'" || c === '"' || c === '`' || c === '$') {
        plain = false
        state = 'none'
      }
      i = this.wordChar(i)
    }
    return token('word', text.slice(start, i).replaceAll('\\\n', ''), start, i, plain, assign)
  }

  /** Where a subscript in an argument closes, if it does before the word
   * ends: only a prefix's subscript may hold blanks. */
  subscriptEnd(i: number): number | null {
    const text = this.text
    for (let j = i + 1; j < this.n && !WORD_BREAKS.has(text.charAt(j)); j += 1)
      if (text.charAt(j) === ']') return j + 1
    return null
  }

  /** Read `((` as arithmetic, or as the `(` of a subshell when it does not
   * close as `))`. Where a command starts, arithmetic that does not close on
   * its line is read again as two subshells up to that point, and running
   * out there is bash's `syntax error near `X'`. */
  arithCommand(i: number, start: boolean): Token {
    const text = this.text
    const end = this.matched(i + 2, i)
    if (text.charAt(end + 1) === ')') return token('arith', text.slice(i, end + 2), i, end + 2)
    if (start && (end + 1 >= this.n || text.charAt(end + 1) === '\n')) {
      if (this.nesting >= MAX_NESTING) this.failToken(token('op', '(', i, i + 1))
      this.nesting += 1
      const state = this.save()
      const outer: [number | null, number] = [this.limit, this.floor]
      this.limit = end + 1
      this.floor = i + 1
      this.pos = i + 1
      this.peeked = null
      try {
        this.compoundList(new Set(), new Set([')']))
      } finally {
        ;[this.limit, this.floor] = outer
        this.restore(state)
      }
      this.failNear(end + 1)
    }
    return token('op', '(', i, i + 1)
  }

  // -- grammar -------------------------------------------------------------------

  /** The reserved word a token is where a command starts, if any. A closing
   * word an alias spells is a command, except inside that alias's own text
   * and inside a substitution. */
  keyword(tok: Token): string | null {
    if (tok.kind !== 'word' || !tok.plain || !RESERVED_WORDS.has(tok.text)) return null
    if (CLOSING_WORDS.has(tok.text) && this.aliases.has(tok.text) && !this.frames.includes('sub')) {
      const span = this.own.get(tok.text)
      if (span === undefined || !(span[0] <= tok.start && tok.start < span[1])) return null
    }
    return tok.text
  }

  linebreak(): void {
    for (let tok = this.peek(); tok.kind === 'newline'; tok = this.peek()) this.take(tok)
  }

  program(): void {
    this.linebreak()
    for (;;) {
      let tok = this.peek(READ_COMMAND)
      if (tok.kind === 'eof') return
      this.andOr()
      tok = this.peekAfter()
      if (tok.kind === 'op' && (tok.text === ';' || tok.text === '&')) {
        this.take(tok)
        this.linebreak()
      } else if (tok.kind === 'newline') this.linebreak()
      else if (tok.kind !== 'eof') this.failToken(tok)
    }
  }

  stops(tok: Token, words: ReadonlySet<string>, ops: ReadonlySet<string>): boolean {
    if (tok.kind === 'op') return ops.has(tok.text)
    const word = this.keyword(tok)
    return word !== null && words.has(word)
  }

  /** Parse commands up to one of the reserved `words` or `ops` that end the
   * list; return it. With `empty` the list may hold no command (a case
   * item). */
  compoundList(words: ReadonlySet<string>, ops: ReadonlySet<string>, empty = false): Token {
    this.linebreak()
    let seen = false
    for (;;) {
      let tok = this.peek(READ_COMMAND)
      if (this.stops(tok, words, ops)) {
        if (!seen && !empty) this.failToken(tok)
        return tok
      }
      if (tok.kind === 'eof') this.failEof()
      this.andOr()
      seen = true
      tok = this.peekAfter()
      if (tok.kind === 'op' && (tok.text === ';' || tok.text === '&')) {
        this.take(tok)
        this.linebreak()
      } else if (tok.kind === 'newline') this.linebreak()
      else if (!this.stops(tok, words, ops)) this.failToken(tok)
    }
  }

  andOr(): void {
    this.pipeline()
    for (
      let tok = this.peekAfter();
      tok.kind === 'op' && (tok.text === '&&' || tok.text === '||');
      tok = this.peekAfter()
    ) {
      this.take(tok)
      this.linebreak()
      this.pipeline()
    }
  }

  /** Parse a pipeline. `time` and `!` may lead it, with nothing after them
   * before `;` or a newline; `time` takes an unquoted `-p` and then `--`.
   * After a `|` neither is a prefix (`time` is a command there, `!` an
   * error). */
  pipeline(): void {
    let prefixed = false
    for (;;) {
      const tok = this.peek(READ_COMMAND)
      const word = this.keyword(tok)
      if (word === 'time') {
        this.take(tok)
        for (const option of ['-p', '--']) {
          const next = this.peek()
          if (next.kind === 'word' && next.plain && next.text === option) this.take(next)
        }
      } else if (word === '!') this.take(tok)
      else break
      prefixed = true
    }
    if (prefixed) {
      const tok = this.peek(READ_COMMAND)
      if (tok.kind === 'newline' || tok.kind === 'eof' || (tok.kind === 'op' && tok.text === ';')) {
        this.after = false
        return
      }
    }
    this.command(false)
    for (
      let tok = this.peekAfter();
      tok.kind === 'op' && (tok.text === '|' || tok.text === '|&');
      tok = this.peekAfter()
    ) {
      this.take(tok)
      this.linebreak()
      this.command(true)
    }
  }

  /** Parse one command where a command starts; `piped` after a `|`, where
   * `time` is a command. */
  command(piped: boolean): void {
    const tok = this.peek(READ_COMMAND)
    let word = this.keyword(tok)
    if (piped && word === 'time') word = null
    if (word !== null) {
      if (!COMPOUND_OPENERS.has(word) && word !== 'function' && word !== 'coproc')
        this.failToken(tok)
      this.compound(tok)
      this.redirects()
      return
    }
    if (tok.kind === 'arith' || (tok.kind === 'op' && tok.text === '(')) {
      this.compound(tok)
      this.redirects()
      return
    }
    if (
      tok.kind === 'word' ||
      tok.kind === 'number' ||
      tok.kind === 'redirvar' ||
      (tok.kind === 'op' && REDIRECTIONS.has(tok.text))
    ) {
      this.simple()
      return
    }
    this.failToken(tok)
  }

  /** Parse a compound command, a function definition or a coproc; one nested
   * `MAX_NESTING` deep is refused at its opener. */
  compound(tok: Token): void {
    if (this.nesting >= MAX_NESTING) this.failToken(tok)
    this.nesting += 1
    const word = this.keyword(tok)
    if (tok.kind === 'arith') this.take(tok)
    else if (tok.kind === 'op' && tok.text === '(') {
      this.take(tok)
      this.take(this.compoundList(new Set(), new Set([')'])))
    } else if (word === '{') {
      this.take(tok)
      this.braces += 1
      this.take(this.compoundList(new Set(['}']), new Set()))
      this.braces -= 1
    } else if (word === 'if') this.ifClause(tok)
    else if (word === 'while' || word === 'until') {
      this.take(tok)
      this.take(this.compoundList(new Set(['do']), new Set()))
      this.take(this.compoundList(new Set(['done']), new Set()))
    } else if (word === 'for' || word === 'select') this.forClause(tok)
    else if (word === 'case') this.caseClause(tok)
    else if (word === '[[') this.conditional(tok)
    else if (word === 'function') this.function(tok)
    else if (word === 'coproc') this.coproc(tok)
    else this.failToken(tok)
    this.nesting -= 1
    if (word !== 'function' && word !== 'coproc') this.after = true
  }

  redirects(): void {
    for (;;) {
      const tok = this.peekAfter()
      if (
        tok.kind === 'number' ||
        tok.kind === 'redirvar' ||
        (tok.kind === 'op' && REDIRECTIONS.has(tok.text))
      ) {
        this.redirect(tok)
        this.after = false
      } else return
    }
  }

  /** Parse a redirection: its descriptor or operator, then its target word. */
  redirect(tok: Token): void {
    if (tok.kind === 'number' || tok.kind === 'redirvar') {
      this.take(tok)
      tok = this.peek()
    }
    this.take(tok)
    let target = this.peek()
    if (target.kind === 'number' && (tok.text === '<&' || tok.text === '>&'))
      target = { ...target, kind: 'word' }
    if (target.kind !== 'word') this.failToken(target)
    this.take(target)
    if (tok.text === '<<' || tok.text === '<<-') {
      const word = this.text.slice(target.start, target.end)
      this.pend([
        {
          at: tok.start,
          delimiter: cleanDelimiter(word),
          strip: tok.text === '<<-',
          quoted: delimiterQuoted(word),
        },
      ])
    }
  }

  /** Parse a simple command, or a function definition `name ()`.
   * Assignments and redirections may lead it. An array stays an array through
   * them until a redirection follows an assignment, and the first one after a
   * redirection reads its elements' subscripts; the arguments of `declare`
   * and its kin read arrays too, until a redirection. */
  simple(): void {
    this.after = false
    let mode = READ_PREFIX
    let assigned = false
    let prefixed = false
    let tok: Token
    for (;;) {
      tok = this.peek(mode)
      if (
        tok.kind === 'number' ||
        tok.kind === 'redirvar' ||
        (tok.kind === 'op' && REDIRECTIONS.has(tok.text))
      ) {
        this.redirect(tok)
        mode = assigned ? 0 : READ_PREFIX | READ_KEYS
        prefixed = true
      } else if (tok.kind === 'word' && tok.assign) {
        this.take(tok)
        mode &= ~READ_KEYS
        assigned = true
        prefixed = true
      } else break
    }
    if (tok.kind === 'word') {
      this.take(tok)
      if (!prefixed) {
        const next = this.peek()
        if (next.kind === 'op' && next.text === '(') {
          this.take(next)
          const close = this.peek(READ_FOLLOW)
          if (!(close.kind === 'op' && close.text === ')')) this.failToken(close)
          this.take(close)
          this.linebreak()
          this.functionBody()
          return
        }
      }
      mode = tok.plain && ARRAY_BUILTINS.has(tok.text) ? READ_ARRAYS : 0
      for (;;) {
        tok = this.peek(mode)
        if (tok.kind === 'word') this.take(tok)
        else if (
          tok.kind === 'number' ||
          tok.kind === 'redirvar' ||
          (tok.kind === 'op' && REDIRECTIONS.has(tok.text))
        ) {
          this.redirect(tok)
          mode = 0
        } else break
      }
    }
    if (tok.kind === 'op' && tok.text === '(') this.failToken(tok)
  }

  functionBody(): void {
    const tok = this.peek(READ_COMMAND | READ_BODY)
    const word = this.keyword(tok)
    if (
      (word !== null && COMPOUND_OPENERS.has(word)) ||
      tok.kind === 'arith' ||
      (tok.kind === 'op' && tok.text === '(')
    ) {
      this.compound(tok)
      this.redirects()
      return
    }
    this.failToken(tok)
  }

  /** Parse `function NAME [()] body`; a `(` not followed by `)` opens a
   * subshell body. */
  function(tok: Token): void {
    this.take(tok)
    const name = this.peek()
    if (name.kind !== 'word') this.failToken(name)
    this.take(name)
    const open = this.peek()
    if (open.kind === 'op' && open.text === '(') {
      const state = this.save()
      this.take(open)
      const close = this.peek()
      if (close.kind === 'op' && close.text === ')') this.take(close)
      else this.restore(state)
    }
    this.linebreak()
    this.functionBody()
  }

  /** Parse `coproc [NAME] command`: a name only before a compound command,
   * and `time` is a command here. */
  coproc(tok: Token): void {
    this.take(tok)
    tok = this.peek(READ_COMMAND)
    let word = this.keyword(tok)
    if (word === 'time') word = null
    if (word !== null || tok.kind === 'arith' || (tok.kind === 'op' && tok.text === '(')) {
      if (word !== null && !COMPOUND_OPENERS.has(word)) this.failToken(tok)
      this.compound(tok)
      return
    }
    if (tok.kind === 'word' && !tok.assign) {
      const state = this.save()
      this.take(tok)
      const next = this.peek(READ_COMMAND)
      let after = this.keyword(next)
      if (after === 'time') after = null
      if (after !== null || next.kind === 'arith' || (next.kind === 'op' && next.text === '(')) {
        if (after !== null && !COMPOUND_OPENERS.has(after)) this.failToken(next)
        this.compound(next)
        return
      }
      this.restore(state)
    }
    if (
      tok.kind === 'word' ||
      tok.kind === 'number' ||
      (tok.kind === 'op' && REDIRECTIONS.has(tok.text))
    ) {
      this.simple()
      return
    }
    this.failToken(tok)
  }

  ifClause(tok: Token): void {
    const none: ReadonlySet<string> = new Set()
    this.take(tok)
    this.take(this.compoundList(new Set(['then']), none))
    let end = this.compoundList(new Set(['elif', 'else', 'fi']), none)
    while (end.text === 'elif') {
      this.take(end)
      this.take(this.compoundList(new Set(['then']), none))
      end = this.compoundList(new Set(['elif', 'else', 'fi']), none)
    }
    if (end.text === 'else') {
      this.take(end)
      end = this.compoundList(new Set(['fi']), none)
    }
    this.take(end)
  }

  /** Parse a loop's `do ... done`, or `{ ... }` when `brace`. After a `;` or
   * newline (`separated`) the body's place reads arrays and arithmetic. */
  loopBody(brace: boolean, separated: boolean): void {
    const tok = this.peek(separated ? READ_FOLLOW : 0)
    const word = this.keyword(tok)
    if (word === 'do') {
      this.take(tok)
      this.take(this.compoundList(new Set(['done']), new Set()))
    } else if (word === '{' && brace) {
      this.take(tok)
      this.take(this.compoundList(new Set(['}']), new Set()))
    } else this.failToken(tok)
  }

  /** Parse `for`/`select NAME [in WORDS ;] body`, or an arithmetic `for`; a
   * brace body needs a separator before it, and a `;` after the name cannot
   * follow a newline. */
  forClause(tok: Token): void {
    const arith = tok.text === 'for'
    this.take(tok)
    const start = this.blankEnd(this.pos)
    if (arith && this.text.startsWith('((', start)) {
      this.arithFor(start)
      return
    }
    const name = this.peek()
    if (name.kind !== 'word') this.failToken(name)
    this.take(name)
    let separated = this.peek().kind === 'newline'
    this.linebreak()
    let next = this.peek()
    if (this.keyword(next) === 'in') {
      this.take(next)
      for (next = this.peek(); next.kind === 'word'; next = this.peek()) this.take(next)
      if (next.kind === 'op' && next.text === ';') this.take(next)
      else if (next.kind !== 'newline') this.failToken(next)
      this.linebreak()
      separated = true
    } else if (!separated && next.kind === 'op' && next.text === ';') {
      this.take(next)
      this.linebreak()
      separated = true
    }
    this.loopBody(separated, separated)
  }

  /** Parse `for ((init; test; step))` and its body; its three expressions
   * are counted once the body is read, as bash does. */
  arithFor(i: number): void {
    const text = this.text
    const end = this.matched(i + 2, i)
    if (text.charAt(end + 1) !== ')') {
      if (end + 1 >= this.n || text.charAt(end + 1) === '\n') this.failNear(end + 1, false)
      this.failNear(end + 3, false)
    }
    this.pos = end + 2
    this.peeked = null
    const tok = this.peek()
    const separated = tok.kind === 'newline' || (tok.kind === 'op' && tok.text === ';')
    if (tok.kind === 'op' && tok.text === ';') this.take(tok)
    this.linebreak()
    this.loopBody(true, separated)
    const parts = semicolons(text.slice(i + 2, end))
    if (parts !== 2) {
      const first = parts < 2 ? 'arithmetic expression required' : "`;' unexpected"
      const whole = text.slice(i, end + 2)
      this.refuse([`syntax error: ${first}`, `syntax error: \`${whole}'`], false, whole, i, end + 2)
    }
  }

  /** Parse `case WORD in [(]PATTERN[|PATTERN]...) LIST ;; ... esac`. Inside a
   * brace group a `}` where a pattern word starts closes the group, as bash
   * reads it, but for the word right after `in` on its line. */
  caseClause(tok: Token): void {
    this.take(tok)
    const subject = this.peek()
    if (subject.kind !== 'word') this.failToken(subject)
    this.take(subject)
    this.linebreak()
    const word = this.peek()
    if (this.keyword(word) !== 'in') this.failToken(word)
    this.take(word)
    let afterIn = this.peek().kind !== 'newline'
    this.linebreak()
    for (;;) {
      let next = this.peek()
      if (this.keyword(next) === 'esac') {
        this.take(next)
        return
      }
      if (next.kind === 'op' && next.text === '(') {
        this.take(next)
        next = this.peek()
        afterIn = false
      }
      for (;;) {
        if (
          next.kind !== 'word' ||
          (this.braces > 0 && !afterIn && next.plain && next.text === '}')
        )
          this.failToken(next)
        afterIn = false
        this.take(next)
        next = this.peek()
        if (next.kind === 'op' && next.text === ')') {
          this.take(next)
          break
        }
        if (!(next.kind === 'op' && next.text === '|')) this.failToken(next)
        this.take(next)
        next = this.peek()
      }
      const end = this.compoundList(new Set(['esac']), CASE_TERMINATORS, true)
      this.take(end)
      if (end.kind !== 'op') return
      this.linebreak()
    }
  }

  // -- [[ ... ]] -----------------------------------------------------------------

  /** Parse `[[ ... ]]`, whose errors bash words in their own family: its own
   * lines, then the text it stopped at or the end of input. */
  conditional(tok: Token): void {
    this.take(tok)
    const outer = this.depth
    this.depth = 0
    try {
      this.testOr()
      this.testClose()
    } catch (err) {
      if (!(err instanceof TestFailure)) throw err
      const lines = [...err.lines]
      if (err.eof) {
        lines.push(this.eofLine())
        this.refuse(lines, true, '', this.n, this.n)
      }
      const stop = err.token
      const [start, end] = this.nearSpan(stop.end + (stop.kind === 'newline' ? 0 : 1))
      const word = this.text.slice(start, end)
      lines.push(`syntax error near \`${word}'`)
      this.refuse(lines, false, word, start, end)
    } finally {
      this.depth = outer
    }
  }

  testPeek(): Token {
    this.linebreak()
    return this.peek(READ_TEST)
  }

  testWord(): Token {
    return this.peek(READ_TEST)
  }

  /** The token after a whole test; ending inside a quote there, bash adds
   * that it was looking for `]]`. */
  testAfter(): Token {
    try {
      return this.testPeek()
    } catch (err) {
      if (err instanceof Refusal && err.eof && this.depth === 0)
        err.lines.push("unexpected EOF while looking for `]]'")
      throw err
    }
  }

  testClose(): void {
    const tok = this.testAfter()
    if (isTestClose(tok)) {
      this.take(tok)
      return
    }
    if (tok.kind === 'eof')
      throw new TestFailure(["unexpected EOF while looking for `]]'"], tok, true)
    if (tok.kind === 'word') throw new TestFailure(['syntax error in conditional expression'], tok)
    throw new TestFailure(
      [`syntax error in conditional expression: unexpected token \`${testText(tok)}'`],
      tok,
    )
  }

  testOr(): void {
    this.testAnd()
    for (
      let tok = this.testAfter();
      tok.kind === 'op' && tok.text === '||';
      tok = this.testAfter()
    ) {
      this.take(tok)
      this.testAnd()
    }
  }

  testAnd(): void {
    this.testTerm()
    for (
      let tok = this.testAfter();
      tok.kind === 'op' && tok.text === '&&';
      tok = this.testAfter()
    ) {
      this.take(tok)
      this.testTerm()
    }
  }

  /** Parse one test: `! TEST`, `( EXPR )`, `OP WORD`, `WORD OP WORD` or
   * `WORD`. */
  testTerm(): void {
    const tok = this.testPeek()
    if (tok.kind === 'eof')
      throw new TestFailure(["unexpected token `EOF' in conditional command"], tok, true)
    if (isTestClose(tok)) throw new TestFailure([], tok)
    if (tok.kind === 'word' && tok.plain && tok.text === '!') {
      this.take(tok)
      this.testTerm()
      return
    }
    if (tok.kind === 'op' && tok.text === '(') {
      this.testGroup(tok)
      return
    }
    if (tok.kind !== 'word')
      throw new TestFailure([`unexpected token \`${testText(tok)}' in conditional command`], tok)
    if (tok.plain && UNARY_TESTS.has(tok.text)) {
      this.take(tok)
      const arg = this.testOperand('unary', () => this.testWord())
      if (arg.kind !== 'word' || isTestClose(arg))
        throw new TestFailure(
          [`unexpected argument \`${testText(arg)}' to conditional unary operator`],
          arg,
        )
      this.take(arg)
      return
    }
    this.take(tok)
    let op: Token
    try {
      op = this.peek(READ_TEST)
    } catch (err) {
      if (err instanceof Refusal && err.eof) err.lines.push('conditional binary operator expected')
      throw err
    }
    if (
      (op.kind === 'word' && op.plain && BINARY_TESTS.has(op.text)) ||
      (op.kind === 'op' && (op.text === '<' || op.text === '>'))
    ) {
      this.take(op)
      let reader = (): Token => this.testWord()
      if (op.text === '=~') reader = () => this.regexWord()
      else if (op.text === '==' || op.text === '=' || op.text === '!=')
        reader = () => this.patternWord()
      const arg = this.testOperand('binary', reader)
      if (arg.kind !== 'word' || isTestClose(arg))
        throw new TestFailure(
          [`unexpected argument \`${testText(arg)}' to conditional binary operator`],
          arg,
        )
      this.take(arg)
      return
    }
    if (
      (op.kind === 'op' && (op.text === '&&' || op.text === '||' || op.text === ')')) ||
      isTestClose(op)
    )
      return
    if (op.kind === 'word') throw new TestFailure(['conditional binary operator expected'], op)
    throw new TestFailure(
      [`unexpected token \`${testText(op)}', conditional binary operator expected`],
      op,
      op.kind === 'eof',
    )
  }

  /** Parse `( EXPR )`; every error inside adds that bash expected the `)`. */
  testGroup(tok: Token): void {
    if (this.nesting >= MAX_NESTING) this.failToken(tok)
    this.take(tok)
    this.depth += 1
    this.nesting += 1
    let close: Token
    try {
      this.testOr()
      close = this.testPeek()
    } catch (err) {
      if (err instanceof TestFailure || (err instanceof Refusal && err.eof))
        err.lines.push("expected `)'")
      throw err
    } finally {
      this.depth -= 1
      this.nesting -= 1
    }
    if (close.kind === 'op' && close.text === ')') {
      this.take(close)
      return
    }
    if (close.kind === 'word' && !isTestClose(close)) throw new TestFailure(["expected `)'"], close)
    throw new TestFailure(
      [`unexpected token \`${testText(close)}', expected \`)'`],
      close,
      close.kind === 'eof',
    )
  }

  /** Read an operator's operand; ending inside a quote there, bash adds that
   * the operator's argument is missing. */
  testOperand(kind: string, reader: () => Token): Token {
    try {
      return reader()
    } catch (err) {
      if (err instanceof Refusal && err.eof)
        err.lines.push(`unexpected argument to conditional ${kind} operator`)
      throw err
    }
  }

  /** The right side of `==`, `=` or `!=`, read with extglob on. */
  patternWord(): Token {
    const i = this.blankEnd(this.pos)
    const text = this.text
    const tok = this.lex(i, READ_TEST)
    if (tok.kind !== 'word' && !(EXTGLOB_OPENERS.has(text.charAt(i)) && text.charAt(i + 1) === '('))
      return tok
    let j = i
    let extended = false
    while (j < this.n) {
      const c = text.charAt(j)
      if (EXTGLOB_OPENERS.has(c) && text.charAt(j + 1) === '(') {
        j = this.matched(j + 2, j + 1) + 1
        extended = true
        continue
      }
      if (WORD_BREAKS.has(c)) break
      j = this.wordChar(j)
    }
    if (!extended) return tok
    return token('word', text.slice(i, j).replaceAll('\\\n', ''), i, j)
  }

  /** The right side of `=~`: parentheses group blanks into it and `|` is
   * part of it; `;`, `<`, `>`, `)` and `&` end it, and one of them first is
   * an empty pattern. A `#` first starts a comment, as at any word's start. */
  regexWord(): Token {
    const i = this.blankEnd(this.pos)
    const text = this.text
    if (i >= this.n || '\n#'.includes(text.charAt(i))) return this.lex(i, 0)
    if (';<>)&'.includes(text.charAt(i))) return token('word', '', i, i)
    let j = i
    while (j < this.n) {
      const c = text.charAt(j)
      if (c === '(') {
        j = this.matched(j + 1, j) + 1
        continue
      }
      if (' \t\n;<>)&'.includes(c)) break
      j = this.wordChar(j)
    }
    const word = text.slice(i, j).replaceAll('\\\n', '')
    return token('word', word, i, j, word === ']]')
  }
}
