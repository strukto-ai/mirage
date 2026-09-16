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
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { pureProvision } from '../generic_bind/provision.ts'
import { encodeText } from '../../../shell/bytes.ts'
import { BreError, compileBre } from '../utils/bre.ts'
import { quoteWord } from '../../quote.ts'

const CMP_OPS = new Set(['=', '==', '!=', '<', '<=', '>', '>='])
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
function missingArgumentAfter(word: string): string {
  return `expr: syntax error: missing argument after '${quoteWord(word)}'`
}

// GNU's wording for a leftover word the grammar had no slot for.
function unexpectedArgument(word: string): string {
  return `expr: syntax error: unexpected argument '${quoteWord(word)}'`
}

// GNU's wording for a parenthesis that was never closed.
//
// GNU has two clauses here and picks between them on one fact: whether
// the line ran out or a word is standing where the `)` belonged. It names
// the last word consumed in the first case and the offending word in the
// second, so `expr '(' 1` reports `after '1'` while `expr '(' 1 1`
// reports `instead of '1'` -- the same text for different reasons, and
// different text for what looks like the same error.
function expectingClose(current: string | null, prev: string): string {
  if (current === null) {
    return `expr: syntax error: expecting ')' after '${quoteWord(prev)}'`
  }
  return `expr: syntax error: expecting ')' instead of '${quoteWord(current)}'`
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

// One argv word as GNU sees it: one character per byte.
//
// Every expr string operator counts bytes, not characters, because GNU
// runs in the C locale: `expr length ee` with two two-byte `e` acutes is
// 4, `substr` will split one character in half and print the half
// (`expr substr <e-acute><e-acute> 2 2` is the bytes `a9 c3`), `index`
// searches a set of bytes so a byte shared with another character
// matches, and the BRE's `.` matches one byte. All of that follows from
// one representation change rather than four special cases, so the whole
// parser runs on a string whose every character is one byte and the
// conversion happens only at the command boundary. `to_byte_view` in
// expr.py is the twin.
//
// `encodeText` rather than `TextEncoder`, because a raw byte reaches a
// command as its U+DCxx sentinel and `TextEncoder` would write that as
// U+FFFD.
function toByteView(text: string): string {
  const raw = encodeText(text)
  let view = ''
  for (const byte of raw) view += String.fromCharCode(byte)
  return view
}

// The bytes a byte-view string stands for -- a value, or a diagnostic
// built from byte-view words and this module's ASCII wording, so every
// code point is below 256. GNU writes the raw bytes of the operand it was
// handed, so a `substr` that split a character prints the invalid half
// rather than a replacement character.
function fromByteView(view: string): Uint8Array {
  const raw = new Uint8Array(view.length)
  for (let i = 0; i < view.length; i += 1) raw[i] = view.charCodeAt(i) & 0xff
  return raw
}

// Whether GNU expr counts a value as false. GNU's `null()` is not "empty
// or the character zero": the empty string is false, and so is any run of
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
// prefix the way GNU's `error()` does.
function compileOrRefuse(pattern: string): [RegExp, number] {
  try {
    return compileBre(pattern)
  } catch (err) {
    if (err instanceof BreError) throw new ExprError(`expr: ${err.message}`, { cause: err })
    throw err
  }
}

// The `:` operator, which `match` is the prefix spelling of. The pattern
// is a POSIX BRE anchored at the start of the subject. A pattern with a
// group answers with group 1's text -- the empty string when the group
// did not participate -- and one without answers with the match length,
// or `0` when nothing matched. Which of the two it is depends on the
// pattern alone, so the group count has to come from the translator
// rather than from a match object that may not exist.
//
// Both the subject and the pattern are byte views, so `.` matches one
// byte and the length this answers with is a byte count: GNU reads
// `expr <e-acute> : '.'` as 1 and `expr <e-acute> : '\(.\)'` as the
// single byte `c3`.
function docolon(subject: string, pattern: string): string {
  const [regex, groups] = compileOrRefuse(pattern)
  regex.lastIndex = 0
  const matched = regex.exec(subject)
  if (matched === null) return groups > 0 ? '' : '0'
  if (groups > 0) return matched[1] ?? ''
  return String(matched[0].length)
}

// The `index` operator, which is `strcspn` over a character set. It is
// not a substring search: `expr index abcde ec` is 3, because `c` sits
// earlier in the subject than `e` does. Both arguments are byte views, so
// the set is a set of bytes and the position counts bytes:
// `expr index <a-umlaut> <e-acute>` is 1, because both characters begin
// with the byte `c3`.
function doIndex(text: string, charSet: string): string {
  const wanted = new Set(charSet)
  for (let offset = 0; offset < text.length; offset += 1) {
    if (wanted.has(text.charAt(offset))) return String(offset + 1)
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
  const size = BigInt(text.length)
  if (start < 1n || count < 0n || start > size) return ''
  const from = Number(start - 1n)
  return text.slice(from, from + Number(count > size ? size : count))
}

// GNU expr's grammar as a recursive descent over argv words.
//
// Each level binds tighter than the one above it and every level is
// left-associative: `|`, then `&`, then the comparisons, then `+ -`, then
// `* / %`, then `:`, then the keyword operators and `+ TOKEN`, then
// primaries. There is no unary operator anywhere -- `-5` is an integer
// literal, `+` is the string-quoting operator, and `^`, `!` and `<>` are
// not operators at all. The structure is mirrored level for level in
// `expr.py`.
//
// `evaluate` threads GNU's short-circuiting through: `|` and `&` parse
// their right operand with it false when the left already decided the
// answer, and every level that can refuse a value checks it first, so
// `expr 1 '|' 1 '/' 0` is 1 rather than a division by zero.
//
// Every word in `args`, every value it produces and every word it quotes
// in a diagnostic is a byte view (`toByteView`), which is what makes
// `length`, `index`, `substr` and `:` count bytes as GNU does and makes a
// string comparison the `strcmp` byte order GNU uses. The conversion is
// the command's, not the parser's.
class ExprParser {
  private readonly args: string[]
  private pos = 0
  private depth = 0

  constructor(args: string[]) {
    this.args = args
  }

  // Whether every word has been consumed.
  atEnd(): boolean {
    return this.pos >= this.args.length
  }

  // The offending word at the cursor, for the leftover-word diagnostic.
  current(): string {
    return this.args[this.pos] ?? ''
  }

  // The next word without consuming it, or null at the end of the line.
  private peek(): string | null {
    return this.atEnd() ? null : (this.args[this.pos] ?? '')
  }

  // Consume the next word if it is exactly `word`.
  private nextarg(word: string): boolean {
    if (this.peek() === word) {
      this.pos += 1
      return true
    }
    return false
  }

  // Consume the next word unconditionally.
  private take(): string {
    const word = this.args[this.pos] ?? ''
    this.pos += 1
    return word
  }

  // The last word consumed, which GNU names in two of its diagnostics.
  private prev(): string {
    return this.pos > 0 ? (this.args[this.pos - 1] ?? '') : ''
  }

  // Refuse a line that ended where an operand was needed.
  private requireMoreArgs(): void {
    if (this.atEnd()) throw new ExprError(missingArgumentAfter(this.prev()))
  }

  // Level 1: `|`, which short-circuits on a truthy left operand. It
  // answers the left operand when that is truthy, else the right one,
  // normalised to `0` when both are falsy.
  evalOr(evaluate: boolean): string {
    let left = this.evalAnd(evaluate)
    while (this.nextarg('|')) {
      const right = this.evalAnd(evaluate && isNull(left))
      if (isNull(left)) left = isNull(right) ? '0' : right
    }
    return left
  }

  // Level 2: `&`, which short-circuits on a falsy left operand. It
  // answers the left operand when both are truthy, else `0`.
  private evalAnd(evaluate: boolean): string {
    let left = this.evalCompare(evaluate)
    while (this.nextarg('&')) {
      const right = this.evalCompare(evaluate && !isNull(left))
      if (isNull(left) || isNull(right)) left = '0'
    }
    return left
  }

  // Level 3: the six comparisons, plus `==` as a synonym for `=`.
  private evalCompare(evaluate: boolean): string {
    let left = this.evalAdditive(evaluate)
    for (;;) {
      const op = this.peek()
      if (op === null || !CMP_OPS.has(op)) return left
      this.pos += 1
      const right = this.evalAdditive(evaluate)
      if (evaluate) left = compare(left, op, right)
    }
  }

  // Level 4: `+` and `-` as binary arithmetic. A `+` in an *operand*
  // position is the quoting operator instead, which is why
  // `expr 1 + + 2` is 3: this level reads the first `+` and
  // `evalKeyword` reads the second.
  private evalAdditive(evaluate: boolean): string {
    let left = this.evalMultiplicative(evaluate)
    for (;;) {
      let op: string
      if (this.nextarg('+')) op = '+'
      else if (this.nextarg('-')) op = '-'
      else return left
      const right = this.evalMultiplicative(evaluate)
      if (evaluate) {
        const a = parseIntOperand(left)
        const b = parseIntOperand(right)
        left = String(op === '+' ? a + b : a - b)
      }
    }
  }

  // Level 5: `*`, `/` and `%`, which share one level.
  private evalMultiplicative(evaluate: boolean): string {
    let left = this.evalColon(evaluate)
    for (;;) {
      const op = this.peek()
      if (op === null || !MUL_OPS.has(op)) return left
      this.pos += 1
      const right = this.evalColon(evaluate)
      if (evaluate) {
        const a = parseIntOperand(left)
        const b = parseIntOperand(right)
        if (op === '*') left = String(a * b)
        else if (op === '/') left = String(truncDiv(a, b))
        else left = String(truncMod(a, b))
      }
    }
  }

  // Level 6: `:`, the regex match, tighter than any arithmetic.
  private evalColon(evaluate: boolean): string {
    let left = this.evalKeyword(evaluate)
    while (this.nextarg(':')) {
      const right = this.evalKeyword(evaluate)
      if (evaluate) left = docolon(left, right)
    }
    return left
  }

  // The keyword operators and `+ TOKEN`, all above the primaries.
  //
  // `+` consumes the next argv word unconditionally and pushes it as a
  // literal string, whatever it spells: `expr + length` is `length` and
  // `expr + '('` is `(`. It does not recurse, so `expr + + hello` and
  // `expr + length abcde` are syntax errors -- the quoted token eats the
  // operator and the next word is left with no slot.
  //
  // `length` counts bytes, which is what it costs to have every value be
  // a byte view: the string's length is already a byte count, so there is
  // nothing here to special-case.
  private evalKeyword(evaluate: boolean): string {
    if (this.nextarg('+')) {
      this.requireMoreArgs()
      return this.take()
    }
    if (this.nextarg('length')) {
      return String(this.evalKeyword(evaluate).length)
    }
    if (this.nextarg('match')) {
      const left = this.evalKeyword(evaluate)
      const right = this.evalKeyword(evaluate)
      return evaluate ? docolon(left, right) : left
    }
    if (this.nextarg('index')) {
      const left = this.evalKeyword(evaluate)
      const right = this.evalKeyword(evaluate)
      return doIndex(left, right)
    }
    if (this.nextarg('substr')) {
      const text = this.evalKeyword(evaluate)
      const posArg = this.evalKeyword(evaluate)
      const lenArg = this.evalKeyword(evaluate)
      return doSubstr(text, posArg, lenArg)
    }
    return this.evalPrimary(evaluate)
  }

  // A parenthesised expression, or a bare word.
  private evalPrimary(evaluate: boolean): string {
    this.requireMoreArgs()
    if (this.nextarg('(')) {
      this.depth += 1
      if (this.depth > MAX_NESTING) throw new ExprError(NESTING_TOO_DEEP)
      const value = this.evalOr(evaluate)
      this.depth -= 1
      if (!this.nextarg(')')) throw new ExprError(expectingClose(this.peek(), this.prev()))
      return value
    }
    if (this.peek() === ')') throw new ExprError(UNEXPECTED_CLOSE)
    return this.take()
  }
}

// Evaluate a whole expr line, answering the value to print and the exit
// code. GNU exits 1 when the value is false even on full success, so exit
// 1 means "the answer was zero or empty" and exit 2 is the only error
// status. The words in and the value out are byte views.
export function exprEval(args: string[]): [string, number] {
  const parser = new ExprParser(args)
  const value = parser.evalOr(true)
  if (!parser.atEnd()) throw new ExprError(unexpectedArgument(parser.current()))
  return [value, isNull(value) ? 1 : 0]
}

function exprCommand(
  _accessor: Accessor,
  paths: PathSpec[],
  texts: string[],
  _opts: CommandOpts,
): CommandFnResult {
  if (texts.length === 0) {
    return [null, new IOResult({ exitCode: 2, stderr: fromByteView(MISSING_OPERAND) })]
  }
  try {
    const [result, exitCode] = exprEval(texts.map(toByteView))
    return [fromByteView(result + '\n'), new IOResult({ exitCode })]
  } catch (err) {
    if (err instanceof ExprError) {
      // GNU writes the refusal to stderr, nothing to stdout, and exits
      // 2; exit 1 is reserved for a zero-valued success. The diagnostic
      // quotes a byte view of the offending word, so it leaves through
      // the same door the value does.
      return [null, new IOResult({ exitCode: 2, stderr: fromByteView(`${err.message}\n`) })]
    }
    throw err
  }
}

export const GENERAL_EXPR = command({
  name: 'expr',
  resource: null,
  spec: specOf('expr'),
  fn: exprCommand,
  provision: pureProvision,
})
