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
import { readStdinAsync } from '../utils/stream.ts'
import { pureProvision } from '../generic_bind/provision.ts'
import { FlagView } from '../../spec/flag_view.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

// Grammar, shared with `bc.py` so the two hosts parse one language
// (precedence low to high):
//   statement := 'halt' | string | 'print' print_list | assign | expr
//   print_list:= element { ',' element }
//   element   := string | expr
//   expr      := assign | additive
//   assign    := target ('='|'+='|'-='|'*='|'/='|'%='|'^=') expr
//   additive  := term   { (+|-) term }
//   term      := unary  { (*|/|%) unary }
//   unary     := (++|--) target | '-' unary | power
//   power     := atom ^ unary | atom
//   atom      := number | '(' expr ')' | register | name ('++'|'--')?
//               | builtin '(' expr ')' | func '(' expr ')'
//   target    := name | 'scale' | 'ibase' | 'obase' | 'last' | '.'
//   builtin   := sqrt | length | scale
//   func      := s | c | a | l | e   (all need -l)
//   string    := '"' [^"]* '"'
// A statement's output is rendered as it is reached rather than at the
// end, because `obase`, `scale` and `last` can all change partway down a
// `print` list: `print 255, obase=16` writes `255` and then `10`.
// A string is a statement and never an expression, so `1+"a"` is a syntax
// error, and its token runs to the next `"` anywhere in the input --
// across newlines, and past a `;`, a `#` or a `/*` -- because a backslash
// never escapes the closing quote. A `"` the input never closes is not a
// token at all: GNU's lexer has no rule it matches, so the quote is
// reported as an illegal character and scanning resumes right after it.
// There is no unary `+`: GNU's lexer has no such operator, so `+5` and
// `1+ +2` are both syntax errors, and `++`/`--` are single tokens, which
// is what makes `1++2` one too rather than `1 + (+2)`.

// `-l` loads the math library, which sets scale to 20. Without it bc's
// scale is 0, which is why plain `7/2` is 3 and `bc -l` answers 3.50...
const MATH_LIBRARY_SCALE = 20

// The largest scale either host can render. `Number.prototype.toFixed`
// refuses a fractionDigits above 100, so a larger scale could not be
// printed identically by the python twin; it also bounds what a typed
// `scale=` can make this allocate. GNU bc accepts more, which is a
// documented divergence.
const MAX_SCALE = 100

const DEFAULT_BASE = 10
const MIN_BASE = 2
// GNU refuses an `ibase` above 16 and an `obase` above 999 with a
// `too large` warning whose wording is not measured, so both hosts clamp
// silently instead of inventing one. The `obase` ceiling also keeps the
// digit-group width below the point where the two hosts spell the base
// differently (JavaScript switches to exponential notation at 1e21).
const MAX_IBASE = 16
const MAX_OBASE = 999
// Up to base 16 a digit is one character; above it GNU prints each digit
// as a space-separated decimal group instead.
const MAX_CHAR_BASE = 16

// The magnitudes where both hosts spell a float in plain notation with
// the shortest digits that read back as it: python's `repr` turns
// exponential outside 1e-4..1e16 and JavaScript's `String` outside
// 1e-6..1e21, so this is the window they agree on, and outside it the
// exact expansion is used in both. `toFixed` itself turns exponential
// from 1e21 up, where every double is an integer and `BigInt` spells it.
const PLAIN_MIN = 1e-4
const PLAIN_MAX = 1e16
const FIXED_MAX = 1e21

// `^` and the math library are computed here, from IEEE multiplications
// and series, rather than through the platform's own `**` and `Math`,
// because the hosts' libms do not agree: V8's `**` and glibc's `pow`
// answered `7.8041^15` as 24257295885134.4530 and 24257295885134.4570,
// and `Math.cos(.1)` and `math.cos(.1)` differ in the last bit too. The
// renderer prints the shortest digits that read back as the double, so
// one ulp reaches stdout. Everything below uses only `+ - * /` and
// `Math.sqrt`, which IEEE-754 requires to be correctly rounded and both
// hosts therefore answer identically, in one fixed order.
//
// ln 2 and pi/2 are each split so the reduction's `k * <HI>` product is
// exact -- both HI constants carry 33 significant bits -- with the LO
// half holding the rest, which is Cody and Waite's reduction.
const LN2_HI = 0.6931471803691238
const LN2_LO = 1.9082149292705877e-10
const LOG2E = 1.4426950408889634
const PIO2_HI = 1.5707963267341256
const PIO2_LO = 6.077100506506192e-11
const TWO_OVER_PI = 0.6366197723675814
const PI_2 = 1.5707963267948966

// Where `e(x)` saturates: exp(710) is past float64's largest value and
// exp(-746) below its smallest subnormal, so the reduction is only
// entered for an argument that can still produce a number.
const EXP_MAX = 710.0
const EXP_MIN = -746.0

// Series lengths. Each is the term count that carries its own reduced
// argument past float64's last bit, and the terms are summed
// smallest-first, so one surplus term costs a multiply and changes
// nothing while one term short would be visible.
const EXP_TERMS = 15
const SIN_TERMS = 10
const ATAN_TERMS = 14
const ATANH_TERMS = 18

// `l` reduces by repeated square roots until its argument is inside
// (0.5, 2), which is GNU's own libmath.b bracket. A tighter one is
// worse, not better: the answer is `2^k * atanh((x-1)/(x+1))`, so the
// relative error of that last atanh is divided by its own value, and a
// bracket nearer 1 makes the value smaller.
const LOG_HI = 2.0
const LOG_LO = 0.5
// `a` halves through `x/(1+sqrt(1+x*x))` until its argument is this
// small, which is at most two halvings for an argument in (0, 1].
const ATAN_HI = 0.25
// `2^1024` is already an infinity, so a scaling exponent past this is
// applied in chunks.
const POW2_CHUNK = 1000

// GNU writes a printed value one character at a time and breaks the
// output with a backslash and a newline when the column reaches
// `line_size`, so a folded line carries `line_size - 2` characters of
// the value plus the backslash. The width is settable through
// `BC_LINE_LENGTH`, where 0 means no folding at all; a value below
// `MIN_LINE_LENGTH` (but not 0) falls back to the default, since one
// character per line and a backslash leaves no room for the value.
const LINE_LENGTH_VAR = 'BC_LINE_LENGTH'
const DEFAULT_LINE_LENGTH = 70
const MIN_LINE_LENGTH = 3
// What C's `isspace` skips, which is not `String.trim`'s set.
const C_BLANKS = ' \t\n\v\f\r'
// `atoi` is `strtol` saturated to a signed 64-bit range and then
// truncated to an `int`, and both halves are observable:
// `BC_LINE_LENGTH=4294967296` disables folding because that truncates
// to 0, while `9223372036854775808` saturates and then truncates to -1,
// which falls back to the default.
const C_LONG_BITS = 64n
const C_INT_BITS = 32n

// GNU renders a non-fatal runtime error or warning with the bytecode
// address it happened at. The address depends on everything parsed before
// it, so it is not derivable here; 3 is what GNU emits for a bare `1/0`
// as the first statement, which is the measured case, and both hosts use
// the same constant so parity holds for the rest.
const RUNTIME_ERROR_ADDR = 3

const DIVIDE_BY_ZERO = 'Divide by zero'
const MODULO_BY_ZERO = 'Modulo by zero'
// `0^-1` is reported with a lowercase reason where `1/0` is capitalised:
// GNU raises the two from different places and never spelled them the
// same way. Measured on bc 1.07.1, both as `Runtime error`.
const POW_DIVIDE_BY_ZERO = 'divide by zero'
const IBASE_TOO_SMALL = 'ibase too small, set to 2'
const OBASE_TOO_SMALL = 'obase too small, set to 2'
const NEGATIVE_SCALE = 'negative scale, set to 0'
const NEGATIVE_SQRT = 'Square root of a negative number'
// `^` takes an integer exponent, and GNU warns whenever the value it
// truncates carries a scale at all -- `2^1.0` warns although its value
// is whole -- and then uses the truncated exponent.
const NONZERO_EXPONENT_SCALE = 'non-zero scale in exponent'

// GNU names the input in a parse diagnostic; reading stdin it is the
// literal `(standard_in)`, and there is no `bc:` prefix anywhere.
const INPUT_NAME = '(standard_in)'
const SYNTAX_ERROR = 'syntax error'
const ILLEGAL_CHARACTER = 'illegal character'
// A block comment that runs to the end of the input. GNU reports it with
// no input name and no line number, unlike every other diagnostic.
const EOF_IN_COMMENT = 'EOF encountered in a comment.'

// Text bc cannot parse; reported, then evaluation continues. GNU charges
// an unexpected token to its own line and an incomplete construct to the
// line after its last token, because a legal prefix only fails once the
// next line arrives. `pos` is the offset in the statement the diagnostic
// belongs to, or -1 for its first character: a block comment spanning
// lines puts later characters of one statement on a later input line, so
// the offset is what names the line.
class BcParseError extends Error {
  constructor(
    readonly text: string,
    readonly incomplete = false,
    readonly pos = -1,
  ) {
    super(text)
  }
}

// A non-fatal runtime error: reported, then evaluation continues.
class BcRuntimeError extends Error {}

// `halt` was reached: stop the run, keeping what already printed. It is a
// statement, so it acts when the statement runs, which is what tells it
// apart from `quit`: everything earlier on its line has already printed.
class BcHalt extends Error {}

// A bc value and the number of fractional digits it prints with. bc
// tracks a scale per value, not just globally, which is the whole
// reason `0.1+0.2` prints `.3` at the default scale of 0: addition
// keeps the wider of its operands' scales, while division adopts the
// global one.
interface BcNumber {
  readonly value: number
  readonly scale: number
}

const ZERO: BcNumber = { value: 0, scale: 0 }

// What survives between statements on one bc run: the registers, the
// symbol table and whether `-l` loaded the math library. The whole
// BcNumber is stored per variable, so a variable carries its own scale.
// `warnings` holds what the statement being evaluated raised, and the
// caller drains it after each one.
interface BcState {
  scale: number
  mathMode: boolean
  ibase: number
  obase: number
  last: BcNumber
  variables: Map<string, BcNumber>
  warnings: string[]
}

// One bc statement and where its characters came from. `lines` holds the
// input line each character of `text` sits on -- a block comment spanning
// lines advances the counter without ending the statement, so one
// statement's characters can sit on more than one line. `incompleteLine`
// is the line GNU charges an incomplete construct to: its parser fails on
// whichever token arrives next, so that is the `;` ending this statement
// when one does (`1+;2` reports line 1) and otherwise the newline after
// it, which has already moved the counter on. `execute` is false for a
// statement on a line a `quit` cut short: GNU exits inside the lexer, so
// that line is parsed -- and a parse error still reported -- but never
// executed.
interface BcStatement {
  readonly text: string
  readonly lines: readonly number[]
  readonly incompleteLine: number
  readonly execute: boolean
}

type MathFn = (x: number) => number

// Square root, refusing a negative argument as GNU does rather than
// answering a NaN. IEEE-754 requires a correctly rounded square root, so
// this is the one library call both hosts already agreed on bit for bit
// and the only one not rebuilt from a series here.
function bcSqrt(x: number): number {
  if (x < 0) throw new BcRuntimeError(NEGATIVE_SQRT)
  return Math.sqrt(x)
}

// `base` raised to an integer power, by repeated squaring. Computed here
// rather than through `**` because V8's and glibc's answers differ by
// one ulp on ordinary input, which the renderer then prints. Repeated
// squaring is also the order GNU's own `bc_raise` multiplies in. The
// exponent is halved with `% 2` and `Math.floor` rather than with bit
// operators, which truncate to 32 bits and would make an exponent past
// that mean something different in the two hosts. Overflow saturates to
// a signed Infinity and underflow to zero, as the multiplications do on
// their own.
function floatPow(base: number, exponent: number): number {
  if (base === 0 && exponent < 0) throw new BcRuntimeError(POW_DIVIDE_BY_ZERO)
  let remaining = exponent < 0 ? -exponent : exponent
  let result = 1.0
  let square = base
  while (remaining > 0) {
    if (remaining % 2 === 1) result *= square
    remaining = Math.floor(remaining / 2)
    if (remaining > 0) square *= square
  }
  if (exponent >= 0) return result
  return 1.0 / result
}

// Multiply by a power of two, in chunks so nothing overflows first.
// `e(x)` reduces to `r + k*ln2` and then scales by `2^k`, and `k` runs
// past float64's largest power of two at both ends: `e(709.7)` is finite
// while `2^1024` is not, so the scaling cannot be one multiply.
function scalePow2(value: number, exponent: number): number {
  let scaled = value
  let remaining = exponent
  while (remaining > POW2_CHUNK) {
    scaled *= floatPow(2.0, POW2_CHUNK)
    remaining -= POW2_CHUNK
  }
  while (remaining < -POW2_CHUNK) {
    scaled *= floatPow(2.0, -POW2_CHUNK)
    remaining += POW2_CHUNK
  }
  return scaled * floatPow(2.0, remaining)
}

// `e^x`, from the Taylor series after a `k*ln2` reduction.
function bcExp(x: number): number {
  if (Number.isNaN(x)) return NaN
  if (x > EXP_MAX) return Infinity
  if (x < EXP_MIN) return 0
  const halves = Math.floor(x * LOG2E + 0.5)
  const rest = x - halves * LN2_HI - halves * LN2_LO
  let total = 1.0
  for (let term = EXP_TERMS; term > 0; term--) total = 1.0 + (rest * total) / term
  return scalePow2(total, halves)
}

// `atanh(z)` for a `z` the log reduction has made small, no larger than
// a third in magnitude.
function atanhSeries(z: number): number {
  const square = z * z
  let total = 0.0
  for (let term = ATANH_TERMS; term > 0; term--) total = 1.0 / (2 * term + 1) + square * total
  return z * (1.0 + square * total)
}

// Natural log, as `2^k * atanh((x-1)/(x+1))`. The argument is brought
// inside (0.5, 2) by repeated square roots, each of which halves the log
// it is taking, which is the reduction GNU's libmath.b uses. A
// non-positive argument never reaches here: GNU answers it from `scale`
// alone, which `logDomainValue` does. An argument that is not finite is
// answered with itself, because the square-root reduction would never
// leave the bracket for one and `Math.log(Infinity)` is Infinity.
function bcLog(x: number): number {
  if (!Number.isFinite(x)) return x
  let doublings = 2.0
  let reduced = x
  while (reduced >= LOG_HI) {
    doublings += doublings
    reduced = Math.sqrt(reduced)
  }
  while (reduced <= LOG_LO) {
    doublings += doublings
    reduced = Math.sqrt(reduced)
  }
  return doublings * atanhSeries((reduced - 1.0) / (reduced + 1.0))
}

// What GNU's `l(x)` answers for an argument at or below zero: libmath.b
// returns `(1 - 10^scale)/1` rather than refusing, so `scale=5; l(0)` is
// `-99999.00000`. float64 carries that exactly up to a scale of 15 and
// rounds it above, where GNU stays exact.
function logDomainValue(scale: number): number {
  return 1.0 - Number(10n ** BigInt(scale))
}

// `sin(r)` for an `r` the quadrant reduction has made small, no larger
// than pi/4 in magnitude.
function sinSeries(r: number): number {
  const square = r * r
  let total = 1.0
  for (let term = SIN_TERMS; term > 0; term--) {
    total = 1.0 - (square * total) / (2 * term * (2 * term + 1))
  }
  return r * total
}

// `cos(r)` for an `r` the quadrant reduction has made small.
function cosSeries(r: number): number {
  const square = r * r
  let total = 1.0
  for (let term = SIN_TERMS; term > 0; term--) {
    total = 1.0 - (square * total) / ((2 * term - 1) * (2 * term))
  }
  return total
}

// `sin(x + offset*pi/2)` for a non-negative `x`. One reduction serves
// both `s` and `c`, which is also how GNU's libmath.b spells the cosine
// -- `c(x)` is `s(x + pi/2)` there -- and is why the offset is a quarter
// turn rather than a second series. The quarter count stays in float64
// rather than being reduced as an integer: an argument past 2^53 makes
// it bigger than the integers float64 can tell apart, and only the float
// sum is a fact both hosts share. An argument that is not finite has no
// quadrant to reduce into, and NaN is what `Math.sin` answered for one.
function sinQuadrant(x: number, offset: number): number {
  if (!Number.isFinite(x)) return NaN
  const quarters = Math.floor(x * TWO_OVER_PI + 0.5)
  const rest = x - quarters * PIO2_HI - quarters * PIO2_LO
  const quadrant = (quarters + offset) % 4
  if (quadrant === 0) return sinSeries(rest)
  if (quadrant === 1) return cosSeries(rest)
  if (quadrant === 2) return -sinSeries(rest)
  return -cosSeries(rest)
}

// `sin(x)`, odd about zero so the reduction only sees a magnitude.
function bcSin(x: number): number {
  if (x < 0) return -sinQuadrant(-x, 0)
  return sinQuadrant(x, 0)
}

// `cos(x)`, even about zero.
function bcCos(x: number): number {
  return sinQuadrant(x < 0 ? -x : x, 1)
}

// `atan(x)` for an `x` the halving has made no larger than `ATAN_HI`.
function atanSeries(x: number): number {
  const square = x * x
  let total = 0.0
  for (let term = ATAN_TERMS; term > 0; term--) total = 1.0 / (2 * term + 1) - square * total
  return x * (1.0 - square * total)
}

// `atan(x)`, by reciprocal and half-angle reduction: an argument above
// one is reflected through `pi/2 - atan(1/x)` and what is left is halved
// by `x/(1+sqrt(1+x*x))` until the series converges in a few terms.
function bcAtan(x: number): number {
  const magnitude = x < 0 ? -x : x
  let value: number
  // Infinity only: a NaN falls through to the series, which answers NaN
  // the way `Math.atan` did, and is what the python twin answers.
  if (magnitude === Infinity) {
    value = PI_2
  } else {
    const reflected = magnitude > 1.0
    let reduced = reflected ? 1.0 / magnitude : magnitude
    let halvings = 0
    while (reduced > ATAN_HI) {
      reduced = reduced / (1.0 + Math.sqrt(1.0 + reduced * reduced))
      halvings += 1
    }
    value = floatPow(2.0, halvings) * atanSeries(reduced)
    if (reflected) value = PI_2 - value
  }
  return x < 0 ? -value : value
}

const LOG_NAME = 'l'

// The math library, whose members are reachable only under -l. `sqrt` is
// not one of them: GNU bc has it built in, so it answers without the
// flag, and it is dispatched separately below. A math-library name is
// only a function when a `(` follows it: the function and variable
// namespaces are separate, so `s=5; s; s(0)` reads the variable, the
// variable again, and then the sine.
const MATH_FUNCS = new Map<string, MathFn>([
  ['s', bcSin],
  ['c', bcCos],
  ['a', bcAtan],
  [LOG_NAME, bcLog],
  ['e', bcExp],
])

const SQRT_NAME = 'sqrt'
const LENGTH_NAME = 'length'
const HALT_NAME = 'halt'
const QUIT_NAME = 'quit'
const PRINT_NAME = 'print'
const SCALE_NAME = 'scale'
const IBASE_NAME = 'ibase'
const OBASE_NAME = 'obase'
const LAST_NAME = 'last'
// GNU spells the `last` register `.` as well, which is why a bare `.` is
// not part of a number.
const LAST_ALIAS = '.'

const REGISTERS = new Set([SCALE_NAME, IBASE_NAME, OBASE_NAME, LAST_NAME, LAST_ALIAS])

// The builtins that take one parenthesised argument and need no `-l`.
// `scale` doubles as a register, so it is only a call when a `(` follows
// it, and `length` is otherwise a reserved word, which is why `length=2`
// refuses where `length(1/3)` answers.
const BUILTIN_CALLS = new Set([SQRT_NAME, LENGTH_NAME, SCALE_NAME])

// A reserved word is a syntax error where a name is expected, never a
// variable: `length=2` and `if=1` do not assign.
const RESERVED_WORDS = new Set([
  SCALE_NAME,
  IBASE_NAME,
  OBASE_NAME,
  LAST_NAME,
  SQRT_NAME,
  'length',
  'read',
  'define',
  'auto',
  'return',
  'if',
  'else',
  'while',
  'for',
  'break',
  'continue',
  'halt',
  'quit',
  'print',
  'limits',
  'warranty',
])

// `A` to `Z` are digits worth 10 to 35, so `X` is the number 33 and
// `X=5` assigns to a constant, which is a syntax error.
const BASE_DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const DECIMAL_DIGITS = new Set('0123456789')
const DIGIT_CHARS = new Set(BASE_DIGITS)
const NUMBER_CHARS = new Set([...DIGIT_CHARS, '.'])
// ASCII only, matching `NAME_CHARS` in the python twin. A name is
// `[a-z][a-z0-9_]*`, so a leading `_` is not a name at all.
const NAME_START = new Set('abcdefghijklmnopqrstuvwxyz')
const NAME_CHARS = new Set([...NAME_START, ...DECIMAL_DIGITS, '_'])
// Every character GNU's lexer has a rule for. One outside this set is
// reported as an illegal character rather than a syntax error, which is
// why `@` and a stray `_` read differently from `)`.
const SYMBOL_CHARS = new Set('.+-*/%^=<>!()[]{},;')
const QUOTE_CHARS = new Set('"\\# \t')
const LEGAL_CHARS = new Set([...DIGIT_CHARS, ...NAME_START, ...SYMBOL_CHARS, ...QUOTE_CHARS])
const COMPOUND_OPS = '+-*/%^'
const BLANKS = new Set(' \t')
const STATEMENT_SEPARATOR = ';'
const LINE_COMMENT = '#'
const BLOCK_OPEN = '/*'
const BLOCK_CLOSE = '*/'
const STRING_QUOTE = '"'
// What `print` expands in a string. GNU writes nothing at all for an
// escape it has no rule for, dropping both characters, so `\z`, `\0`,
// `\e` and a backslash before the closing quote all vanish. A bare
// string statement is written raw and reaches none of this, which is why
// `"a\nb"` writes a backslash and an `n` where `print "a\nb"` breaks the
// line. The expansion is what reaches the output column, so a tab moves
// the fold one place rather than to the next tab stop, and the two
// source characters never count as two.
const PRINT_ESCAPES = new Map([
  ['a', '\x07'],
  ['b', '\b'],
  ['f', '\f'],
  ['n', '\n'],
  ['q', '"'],
  ['r', '\r'],
  ['t', '\t'],
  ['\\', '\\'],
])
// What a statement is trimmed of at both ends. Spelled out rather than
// left to `String.trim` / `str.strip`, whose sets differ between the two
// hosts; GNU's own whitespace is just space and tab, and it reports the
// other three as illegal characters, which is a separate divergence.
const TRIM_CHARS = ' \t\r\v\f'

// Hold a scale inside the range both hosts can render.
function clampScale(scale: number): number {
  return Math.max(0, Math.min(scale, MAX_SCALE))
}

// The integer bc reads a register or an exponent as, answering 0 for a
// value that is not finite: neither host can truncate an infinity or a
// NaN to an integer, and answering 0 in both is what keeps them in step.
function truncateInt(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.trunc(value)
}

// The `10.0 ** scale` the python twin computes. V8's `**` and CPython's
// float pow disagree by one ulp on 13 of the scales in range, and the
// last digit of a truncation rides on the factor, so it is read as a
// correctly-rounded literal instead. That matches CPython at every
// scale where CPython's own pow is correctly rounded, which is all of
// 0..100 but 23.
function powerOfTen(scale: number): number {
  return Number(`1e${String(scale)}`)
}

// Drop the digits past `scale`, rounding toward zero as bc does.
function truncateToScale(value: number, scale: number): number {
  const factor = powerOfTen(scale)
  const scaled = value * factor
  if (!Number.isFinite(scaled)) return value
  return Math.trunc(scaled) / factor
}

// The value of one input digit. GNU clamps every digit of a multi-digit
// literal to `ibase-1`, so `FF` is 99 at base 10, but leaves a
// single-digit literal alone, so `X` is 33.
// Where the string literal opening at `pos` ends: the offset just past
// the closing quote, or -1 when the input holds no second quote. A
// backslash never escapes the closing quote, so a literal ending in one
// closes there and the text after it is ordinary tokens again.
function stringEnd(text: string, pos: number): number {
  const close = text.indexOf(STRING_QUOTE, pos + 1)
  return close < 0 ? -1 : close + 1
}

// Expand the escapes `print` honours in a string literal's body, which
// arrives without its quotes. An escape GNU has no rule for writes
// nothing, and so does a trailing backslash.
function unescape(text: string): string {
  const out: string[] = []
  let pos = 0
  while (pos < text.length) {
    const char = text.charAt(pos)
    if (char !== '\\') {
      out.push(char)
      pos += 1
      continue
    }
    out.push(PRINT_ESCAPES.get(text.charAt(pos + 1)) ?? '')
    pos += 2
  }
  return out.join('')
}

function digitValue(char: string, ibase: number, clamp: boolean): number {
  const value = BASE_DIGITS.indexOf(char)
  if (clamp && value >= ibase) return ibase - 1
  return value
}

// Respell a base-ten literal with each digit's clamped value. Reading
// base ten through the host's own float parser rather than a digit loop
// keeps every literal correctly rounded, which is what makes `0.29*0.3`
// answer the same in both hosts.
function decimalText(whole: string, fraction: string, clamp: boolean): string {
  const before = Array.from(whole, (c) => String(digitValue(c, DEFAULT_BASE, clamp))).join('')
  const after = Array.from(fraction, (c) => String(digitValue(c, DEFAULT_BASE, clamp))).join('')
  return `${before === '' ? '0' : before}.${after === '' ? '0' : after}`
}

// Read one numeric literal written in the input base. A literal keeps
// its own scale whatever the global `scale` is, so `scale=0; 1.9` still
// prints `1.9`.
function readBaseNumber(raw: string, ibase: number): BcNumber {
  const dot = raw.indexOf('.')
  const whole = dot === -1 ? raw : raw.slice(0, dot)
  const fraction = dot === -1 ? '' : raw.slice(dot + 1)
  if (fraction.includes('.')) throw new BcParseError(SYNTAX_ERROR)
  const scale = clampScale(fraction.length)
  const clamp = whole.length + fraction.length > 1
  if (ibase === DEFAULT_BASE) {
    return { value: Number(decimalText(whole, fraction, clamp)), scale }
  }
  let value = 0
  for (const char of whole) value = value * ibase + digitValue(char, ibase, clamp)
  let factor = 1
  for (const char of fraction) {
    factor /= ibase
    value += digitValue(char, ibase, clamp) * factor
  }
  return { value, scale }
}

// Spell `value` with `scale` fractional digits, truncating. GNU
// truncates toward zero whenever it reduces a value to a scale; it never
// rounds and never floors, so `1.5*2.5` is `3.7`. Truncating the digits
// here is what makes that true: `toFixed` rounds, so `(3.75).toFixed(1)`
// prints `3.8`.
//
// The digits truncated are the *shortest* ones that read back as this
// float, not the float's full expansion. That is what keeps the
// operation stable: a value stored and printed again prints the same
// digits, where truncating the full expansion would turn the `.3` of
// `0.1+0.2` into `.2` the second time round.
// The first `digits` fractional digits of a value below one, exact. A
// double is a dyadic rational, so its decimal expansion is finite and
// can be truncated rather than rounded. `toFixed(MAX_SCALE)` and a slice
// cannot: that asks each host's formatter to round at the hundredth
// digit, and `toFixed` rounds half away from zero where python's
// formatting rounds half to even, so 2^-101 -- whose expansion is
// exactly 101 digits long, the last of them a 5 -- came out differently
// in the two. Truncating is also what GNU does whenever it reduces a
// value to a scale. Doubling to an integer is this host's spelling of
// python's `float.as_integer_ratio`, and is exact for the same reason:
// a power of two only moves the exponent.
function exactFraction(magnitude: number, digits: number): string {
  let scaled = magnitude
  let shift = 0n
  while (!Number.isInteger(scaled)) {
    scaled *= 2
    shift += 1n
  }
  const numerator = BigInt(scaled)
  const text = ((numerator * 10n ** BigInt(digits)) / (1n << shift)).toString()
  return text.padStart(digits, '0')
}

function fixedDigits(value: number, scale: number): string {
  const magnitude = Math.abs(value)
  let whole: string
  let fraction: string
  if (magnitude < PLAIN_MIN) {
    whole = '0'
    fraction = exactFraction(magnitude, MAX_SCALE)
  } else {
    let text: string
    if (magnitude < PLAIN_MAX) {
      text = String(magnitude)
    } else if (magnitude >= FIXED_MAX) {
      text = BigInt(magnitude).toString()
    } else {
      text = magnitude.toFixed(MAX_SCALE)
    }
    const dot = text.indexOf('.')
    whole = dot === -1 ? text : text.slice(0, dot)
    fraction = dot === -1 ? '' : text.slice(dot + 1)
  }
  const sign = value < 0 ? '-' : ''
  if (scale === 0) return `${sign}${whole}`
  return `${sign}${whole}.${fraction.slice(0, scale).padEnd(scale, '0')}`
}

// Cut a value down to the scale it carries. An assignment stores the
// reduced value, which is why raising `scale` after one cannot recover
// the digits a narrower scale dropped.
function reduceNumber(num: BcNumber): BcNumber {
  const scale = clampScale(num.scale)
  if (!Number.isFinite(num.value)) return { value: num.value, scale }
  return { value: Number(fixedDigits(num.value, scale)), scale }
}

// Spell an infinity or NaN as `String` spells it. GNU bc is exact and
// has no such value, so there is nothing to match against; matching the
// other host is what is left.
function nonfiniteText(value: number): string {
  return String(value)
}

// Spell one non-negative value in an output base other than ten, with no
// sign and no leading zero before a bare fraction. Up to base 16 a digit
// is one character; above it each digit becomes a space-separated
// decimal group, so 255 at base 100 is ` 02 55`.
function renderInBase(value: number, scale: number, obase: number): string {
  const base = BigInt(obase)
  let whole = BigInt(Math.trunc(value))
  let rest = value - Math.trunc(value)
  const before: number[] = []
  while (whole > 0n) {
    before.push(Number(whole % base))
    whole /= base
  }
  before.reverse()
  const after: number[] = []
  for (let i = 0; i < scale; i++) {
    rest *= obase
    const digit = Math.trunc(rest)
    after.push(digit)
    rest -= digit
  }
  let text: string
  if (obase <= MAX_CHAR_BASE) {
    text = before.map((d) => BASE_DIGITS.charAt(d)).join('')
    if (after.length > 0) text += '.' + after.map((d) => BASE_DIGITS.charAt(d)).join('')
  } else {
    const width = String(obase - 1).length
    text = before.map((d) => ' ' + String(d).padStart(width, '0')).join('')
    if (after.length > 0) {
      text += '.' + after.map((d) => ' ' + String(d).padStart(width, '0')).join('')
    }
  }
  return text === '' ? '0' : text
}

// Render one printed bc value. Two GNU spellings that are easy to miss:
// an exact zero prints as a bare `0` whatever the scale, and a value
// below one carries no leading zero, so `0.1+0.2` is `.3`, not `0.3`.
function renderNumber(num: BcNumber, obase: number): string {
  if (!Number.isFinite(num.value)) return nonfiniteText(num.value)
  const scale = clampScale(num.scale)
  const reduced = reduceNumber(num)
  if (reduced.value === 0) return '0'
  let text: string
  if (obase === DEFAULT_BASE) {
    text = fixedDigits(num.value, scale)
  } else {
    text = renderInBase(Math.abs(reduced.value), scale, obase)
    if (reduced.value < 0) text = '-' + text
  }
  if (text.startsWith('0.')) return text.slice(1)
  if (text.startsWith('-0.')) return '-' + text.slice(2)
  return text
}

// Read an integer from `text` the way C's `atoi` does. GNU reads
// `BC_LINE_LENGTH` with it, and it is lenient where a host's own integer
// parser is strict: it skips leading blanks, takes one optional sign,
// stops at the first character that is not a digit, and answers 0 when
// there was no digit at all -- so `abc`, an empty value and `0x46` all
// read as 0, which is what turns folding off. glibc's is `strtol`
// saturated to a signed 64-bit range and then truncated to an `int`, and
// both steps show: `4294967296` reads as 0 and `9223372036854775808`
// as -1.
function cAtoi(text: string): number {
  let at = 0
  while (at < text.length && C_BLANKS.includes(text.charAt(at))) at++
  const negative = text.charAt(at) === '-'
  if (negative || text.charAt(at) === '+') at++
  let digits = ''
  while (at < text.length && DECIMAL_DIGITS.has(text.charAt(at))) {
    digits += text.charAt(at)
    at++
  }
  if (digits === '') return 0
  let value = BigInt(digits)
  if (negative) value = -value
  const limit = 1n << (C_LONG_BITS - 1n)
  if (value > limit - 1n) value = limit - 1n
  if (value < -limit) value = -limit
  let low = value & ((1n << C_INT_BITS) - 1n)
  if (low >= 1n << (C_INT_BITS - 1n)) low -= 1n << C_INT_BITS
  return Number(low)
}

// GNU's `line_size`: how wide one output line may be, 0 for no folding.
function outputLineSize(env: Record<string, string> | undefined): number {
  const raw = env?.[LINE_LENGTH_VAR]
  if (raw === undefined) return DEFAULT_LINE_LENGTH
  const size = cAtoi(raw)
  if (size !== 0 && size < MIN_LINE_LENGTH) return DEFAULT_LINE_LENGTH
  return size
}

// Where the UTF-8 encoding of a code point changes width. GNU counts the
// bytes it writes, not the characters, so a two-byte `é` moves the fold
// twice as far as an `x`; derived from the code point rather than by
// encoding each character, so the two hosts count one number.
const UTF8_TWO_BYTES = 0x80
const UTF8_THREE_BYTES = 0x800
const UTF8_FOUR_BYTES = 0x10000

// How far one written character moves GNU's output column: its UTF-8
// byte length, 1 to 4.
function columnWidth(char: string): number {
  const point = char.codePointAt(0) ?? 0
  if (point < UTF8_TWO_BYTES) return 1
  if (point < UTF8_THREE_BYTES) return 2
  if (point < UTF8_FOUR_BYTES) return 3
  return 4
}

// GNU's `out_col`: how full the current output line is. One counter for
// the whole run, not one per value: `print` ends in no newline, so a
// string it wrote moves the column a later value folds at. Only written
// output folds; a diagnostic never does. A `lineSize` of 0 folds
// nothing, however long the output is.
class OutputColumn {
  col = 0
  constructor(private readonly lineSize: number) {}

  // Fold `text` into the output and advance the column, answering the
  // characters with a backslash and a newline at every break. A newline
  // in `text` starts the line over, so an expression statement's own
  // newline is what makes the next value begin at the left margin.
  write(text: string): string {
    const out: string[] = []
    for (const char of text) {
      if (char === '\n') {
        this.col = 0
        out.push(char)
        continue
      }
      const width = columnWidth(char)
      // A folded line carries `lineSize - 2` bytes and then a backslash,
      // so the default 70 puts 68 of them on a line and makes it 69
      // wide. A character that would cross that boundary moves whole to
      // the next line; GNU, writing one byte at a time, splits it there
      // instead and emits bytes that are no longer UTF-8. The fold lands
      // in the same place whenever a character does not straddle it,
      // which is every ASCII one. The `col !== 0` guard keeps a
      // character wider than the whole line from folding forever.
      if (this.lineSize !== 0 && this.col !== 0 && this.col + width > this.lineSize - 2) {
        out.push('\\\n')
        this.col = 0
      }
      out.push(char)
      this.col += width
    }
    return out.join('')
  }
}

// GNU's stderr line for a non-fatal runtime error or warning.
function runtimeLine(kind: string, reason: string): string {
  return `Runtime ${kind} (func=(main), adr=${String(RUNTIME_ERROR_ADDR)}): ${reason}`
}

function runtimeErrorLine(reason: string): string {
  return runtimeLine('error', reason)
}

function runtimeWarningLine(reason: string): string {
  return runtimeLine('warning', reason)
}

// GNU's stderr line for a parse diagnostic, whose line number counts
// from 1 per invocation.
function parseErrorLine(line: number, text: string): string {
  return `${INPUT_NAME} ${String(line)}: ${text}`
}

// Whether `name` can be assigned to or incremented: a register, or any
// non-reserved name.
function assignable(name: string): boolean {
  if (REGISTERS.has(name)) return true
  return name !== '' && !RESERVED_WORDS.has(name)
}

// The scale bc gives a sum or difference: the wider of the two operands.
function addScale(a: BcNumber, b: BcNumber): number {
  return clampScale(Math.max(a.scale, b.scale))
}

// The scale bc gives a product:
// `min(scale(a)+scale(b), max(scale, scale(a), scale(b)))`.
function mulScale(a: BcNumber, b: BcNumber, scale: number): number {
  return clampScale(Math.min(a.scale + b.scale, Math.max(scale, a.scale, b.scale)))
}

// The scale bc gives a power: the global scale for a negative exponent,
// otherwise `min(scale(a)*exponent, max(scale, scale(a)))`.
function powScale(a: BcNumber, exponent: number, scale: number): number {
  if (exponent < 0) return clampScale(scale)
  return clampScale(Math.min(a.scale * exponent, Math.max(scale, a.scale)))
}

// bc's `/`: truncate the quotient to the global scale.
function divide(a: BcNumber, b: BcNumber, scale: number): BcNumber {
  if (b.value === 0) throw new BcRuntimeError(DIVIDE_BY_ZERO)
  return { value: truncateToScale(a.value / b.value, scale), scale: clampScale(scale) }
}

// bc's `%`: `a - (a/b)*b`, with the quotient truncated to the global
// scale first, so the remainder takes the dividend's sign and `-7%2` is
// -1. JavaScript's own `%` agrees only at scale 0.
function modulo(a: BcNumber, b: BcNumber, scale: number): BcNumber {
  if (b.value === 0) throw new BcRuntimeError(MODULO_BY_ZERO)
  const quotient = truncateToScale(a.value / b.value, scale)
  return {
    value: a.value - quotient * b.value,
    scale: clampScale(Math.max(scale + b.scale, a.scale)),
  }
}

// Apply one arithmetic operator, scale rules included. The whole state
// rather than just the scale, because `^` warns: GNU reports an exponent
// that carries a scale before truncating it, and a warning is state the
// statement collects.
function applyBinary(op: string, a: BcNumber, b: BcNumber, state: BcState): BcNumber {
  const scale = state.scale
  if (op === '+') return { value: a.value + b.value, scale: addScale(a, b) }
  if (op === '-') return { value: a.value - b.value, scale: addScale(a, b) }
  if (op === '*') return { value: a.value * b.value, scale: mulScale(a, b, scale) }
  if (op === '/') return divide(a, b, scale)
  if (op === '%') return modulo(a, b, scale)
  const exponent = truncateInt(b.value)
  // Before the refusal a zero base raises, which is the order GNU
  // reports the two in for `0^-1.5`.
  if (b.scale !== 0) state.warnings.push(runtimeWarningLine(NONZERO_EXPONENT_SCALE))
  return { value: floatPow(a.value, exponent), scale: powScale(a, exponent, scale) }
}

// Apply one built-in or math-library function, at `max(scale, scale(arg))`.
function callFunction(name: string, arg: BcNumber, scale: number): BcNumber {
  const resultScale = clampScale(Math.max(scale, arg.scale))
  if (name === LOG_NAME && arg.value <= 0) {
    return { value: logDomainValue(clampScale(scale)), scale: resultScale }
  }
  const fn = name === SQRT_NAME ? bcSqrt : MATH_FUNCS.get(name)
  if (fn === undefined) throw new BcRuntimeError(`Function ${name} not defined.`)
  const value = fn(arg.value)
  // GNU's `bc_sqrt` short-circuits an argument of exactly one to its own
  // canonical one, which carries no scale, so `scale=100; sqrt(1)` prints
  // a bare `1` where `scale=5; sqrt(4)` prints `2.00000`. The rule is
  // narrower than "a perfect square": every other exact root is padded.
  // It compares the value, not the digits written, so `sqrt(1.00)` and
  // `sqrt(3/3)` are bare too, and GNU's `scale(sqrt(1))` is 0 rather
  // than the global scale.
  if (name === SQRT_NAME && arg.value === 1) return { value, scale: 0 }
  return { value, scale: resultScale }
}

// GNU's `length()`: the significant decimal digits in a value. The
// integer part's leading zeros do not count, so `length(0.5)` is 1 and
// `length(007)` is 1, while the fraction's do, so `length(0.05)` is 2. A
// zero carrying no fractional digits is 1 rather than 0. A value that is
// not finite answers 0: GNU is exact and has no infinity whose digits
// could be counted, so both hosts answer one agreed number instead.
function bcLength(num: BcNumber): number {
  if (!Number.isFinite(num.value)) return 0
  const scale = clampScale(num.scale)
  const text = fixedDigits(Math.abs(num.value), scale)
  const dot = text.indexOf('.')
  const whole = dot === -1 ? text : text.slice(0, dot)
  let start = 0
  while (start < whole.length && whole.charAt(start) === '0') start++
  const digits = whole.length - start + scale
  return digits === 0 ? 1 : digits
}

// Apply one builtin that needs no math library. `length` and `scale`
// answer a count, which is an integer at scale 0 whatever scale the
// argument carries.
function callBuiltin(name: string, arg: BcNumber, scale: number): BcNumber {
  if (name === LENGTH_NAME) return { value: bcLength(arg), scale: 0 }
  if (name === SCALE_NAME) return { value: clampScale(arg.scale), scale: 0 }
  return callFunction(SQRT_NAME, arg, scale)
}

// A recursive-descent parser for one bc statement, mirroring `Parser` in
// `bc.py` method for method so the two hosts accept and refuse the same
// lines.
class Parser {
  private pos = 0
  // `writes` holds already-rendered text and is owned by the caller, so
  // what a statement produced before a runtime error survives it:
  // `print "x", 1/0` writes the `x` GNU had already written when the
  // division refused.
  constructor(
    private readonly src: string,
    private readonly state: BcState,
    private readonly writes: string[],
  ) {}

  private skipBlanks(): void {
    while (this.pos < this.src.length && BLANKS.has(this.src.charAt(this.pos))) this.pos++
  }

  private peek(): string {
    this.skipBlanks()
    return this.src[this.pos] ?? ''
  }

  private consume(): string {
    const c = this.peek()
    this.pos++
    return c
  }

  private match(s: string): boolean {
    this.skipBlanks()
    if (this.src.startsWith(s, this.pos)) {
      this.pos += s.length
      return true
    }
    return false
  }

  // The diagnostic for whatever sits at the cursor: an illegal-character
  // report for a character GNU's lexer has no rule for, otherwise a
  // syntax error, marked incomplete when the input simply ran out.
  unexpected(): BcParseError {
    const c = this.peek()
    // A `"` the input never closes matches no lexer rule either, so it is
    // an illegal character where a closed one is an ordinary token in the
    // wrong place: `1+"a` reports the quote and `1+"a"` a syntax error.
    if (c === STRING_QUOTE && stringEnd(this.src, this.pos) < 0) {
      return new BcParseError(`${ILLEGAL_CHARACTER}: ${c}`, false, this.pos)
    }
    if (c !== '' && !LEGAL_CHARS.has(c)) {
      return new BcParseError(`${ILLEGAL_CHARACTER}: ${c}`, false, this.pos)
    }
    return new BcParseError(SYNTAX_ERROR, c === '', this.pos)
  }

  private readNumber(): BcNumber {
    const start = this.pos
    while (this.pos < this.src.length && NUMBER_CHARS.has(this.src.charAt(this.pos))) this.pos++
    try {
      return readBaseNumber(this.src.slice(start, this.pos), this.state.ibase)
    } catch (err) {
      if (err instanceof BcParseError) throw new BcParseError(err.text, err.incomplete, start)
      throw err
    }
  }

  private readIdentifier(): string {
    if (this.pos >= this.src.length || !NAME_START.has(this.src.charAt(this.pos))) return ''
    const start = this.pos
    this.pos++
    while (this.pos < this.src.length && NAME_CHARS.has(this.src.charAt(this.pos))) this.pos++
    return this.src.slice(start, this.pos)
  }

  // Render one value the moment the statement reaches it. GNU writes a
  // value where its own instruction runs, not at the end of the
  // statement, so everything an element changes before it is already in
  // force and everything a later element changes is not:
  // `print 255, obase=16` writes `255` and then `10`, and
  // `print 5, last` writes the 5 twice.
  private emit(num: BcNumber): string {
    this.state.last = reduceNumber(num)
    return renderNumber(num, this.state.obase)
  }

  private readString(): string {
    this.skipBlanks()
    const start = this.pos
    const end = stringEnd(this.src, start)
    if (end < 0) throw this.unexpected()
    this.pos = end
    return this.src.slice(start + 1, end - 1)
  }

  private readTarget(): string {
    this.skipBlanks()
    const name = this.readIdentifier()
    if (name !== '') return name
    if (
      this.src.charAt(this.pos) === LAST_ALIAS &&
      !DIGIT_CHARS.has(this.src.charAt(this.pos + 1))
    ) {
      this.pos += 1
      return LAST_ALIAS
    }
    return ''
  }

  // Parse one statement, appending whatever it writes. An assignment
  // writes nothing, which is why `x=5` prints where `(x=5)` does not; an
  // increment is not an assignment, so `x++` prints 5. Only an expression
  // statement writes a trailing newline, which is what leaves `print` and
  // a bare string mid-line.
  parseStatement(): void {
    if (this.isHalt()) throw new BcHalt()
    if (this.peek() === STRING_QUOTE) {
      // A bare string is written exactly as it was typed: GNU expands
      // escapes for `print` alone, so `"a\n"` writes a backslash and an
      // `n`. It does not touch `last` either.
      this.writes.push(this.readString())
      return
    }
    if (this.isPrint()) {
      this.parsePrint()
      return
    }
    const probe = this.tryAssignment()
    if (probe === null) {
      this.writes.push(this.emit(this.parseExpr()))
      this.writes.push('\n')
      return
    }
    const [name, op] = probe
    this.assign(name, op, this.parseExpr())
  }

  // A whole identifier, so `printx` stays an ordinary variable, and a
  // keyword rather than a name, so `print=1` and `1+print` are still
  // syntax errors on the reserved word.
  private isPrint(): boolean {
    const mark = this.pos
    this.skipBlanks()
    if (this.readIdentifier() === PRINT_NAME) return true
    this.pos = mark
    return false
  }

  // Each element is written as it is reached, so a refusal partway down
  // the list keeps what came before it. A string element is unescaped
  // where the same string alone is not, and an expression element prints
  // even when it is an assignment: `print x=5` writes 5 where the
  // statement `x=5` writes nothing.
  private parsePrint(): void {
    for (;;) {
      if (this.peek() === STRING_QUOTE) this.writes.push(unescape(this.readString()))
      else this.writes.push(this.emit(this.parseExpr()))
      if (!this.match(',')) return
    }
  }

  // `halt` is a statement, never part of an expression, so it only counts
  // when it is the whole statement: `halt 1+1`, `1+halt` and `x=halt` all
  // stay syntax errors on the reserved word.
  private isHalt(): boolean {
    const mark = this.pos
    this.skipBlanks()
    if (this.readIdentifier() === HALT_NAME && this.done()) return true
    this.pos = mark
    return false
  }

  private tryAssignment(): [string, string] | null {
    const mark = this.pos
    const name = this.readTarget()
    if (!assignable(name)) {
      this.pos = mark
      return null
    }
    this.skipBlanks()
    const rest = this.src.slice(this.pos)
    for (const op of COMPOUND_OPS) {
      if (rest.startsWith(`${op}=`)) {
        this.pos += 2
        return [name, op]
      }
    }
    // `x =- 2` is `=` then a negation, not the historical `-=`, so the
    // compound spellings are read before the bare `=` and never across
    // it.
    if (rest.startsWith('=') && !rest.startsWith('==')) {
      this.pos += 1
      return [name, '']
    }
    this.pos = mark
    return null
  }

  private assign(name: string, op: string, rhs: BcNumber): BcNumber {
    const value = op === '' ? rhs : applyBinary(op, this.readValue(name), rhs, this.state)
    this.store(name, value)
    return this.readValue(name)
  }

  private readValue(name: string): BcNumber {
    const state = this.state
    if (name === SCALE_NAME) return { value: state.scale, scale: 0 }
    if (name === IBASE_NAME) return { value: state.ibase, scale: 0 }
    if (name === OBASE_NAME) return { value: state.obase, scale: 0 }
    if (name === LAST_NAME || name === LAST_ALIAS) return state.last
    return state.variables.get(name) ?? ZERO
  }

  private store(name: string, num: BcNumber): void {
    const state = this.state
    let requested = truncateInt(num.value)
    if (name === SCALE_NAME) {
      if (requested < 0) {
        state.warnings.push(runtimeWarningLine(NEGATIVE_SCALE))
        requested = 0
      }
      state.scale = clampScale(requested)
      return
    }
    if (name === IBASE_NAME) {
      state.ibase = this.clampBase(requested, MAX_IBASE, IBASE_TOO_SMALL)
      return
    }
    if (name === OBASE_NAME) {
      state.obase = this.clampBase(requested, MAX_OBASE, OBASE_TOO_SMALL)
      return
    }
    // The stored value is already truncated, so raising `scale`
    // afterwards cannot recover digits a narrower scale dropped.
    if (name === LAST_NAME || name === LAST_ALIAS) {
      state.last = reduceNumber(num)
      return
    }
    state.variables.set(name, reduceNumber(num))
  }

  private clampBase(requested: number, ceiling: number, warning: string): number {
    if (requested < MIN_BASE) {
      this.state.warnings.push(runtimeWarningLine(warning))
      return MIN_BASE
    }
    return Math.min(requested, ceiling)
  }

  // Parse an expression, assignment included. Assignment is part of the
  // expression grammar, not just the statement one, which is why a bare
  // `x=5` prints nothing but `(x=5)` prints 5.
  parseExpr(): BcNumber {
    const probe = this.tryAssignment()
    if (probe === null) return this.parseAdditive()
    const [name, op] = probe
    return this.assign(name, op, this.parseExpr())
  }

  private parseAdditive(): BcNumber {
    let left = this.parseTerm()
    for (;;) {
      const c = this.peek()
      if (c !== '+' && c !== '-') return left
      // GNU's lexer reads `++` and `--` as one token each, so a doubled
      // sign is never an operator followed by a sign: `1++2` is refused
      // where `1+ +2` would be `1 + (+2)` if there were a unary `+`, and
      // there is not.
      if (this.src.startsWith(c + c, this.pos)) return left
      this.consume()
      left = applyBinary(c, left, this.parseTerm(), this.state)
    }
  }

  private parseTerm(): BcNumber {
    let left = this.parseUnary()
    for (;;) {
      const c = this.peek()
      if (c !== '*' && c !== '/' && c !== '%') return left
      this.consume()
      left = applyBinary(c, left, this.parseUnary(), this.state)
    }
  }

  private parseUnary(): BcNumber {
    if (this.match('++')) return this.parsePrefixStep(1)
    if (this.match('--')) return this.parsePrefixStep(-1)
    const c = this.peek()
    if (c === '-') {
      this.consume()
      const operand = this.parseUnary()
      return { value: -operand.value, scale: operand.scale }
    }
    // No unary `+`: GNU has no such operator, so `+5` is a syntax error
    // charged to its own line rather than an incomplete construct
    // charged to the next one.
    return this.parsePower()
  }

  private parsePrefixStep(delta: number): BcNumber {
    const name = this.readTarget()
    if (!assignable(name)) throw this.unexpected()
    const old = this.readValue(name)
    this.store(name, { value: old.value + delta, scale: old.scale })
    return this.readValue(name)
  }

  private parsePower(): BcNumber {
    const base = this.parseAtom()
    if (this.peek() !== '^') return base
    this.consume()
    return applyBinary('^', base, this.parseUnary(), this.state)
  }

  private parseAtom(): BcNumber {
    const c = this.peek()
    if (c === '(') {
      this.consume()
      const val = this.parseExpr()
      if (!this.match(')')) throw this.unexpected()
      return val
    }
    if (c === LAST_ALIAS) {
      if (DIGIT_CHARS.has(this.src.charAt(this.pos + 1))) return this.readNumber()
      return this.parseName()
    }
    if (DIGIT_CHARS.has(c)) return this.readNumber()
    if (NAME_START.has(c)) return this.parseName()
    throw this.unexpected()
  }

  private parseName(): BcNumber {
    this.skipBlanks()
    const start = this.pos
    const name = this.readTarget()
    if (BUILTIN_CALLS.has(name)) {
      if (this.peek() === '(') return this.parseBuiltinCall(name)
      if (name === SCALE_NAME) return this.parsePostfix(name)
      // A builtin with no `(` is a legal prefix, so GNU charges the
      // failure to the line after it: bare `length` and bare `sqrt`
      // report the next line where `length=2` reports their own.
      throw new BcParseError(SYNTAX_ERROR, this.peek() === '', start)
    }
    if (REGISTERS.has(name)) return this.parsePostfix(name)
    if (RESERVED_WORDS.has(name)) throw new BcParseError(SYNTAX_ERROR, false, start)
    if (this.match('(')) {
      const arg = this.parseExpr()
      if (!this.match(')')) throw this.unexpected()
      if (this.state.mathMode && MATH_FUNCS.has(name)) {
        return callFunction(name, arg, this.state.scale)
      }
      // GNU compiles the call and only then finds no such function, so
      // an unknown name is the runtime shape, with a trailing period.
      throw new BcRuntimeError(`Function ${name} not defined.`)
    }
    return this.parsePostfix(name)
  }

  private parseBuiltinCall(name: string): BcNumber {
    this.consume()
    const arg = this.parseExpr()
    if (!this.match(')')) throw this.unexpected()
    return callBuiltin(name, arg, this.state.scale)
  }

  private parsePostfix(name: string): BcNumber {
    // An undefined name reads as 0, silently; only writing to a reserved
    // word is an error.
    const value = this.readValue(name)
    if (this.match('++')) {
      this.store(name, { value: value.value + 1, scale: value.scale })
    } else if (this.match('--')) {
      this.store(name, { value: value.value - 1, scale: value.scale })
    }
    return value
  }

  // Whether the whole statement was consumed.
  done(): boolean {
    this.skipBlanks()
    return this.pos >= this.src.length
  }
}

// Evaluate one bc statement against the run's state, answering null for
// an assignment.
// Evaluate one statement, appending its output to `writes`. A refusal
// leaves behind whatever was written before it.
function evalStatement(text: string, state: BcState, writes: string[]): void {
  const parser = new Parser(text, state, writes)
  parser.parseStatement()
  if (!parser.done()) throw parser.unexpected()
}

// Whether `text` holds nothing but blanks a statement is trimmed of.
function allBlank(text: string): boolean {
  for (const char of text) {
    if (!TRIM_CHARS.includes(char)) return false
  }
  return true
}

// Drop the blanks at both ends of a statement and its line map. The map
// has to stay the same length as the text, so an offset still names a
// line.
function trimPiece(text: string, lines: readonly number[]): [string, number[]] {
  let start = 0
  let end = text.length
  while (start < end && TRIM_CHARS.includes(text.charAt(start))) start++
  while (end > start && TRIM_CHARS.includes(text.charAt(end - 1))) end--
  return [text.slice(start, end), lines.slice(start, end)]
}

// Where GNU's lexer meets a `quit` token on one input line, or -1. `quit`
// is read by the lexer, which exits the moment it reaches one, so nothing
// later on that line is ever scanned and the line itself never runs. Only
// a whole identifier counts, which is why `quitx` is an ordinary
// variable, and a `quit` inside a number or a string literal is not one.
function quitOffset(text: string): number {
  let pos = 0
  while (pos < text.length) {
    const char = text.charAt(pos)
    if (NAME_START.has(char)) {
      const start = pos
      pos++
      while (pos < text.length && NAME_CHARS.has(text.charAt(pos))) pos++
      if (text.slice(start, pos) === QUIT_NAME) return start
    } else if (NUMBER_CHARS.has(char)) {
      while (pos < text.length && NUMBER_CHARS.has(text.charAt(pos))) pos++
    } else if (char === STRING_QUOTE) {
      // An unterminated quote is one illegal character and scanning
      // resumes right after it, so a `quit` behind one still ends the run.
      const end = stringEnd(text, pos)
      pos = end < 0 ? pos + 1 : end
    } else {
      pos++
    }
  }
  return -1
}

// Trim one input line at the `quit` its lexer would exit on, answering
// whether the line quits. GNU hands `quit` to the parser, which ends the
// run on it as a whole statement and refuses it anywhere else, so the
// keyword is kept when something precedes it in its own statement
// (`1 quit` is a syntax error) and dropped when nothing does
// (`1+1;quit` is silent).
function cutAtQuit(text: string, lines: readonly number[]): [string, readonly number[], boolean] {
  const cut = quitOffset(text)
  if (cut < 0) return [text, lines, false]
  const before = text.slice(0, cut)
  const head = before.slice(before.lastIndexOf(STATEMENT_SEPARATOR) + 1)
  const end = allBlank(head) ? cut : cut + QUIT_NAME.length
  return [text.slice(0, end), lines.slice(0, end), true]
}

// Split one input line into statements, answering whether a `quit` on it
// ends the run.
function lineStatements(
  raw: string,
  rawLines: readonly number[],
  endLine: number,
): [BcStatement[], boolean] {
  const [text, lines, quits] = cutAtQuit(raw, rawLines)
  const out: BcStatement[] = []
  let start = 0
  let index = 0
  while (index <= text.length) {
    if (index < text.length) {
      const char = text.charAt(index)
      // A `;` inside a string is content, not a separator, so the whole
      // token is stepped over before the next one is looked for.
      if (char === STRING_QUOTE) {
        const end = stringEnd(text, index)
        index = end < 0 ? index + 1 : end
        continue
      }
      if (char !== STATEMENT_SEPARATOR) {
        index++
        continue
      }
    }
    const [piece, pieceLines] = trimPiece(text.slice(start, index), lines.slice(start, index))
    if (piece !== '') {
      // The token that follows decides where an incomplete construct is
      // charged: a `;` sits on the current line, while a newline has
      // already moved the counter on.
      const incompleteLine = index < text.length ? (lines[index] ?? endLine) : endLine + 1
      out.push({ text: piece, lines: pieceLines, incompleteLine, execute: !quits })
    }
    start = index + 1
    index++
  }
  return [out, quits]
}

// Read bc's input into the statements of each logical line, stripping
// its comments, and answer whether a block comment ran to the end of the
// input -- which GNU reports and which discards the statements it was
// reading. The grouping is what GNU runs as one unit: a whole
// `semicolon_list`, however many input lines a block comment stretched it
// over, so a parse error anywhere in a group discards the whole group.
//
// `#` runs to the end of its line and leaves the newline in place, so the
// newline still terminates the statement and the line counter still
// advances, which is what keeps a later diagnostic on the right line. A
// `/* */` comment becomes one space, so it separates tokens rather than
// vanishing (`1/*c*/2` is `1 2`), and the newlines inside one advance the
// counter without ending the statement. A string is neither: it is copied
// verbatim, so `"a#b"` keeps its hash and a string carrying a newline
// keeps the statement open across the line break.
function parseInput(text: string): [BcStatement[][], boolean] {
  const lines: BcStatement[][] = []
  let chars: string[] = []
  let charLines: number[] = []
  let pos = 0
  let line = 1
  while (pos < text.length) {
    const char = text.charAt(pos)
    if (char === STRING_QUOTE) {
      const end = stringEnd(text, pos)
      if (end > 0) {
        // The token is copied as it stands: a `#` or a `/*` in it is
        // content, and a newline in it advances the counter without
        // ending the logical line, so a diagnostic after a string that
        // spans lines still names its own line.
        for (let index = pos; index < end; index++) {
          const inner = text.charAt(index)
          chars.push(inner)
          charLines.push(line)
          if (inner === '\n') line++
        }
        pos = end
        continue
      }
      // No closing quote anywhere: the parser reports this one as an
      // illegal character, and the rest of the input lexes as usual,
      // comments included.
    }
    if (char === LINE_COMMENT) {
      while (pos < text.length && text.charAt(pos) !== '\n') pos++
      continue
    }
    if (text.startsWith(BLOCK_OPEN, pos)) {
      pos += BLOCK_OPEN.length
      while (pos < text.length && !text.startsWith(BLOCK_CLOSE, pos)) {
        if (text.charAt(pos) === '\n') line++
        pos++
      }
      if (pos >= text.length) return [lines, true]
      pos += BLOCK_CLOSE.length
      chars.push(' ')
      charLines.push(line)
      continue
    }
    if (char === '\n') {
      const [found, quits] = lineStatements(chars.join(''), charLines, line)
      if (found.length > 0) lines.push(found)
      if (quits) return [lines, false]
      chars = []
      charLines = []
      line++
      pos++
      continue
    }
    chars.push(char)
    charLines.push(line)
    pos++
  }
  const [found] = lineStatements(chars.join(''), charLines, line)
  if (found.length > 0) lines.push(found)
  return [lines, false]
}

// Copy the state a discarded line has to be rolled back to. GNU compiles
// a whole line and runs it only if all of it parsed, so a parse error
// anywhere on the line undoes every write the line made: `x=5;1 2` leaves
// `x` unset and `ibase=1;1 2` leaves `ibase` at ten. The warnings list is
// not copied, because a line's warnings are buffered by the caller rather
// than kept on the state.
function snapshotState(state: BcState): BcState {
  return {
    scale: state.scale,
    mathMode: state.mathMode,
    ibase: state.ibase,
    obase: state.obase,
    last: state.last,
    variables: new Map(state.variables),
    warnings: [],
  }
}

// Undo every write a discarded line made, in place, because the parser
// holds a reference to the live state.
function restoreState(state: BcState, saved: BcState): void {
  state.scale = saved.scale
  state.ibase = saved.ibase
  state.obase = saved.obase
  state.last = saved.last
  state.variables = new Map(saved.variables)
}

// The input line GNU charges a parse diagnostic to: an incomplete
// construct goes to the line its own terminator sits on, anything else to
// the line the offending character sits on.
function errorLine(statement: BcStatement, error: BcParseError): number {
  if (error.incomplete) return statement.incompleteLine
  return statement.lines[error.pos] ?? statement.lines[0] ?? statement.incompleteLine
}

async function bcCommand(
  _accessor: Accessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const fl = new FlagView(opts.flags, specOf('bc'))
  // -l is short-only, so it lands on the disambiguated `args_l` dest
  // (`AMBIGUOUS_NAMES`); a plain `l` key is one the parser never emits.
  const useMath = fl.asBool('args_l')
  const raw = (await readStdinAsync(opts.stdin)) ?? new Uint8Array(0)
  const state: BcState = {
    scale: useMath ? MATH_LIBRARY_SCALE : 0,
    mathMode: useMath,
    ibase: DEFAULT_BASE,
    obase: DEFAULT_BASE,
    last: ZERO,
    variables: new Map<string, BcNumber>(),
    warnings: [],
  }
  const folder = new OutputColumn(outputLineSize(opts.env))
  const results: string[] = []
  const errors: string[] = []
  const [lines, eofInComment] = parseInput(DEC.decode(raw))
  let halted = false
  for (const statements of lines) {
    // GNU compiles one whole line and runs it at its newline, so a parse
    // error anywhere on the line means none of it ever ran: the values,
    // the runtime errors, the warnings and every write are buffered here
    // and thrown away if any statement refused to parse. The parse
    // diagnostics themselves are not buffered -- GNU reports one per bad
    // statement even on a line it discards.
    const saved = snapshotState(state)
    const savedCol = folder.col
    const lineResults: string[] = []
    const lineErrors: string[] = []
    const parseErrors: string[] = []
    // A runtime error is fatal to the rest of its own line and non-fatal
    // to every later one, so `1/0;2+2` prints nothing and `1/0\n2+2\n`
    // prints 4. It does not roll the line back the way a parse error
    // does: `x=5;1/0;y=7` leaves `x` at 5 and `y` unset.
    let aborted = false
    for (const statement of statements) {
      // A statement after a `halt`, after a runtime error, or on a line a
      // `quit` cut short is still parsed -- GNU compiles the whole line
      // before running any of it, which is where `1+1;halt;1 2`'s syntax
      // error comes from -- but never runs.
      const runs: boolean = statement.execute && !halted && !aborted
      // One that does not run is parsed against a throwaway copy, so it
      // cannot write: GNU never executes it, and `x=5;1/0;y=7` has to
      // leave `y` unset while leaving `x` at 5.
      const target = runs ? state : snapshotState(state)
      // Owned here rather than inside the parser, so that a runtime error
      // partway down a `print` list keeps the text already written:
      // `print "x", 1/0` writes the `x`.
      const writes: string[] = []
      try {
        evalStatement(statement.text, target, writes)
      } catch (err) {
        if (err instanceof BcParseError) {
          parseErrors.push(parseErrorLine(errorLine(statement, err), err.text))
        } else if (err instanceof BcRuntimeError) {
          // Reported unless the line turns out to be discarded, which is
          // why it is buffered: `1/0;2+2` reports the division where
          // `1/0;1 2` reports only the syntax error.
          if (runs) {
            // Warnings the same statement already raised come first:
            // `0^-1.5` warns about the exponent's scale and then
            // refuses, in that order.
            lineErrors.push(...state.warnings)
            state.warnings.length = 0
            lineErrors.push(runtimeErrorLine(err.message))
            aborted = true
          }
        } else if (err instanceof BcHalt) {
          // `halt` ends the run where it is reached, so everything
          // earlier on its line has already printed.
          halted = runs
        } else {
          throw err
        }
      }
      if (runs) lineErrors.push(...state.warnings)
      state.warnings.length = 0
      if (!runs) continue
      // The one place output is folded. Rendering happened as each element
      // was reached, in `Parser.emit`, because GNU's `obase` and `last`
      // can both change partway down a `print` list.
      for (const piece of writes) lineResults.push(folder.write(piece))
    }
    if (parseErrors.length > 0) {
      // None of the line ran, so a `halt` on it did not run either, and
      // the column never moved: GNU compiles the line before it writes
      // anything, so a later statement's syntax error undoes an earlier
      // one's `print`.
      errors.push(...parseErrors)
      restoreState(state, saved)
      folder.col = savedCol
      halted = false
      continue
    }
    errors.push(...lineErrors)
    results.push(...lineResults)
    if (halted) break
  }
  if (eofInComment) errors.push(EOF_IN_COMMENT)
  const stdout = ENC.encode(results.join(''))
  const stderr = errors.length > 0 ? ENC.encode(errors.join('\n') + '\n') : null
  return [stdout, new IOResult({ stderr })]
}

export const GENERAL_BC = command({
  name: 'bc',
  vfs: null,
  spec: specOf('bc'),
  fn: bcCommand,
  provision: pureProvision,
})
