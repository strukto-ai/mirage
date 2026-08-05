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

import type { FetchedMessage } from '../../../../core/email/_client.ts'

// himalaya's search DSL: 3 operators (and, or, not) and 8 conditions
// (date, before, after, from, to, subject, body, flag), optionally
// followed by `order by <kind> [asc|desc]` sorters. Date conditions
// anchor on the `Date:` header, never on the server's received-at
// timestamp, which is why they emit SENTON/SENTBEFORE/SENTSINCE rather
// than ON/BEFORE/SINCE: imported or delayed mail would otherwise land on
// the wrong day.
const CONDITIONS = ['date', 'before', 'after', 'from', 'to', 'subject', 'body', 'flag'] as const
const SORT_KINDS = ['date', 'from', 'to', 'subject'] as const
const FLAGS: Record<string, string> = {
  seen: 'SEEN',
  answered: 'ANSWERED',
  flagged: 'FLAGGED',
  draft: 'DRAFT',
  deleted: 'DELETED',
}
const IMAP_MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

type SortKind = (typeof SORT_KINDS)[number]

export class QueryError extends Error {}

interface Token {
  text: string
  quoted: boolean
}

export interface Sorter {
  kind: SortKind
  descending: boolean
}

export interface Query {
  criteria: string
  sorters: Sorter[]
}

/**
 * Splits a query string into words, parens and quoted patterns.
 *
 * Mirrors upstream, which joins argv with spaces and parses the resulting
 * character stream: a pattern containing spaces must carry literal double
 * quotes, since the shell's own quotes are gone by the time it arrives.
 */
function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  let index = 0
  while (index < source.length) {
    const char = source.charAt(index)
    if (/\s/.test(char)) {
      index += 1
      continue
    }
    if (char === '(' || char === ')') {
      tokens.push({ text: char, quoted: false })
      index += 1
      continue
    }
    if (char === '"') {
      index += 1
      const chars: string[] = []
      while (index < source.length && source.charAt(index) !== '"') {
        if (source.charAt(index) === '\\' && index + 1 < source.length) index += 1
        chars.push(source.charAt(index))
        index += 1
      }
      if (index >= source.length) throw new QueryError('unterminated quoted pattern')
      index += 1
      tokens.push({ text: chars.join(''), quoted: true })
      continue
    }
    const start = index
    while (index < source.length && !/[\s()]/.test(source.charAt(index))) index += 1
    tokens.push({ text: source.slice(start, index), quoted: false })
  }
  return tokens
}

function keyword(token: Token | undefined): string | null {
  if (token === undefined || token.quoted) return null
  return token.text.toLowerCase()
}

function quote(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

function imapDate(text: string): Date {
  const parts = text.split('-')
  if (parts.length !== 3) {
    throw new QueryError(`invalid date '${text}', expected yyyy-mm-dd`)
  }
  const year = Number(parts[0])
  const month = Number(parts[1])
  const day = Number(parts[2])
  const value = new Date(Date.UTC(year, month - 1, day))
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    Number.isNaN(value.getTime()) ||
    value.getUTCMonth() !== month - 1 ||
    value.getUTCDate() !== day
  ) {
    throw new QueryError(`invalid date '${text}'`)
  }
  return value
}

function formatDate(value: Date): string {
  const day = String(value.getUTCDate()).padStart(2, '0')
  const month = IMAP_MONTHS[value.getUTCMonth()] ?? 'Jan'
  return `${day}-${month}-${String(value.getUTCFullYear())}`
}

/**
 * Recursive-descent parser producing IMAP SEARCH keys directly: the AST
 * would be a himalaya type, and translating it to IMAP is the only thing
 * anything ever does with it.
 */
class Parser {
  private index = 0

  constructor(private readonly tokens: Token[]) {}

  peek(): Token | undefined {
    return this.tokens[this.index]
  }

  take(): Token {
    const token = this.peek()
    if (token === undefined) throw new QueryError('unexpected end of query')
    this.index += 1
    return token
  }

  parseOr(): string {
    let left = this.parseAnd()
    while (keyword(this.peek()) === 'or') {
      this.take()
      left = `OR ${left} ${this.parseAnd()}`
    }
    return left
  }

  parseAnd(): string {
    let left = this.parseUnary()
    while (keyword(this.peek()) === 'and') {
      this.take()
      left = `(${left} ${this.parseUnary()})`
    }
    return left
  }

  parseUnary(): string {
    const word = keyword(this.peek())
    if (word === 'not') {
      this.take()
      return `NOT ${this.parseUnary()}`
    }
    if (word === '(') {
      this.take()
      const inner = this.parseOr()
      if (keyword(this.peek()) !== ')') throw new QueryError("missing closing ')'")
      this.take()
      return inner
    }
    return this.parseCondition()
  }

  parseCondition(): string {
    const token = this.take()
    const word = keyword(token)
    if (word === null || !(CONDITIONS as readonly string[]).includes(word)) {
      throw new QueryError(
        `expected a condition (${CONDITIONS.join(', ')}) but found '${token.text}'`,
      )
    }
    const value = this.take().text
    if (word === 'date') return `SENTON ${formatDate(imapDate(value))}`
    if (word === 'before') return `SENTBEFORE ${formatDate(imapDate(value))}`
    if (word === 'after') {
      // Strictly greater than the given day; IMAP SENTSINCE is
      // inclusive, so ask for the day after.
      const next = new Date(imapDate(value).getTime() + 86400000)
      return `SENTSINCE ${formatDate(next)}`
    }
    if (word === 'flag') {
      const key = FLAGS[value.toLowerCase()]
      if (key === undefined) {
        throw new QueryError(
          `unknown flag '${value}', expected one of ${Object.keys(FLAGS).sort().join(', ')}`,
        )
      }
      return key
    }
    return `${word.toUpperCase()} ${quote(value)}`
  }

  parseSorters(): Sorter[] {
    this.take()
    if (keyword(this.peek()) !== 'by') throw new QueryError("expected 'by' after 'order'")
    this.take()
    const sorters: Sorter[] = []
    for (;;) {
      const kind = keyword(this.peek())
      if (kind === null || !(SORT_KINDS as readonly string[]).includes(kind)) break
      this.take()
      let descending = false
      const order = keyword(this.peek())
      if (order === 'asc' || order === 'desc') {
        this.take()
        descending = order === 'desc'
      }
      sorters.push({ kind: kind as SortKind, descending })
    }
    if (sorters.length === 0) {
      throw new QueryError(`expected a sort key (${SORT_KINDS.join(', ')}) after 'order by'`)
    }
    return sorters
  }
}

/** Parses a himalaya search query into IMAP criteria plus sorters. */
export function parseQuery(source: string): Query {
  const parser = new Parser(tokenize(source))
  let criteria = 'ALL'
  const head = keyword(parser.peek())
  if (head !== null && head !== 'order') criteria = parser.parseOr()
  let sorters: Sorter[] = []
  if (keyword(parser.peek()) === 'order') sorters = parser.parseSorters()
  const leftover = parser.peek()
  if (leftover !== undefined) {
    throw new QueryError(`unexpected '${leftover.text}' at end of query`)
  }
  return { criteria, sorters }
}

function sentAt(header: FetchedMessage): number {
  const value = Date.parse(header.date)
  return Number.isNaN(value) ? 0 : value
}

const SORT_KEYS: Record<SortKind, (header: FetchedMessage) => string | number> = {
  date: sentAt,
  from: (header) => header.from.email,
  to: (header) => header.to[0]?.email ?? '',
  subject: (header) => header.subject,
}

function compare(a: string | number, b: string | number): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0
}

/**
 * Orders fetched headers by the query's sorters, applied right to left so
 * the first sorter ends up the primary key. With no sorters the order is
 * date descending, matching `envelope list`.
 */
export function sortHeaders(
  headers: FetchedMessage[],
  sorters: readonly Sorter[],
): FetchedMessage[] {
  const ordered = [...headers]
  if (sorters.length === 0) {
    ordered.sort((a, b) => sentAt(b) - sentAt(a))
    return ordered
  }
  for (const sorter of [...sorters].reverse()) {
    const key = SORT_KEYS[sorter.kind]
    ordered.sort((a, b) => (sorter.descending ? compare(key(b), key(a)) : compare(key(a), key(b))))
  }
  return ordered
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

export function pageSlice<T>(items: readonly T[], page: number, pageSize: number): T[] {
  const start = Math.max(page - 1, 0) * pageSize
  return items.slice(start, start + pageSize)
}
