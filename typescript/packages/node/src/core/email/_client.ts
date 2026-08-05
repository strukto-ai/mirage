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

import type { ImapFlow, MailboxLockObject } from 'imapflow'
import type { EmailAccessor } from '../../accessor/email.ts'
import { parseRfc822, parseWithPayloads, type ParsedRfc822 } from './_parse.ts'

export interface FetchedMessage extends ParsedRfc822 {
  uid: string
  flags: string[]
}

export async function listFolders(accessor: EmailAccessor): Promise<string[]> {
  const imap = await accessor.getImap()
  const tree = await imap.list()
  return tree.map((m) => m.pathAsListed)
}

/**
 * Selects and locks a mailbox, failing loudly when it does not exist.
 *
 * imapflow reports every refused command as a bare "Command failed" and
 * keeps the server's own words on `responseText`, so a missing mailbox
 * arrives naming neither itself nor the problem. A `responseText` means
 * the server answered and refused, which is the same condition python
 * checks through the SELECT response code.
 */
export async function lockMailbox(imap: ImapFlow, folder: string): Promise<MailboxLockObject> {
  try {
    return await imap.getMailboxLock(folder)
  } catch (error) {
    const answered = (error as { responseText?: string }).responseText !== undefined
    if (answered) throw new Error(`no such mailbox '${folder}'`)
    throw error
  }
}

export async function listMessageUids(
  accessor: EmailAccessor,
  folder: string,
  searchCriteria = 'ALL',
  maxResults: number | null = null,
): Promise<string[]> {
  const imap = await accessor.getImap()
  const lock = await lockMailbox(imap, folder)
  try {
    const query = parseSearchCriteria(searchCriteria)
    const uidsRaw = await imap.search(query, { uid: true })
    // imapflow answers `false` when the server refused the search. That
    // must not read as "matched nothing": it would hide criteria the
    // server cannot answer behind an empty result.
    if (uidsRaw === false) throw new Error(`IMAP rejected the search: ${searchCriteria}`)
    const uids = uidsRaw.map((n) => String(n))
    if (maxResults !== null && uids.length > maxResults) {
      return uids.slice(uids.length - maxResults)
    }
    return uids
  } finally {
    lock.release()
  }
}

/**
 * imapflow's search object. AND is expressed by several keys on one
 * object; `or` and `not` nest further objects.
 */
export interface SearchQuery {
  all?: boolean
  seen?: boolean
  answered?: boolean
  flagged?: boolean
  draft?: boolean
  deleted?: boolean
  body?: string
  text?: string
  subject?: string
  from?: string
  to?: string
  on?: Date
  since?: Date
  before?: Date
  sentOn?: Date
  sentSince?: Date
  sentBefore?: Date
  not?: SearchQuery
  or?: SearchQuery[]
}

const FLAG_KEYS: Record<string, keyof SearchQuery> = {
  SEEN: 'seen',
  ANSWERED: 'answered',
  FLAGGED: 'flagged',
  DRAFT: 'draft',
  DELETED: 'deleted',
}

const TEXT_KEYS: Record<string, 'body' | 'text' | 'subject' | 'from' | 'to'> = {
  BODY: 'body',
  TEXT: 'text',
  SUBJECT: 'subject',
  FROM: 'from',
  TO: 'to',
}

// ON/SINCE/BEFORE match the mailbox's internal date, SENT* the `Date:`
// header. They are different searches, so both spellings map through.
const DATE_KEYS: Record<string, 'on' | 'since' | 'before' | 'sentOn' | 'sentSince' | 'sentBefore'> =
  {
    ON: 'on',
    SINCE: 'since',
    BEFORE: 'before',
    SENTON: 'sentOn',
    SENTSINCE: 'sentSince',
    SENTBEFORE: 'sentBefore',
  }

/**
 * ANDs two search objects.
 *
 * imapflow ANDs the keys of one object, so a plain merge works until the
 * same key appears twice (`SUBJECT a SUBJECT b`). De Morgan expresses
 * that case without dropping either half, which a merge would do
 * silently.
 */
function andQueries(left: SearchQuery, right: SearchQuery): SearchQuery {
  const collides = Object.keys(right).some((key) => key in left)
  if (!collides) return { ...left, ...right }
  return { not: { or: [{ not: left }, { not: right }] } }
}

class CriteriaParser {
  private index = 0

  constructor(private readonly tokens: string[]) {}

  private peek(): string | undefined {
    return this.tokens[this.index]
  }

  private take(): string {
    const token = this.peek()
    if (token === undefined) throw new Error('email: truncated IMAP search criteria')
    this.index += 1
    return token
  }

  atEnd(): boolean {
    return this.index >= this.tokens.length
  }

  /** One or more keys juxtaposed, which IMAP reads as AND. */
  parseSequence(stopAtParen = false): SearchQuery {
    let query: SearchQuery | null = null
    while (!this.atEnd()) {
      if (stopAtParen && this.peek() === ')') break
      const next = this.parseKey()
      query = query === null ? next : andQueries(query, next)
    }
    return query ?? { all: true }
  }

  parseKey(): SearchQuery {
    const token = this.take()
    if (token === '(') {
      const inner = this.parseSequence(true)
      if (this.peek() !== ')') throw new Error('email: unbalanced IMAP search criteria')
      this.index += 1
      return inner
    }
    const word = token.toUpperCase()
    if (word === 'ALL') return { all: true }
    if (word === 'NOT') return { not: this.parseKey() }
    if (word === 'OR') return { or: [this.parseKey(), this.parseKey()] }
    if (word === 'UNSEEN') return { seen: false }
    const flag = FLAG_KEYS[word]
    if (flag !== undefined) return { [flag]: true }
    const textKey = TEXT_KEYS[word]
    if (textKey !== undefined) return { [textKey]: this.take() }
    const dateKey = DATE_KEYS[word]
    if (dateKey !== undefined) {
      const parsed = parseImapDate(this.take())
      if (parsed === null) throw new Error(`email: bad date in IMAP search criteria: ${token}`)
      return { [dateKey]: parsed }
    }
    // Never fall through silently: a dropped key would widen the search
    // and quietly return the wrong messages.
    throw new Error(`email: unsupported IMAP search key '${token}'`)
  }
}

export function parseSearchCriteria(criteria: string): SearchQuery {
  if (criteria === 'ALL' || criteria === '') return { all: true }
  return new CriteriaParser(tokenizeCriteria(criteria)).parseSequence()
}

function tokenizeCriteria(criteria: string): string[] {
  const tokens: string[] = []
  let i = 0
  while (i < criteria.length) {
    const char = criteria.charAt(i)
    if (char === ' ') {
      i += 1
      continue
    }
    if (char === '(' || char === ')') {
      tokens.push(char)
      i += 1
      continue
    }
    if (char === '"') {
      let value = ''
      let j = i + 1
      while (j < criteria.length && criteria.charAt(j) !== '"') {
        if (criteria.charAt(j) === '\\' && j + 1 < criteria.length) j += 1
        value += criteria.charAt(j)
        j += 1
      }
      tokens.push(value)
      i = j + 1
      continue
    }
    let end = i
    while (end < criteria.length && !' ()'.includes(criteria.charAt(end))) end += 1
    tokens.push(criteria.slice(i, end))
    i = end
  }
  return tokens
}

function parseImapDate(s: string): Date | null {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(s)
  if (m === null) return null
  const months: Record<string, number> = {
    Jan: 0,
    Feb: 1,
    Mar: 2,
    Apr: 3,
    May: 4,
    Jun: 5,
    Jul: 6,
    Aug: 7,
    Sep: 8,
    Oct: 9,
    Nov: 10,
    Dec: 11,
  }
  const day = Number.parseInt(m[1] ?? '0', 10)
  const monKey = (m[2] ?? '').slice(0, 1).toUpperCase() + (m[2] ?? '').slice(1).toLowerCase()
  const mon = months[monKey]
  const year = Number.parseInt(m[3] ?? '1970', 10)
  // An unknown month defaulting to January, or a day rolling over into
  // the next month, would hand the server a confidently wrong date.
  if (mon === undefined) return null
  const value = new Date(Date.UTC(year, mon, day))
  if (value.getUTCMonth() !== mon || value.getUTCDate() !== day) return null
  return value
}

export async function fetchRawMessage(
  accessor: EmailAccessor,
  folder: string,
  uid: string,
): Promise<Uint8Array> {
  const imap = await accessor.getImap()
  const lock = await lockMailbox(imap, folder)
  try {
    const msg = await imap.fetchOne(uid, { source: true, uid: true }, { uid: true })
    if (msg === false) {
      throw new Error(`email: uid ${uid} not found in ${folder}`)
    }
    return msg.source instanceof Buffer ? new Uint8Array(msg.source) : new Uint8Array(0)
  } finally {
    lock.release()
  }
}

export async function fetchMessage(
  accessor: EmailAccessor,
  folder: string,
  uid: string,
): Promise<FetchedMessage> {
  const imap = await accessor.getImap()
  const lock = await lockMailbox(imap, folder)
  try {
    const msg = await imap.fetchOne(uid, { source: true, flags: true, uid: true }, { uid: true })
    if (msg === false) {
      throw new Error(`email: uid ${uid} not found in ${folder}`)
    }
    const source = msg.source instanceof Buffer ? new Uint8Array(msg.source) : new Uint8Array(0)
    const parsed = await parseRfc822(source)
    return {
      ...parsed,
      uid,
      flags: msg.flags !== undefined ? [...msg.flags] : [],
    }
  } finally {
    lock.release()
  }
}

export async function fetchHeaders(
  accessor: EmailAccessor,
  folder: string,
  uids: readonly string[],
): Promise<FetchedMessage[]> {
  if (uids.length === 0) return []
  const imap = await accessor.getImap()
  const lock = await lockMailbox(imap, folder)
  try {
    const results: FetchedMessage[] = []
    for (const uid of uids) {
      // Full source (not headers-only): listings need the MIME structure
      // to surface attachment dirs, mirroring the python backend.
      const msg = await imap.fetchOne(uid, { source: true, flags: true, uid: true }, { uid: true })
      if (msg === false) continue
      const source = msg.source instanceof Buffer ? new Uint8Array(msg.source) : new Uint8Array(0)
      const parsed = await parseRfc822(source)
      results.push({
        ...parsed,
        uid,
        flags: msg.flags !== undefined ? [...msg.flags] : [],
      })
    }
    return results
  } finally {
    lock.release()
  }
}

export async function fetchAttachment(
  accessor: EmailAccessor,
  folder: string,
  uid: string,
  filename: string,
): Promise<Uint8Array | null> {
  const imap = await accessor.getImap()
  const lock = await lockMailbox(imap, folder)
  try {
    const msg = await imap.fetchOne(uid, { source: true }, { uid: true })
    if (msg === false) return null
    const source = msg.source instanceof Buffer ? new Uint8Array(msg.source) : new Uint8Array(0)
    const attachments = await parseWithPayloads(source)
    for (const att of attachments) {
      if (att.filename === filename) return att.payload
    }
    return null
  } finally {
    lock.release()
  }
}
