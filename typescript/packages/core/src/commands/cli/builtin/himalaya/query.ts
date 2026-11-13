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

import { MONTHS } from '../../../builtin/utils/constants.ts'
import type { fetchMessage } from '../../../../core/email/client.ts'
import { quoteString } from '../../../../core/email/client.ts'
import { displayWidth } from '../git/ref_format.ts'

// himalaya's search DSL: 3 operators (and, or, not) and 7 conditions
// (date, after, from, to, subject, body, flag), optionally followed by
// `order by <kind> [asc|desc]` sorters. Date conditions anchor on the
// `Date:` header, never on the server's received-at timestamp, which is
// why they emit SENTON/SENTSINCE rather than ON/SINCE: imported or
// delayed mail would otherwise land on the wrong day.
const SORT_KINDS = ['date', 'from', 'to', 'subject'] as const
type SortKind = (typeof SORT_KINDS)[number]
const FLAGS: Record<string, string> = {
  seen: 'SEEN',
  answered: 'ANSWERED',
  flagged: 'FLAGGED',
  draft: 'DRAFT',
  deleted: 'DELETED',
}
const QUERY_SOURCE = 'query'
const ORDER_BY = 'order by'
const QUOTED_ESCAPES = '\\"'
const UNQUOTED_ESCAPES = '\\ ()'
const END_OF_INPUT = 'end of input'
const ATOM_SPECIALS = '(){%*"\\]'
const LINE_BREAKS = String.fromCodePoint(0x0d, 0x0a, 0x0b, 0x0c, 0x85, 0x2028, 0x2029)
const WHITE_SPACE =
  LINE_BREAKS +
  String.fromCodePoint(
    0x09,
    0x20,
    0xa0,
    0x1680,
    0x2000,
    0x2001,
    0x2002,
    0x2003,
    0x2004,
    0x2005,
    0x2006,
    0x2007,
    0x2008,
    0x2009,
    0x200a,
    0x202f,
    0x205f,
    0x3000,
  )
const TAB_WIDTH = 4
const LABEL_MARGIN = 2
const MATCH_NOTHING = 'NOT ALL'
const ENC = new TextEncoder()

type Parsed<T = string> = [T, number] | null

export class QueryError extends Error {}

export interface Sorter {
  kind: SortKind
  descending: boolean
}

export interface Query {
  criteria: string
  sorters: readonly Sorter[]
}

function formatDate(value: Date): string {
  const day = String(value.getUTCDate()).padStart(2, '0')
  return `${day}-${MONTHS[value.getUTCMonth()] ?? ''}-${String(value.getUTCFullYear())}`
}

function validDate(year: number, month: number, day: number): Date | null {
  const date = new Date(Date.UTC(year, month - 1, day))
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null
  }
  return date
}

function parseDateWord(text: string): Date | null {
  let match = /^(\d{1,4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(text)
  if (match !== null && match[1]?.length === 4) {
    return validDate(Number(match[1]), Number(match[2]), Number(match[3]))
  }
  match = /^(\d{1,2})[-/](\d{1,2})[-/](\d{1,4})$/.exec(text)
  if (match !== null) return validDate(Number(match[3]), Number(match[2]), Number(match[1]))
  return null
}

// A header is unfolded before it is searched, so a pattern holding a line
// break finds nothing, and a quoted string cannot carry one.
function textCriteria(word: string, pattern: string): string {
  if (pattern.includes('\r') || pattern.includes('\n')) return MATCH_NOTHING
  return `${word.toUpperCase()} ${quoteString(pattern)}`
}

function isAtom(word: string): boolean {
  return (
    word !== '' &&
    Array.from(word).every((char) => {
      const code = char.charCodeAt(0)
      return code > 0x20 && code < 0x7f && !ATOM_SPECIALS.includes(char)
    })
  )
}

function expected(labels: readonly string[]): string {
  if (labels.length === 1) return labels[0] ?? ''
  return `${labels.slice(0, -1).join(', ')}, or ${labels[labels.length - 1] ?? ''}`
}

/** The line number, start, end of text and end of terminator at an offset. */
function lineAt(chars: readonly string[], offset: number): [number, number, number, number] {
  let number = 1
  let start = 0
  let index = 0
  while (index < chars.length) {
    const char = chars[index] ?? ''
    index += 1
    if (!LINE_BREAKS.includes(char)) continue
    const textEnd = index - 1
    if (char === '\r' && chars[index] === '\n') index += 1
    if (offset < index) return [number, start, textEnd, index]
    number += 1
    start = index
  }
  return [number, start, chars.length, chars.length]
}

/** The text as drawn, and the column each character starts at, then the end. */
function drawn(line: readonly string[]): [string, number[]] {
  let shown = ''
  let column = 0
  const columns = [0]
  for (const char of line) {
    let cells = 1
    if (char === '\t') {
      cells = (Math.floor(column / TAB_WIDTH) + 1) * TAB_WIDTH - column
      shown += ' '.repeat(cells)
    } else if (WHITE_SPACE.includes(char)) {
      shown += ' '
    } else {
      cells = displayWidth(char)
      shown += char
    }
    column += cells
    columns.push(column)
  }
  return [shown, columns]
}

function cells(columns: readonly number[], index: number): number {
  const start = columns[index]
  const next = columns[index + 1]
  return start === undefined || next === undefined ? 1 : next - start
}

/**
 * The underline and arrow rows under a label. The trailing margin and a
 * zero-width character are counted by character, so a mark on a combining
 * accent draws nothing.
 */
function marks(columns: readonly number[], column: number, size: number): [string, string] {
  const first = ' '.repeat(columns[column] ?? 0)
  if (size === 0) return [`${first}│ `, `${first}╰─`]
  const middle = column + Math.floor(size / 2)
  const last = column + size
  let underline = ''
  for (let index = column; index < last + LABEL_MARGIN; index += 1) {
    const width = cells(columns, index)
    if (index >= last) underline += ' '.repeat(width)
    else if (index === middle && width > 0) underline += `┬${'─'.repeat(width - 1)}`
    else underline += '─'.repeat(width)
  }
  let arrow = ''
  for (let index = middle; index < last + LABEL_MARGIN; index += 1) {
    const width = cells(columns, index)
    if (index === middle && width > 0) arrow += `╰${'─'.repeat(width - 1)}`
    else arrow += '─'.repeat(width)
  }
  return [`${first}${underline}`, `${' '.repeat(columns[middle] ?? 0)}${arrow}`]
}

// The parser counts bytes and the report reads them as characters, so text
// past a multibyte character sits further right than it is, and can fall off
// the end of the query altogether.
function report(source: string, pos: number, message: string): string {
  const head = `Error: cannot parse search emails query \`${source}\`\n`
  const chars = Array.from(source)
  const offset = ENC.encode(source.slice(0, pos)).length
  const point = pos < source.length ? source.codePointAt(pos) : undefined
  const size = point === undefined ? 0 : ENC.encode(String.fromCodePoint(point)).length
  if (offset > chars.length || (size > 0 && offset + size - 1 > chars.length)) return head
  const [number, start, textEnd, lineEnd] = lineAt(chars, offset)
  const margin = ' '.repeat(String(number).length + 2)
  const column = offset - start
  const title = `${margin}╭─[ ${QUERY_SOURCE}:${String(number)}:${String(column + 1)} ]\n`
  const bottom = `${'─'.repeat(margin.length)}╯\n`
  if (size > 0 && offset + size > lineEnd) {
    return `${head}${title}${margin}│\n${margin}│ \n${bottom}`
  }
  const columns = drawn(chars.slice(start, lineEnd))[1]
  const shown = drawn(chars.slice(start, textEnd))[0].trimEnd()
  const [marker, arrow] = marks(columns, column, size)
  return (
    `${head}${title}${margin}│\n` +
    ` ${String(number)} │ ${shown}\n` +
    `${margin}│ ${marker}\n` +
    `${margin}│ ${arrow} ${message}\n` +
    bottom
  )
}

/**
 * The filter and sort grammars, tracking the furthest failure. The parser
 * mirrors upstream's combinators, because the expected-token list in its
 * error is what a caller reads: the furthest failure wins and every
 * alternative tried there is named, in the order it was tried.
 */
class Grammar {
  best = -1
  labels: string[] = []

  constructor(readonly source: string) {}

  fail(pos: number, label: string): void {
    if (pos > this.best) {
      this.best = pos
      this.labels = [label]
    } else if (pos === this.best && !this.labels.includes(label)) {
      this.labels.push(label)
    }
  }

  at(pos: number): string | null {
    return pos < this.source.length ? this.source.charAt(pos) : null
  }

  char(pos: number, char: string, label: string): number | null {
    if (this.at(pos) === char) return pos + 1
    this.fail(pos, label)
    return null
  }

  word(pos: number, word: string, label: string): number | null {
    for (let offset = 0; offset < word.length; offset += 1) {
      if (this.at(pos + offset) !== word[offset]) {
        this.fail(pos + offset, label)
        return null
      }
    }
    return pos + word.length
  }

  spaces(start: number, label: string, atLeast: number): number | null {
    let pos = start
    let count = 0
    while (this.at(pos) === ' ') {
      pos += 1
      count += 1
    }
    this.fail(pos, label)
    return count >= atLeast ? pos : null
  }

  labelled(label: string, start: number, parser: () => Parsed): Parsed {
    const best = this.best
    const labels = [...this.labels]
    const result = parser()
    if (result === null && this.best === start) {
      this.best = best
      this.labels = labels
      this.fail(start, label)
    }
    return result
  }

  escapedRun(start: number, stops: string, atLeast: number): Parsed {
    let pos = start
    const chars: string[] = []
    for (;;) {
      const char = this.at(pos)
      if (char === '\\') {
        const following = this.at(pos + 1)
        if (following === null || !stops.includes(following)) {
          this.fail(pos + 1, 'something else')
          break
        }
        chars.push(following)
        pos += 2
        continue
      }
      this.fail(pos, 'backslash')
      if (char === null || stops.includes(char)) {
        this.fail(pos, 'something else')
        break
      }
      chars.push(char)
      pos += 1
    }
    return chars.length < atLeast ? null : [chars.join(''), pos]
  }

  quoted(pos: number): Parsed {
    const after = this.char(pos, '"', 'double quote')
    if (after === null) return null
    const body = this.escapedRun(after, QUOTED_ESCAPES, 0)
    if (body === null) return null
    const end = this.char(body[1], '"', 'double quote')
    return end === null ? null : [body[0], end]
  }

  unquoted(pos: number): Parsed {
    return this.escapedRun(pos, UNQUOTED_ESCAPES, 1)
  }

  pattern(pos: number): Parsed {
    return this.quoted(pos) ?? this.unquoted(pos)
  }

  dateValue(pos: number): Parsed<Date> {
    const best = this.best
    const labels = [...this.labels]
    const parsed = this.pattern(pos)
    if (parsed === null) return null
    const value = parseDateWord(parsed[0])
    if (value === null) {
      this.best = best
      this.labels = labels
      return null
    }
    return [value, parsed[1]]
  }

  keyword<T>(
    pos: number,
    word: string,
    label: string,
    value: (at: number) => Parsed<T>,
  ): Parsed<T> {
    let after = this.word(pos, word, `\`${word}\``)
    if (after === null) return null
    after = this.spaces(after, `space after \`${word}\``, 1)
    if (after === null) return null
    const start = after
    const best = this.best
    const labels = [...this.labels]
    const result = value(start)
    if (result === null && this.best === start) {
      this.best = best
      this.labels = labels
      this.fail(start, label)
    }
    return result
  }

  dateCondition(pos: number): Parsed {
    const found = this.keyword(pos, 'date', 'date format after `date`', (at) => this.dateValue(at))
    return found === null ? null : [`SENTON ${formatDate(found[0])}`, found[1]]
  }

  afterCondition(pos: number): Parsed {
    const found = this.keyword(pos, 'after', 'pattern after `after`', (at) => this.dateValue(at))
    if (found === null) return null
    const next = new Date(found[0].getTime() + 86_400_000)
    return [`SENTSINCE ${formatDate(next)}`, found[1]]
  }

  textCondition(pos: number, word: string): Parsed {
    const found = this.keyword(pos, word, `pattern after \`${word}\``, (at) => this.pattern(at))
    return found === null ? null : [textCriteria(word, found[0]), found[1]]
  }

  flagCondition(pos: number): Parsed {
    const found = this.keyword(pos, 'flag', 'flag name after `flag`', (at) => this.unquoted(at))
    if (found === null) return null
    const name = found[0].replace(/^\\/, '').replace(/^\$/, '').toLowerCase()
    const key = FLAGS[name]
    if (key === undefined && !isAtom(found[0])) {
      throw new QueryError(`Invalid IMAP keyword \`${found[0]}\``)
    }
    return [key ?? `KEYWORD ${found[0]}`, found[1]]
  }

  nested(pos: number): Parsed {
    const after = this.char(pos, '(', "nested filter opening '('")
    if (after === null) return null
    const inner = this.parseOr(after)
    if (inner === null) return null
    const end = this.char(inner[1], ')', "nested filter closing ')'")
    return end === null ? null : [inner[0], end]
  }

  condition(pos: number): Parsed {
    const found =
      this.dateCondition(pos) ??
      this.afterCondition(pos) ??
      this.textCondition(pos, 'from') ??
      this.textCondition(pos, 'to') ??
      this.textCondition(pos, 'subject') ??
      this.textCondition(pos, 'body') ??
      this.flagCondition(pos) ??
      this.labelled('(nested filter)', pos, () => this.nested(pos))
    if (found === null) return null
    const end = this.spaces(found[1], 'space between filters', 0)
    return end === null ? null : [found[0], end]
  }

  parseNot(start: number): Parsed {
    let pos = start
    let negations = 0
    for (;;) {
      let after = this.word(pos, 'not', '`not`')
      if (after === null) break
      after = this.spaces(after, 'space after `not`', 1)
      if (after === null) break
      pos = after
      negations += 1
    }
    const found = this.condition(pos)
    if (found === null) return null
    let criteria = found[0]
    for (let index = 0; index < negations; index += 1) criteria = `NOT ${criteria}`
    return [criteria, found[1]]
  }

  parseAnd(pos: number): Parsed {
    let left = this.parseNot(pos)
    if (left === null) return null
    for (;;) {
      let after = this.word(left[1], 'and', '`and`')
      if (after === null) return left
      after = this.spaces(after, 'space after `and`', 1)
      if (after === null) return left
      const right = this.parseNot(after)
      if (right === null) return left
      left = [`(${left[0]} ${right[0]})`, right[1]]
    }
  }

  parseOr(pos: number): Parsed {
    let left = this.parseAnd(pos)
    if (left === null) return null
    for (;;) {
      let after = this.word(left[1], 'or', '`or`')
      if (after === null) return left
      after = this.spaces(after, 'space after `or`', 1)
      if (after === null) return left
      const right = this.parseAnd(after)
      if (right === null) return left
      left = [`OR ${left[0]} ${right[0]}`, right[1]]
    }
  }

  sorter(pos: number): Parsed<Sorter> {
    for (const kind of SORT_KINDS) {
      const after = this.word(pos, kind, `\`${kind}\``)
      if (after === null) continue
      const spaced = this.spaces(after, `space after \`${kind}\``, 1)
      if (spaced !== null) {
        let ended = this.word(spaced, 'asc', '`asc`')
        if (ended !== null) return [{ kind, descending: false }, ended]
        ended = this.word(spaced, 'desc', '`desc`')
        if (ended !== null) return [{ kind, descending: true }, ended]
      }
      return [{ kind, descending: false }, after]
    }
    return null
  }

  sorters(start: number): [Sorter[], number] {
    const out: Sorter[] = []
    let pos = start
    let found = this.sorter(pos)
    while (found !== null) {
      out.push(found[0])
      pos = found[1]
      const after = this.spaces(pos, 'space between sorters', 1)
      if (after === null) break
      found = this.sorter(after)
    }
    return [out, pos]
  }

  error(): QueryError {
    const point = this.source.codePointAt(this.best)
    const shown = point === undefined ? END_OF_INPUT : `'${String.fromCodePoint(point)}'`
    return new QueryError(
      report(this.source, this.best, `found ${shown} expected ${expected(this.labels)}`),
    )
  }
}

function parseFilter(source: string): string {
  const grammar = new Grammar(source)
  const found = grammar.parseOr(0)
  if (found !== null && found[1] === source.length) return found[0]
  if (found !== null) grammar.fail(found[1], END_OF_INPUT)
  throw grammar.error()
}

function parseSort(source: string): Sorter[] {
  const grammar = new Grammar(source)
  const [sorters, end] = grammar.sorters(0)
  if (end === source.length) return sorters
  grammar.fail(end, END_OF_INPUT)
  throw grammar.error()
}

/** Parse a himalaya search query into IMAP criteria plus sorters. */
export function parseQuery(source: string): Query {
  const text = source.trim()
  if (text === '') return { criteria: 'ALL', sorters: [] }
  const at = text.lastIndexOf(ORDER_BY)
  if (at < 0) return { criteria: parseFilter(text), sorters: [] }
  const filterText = text.slice(0, at).trim()
  const criteria = filterText === '' ? 'ALL' : parseFilter(filterText)
  return { criteria, sorters: parseSort(text.slice(at + ORDER_BY.length).trim()) }
}

function sentAt(header: Awaited<ReturnType<typeof fetchMessage>>): number {
  const value = Date.parse(header.date)
  return Number.isNaN(value) ? 0 : value
}

function uidNumber(header: Awaited<ReturnType<typeof fetchMessage>>): number {
  return Number(header.uid)
}

const SORT_KEYS: Record<
  SortKind,
  (header: Awaited<ReturnType<typeof fetchMessage>>) => string | number
> = {
  date: sentAt,
  from: (header) => header.from.email,
  to: (header) => header.to[0]?.email ?? '',
  subject: (header) => header.subject,
}

/**
 * Orders fetched headers by the query's sorters, applied right to left so
 * the first sorter ends up the primary key. With no sorters the order is
 * date descending, matching `envelope list`.
 */
export function sortHeaders(
  headers: Awaited<ReturnType<typeof fetchMessage>>[],
  sorters: readonly Sorter[],
): Awaited<ReturnType<typeof fetchMessage>>[] {
  // Ties stay in mailbox order, lowest UID first, the last key RFC 5256 gives
  // a server-side SORT.
  const ordered = [...headers].sort((a, b) => uidNumber(a) - uidNumber(b))
  if (sorters.length === 0) {
    ordered.sort((a, b) => sentAt(b) - sentAt(a))
    return ordered
  }
  for (const sorter of [...sorters].reverse()) {
    const key = SORT_KEYS[sorter.kind]
    ordered.sort((a, b) => {
      const [x, y] = sorter.descending ? [key(b), key(a)] : [key(a), key(b)]
      if (typeof x === 'number' && typeof y === 'number') return x - y
      return String(x) < String(y) ? -1 : String(x) > String(y) ? 1 : 0
    })
  }
  return ordered
}

/**
 * Orders fetched headers newest arrival first, as `envelope list` does.
 *
 * Arrival rather than the `Date:` header, so an old message copied in last
 * leads. UIDs only grow within a mailbox, which makes them the arrival order
 * exactly.
 */
export function newestArrivals(
  headers: Awaited<ReturnType<typeof fetchMessage>>[],
): Awaited<ReturnType<typeof fetchMessage>>[] {
  return [...headers].sort((a, b) => uidNumber(b) - uidNumber(a))
}

/** Takes one page of results, counting from 1. */
/**
 * How many of the newest matching UIDs to fetch headers for.
 *
 * Sorting happens client-side, so a page cannot be served without
 * holding the candidate headers. Under the default order (date
 * descending) the newest `page * pageSize` messages are the only ones
 * that can appear, so ask for exactly those. An explicit `order by` is
 * unrelated to arrival order, so the whole account window has to be
 * considered, capped by `maxMessages` either way: that is the account
 * knob for how far back mirage looks, and without it one `envelope list`
 * would fetch every message in the mailbox.
 */
export function uidBudget(
  page: number,
  pageSize: number,
  sorters: readonly Sorter[],
  maxMessages: number,
): number {
  if (sorters.length > 0) return maxMessages
  return Math.min(Math.max(page, 1) * pageSize, maxMessages)
}

/**
 * `--page` and `--page-size` as upstream reads a page size of 0: upstream
 * (v2.2.1 `envelope list`/`search`) filters it out to none at all, which
 * lists the whole mailbox whatever page was asked for; the whole mailbox here
 * is the account's message window. Mirrors Python's `page_window`.
 */
export function pageWindow(page: number, pageSize: number, maxMessages: number): [number, number] {
  return pageSize === 0 ? [1, maxMessages] : [page, pageSize]
}

export function pageSlice<T>(items: readonly T[], page: number, pageSize: number): T[] {
  const start = Math.max(page - 1, 0) * pageSize
  return items.slice(start, start + pageSize)
}
