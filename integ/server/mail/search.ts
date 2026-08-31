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

// RFC 3501 SEARCH, as an expression rather than a list of special cases. It is
// a parser because the consumers make it one: himalaya compiles its own query
// DSL down to IMAP, and that DSL has `and`, `or`, `not` and parentheses, so a
// key-at-a-time matcher answers `NOT SUBJECT "x"` by ignoring the NOT. Three
// families and three operators is the whole grammar here.
//
// What is deliberately absent: `KEYWORD`, `LARGER`/`SMALLER`, `MSGNO` ranges
// beyond the plain forms, and the modified-UTF-7 mailbox encoding. No consumer
// in this repo emits any of them, and a key this fake does not know is an
// ERROR rather than a silent match-everything -- a SEARCH that quietly widens
// is how a test passes while asserting nothing.

export interface SearchMsg {
  seq: number
  uid: number
  internalDate: number
  flags: string[]
  headers: Record<string, string[]>
  // The DECODED body, which is what BODY matches.
  body: string
  // The RAW message bytes, exactly as APPENDed. This is what FETCH serves,
  // so it must stay byte-identical to what arrived; a string here replaced
  // non-UTF-8 octets with U+FFFD and re-encoded them. `text` is the search
  // view.
  source: Buffer
  // Header block plus decoded body, which is what TEXT matches. Kept apart
  // from `source` because the two have opposite requirements and sharing one
  // field silently made FETCH serve a decoded message.
  text: string
}

export class SearchError extends Error {}

// A header block is everything before the first blank line, unfolded: a
// continuation line begins with space or tab and belongs to the header above
// it. Getting that wrong makes a long Subject unsearchable, which is exactly
// the header most likely to be folded.
import { decodeBody } from './mime.ts'

// `head` is the raw header block and `body` is the DECODED text, which is what
// TEXT is: header plus body, with the body as a reader would see it rather than
// as it was transferred.
export function parseSource(source: Buffer): {
  headers: Record<string, string[]>
  head: string
  body: string
} {
  const text = source.toString('utf8')
  const split = /\r?\n\r?\n/.exec(text)
  const head = split === null ? text : text.slice(0, split.index)
  const body = split === null ? '' : text.slice(split.index + split[0].length)
  const headers: Record<string, string[]> = Object.create(null) as Record<string, string[]>
  let current = ''
  for (const raw of head.split(/\r?\n/)) {
    if (/^[ \t]/.test(raw) && current !== '') {
      const list = headers[current]
      if (list !== undefined && list.length > 0) {
        list[list.length - 1] = `${list[list.length - 1] ?? ''} ${raw.trim()}`
      }
      continue
    }
    const colon = raw.indexOf(':')
    if (colon === -1) continue
    current = raw.slice(0, colon).trim().toLowerCase()
    ;(headers[current] ??= []).push(raw.slice(colon + 1).trim())
  }
  // The DECODED body, which is what BODY and TEXT match on; see mime.ts.
  return { headers, head, body: decodeBody(headers, body) }
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

// `1-Jan-2026`, which is the only date form SEARCH takes. Answered as UTC
// midnight, because the comparisons below are all whole-day.
function parseImapDate(raw: string): number {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(raw)
  if (m === null) throw new SearchError(`bad date ${raw}`)
  const month = MONTHS.indexOf((m[2] ?? '').toLowerCase())
  if (month === -1) throw new SearchError(`bad month ${raw}`)
  return Date.UTC(Number(m[3]), month, Number(m[1]))
}

function dayOf(ms: number): number {
  const d = new Date(ms)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}

// The `Date:` header as a day, for the SENT* family. An unparseable or absent
// one answers NaN, and every comparison against NaN is false -- which is the
// right answer: a message with no Date cannot be on, before or since one.
function sentDay(msg: SearchMsg): number {
  const raw = msg.headers.date?.[0]
  if (raw === undefined) return Number.NaN
  const at = Date.parse(raw)
  return Number.isNaN(at) ? Number.NaN : dayOf(at)
}

function headerText(msg: SearchMsg, name: string): string {
  return (own(msg.headers, name) ?? []).join(' ')
}

function has(msg: SearchMsg, flag: string): boolean {
  return msg.flags.some((one) => one.toLowerCase() === flag.toLowerCase())
}

function contains(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase())
}

// `constructor` and its Object.prototype kin answer a bare index on an object
// literal, so a client-typed key must only reach a table's own rows.
function own<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined
}

type Test = (msg: SearchMsg) => boolean

const FLAG_KEYS: Record<string, Test> = {
  ALL: () => true,
  ANSWERED: (m) => has(m, '\\Answered'),
  UNANSWERED: (m) => !has(m, '\\Answered'),
  DELETED: (m) => has(m, '\\Deleted'),
  UNDELETED: (m) => !has(m, '\\Deleted'),
  DRAFT: (m) => has(m, '\\Draft'),
  UNDRAFT: (m) => !has(m, '\\Draft'),
  FLAGGED: (m) => has(m, '\\Flagged'),
  UNFLAGGED: (m) => !has(m, '\\Flagged'),
  SEEN: (m) => has(m, '\\Seen'),
  UNSEEN: (m) => !has(m, '\\Seen'),
  // \Recent is not stored: this fake has no notion of a session that has not
  // seen a message yet, and every consumer here reads \Seen instead. RECENT
  // therefore matches nothing and NEW, which is RECENT and UNSEEN, matches
  // nothing with it. Answering "everything" would be the dangerous direction.
  RECENT: () => false,
  NEW: () => false,
  OLD: () => true,
}

const TEXT_KEYS: Record<string, (m: SearchMsg) => string> = {
  BCC: (m) => headerText(m, 'bcc'),
  BODY: (m) => m.body,
  CC: (m) => headerText(m, 'cc'),
  FROM: (m) => headerText(m, 'from'),
  SUBJECT: (m) => headerText(m, 'subject'),
  TEXT: (m) => m.text,
  TO: (m) => headerText(m, 'to'),
}

// Two date families, and conflating them is the bug himalaya's DSL exists to
// avoid: SINCE/BEFORE/ON read the server's INTERNALDATE (when it arrived) and
// SENTSINCE/SENTBEFORE/SENTON read the `Date:` header (when it was written).
const DATE_KEYS: Record<string, { day: (m: SearchMsg) => number; cmp: 'on' | 'before' | 'since' }> =
  {
    ON: { day: (m) => dayOf(m.internalDate), cmp: 'on' },
    BEFORE: { day: (m) => dayOf(m.internalDate), cmp: 'before' },
    SINCE: { day: (m) => dayOf(m.internalDate), cmp: 'since' },
    SENTON: { day: sentDay, cmp: 'on' },
    SENTBEFORE: { day: sentDay, cmp: 'before' },
    SENTSINCE: { day: sentDay, cmp: 'since' },
  }

class Parser {
  private readonly words: string[]
  private readonly seqMax: number
  private readonly uidMax: number
  private at = 0

  constructor(words: string[], seqMax: number, uidMax: number) {
    this.words = words
    this.seqMax = seqMax
    this.uidMax = uidMax
  }

  done(): boolean {
    return this.at >= this.words.length
  }

  peek(): string {
    return this.words[this.at] ?? ''
  }

  take(): string {
    if (this.done()) throw new SearchError('unexpected end of search key')
    const word = this.words[this.at] ?? ''
    this.at += 1
    return word
  }

  // A whole search program is an implicit AND of everything left, which is
  // what makes `UNSEEN FROM "a"` mean both.
  all(): Test {
    const tests: Test[] = []
    while (!this.done() && this.peek() !== ')') tests.push(this.one())
    if (tests.length === 0) return () => true
    return (msg) => tests.every((t) => t(msg))
  }

  one(): Test {
    const word = this.take()
    if (word === '(') {
      const inner = this.all()
      if (this.take() !== ')') throw new SearchError('missing )')
      return inner
    }
    const key = word.toUpperCase()
    if (key === 'NOT') {
      const inner = this.one()
      return (msg) => !inner(msg)
    }
    if (key === 'OR') {
      const left = this.one()
      const right = this.one()
      return (msg) => left(msg) || right(msg)
    }
    const flag = own(FLAG_KEYS, key)
    if (flag !== undefined) return flag
    const text = own(TEXT_KEYS, key)
    if (text !== undefined) {
      const want = this.take()
      return (msg) => contains(text(msg), want)
    }
    const date = own(DATE_KEYS, key)
    if (date !== undefined) {
      const when = parseImapDate(this.take())
      if (date.cmp === 'on') return (msg) => date.day(msg) === when
      if (date.cmp === 'before') return (msg) => date.day(msg) < when
      return (msg) => date.day(msg) >= when
    }
    if (key === 'HEADER') {
      const field = this.take().toLowerCase()
      const want = this.take()
      return (msg) => contains(headerText(msg, field), want)
    }
    if (key === 'UID') {
      const set = this.take()
      return (msg) => inSet(set, msg.uid, this.uidMax)
    }
    // A bare number or range is a MESSAGE SEQUENCE set, which is the one key
    // with no keyword in front of it.
    if (/^[\d,:*]+$/.test(key)) return (msg) => inSet(key, msg.seq, this.seqMax)
    throw new SearchError(`unsupported search key ${key}`)
  }
}

/**
 * Whether `n` is in an IMAP sequence set (`2`, `2:4`, `1,3:*`).
 *
 * `*` is the largest number in use, so a bare `*` matches only `max` and a
 * range end of `*` runs to `max`. RFC 3501 reads a range's endpoints in
 * either order, which is why `4:*` on a two-message mailbox still means 2:4.
 */
export function inSet(set: string, n: number, max: number): boolean {
  for (const part of set.split(',')) {
    const [lo, hi] = part.split(':')
    if (hi === undefined) {
      if (lo === '*' ? n === max : Number(lo) === n) return true
      continue
    }
    const from = lo === '*' ? max : Number(lo)
    const to = hi === '*' ? max : Number(hi)
    if (n >= Math.min(from, to) && n <= Math.max(from, to)) return true
  }
  return false
}

/**
 * Split a SEARCH argument list into words, honouring quoted strings.
 *
 * A quoted string may hold spaces and escaped quotes, and `(`/`)` are their own
 * words even with no space around them, which is how `(SUBJECT "a" NOT SEEN)`
 * tokenizes.
 */
export function tokenize(raw: string): string[] {
  const out: string[] = []
  let at = 0
  while (at < raw.length) {
    const ch = raw[at] ?? ''
    if (ch === ' ' || ch === '\t') {
      at += 1
      continue
    }
    if (ch === '(' || ch === ')') {
      out.push(ch)
      at += 1
      continue
    }
    if (ch === '"') {
      let word = ''
      at += 1
      while (at < raw.length && raw[at] !== '"') {
        if (raw[at] === '\\' && at + 1 < raw.length) {
          word += raw[at + 1] ?? ''
          at += 2
          continue
        }
        word += raw[at] ?? ''
        at += 1
      }
      at += 1
      out.push(word)
      continue
    }
    let word = ''
    while (at < raw.length && !' \t()'.includes(raw[at] ?? '')) {
      word += raw[at] ?? ''
      at += 1
    }
    out.push(word)
  }
  return out
}

/**
 * The messages one SEARCH argument list selects.
 *
 * A leading `CHARSET <name>` is consumed and ignored, which is the vendor's
 * own behaviour for UTF-8 and the reason it is handled here rather than
 * rejected: aioimaplib sends `SEARCH CHARSET UTF-8 ...` whenever a criterion
 * carries a non-ASCII byte, and a fake that treated CHARSET as an unknown key
 * failed exactly the searches with accented names in them.
 */
export function searchMessages(raw: string, messages: SearchMsg[]): SearchMsg[] {
  const words = tokenize(raw)
  if ((words[0] ?? '').toUpperCase() === 'CHARSET') words.splice(0, 2)
  const seqMax = messages.reduce((top, one) => Math.max(top, one.seq), 0)
  const uidMax = messages.reduce((top, one) => Math.max(top, one.uid), 0)
  const parser = new Parser(words, seqMax, uidMax)
  const test = parser.all()
  if (!parser.done()) throw new SearchError('trailing input in search key')
  return messages.filter((msg) => test(msg))
}
