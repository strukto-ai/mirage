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

import type { PathSpec } from '../../../types.ts'
import type { Accessor } from '../../../accessor/base.ts'
import { IOResult } from '../../../io/types.ts'
import { command, type CommandFnResult, type Context } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { byteView, fromByteView, utf8Locale } from '../../../shell/bytes.ts'
import { RegexError } from '../../../rs/errors.ts'
import { posixRegex, type PosixRegex } from '../../../rs/regex.ts'
import { quoteWord } from '../../quote.ts'

const CMP_OPS = new Set(['=', '==', '!=', '<', '<=', '>', '>='])
const ADD_OPS = new Set(['+', '-'])
const MUL_OPS = new Set(['*', '/', '%'])

// GNU expr's operand grammar, which is narrower than either language's
// own integer parser: no sign but a leading `-`, no surrounding space,
// no digit separator, no `0x`/`1e3` form. Leading zeros are decimal, so
// `05` is 5. `\d` is ASCII-only in JavaScript, matching `[0-9]` in the
// python twin (`INT_OPERAND_RE`, expr.py), whose twin is read with
// `fullmatch` because python's `$` also matches before a trailing
// newline; JavaScript's `$` is already end-of-input.
//
// The grammar is read into a `bigint`, not a `number`, because GNU expr
// is arbitrary precision and this is the only way to be. A float64 could
// not merely round: it turned a comparison's answer upside down, because
// an operand past ~1.8e308 read as `Infinity`, `Number.isFinite` reported
// it as not an integer at all, and the comparison silently fell back to
// comparing strings -- `expr 2 '<' 1e320` answered 0 where GNU answers 1.
// It also printed what expr cannot print and cannot read back, since
// `String(1e24)` is `1e+24`.
//
// This host has no digit limit; the python twin does, and it is the one
// place the two still part company. CPython caps base-10 `int(str)` and
// `str(int)` at `sys.get_int_max_str_digits()`, 4300 by default, so an
// operand or a product longer than that raises there while this answers.
const INT_OPERAND_RE = /^-?\d+$/

const NON_INTEGER = 'expr: non-integer argument'
const DIVISION_BY_ZERO = 'expr: division by zero'

// GNU's only two-line diagnostic, and the only one it reaches for when
// the line leaves zero expression words -- `expr` and `expr --`, since
// `--` is consumed as the options terminator. Every other refusal is one
// `syntax error: <detail>` line.
const MISSING_OPERAND = "expr: missing operand\nTry 'expr --help' for more information.\n"

// GNU declares no nesting limit and segfaults on a C-stack overflow at
// somewhere past 10000 parentheses, with nothing on stderr, so there is
// no message to copy. This limit is ours: it keeps the recursive descent
// well inside CPython's default recursion limit on the python side (eight
// frames per level) and is far past any expression written by hand.
const MAX_NESTING = 64
const NESTING_TOO_DEEP = `expr: expression nesting too deep (limit ${String(MAX_NESTING)})`

// An operand or operation GNU expr refuses, worded as GNU words it.
export class ExprError extends Error {}

// GNU's wording for an operator with nothing to its right. The word is
// the last one the parser consumed, which is what GNU names here rather
// than the operator that needed an operand -- `expr substr abc 1` reports
// `1`, not `substr`. It outranks an unclosed parenthesis: `expr '(' 1 +`
// reports this, not `expecting ')'`.
// `utf8` means the word is text, under a UTF-8 locale.
function missingArgumentAfter(word: string, utf8 = false): string {
  return `expr: syntax error: missing argument after '${quoteWord(word, utf8)}'`
}

// GNU's wording for a leftover word the grammar had no slot for.
function unexpectedArgument(word: string, utf8 = false): string {
  return `expr: syntax error: unexpected argument '${quoteWord(word, utf8)}'`
}

// GNU's wording for a parenthesis that was never closed.
//
// GNU has two clauses here and picks between them on one fact: whether
// the line ran out or a word is standing where the `)` belonged. It names
// the last word consumed in the first case and the offending word in the
// second, so `expr '(' 1` reports `after '1'` while `expr '(' 1 1`
// reports `instead of '1'` -- the same text for different reasons, and
// different text for what looks like the same error.
function expectingClose(current: string | null, prev: string, utf8 = false): string {
  if (current === null) {
    return `expr: syntax error: expecting ')' after '${quoteWord(prev, utf8)}'`
  }
  return `expr: syntax error: expecting ')' instead of '${quoteWord(current, utf8)}'`
}

// The one detail clause with no `argument` noun in it, for a `)` where a
// primary was expected. A `)` left over at the *end* of a complete
// expression is reported by `unexpectedArgument` instead.
const UNEXPECTED_CLOSE = "expr: syntax error: unexpected ')'"

// One expr operand read as GNU reads it, or null when it is not an
// integer in GNU's grammar -- the read a comparison uses, since a
// comparison falls back to comparing strings instead of refusing. A
// value out of every float's range is still an integer here, which is
// the whole point of the `bigint`: `null` means "compare as strings".
function intOperandOrNone(s: string): bigint | null {
  if (!INT_OPERAND_RE.test(s)) return null
  return BigInt(s)
}

// The same read for an arithmetic operand, which GNU refuses outright.
function parseIntOperand(s: string): bigint {
  const n = intOperandOrNone(s)
  if (n === null) throw new ExprError(NON_INTEGER)
  return n
}

// Whether GNU expr counts a value as false. False is not "empty or the
// character zero": the empty string is false, and so is any run of
// zeros with at most one leading minus, which is why `expr 00 '&' 1` is
// false and `expr - '&' 1` is not.
export function isNull(value: string): boolean {
  if (value === '') return true
  const digits = value.startsWith('-') ? value.slice(1) : value
  if (digits === '') return false
  for (const ch of digits) {
    if (ch !== '0') return false
  }
  return true
}

// Integer division truncated toward zero, as C and GNU expr do it.
// `bigint` division already truncates, so there is nothing to round; a
// zero divisor is GNU's `division by zero`, which is also why this cannot
// be left to the operator (`bigint` raises `RangeError` instead).
function truncDiv(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new ExprError(DIVISION_BY_ZERO)
  return a / b
}

// The remainder that takes the dividend's sign, as GNU expr does:
// `-10 % 3` is -1 and `10 % -3` is 1, which JavaScript's own `%`
// already answers. GNU reports a zero divisor here with the same
// `division by zero` message it uses for `/`, not a modulo variant.
function truncMod(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new ExprError(DIVISION_BY_ZERO)
  return a % b
}

// Compare two operands the way GNU's `=` family compares them. The
// comparison is numeric only when *both* sides are integers in GNU's
// grammar; one bad side makes it a byte-order string compare, so
// `expr 10 '>' 9a` is false and `expr '+1' '=' 1` is false. That fallback
// is GNU's `strcmp`, and it is the byte order because both sides are byte
// views by the time they arrive.
function orderOf(left: string, right: string): number {
  const a = intOperandOrNone(left)
  const b = intOperandOrNone(right)
  if (a !== null && b !== null) return a > b ? 1 : a < b ? -1 : 0
  return left > right ? 1 : left < right ? -1 : 0
}

// One comparison, answered as GNU's `1` or `0`. `==` is an undocumented
// synonym for `=`.
function compare(left: string, op: string, right: string): string {
  const order = orderOf(left, right)
  let held: boolean
  if (op === '=' || op === '==') held = order === 0
  else if (op === '!=') held = order !== 0
  else if (op === '<') held = order < 0
  else if (op === '<=') held = order <= 0
  else if (op === '>') held = order > 0
  else held = order >= 0
  return held ? '1' : '0'
}

// Compile a BRE, re-wording glibc's refusal under expr's own program
// prefix, as GNU prints it.
function compileOrRefuse(pattern: string, utf8: boolean): PosixRegex {
  try {
    return posixRegex(pattern, false, 'posix', false, utf8)
  } catch (err) {
    if (err instanceof RegexError) throw new ExprError(`expr: ${err.message}`, { cause: err })
    throw err
  }
}

// The `:` operator, which `match` is the prefix spelling of. POSIX: the
// pattern is a BRE anchored at the start of the subject. A pattern with a
// group answers with what group 1 matched -- the empty string when the match
// failed or the group took no part -- and one without answers with the length
// of the match, `0` when there is none. Whether it has a group is the
// pattern's business alone, so a failed `expr abc : '\(x\)'` is empty, not
// `0`.
//
// Both strings are byte views, so `.` matches one byte and the length counts
// bytes: GNU reads `expr <e-acute> : '.'` as 1 and `expr <e-acute> : '\(.\)'`
// as the single byte `c3`. Under a UTF-8 locale (`utf8`) both are text and
// the same two answer the whole character, counted by code point. Mirrors
// Python's colon_match.
async function colonMatch(
  subject: string,
  pattern: string,
  utf8 = false,
  signal?: AbortSignal,
): Promise<string> {
  const regex = compileOrRefuse(pattern, utf8)
  let found = await regex.search(subject, 0, signal)
  // The leftmost match is the one at the start, when there is one.
  if (found !== null && found[0]?.[0] !== 0) found = null
  if (regex.groups > 0) {
    const group = found?.[1] ?? null
    return group === null ? '' : subject.slice(group[0], group[1])
  }
  const whole = found?.[0] ?? null
  return whole === null ? '0' : String(Array.from(subject.slice(0, whole[1])).length)
}

// The `index` operator, which is `strcspn` over a character set. It is
// not a substring search: `expr index abcde ec` is 3, because `c` sits
// earlier in the subject than `e` does. Both arguments are byte views, so
// the set is a set of bytes and the position counts bytes:
// `expr index <a-umlaut> <e-acute>` is 1, because both characters begin
// with the byte `c3`. Every count here goes by code point, which is one
// byte in a byte view and one character in a UTF-8 locale's text.
function doIndex(text: string, charSet: string): string {
  const wanted = new Set(charSet)
  let offset = 0
  for (const ch of text) {
    offset += 1
    if (wanted.has(ch)) return String(offset)
  }
  return '0'
}

// The `substr` operator, 1-based and forgiving. A position that is zero,
// negative, past the end or not a number at all is not an error: GNU
// answers with the empty string, which makes expr exit 1. A negative or
// zero length answers the same way, and an over-long one clamps.
//
// The subject is a byte view, so both the position and the length count
// bytes and a slice may land mid-character. GNU does exactly that and
// prints the half it selected, so this does too. The length is clamped to
// the subject before it leaves `bigint`, because `expr substr abcde 1
// 1e320` is a legal line and `Number` of that offset is not an index.
function doSubstr(text: string, posArg: string, lenArg: string): string {
  const start = intOperandOrNone(posArg)
  const count = intOperandOrNone(lenArg)
  if (start === null || count === null) return ''
  const chars = Array.from(text)
  const size = BigInt(chars.length)
  if (start < 1n || count < 0n || start > size) return ''
  const from = Number(start - 1n)
  return chars.slice(from, from + Number(count > size ? size : count)).join('')
}

// How many operands each prefix keyword reads: GNU's `match`, `substr`,
// `index` and `length`.
const KEYWORD_ARITY = new Map([
  ['match', 2],
  ['substr', 3],
  ['index', 2],
  ['length', 1],
])

// An expr line read and evaluated in one left-to-right pass.
//
// The grammar is POSIX's, loosest first: `|`, `&`, the six comparisons (and
// GNU's `==`), `+ -`, `* / %`, then `:`, every level left-associative. Under
// `:` sit GNU's operands: a prefix keyword (`match`, `substr`, `index`,
// `length`) with its operands, `+ WORD` quoting one word, `( EXPR )`, or any
// other single word, operator words included (`expr '*'` prints `*`). There
// is no unary operator: `-5` is a word and so is `-`.
//
// `live` is false inside an operand `|` or `&` has already decided (`expr 1
// '|' a / 0` prints 1): the operand is still read, so a syntax error in it
// still counts, but nothing in it is computed and so nothing in it can refuse
// a value -- not a non-integer, not a zero divisor, not a bad pattern.
//
// Every word and value is a byte view (see exprEval), or text under a UTF-8
// locale (`utf8`). Mirrors Python's ExprReader.
class ExprReader {
  next = 0
  private depth = 0

  constructor(
    readonly words: readonly string[],
    private readonly utf8 = false,
    private readonly signal?: AbortSignal,
  ) {}

  done(): boolean {
    return this.next >= this.words.length
  }

  ahead(): string | null {
    return this.words[this.next] ?? null
  }

  lastRead(): string {
    return this.words[this.next - 1] ?? ''
  }

  // The next word, which has to be there: when the line ran out, GNU names
  // the word before.
  readWord(): string {
    const word = this.words[this.next]
    if (word === undefined) throw new ExprError(missingArgumentAfter(this.lastRead(), this.utf8))
    this.next++
    return word
  }

  takeIf(wanted: string | ReadonlySet<string>): string | null {
    const word = this.ahead()
    if (word === null) return null
    if (typeof wanted === 'string' ? word !== wanted : !wanted.has(word)) return null
    this.next++
    return word
  }

  // `A | B`: A unless it is null or 0, else B unless it is, else 0.
  async either(live: boolean): Promise<string> {
    let left = await this.both(live)
    while (this.takeIf('|') !== null) {
      const right = await this.both(live && isNull(left))
      if (live && isNull(left)) left = isNull(right) ? '0' : right
    }
    return left
  }

  // `A & B`: A when neither is null or 0, else 0.
  async both(live: boolean): Promise<string> {
    let left = await this.relation(live)
    while (this.takeIf('&') !== null) {
      const right = await this.relation(live && !isNull(left))
      if (live) left = isNull(left) || isNull(right) ? '0' : left
    }
    return left
  }

  async relation(live: boolean): Promise<string> {
    let left = await this.sum(live)
    for (let op = this.takeIf(CMP_OPS); op !== null; op = this.takeIf(CMP_OPS)) {
      const right = await this.sum(live)
      if (live) left = compare(left, op, right)
    }
    return left
  }

  async sum(live: boolean): Promise<string> {
    let left = await this.product(live)
    for (let op = this.takeIf(ADD_OPS); op !== null; op = this.takeIf(ADD_OPS)) {
      const right = await this.product(live)
      if (live) {
        const a = parseIntOperand(left)
        const b = parseIntOperand(right)
        left = String(op === '+' ? a + b : a - b)
      }
    }
    return left
  }

  async product(live: boolean): Promise<string> {
    let left = await this.matching(live)
    for (let op = this.takeIf(MUL_OPS); op !== null; op = this.takeIf(MUL_OPS)) {
      const right = await this.matching(live)
      if (live) {
        const a = parseIntOperand(left)
        const b = parseIntOperand(right)
        if (op === '*') left = String(a * b)
        else if (op === '/') left = String(truncDiv(a, b))
        else left = String(truncMod(a, b))
      }
    }
    return left
  }

  async matching(live: boolean): Promise<string> {
    let left = await this.operand(live)
    while (this.takeIf(':') !== null) {
      const right = await this.operand(live)
      if (live) left = await colonMatch(left, right, this.utf8, this.signal)
    }
    return left
  }

  // One operand under `:`, prefix keywords applied. A keyword reads its own
  // operands at this same level, so `length length abc` is 1 and `substr + abc
  // 1 1` is `a`. Those chains are kept on a list here rather than on the call
  // stack: GNU reads one of any length, and only parentheses count toward the
  // nesting limit.
  async operand(live: boolean): Promise<string> {
    const waiting: [string, string[]][] = []
    for (;;) {
      const word = this.readWord()
      if (KEYWORD_ARITY.has(word)) {
        waiting.push([word, []])
        continue
      }
      let value = await this.simple(word, live)
      for (let top = waiting.at(-1); top !== undefined; top = waiting.at(-1)) {
        const [keyword, given] = top
        given.push(value)
        if (given.length < (KEYWORD_ARITY.get(keyword) ?? 0)) break
        waiting.pop()
        value = live ? await this.keyword(keyword, given) : ''
      }
      if (waiting.length === 0) return value
    }
  }

  async keyword(keyword: string, given: readonly string[]): Promise<string> {
    const [first = '', second = '', third = ''] = given
    if (keyword === 'length') return String(Array.from(first).length)
    if (keyword === 'index') return doIndex(first, second)
    if (keyword === 'substr') return doSubstr(first, second, third)
    return colonMatch(first, second, this.utf8, this.signal)
  }

  // `+ WORD`, `( EXPR )` or a word standing for itself, the word already read.
  async simple(word: string, live: boolean): Promise<string> {
    if (word === '+') return this.readWord()
    if (word === ')') throw new ExprError(UNEXPECTED_CLOSE)
    if (word !== '(') return word
    if (this.depth >= MAX_NESTING) throw new ExprError(NESTING_TOO_DEEP)
    this.depth++
    const value = await this.either(live)
    this.depth--
    if (this.takeIf(')') === null) {
      throw new ExprError(expectingClose(this.ahead(), this.lastRead(), this.utf8))
    }
    return value
  }
}

// Evaluate a whole expr line, answering the value to print and the exit
// code. GNU exits 1 when the value is false even on full success, so exit
// 1 means "the answer was zero or empty" and exit 2 is the only error
// status. The words in and the value out are byte views, or text under a
// UTF-8 locale (`utf8`).
export async function exprEval(
  args: string[],
  utf8 = false,
  signal?: AbortSignal,
): Promise<[string, number]> {
  const reader = new ExprReader(args, utf8, signal)
  const value = await reader.either(true)
  const leftover = reader.ahead()
  if (leftover !== null) throw new ExprError(unexpectedArgument(leftover, utf8))
  return [value, isNull(value) ? 1 : 0]
}

async function expr(
  _accessor: Accessor,
  paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  if (texts.length === 0) {
    return [null, new IOResult({ exitCode: 2, stderr: fromByteView(MISSING_OPERAND) })]
  }
  const utf8 = utf8Locale(ctx.env)
  try {
    const [result, exitCode] = await exprEval(
      texts.map((text) => byteView(text, utf8)),
      utf8,
      ctx.signal,
    )
    return [fromByteView(result + '\n', utf8), new IOResult({ exitCode })]
  } catch (err) {
    if (err instanceof ExprError) {
      // GNU writes the refusal to stderr, nothing to stdout, and exits
      // 2; exit 1 is reserved for a zero-valued success. The diagnostic
      // quotes a byte view of the offending word, so it leaves through
      // the same entry point the value does.
      return [null, new IOResult({ exitCode: 2, stderr: fromByteView(`${err.message}\n`, utf8) })]
    }
    throw err
  }
}

export const GENERAL_EXPR = command({
  name: 'expr',
  vfs: null,
  spec: specOf('expr'),
  fn: expr,
})
