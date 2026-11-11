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
import { parseRfc822, parseWithPayloads } from './_parse.ts'

function internalDateOf(value: Date | string | undefined): string {
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  return value.toISOString()
}

/** Each folder's name and its LIST attributes as the server sent them. */
export async function listFolderEntries(
  accessor: EmailAccessor,
): Promise<{ name: string; attributes: string[] }[]> {
  const imap = await accessor.getImap()
  // Without listOnly imapflow re-sorts the list and guesses special-use from
  // names, where a server's own order and attributes are what callers need.
  const tree = await imap.list({ listOnly: true })
  return tree.map((m) => ({ name: m.pathAsListed, attributes: [...m.flags] }))
}

export async function listFolders(accessor: EmailAccessor): Promise<string[]> {
  return (await listFolderEntries(accessor)).map((entry) => entry.name)
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
    const text = (error as { responseText?: string }).responseText
    if (text !== undefined) throw new MailboxNotFound(folder, `NO ${text}`)
    throw error
  }
}

/** A mailbox the server refused, with the server's own answer. */
export class MailboxNotFound extends Error {
  constructor(
    folder: string,
    readonly detail: string,
    readonly verb = 'SELECT',
  ) {
    super(`no such mailbox '${folder}'`)
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
    // imapflow answers `false` when the server refused the search, and
    // nothing when no mailbox is open. Neither may read as "matched
    // nothing": it would hide criteria the server cannot answer behind an
    // empty result.
    if (uidsRaw === false || uidsRaw === undefined)
      throw new Error(`IMAP rejected the search: ${searchCriteria}`)
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
  keyword?: string
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

const NO_SUCH_MAILBOX = 'NO no such mailbox'
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

  /**
   * One or more keys juxtaposed, which IMAP reads as AND.
   *
   * imapflow ANDs the keys of one object, so a plain merge works until the
   * same key appears twice (`SUBJECT a SUBJECT b`). De Morgan expresses
   * that case without dropping either half, which a merge would do
   * silently.
   */
  parseSequence(stopAtParen = false): SearchQuery {
    let query: SearchQuery | null = null
    while (!this.atEnd()) {
      if (stopAtParen && this.peek() === ')') break
      const next = this.parseKey()
      if (query === null) {
        query = next
        continue
      }
      const left: SearchQuery = query
      query = Object.keys(next).some((key) => key in left)
        ? { not: { or: [{ not: left }, { not: next }] } }
        : { ...left, ...next }
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
    if (word === 'KEYWORD') return { keyword: this.take() }
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

/**
 * Spells a value as an RFC 3501 quoted string.
 *
 * The two quoted-specials, `"` and `\\`, are escaped with a backslash and
 * nothing else is touched. A CR or LF has no spelling inside a quoted
 * string, so a value holding one is refused here rather than sent, where
 * it would end the command line early. `tokenizeCriteria` below reads
 * the same encoding back, so the search builder and this client agree
 * on what a quote inside a value means.
 */
export function quoteString(value: string): string {
  if (value.includes('\r') || value.includes('\n')) {
    throw new Error('an IMAP quoted string cannot hold a line break')
  }
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
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

/**
 * Refuses a uid holding a CR, LF or NUL. imapflow sends a uid set as a
 * bare sequence token, unchecked, so one would end the UID FETCH line
 * early and start a command of the caller's choosing.
 */
function checkUid(uid: string): void {
  uidSet([uid])
}

export async function fetchRawMessage(
  accessor: EmailAccessor,
  folder: string,
  uid: string,
): Promise<Uint8Array> {
  checkUid(uid)
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

export async function fetchMessage(accessor: EmailAccessor, folder: string, uid: string) {
  checkUid(uid)
  const imap = await accessor.getImap()
  const lock = await lockMailbox(imap, folder)
  try {
    const msg = await imap.fetchOne(
      uid,
      { source: true, flags: true, uid: true, internalDate: true },
      { uid: true },
    )
    if (msg === false) {
      throw new Error(`email: uid ${uid} not found in ${folder}`)
    }
    const source = msg.source instanceof Buffer ? new Uint8Array(msg.source) : new Uint8Array(0)
    const parsed = await parseRfc822(source)
    return {
      ...parsed,
      uid,
      flags: msg.flags !== undefined ? [...msg.flags] : [],
      internalDate: internalDateOf(msg.internalDate),
      rawSize: source.byteLength,
    }
  } finally {
    lock.release()
  }
}

/**
 * Fetch messages by uid, parsed. `headerOnly` fetches the header block
 * alone, which names a message's file (Subject, Date, INTERNALDATE for a
 * message without one) without its body.
 */
export async function fetchHeaders(
  accessor: EmailAccessor,
  folder: string,
  uids: readonly string[],
  headerOnly = false,
): Promise<Awaited<ReturnType<typeof fetchMessage>>[]> {
  if (uids.length === 0) return []
  for (const uid of uids) checkUid(uid)
  const imap = await accessor.getImap()
  const lock = await lockMailbox(imap, folder)
  try {
    const results: Awaited<ReturnType<typeof fetchMessage>>[] = []
    const batchSize = 25
    for (let i = 0; i < uids.length; i += batchSize) {
      // One UID FETCH per batch. Full source (not headers-only) by default:
      // listings need the MIME structure to surface attachment dirs,
      // mirroring the python backend.
      for await (const msg of imap.fetch(
        uids.slice(i, i + batchSize).join(','),
        headerOnly
          ? { headers: true, uid: true, internalDate: true }
          : { source: true, flags: true, uid: true, internalDate: true },
        { uid: true },
      )) {
        const raw = headerOnly ? msg.headers : msg.source
        const source = raw instanceof Buffer ? new Uint8Array(raw) : new Uint8Array(0)
        const parsed = await parseRfc822(source)
        results.push({
          ...parsed,
          uid: String(msg.uid),
          flags: msg.flags !== undefined ? [...msg.flags] : [],
          internalDate: internalDateOf(msg.internalDate),
          rawSize: source.byteLength,
        })
      }
    }
    return results
  } finally {
    lock.release()
  }
}

/** A mailbox's total and unread message counts. */
export async function mailboxCounts(
  accessor: EmailAccessor,
  folder: string,
): Promise<[number, number]> {
  const imap = await accessor.getImap()
  const status = await imap.status(folder, { messages: true, unseen: true }).catch(() => false)
  if (status === false) throw new Error(`no such mailbox '${folder}'`)
  const counts = status as { messages?: number; unseen?: number }
  return [counts.messages ?? 0, counts.unseen ?? 0]
}

export type FlagOp = 'add' | 'set' | 'remove'

/** Add, set or remove flags on messages. */
export async function storeFlags(
  accessor: EmailAccessor,
  folder: string,
  uids: readonly string[],
  flags: string[],
  op: FlagOp,
): Promise<void> {
  const range = uidSet(uids)
  const imap = await accessor.getImap()
  const lock = await lockMailbox(imap, folder)
  try {
    const options = { uid: true }
    const done =
      op === 'add'
        ? await imap.messageFlagsAdd(range, flags, options)
        : op === 'remove'
          ? await imap.messageFlagsRemove(range, flags, options)
          : await imap.messageFlagsSet(range, flags, options)
    if (!done) throw new Error(`IMAP refused the flags on ${range}`)
  } finally {
    lock.release()
  }
}

/** Copy messages to another mailbox, answering how many the mailbox held. */
export async function copyMessages(
  accessor: EmailAccessor,
  folder: string,
  target: string,
  uids: readonly string[],
): Promise<number> {
  const range = uidSet(uids)
  const imap = await accessor.getImap()
  const lock = await lockMailbox(imap, folder)
  try {
    const held = await fetchedUids(imap, range)
    if (held.length > 0) await uidCopy(imap, held.join(','), target)
    return held.length
  } finally {
    lock.release()
  }
}

/**
 * Move messages to another mailbox, answering how many the mailbox held.
 * imapflow's own fallback for a server without MOVE expunges the source even
 * when its COPY failed, so that case is spelled out here: nothing is removed
 * unless it has landed in the target.
 */
export async function moveMessages(
  accessor: EmailAccessor,
  folder: string,
  target: string,
  uids: readonly string[],
): Promise<number> {
  const range = uidSet(uids)
  const imap = await accessor.getImap()
  const lock = await lockMailbox(imap, folder)
  try {
    const held = await fetchedUids(imap, range)
    if (held.length === 0) return 0
    const spelled = held.join(',')
    if (imap.capabilities.has('MOVE')) {
      const moved = await imap.messageMove(spelled, target, { uid: true })
      if (moved === false) throw new MailboxNotFound(target, NO_SUCH_MAILBOX, 'COPY')
    } else {
      await uidCopy(imap, spelled, target)
      await uidRemove(imap, spelled)
    }
    return held.length
  } finally {
    lock.release()
  }
}

/**
 * Remove messages from a mailbox for good. False when the server has no UID
 * EXPUNGE and they are only flagged \\Deleted.
 */
export async function deleteMessages(
  accessor: EmailAccessor,
  folder: string,
  uids: readonly string[],
): Promise<boolean> {
  const range = uidSet(uids)
  const imap = await accessor.getImap()
  const lock = await lockMailbox(imap, folder)
  try {
    return await uidRemove(imap, range)
  } finally {
    lock.release()
  }
}

async function uidCopy(imap: ImapFlow, range: string, target: string): Promise<void> {
  const copied = await imap.messageCopy(range, target, { uid: true })
  if (copied === false) throw new MailboxNotFound(target, NO_SUCH_MAILBOX, 'COPY')
}

async function uidRemove(imap: ImapFlow, range: string): Promise<boolean> {
  // A plain EXPUNGE would also take messages someone else flagged, so
  // without UIDPLUS the flag is as far as this goes.
  if (!imap.capabilities.has('UIDPLUS')) {
    await imap.messageFlagsAdd(range, ['\\Deleted'], { uid: true })
    return false
  }
  return await imap.messageDelete(range, { uid: true })
}

function uidSet(uids: readonly string[]): string {
  if (uids.length === 0) throw new Error('Empty UID set')
  for (const uid of uids) {
    const valid = /^[0-9]+$/.test(uid) && Number(uid) > 0 && Number(uid) < 2 ** 32
    if (!valid) throw new Error(`Invalid message UID \`${uid}\``)
  }
  return uids.join(',')
}

async function fetchedUids(imap: ImapFlow, range: string): Promise<string[]> {
  const held: string[] = []
  for await (const msg of imap.fetch(range, { uid: true }, { uid: true })) {
    held.push(String(msg.uid))
  }
  return held
}

export async function fetchAttachment(
  accessor: EmailAccessor,
  folder: string,
  uid: string,
  filename: string,
): Promise<Uint8Array | null> {
  checkUid(uid)
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
