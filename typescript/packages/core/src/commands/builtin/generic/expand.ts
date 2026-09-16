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
import { FlagView, type FlagValue } from '../../spec/types.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { readStdinAsync } from '../utils/stream.ts'
import { operandsIo, readOperands } from '../utils/operands.ts'
import { quoteText } from '../../quote.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

// GNU's scanner is `c_isdigit`, which is ASCII. A unicode-aware test (a `\d`
// class with the `u` flag, JavaScript's `Number.parseInt` on a full-width
// digit) accepts U+0663 and friends, which GNU reports as invalid characters.
const DIGITS = new Set(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'])

// `isblank` in the C locale, which is space and TAB and nothing else. A
// newline, a carriage return, a vertical tab and a form feed are all invalid
// characters rather than separators.
const BLANKS = new Set([' ', '\t'])

// The accumulator GNU overflows: a tab stop is read into `uintmax_t`. Held as
// a bigint because the scan has to compare past Number.MAX_SAFE_INTEGER.
const UINTMAX_MAX = 18446744073709551615n

const DEFAULT_TAB_SIZE = 8

// One resolved -t/--tabs list, as gnulib models it.
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

// The state gnulib keeps ACROSS -t occurrences.
//
// `-t 2,4 -t 6` is byte-identical to `-t 2,4,6` and `-t 6 -t 2,4` refuses as
// non-ascending, so the stop list and the two specifier sizes outlive one
// occurrence. What does NOT outlive it is the per-scan state (a pending
// value, having seen `/` or `+`), which is why `-t '+4,2'` refuses but
// `-t +4 -t 2` does not.
interface TabAccumulator {
  stops: number[]
  extend: number
  increment: number
  problems: string[]
}

// Commit one scanned number, as `/`, `+` or an ordinary stop.
//
// `/` wins when both specifiers were seen, matching GNU's `if (extend) ...
// else if (increment) ...`. Either setter refuses a SECOND non-zero value,
// which is how `-t '+4,2'` and `-t +4 -t +5` are reported: the value 0 leaves
// the specifier unset, so `-t '+0,1'` is accepted and means an increment of 1.
function flushStop(
  acc: TabAccumulator,
  value: number,
  sawExtend: boolean,
  sawIncrement: boolean,
): void {
  if (sawExtend) {
    if (acc.extend !== 0) {
      acc.problems.push("expand: '/' specifier only allowed with the last value")
    }
    acc.extend = value
    return
  }
  if (sawIncrement) {
    if (acc.increment !== 0) {
      acc.problems.push("expand: '+' specifier only allowed with the last value")
    }
    acc.increment = value
    return
  }
  acc.stops.push(value)
}

// GNU's two post-scan refusals, in the order it applies them.
//
// The list is walked in order and each element is tested for zero BEFORE it is
// tested for ascending, which is the only thing that tells the two messages
// apart on a list that breaks both rules: `-t 3,0` is `cannot be 0`
// (element 0 is zero) while `-t 3,1,0` is `must be ascending` (element 1 fails
// first). Both run only when the scan reported nothing at all, so `-t 0,x`
// names the `x` and never the zero.
function checkStops(stops: readonly number[]): string | null {
  let previous = 0
  for (const stop of stops) {
    if (stop === 0) return 'expand: tab size cannot be 0'
    if (stop <= previous) return 'expand: tab sizes must be ascending'
    previous = stop
  }
  return null
}

// Scan one -t occurrence, gnulib's parse_tab_stops.
//
// Character by character, because every one of GNU's messages quotes a
// position rather than the argument: an invalid character and a misplaced
// specifier both quote the remainder FROM that character (`-t 1,x` reports
// 'x' where `-t x,1` reports 'x,1'), and an overflowing number quotes its own
// digit run. An empty element is skipped in silence, which is why `-t ''`,
// `-t ','` and `-t '1,,3'` are all accepted.
//
// ONE thing ends the scan and two do not. An invalid character breaks it where
// it stands, so nothing to its right is read and `-t '1,x,0'` reports only the
// `x,0`. A misplaced `/`/`+` does NOT: it is reported and the scan carries on,
// so `-t 4+5+6` prints two misplaced lines and `-t 4+x` prints the misplaced
// one and then the invalid-character one. Neither does an overflowing digit
// run, so `-t '99999999999999999999,x'` reports both lines. Any of them makes
// the caller skip checkStops, which is why `-t '1,99999999999999999999,0'`
// never mentions the zero.
function scanTabStops(raw: string, acc: TabAccumulator): void {
  let have = false
  let value = 0n
  let digitsAt = 0
  let sawExtend = false
  let sawIncrement = false
  let index = 0
  while (index < raw.length) {
    const char = raw[index] ?? ''
    if (char === '/' || char === '+') {
      if (have) {
        // Reported and then CONTINUED, unlike an invalid character:
        // `-t 4+5+6` prints TWO misplaced-specifier lines and `-t 4+x`
        // prints the misplaced one and then the invalid-character one. The
        // specifier is not recorded either, so the `4` in `-t '4+,x'` still
        // flushes as an ordinary stop.
        acc.problems.push(
          `expand: '${char}' specifier not at start of number: '${quoteText(raw.slice(index))}'`,
        )
      } else {
        sawExtend = sawExtend || char === '/'
        sawIncrement = sawIncrement || char === '+'
      }
    } else if (DIGITS.has(char)) {
      if (!have) {
        value = 0n
        have = true
        digitsAt = index
      }
      value = value * 10n + BigInt(char)
      if (value > UINTMAX_MAX) {
        let end = index
        while (end < raw.length && DIGITS.has(raw[end] ?? '')) end += 1
        acc.problems.push(`expand: tab stop is too large '${quoteText(raw.slice(digitsAt, end))}'`)
        index = end - 1
      }
    } else if (char === ',' || BLANKS.has(char)) {
      if (have) {
        flushStop(acc, Number(value), sawExtend, sawIncrement)
        have = false
      }
    } else {
      acc.problems.push(
        `expand: tab size contains invalid character(s): '${quoteText(raw.slice(index))}'`,
      )
      return
    }
    index += 1
  }
  if (have && acc.problems.length === 0) {
    flushStop(acc, Number(value), sawExtend, sawIncrement)
  }
}

// Every -t/--tabs value one line carried, as one tab list.
//
// GNU takes a LIST of tab stops, not a single size, and -t accumulates across
// occurrences, so this is handed every occurrence in typed order rather than
// the one value the flag bag kept. Returns the stderr text (one
// newline-terminated line per problem) instead of the list when GNU refuses.
export function parseTabStops(occurrences: readonly string[]): TabStops | string {
  const acc: TabAccumulator = { stops: [], extend: 0, increment: 0, problems: [] }
  for (const raw of occurrences) scanTabStops(raw, acc)
  if (acc.problems.length > 0) return acc.problems.map((line) => `${line}\n`).join('')
  const bad = checkStops(acc.stops)
  if (bad !== null) return `${bad}\n`
  return { stops: acc.stops, extend: acc.extend, increment: acc.increment }
}

// Read expand's flags once, refusing a tab list GNU refuses.
export function parseFlags(bag: Record<string, FlagValue>): ExpandFlags | string {
  const fl = new FlagView(bag, specOf('expand'))
  const occurrences = fl.valueOccurrences('tabs').map(([, raw]) => raw)
  const tabs = parseTabStops(occurrences)
  if (typeof tabs === 'string') return tabs
  return { tabs, initialOnly: fl.asBool('initial') }
}

// The column a TAB in `column` pads to.
//
// The chosen stop is the first one STRICTLY greater than the current column,
// so a TAB sitting exactly on a stop takes the next one (`expand -t 2,5`
// turns `ab\tc` into `ab` and three blanks). Past the last explicit stop GNU
// has four different answers and they are all observable:
//
//   * `/N` rounds up to a strictly greater multiple of N.
//   * `+N` adds N to the last explicit stop, repeatedly.
//   * ONE explicit stop repeats as a tab SIZE, which is what makes `-t 3`
//     mean 3, 6, 9 and not "one stop at 3".
//   * SEVERAL explicit stops give exactly one blank, forever, so `-t 5,9`
//     pads column 10 by one where `-t 5` pads it by five.
//
// No stops and neither specifier is the default size 8.
export function nextTabStop(tabs: TabStops, column: number): number {
  for (const stop of tabs.stops) {
    if (stop > column) return stop
  }
  if (tabs.extend !== 0) return column + tabs.extend - (column % tabs.extend)
  if (tabs.increment !== 0) {
    const last = tabs.stops.length > 0 ? (tabs.stops[tabs.stops.length - 1] ?? 0) : 0
    return last + tabs.increment * (Math.floor((column - last) / tabs.increment) + 1)
  }
  if (tabs.stops.length === 1) {
    const size = tabs.stops[0] ?? DEFAULT_TAB_SIZE
    return column + size - (column % size)
  }
  if (tabs.stops.length > 0) return column + 1
  return column + DEFAULT_TAB_SIZE - (column % DEFAULT_TAB_SIZE)
}

// Replace every TAB with blanks up to its tab stop.
//
// Only a NEWLINE resets the column, and only a BACKSPACE moves it left. A
// carriage return does neither: `printf 'a\r\tb\n' | expand` pads by six,
// not eight, because the `\r` advanced the column to 2 like any other
// character.
//
// Backspace decrements, floored at 0, so `printf 'a\bb\tX\n'` pads by
// seven (column 1, 0, 1) while `printf '\b\tX\n'` pads by eight -- three
// leading backspaces still leave column 0. It composes with the tab-stop
// list like any other column, which is why it is one branch here and not a
// special case: under `-t 1,3` the same input pads by two, the first stop
// past column 1. `\v` and `\f` are ordinary and advance. Measured,
// ground truth NL3-E.
function expandTabs(text: string, tabs: TabStops): string {
  const out: string[] = []
  let col = 0
  for (const ch of text) {
    if (ch === '\t') {
      const target = nextTabStop(tabs, col)
      out.push(' '.repeat(target - col))
      col = target
    } else if (ch === '\n') {
      out.push(ch)
      col = 0
    } else if (ch === '\b') {
      out.push(ch)
      col = Math.max(col - 1, 0)
    } else {
      out.push(ch)
      col += 1
    }
  }
  return out.join('')
}

// -i: expand only the blanks before a line's first other byte.
function expandLeadingTabs(text: string, tabs: TabStops): string {
  const result: string[] = []
  for (const line of text.split('\n')) {
    let i = 0
    while (i < line.length && BLANKS.has(line[i] ?? '')) i += 1
    if (i === 0) {
      result.push(line)
    } else {
      result.push(expandTabs(line.slice(0, i), tabs) + line.slice(i))
    }
  }
  return result.join('\n')
}

export function applyExpand(txt: string, tabs: TabStops, initialOnly: boolean): string {
  return initialOnly ? expandLeadingTabs(txt, tabs) : expandTabs(txt, tabs)
}

export async function expandGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
): Promise<CommandFnResult> {
  const parsed = parseFlags(opts.flags)
  if (typeof parsed === 'string') {
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(parsed) })]
  }
  const { tabs, initialOnly } = parsed
  if (paths.length > 0) {
    // A missing operand is reported and skipped; the remaining operands
    // still expand (GNU expand).
    const [ok, err] = await readOperands(paths, stream, 'expand')
    const io = operandsIo(err)
    if (ok.length === 0 && err !== '') return [null, io]
    const parts: string[] = []
    for (const o of ok) {
      parts.push(applyExpand(DEC.decode(o.data), tabs, initialOnly))
    }
    const result: ByteSource = ENC.encode(parts.join(''))
    return [result, io]
  }
  const stdinData = await readStdinAsync(opts.stdin)
  if (stdinData === null) {
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode('expand: missing operand\n') })]
  }
  const text = DEC.decode(stdinData)
  const result: ByteSource = ENC.encode(applyExpand(text, tabs, initialOnly))
  return [result, new IOResult()]
}
