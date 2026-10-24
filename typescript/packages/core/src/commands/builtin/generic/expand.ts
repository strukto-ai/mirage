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

import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { type FlagValue } from '../../spec/types.ts'
import { IOResult } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import type { CommandFnResult, Context } from '../../config.ts'
import { stdinStream } from '../utils/stream.ts'
import { reportedStream } from '../utils/operands.ts'
import { asyncChain } from '../../../io/stream.ts'
import { quoteText } from '../../quote.ts'
import { boundedDecimal } from '../utils/strtol.ts'
import { runStream } from '../../../rs/stream.ts'
import type { JsonValue } from '../../../types.ts'

const ENC = new TextEncoder()

// A tab stop's digits are ASCII only: GNU reports U+0663 and the other
// non-ASCII digits as invalid characters, which a unicode-aware test (a `\d`
// class with the `u` flag, JavaScript's `Number.parseInt` on a full-width
// digit) would accept.
const DIGITS = new Set(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'])

// What may lead a number to make it a size rather than a stop.
const SPECIFIERS = new Set(['+', '/'])

// GNU 9.7 refuses a tab stop at or past 2**63, quoting its digits as typed:
// `-t 9223372036854775807` is accepted and `-t 9223372036854775808` is "tab
// stop is too large '9223372036854775808'".
const TOO_LARGE = 2n ** 63n

// `isblank` in the C locale, which is space and TAB and nothing else. A
// newline, a carriage return, a vertical tab and a form feed are all invalid
// characters rather than separators.
const BLANKS = new Set([' ', '\t'])

// One resolved -t/--tabs list.
//
// Three independent pieces, because `-t 2,/4` and `-t 2,+4` differ only in
// which of the last two is set. `stops` are the explicit columns in the order
// typed (validated ascending and non-zero); `extend` is `/N`'s "round up to a
// multiple of N" beyond them and `increment` is `+N`'s "add N to the last
// stop, repeatedly". All-empty means the default size 8.
export interface TabStops {
  readonly stops: readonly number[]
  readonly extend: number
  readonly increment: number
}

export interface ExpandFlags {
  readonly tabs: TabStops
  readonly initialOnly: boolean
}

// The tab list as the -t values read so far have built it: the explicit stops
// in typed order, `/N`'s and `+N`'s sizes (0 when unset) and the diagnostic
// lines so far. The stops and the two sizes carry over from one -t to the
// next; what a single value is in the middle of does not (see readTabList).
// The stops stay bigints until the walk has compared them: 2**63 - 2 and
// 2**63 - 1 are ascending and the same double. Mirrors Python's _TabList.
interface TabList {
  readonly prog: string
  stops: bigint[]
  extend: number
  increment: number
  problems: string[]
}

function invalid(prog: string, rest: string): string {
  return `${prog}: tab size contains invalid character(s): '${quoteText(rest)}'`
}

// Settle one number of a -t value: the character that set a size, or null
// when the number is refused (the line is in `tabs.problems`). A number led by
// `/` or `+` (or by one still waiting from an earlier element of the same
// value, `-t 1,+0,3` making 3 the increment) sets that size; `/` wins over `+`
// when both lead it. A zero sets nothing and leaves the specifier waiting, so
// `-t +0,0,0` is the default 8. Measured on GNU 9.7:
//
//   * a size set twice is refused, even by a zero: `-t +4 -t +0` is "'+'
//     specifier only allowed with the last value";
//   * the other size is refused only by a nonzero value: `-t +4 -t /0` is
//     accepted and `-t +4 -t /3` is "'/' specifier is mutually exclusive with
//     '+'", in either order;
//   * a plain number after a size in the same value is refused, naming the
//     specifier character typed last (`-t /+4,2` names `+`), while `-t +4 -t
//     2` is two values and accepted.
//
// `waiting` holds the specifier characters waiting for a value and is emptied
// once one is set; `given` is the character that set a size earlier in this
// value, or empty. Mirrors Python's _give_value.
function giveValue(tabs: TabList, value: bigint, waiting: string[], given: string): string | null {
  if (waiting.length === 0) {
    if (given !== '') {
      tabs.problems.push(`${tabs.prog}: '${given}' specifier only allowed with the last value`)
      return null
    }
    tabs.stops.push(value)
    return given
  }
  const size = waiting.includes('/') ? '/' : '+'
  if ((size === '/' ? tabs.extend : tabs.increment) !== 0) {
    tabs.problems.push(`${tabs.prog}: '${size}' specifier only allowed with the last value`)
    return null
  }
  if (value === 0n) return given
  if ((size === '/' ? tabs.increment : tabs.extend) !== 0) {
    tabs.problems.push(`${tabs.prog}: '/' specifier is mutually exclusive with '+'`)
    return null
  }
  if (size === '/') tabs.extend = Number(value)
  else tabs.increment = Number(value)
  const named = waiting[waiting.length - 1] ?? size
  waiting.length = 0
  return named
}

// One number of a -t value, from its first digit at `at` to its end: where it
// ends, its value (null when a digit run was too large) and the specifier
// characters misplaced inside it; null when an invalid character ended the
// parse. Mirrors Python's _read_number.
function readNumber(
  raw: string,
  at: number,
  tabs: TabList,
): [number, bigint | null, string[]] | null {
  let digits = ''
  const misplaced: string[] = []
  let oversized = false
  while (at < raw.length && raw[at] !== ',' && !BLANKS.has(raw.charAt(at))) {
    const char = raw.charAt(at)
    if (SPECIFIERS.has(char)) {
      tabs.problems.push(
        `${tabs.prog}: '${char}' specifier not at start of number: '${quoteText(raw.slice(at))}'`,
      )
      misplaced.push(char)
      at++
      continue
    }
    if (!DIGITS.has(char)) {
      tabs.problems.push(invalid(tabs.prog, raw.slice(at)))
      return null
    }
    const run = at
    while (at < raw.length && DIGITS.has(raw.charAt(at))) at++
    if (boundedDecimal(raw.slice(run, at), TOO_LARGE) === null) {
      tabs.problems.push(`${tabs.prog}: tab stop is too large '${quoteText(raw.slice(run, at))}'`)
      oversized = true
    }
    digits += raw.slice(run, at)
  }
  return [at, oversized ? null : BigInt(digits), misplaced]
}

// Read one -t value into `tabs`, false when the parse ended here. Numbers are
// split by commas and blanks (`isblank` in C: space and TAB), and an empty
// element is skipped. A `/` or `+` after a number's first digit is reported
// with the rest of the value and the scan goes on (`-t 4+5+6` reports '+5+6'
// and then '+6'), the character then leading the next number instead, so
// `-t 4+5,6,7` goes on to refuse the 7 as GNU does. A digit run at or past
// 2**63 is reported and the scan goes on too (`-t 99999999999999999999,x`
// reports both). Either leaves the list refused. Any other character ends the
// whole parse, quoting the rest of the value (`-t 1,x,0` reports 'x,0').
// Mirrors Python's _read_tab_list.
function readTabList(raw: string, tabs: TabList): boolean {
  const waiting: string[] = []
  let given = ''
  let at = 0
  while (at < raw.length) {
    const char = raw.charAt(at)
    if (char === ',' || BLANKS.has(char)) {
      at++
      continue
    }
    if (SPECIFIERS.has(char)) {
      waiting.push(char)
      at++
      continue
    }
    if (!DIGITS.has(char)) {
      tabs.problems.push(invalid(tabs.prog, raw.slice(at)))
      return false
    }
    const number = readNumber(raw, at, tabs)
    if (number === null) return false
    const [end, value, misplaced] = number
    at = end
    if (value !== null) {
      const named = giveValue(tabs, value, waiting, given)
      if (named === null) return false
      given = named
    }
    waiting.push(...misplaced)
  }
  return true
}

// GNU's walk over the explicit stops, once every value has scanned: the one
// diagnostic line, or null when they pass. Each stop is tested for zero before
// it is tested against the one before it, so `-t 3,0` cannot be 0 and
// `-t 3,1,0` must be ascending. Mirrors Python's _refused_order.
function refusedOrder(prog: string, stops: readonly bigint[]): string | null {
  let previous = 0n
  for (const stop of stops) {
    if (stop === 0n) return `${prog}: tab size cannot be 0`
    if (stop <= previous) return `${prog}: tab sizes must be ascending`
    previous = stop
  }
  return null
}

// Every -t/--tabs value one line carried, as one tab list. GNU takes a LIST of
// tab stops, not a single size, and -t accumulates across occurrences, so this
// is handed every occurrence in typed order rather than the one value the flag
// bag kept. A value that leaves any problem ends the parse there: `-t 4+ -t x`
// reports only the '+'. Returns the stderr text (one newline-terminated line
// per problem) instead of the list when GNU refuses it. unexpand reads its list
// the same way, in its own name.
export function readTabStops(occurrences: readonly string[], prog = 'expand'): TabStops | string {
  const tabs: TabList = { prog, stops: [], extend: 0, increment: 0, problems: [] }
  for (const raw of occurrences) {
    if (!readTabList(raw, tabs) || tabs.problems.length > 0) {
      return tabs.problems.map((line) => `${line}\n`).join('')
    }
  }
  const refused = refusedOrder(prog, tabs.stops)
  if (refused !== null) return `${refused}\n`
  return { stops: tabs.stops.map(Number), extend: tabs.extend, increment: tabs.increment }
}

// Read expand's flags once, refusing a tab list GNU refuses. `-t`
// accumulates across occurrences, so it is declared `multiple` and read as
// the list it typed.
export function parseFlags(bag: Record<string, FlagValue>): ExpandFlags | string {
  const fl = new FlagView(bag, specOf('expand'))
  const tabs = readTabStops(fl.asList('tabs'))
  if (typeof tabs === 'string') return tabs
  return { tabs, initialOnly: fl.asBool('initial') }
}

// The tab list as the expand and unexpand streams take it. Mirrors Python's
// tab_config.
export function tabConfig(tabs: TabStops): Record<string, JsonValue> {
  return { stops: [...tabs.stops], extend: tabs.extend, increment: tabs.increment }
}

export function expandGeneric(
  paths: PathSpec[],
  ctx: Context,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
): CommandFnResult {
  stream = stdinStream(stream, ctx.stdin)
  const parsed = parseFlags(ctx.flags)
  if (typeof parsed === 'string') {
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(parsed) })]
  }
  const io = new IOResult()
  const sources = paths.map((p) => reportedStream(stream(p), io, p, 'expand'))
  const config = { tabs: tabConfig(parsed.tabs), initial_only: parsed.initialOnly }
  const source = paths.length > 0 ? asyncChain(sources) : (ctx.stdin ?? new Uint8Array())
  return [runStream('expand', config, source, ctx.signal), io]
}
