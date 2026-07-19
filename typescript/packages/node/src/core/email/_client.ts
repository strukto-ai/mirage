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

export async function listMessageUids(
  accessor: EmailAccessor,
  folder: string,
  searchCriteria = 'ALL',
  maxResults: number | null = null,
): Promise<string[]> {
  const imap = await accessor.getImap()
  const lock = await imap.getMailboxLock(folder)
  try {
    const query = parseSearchCriteria(searchCriteria)
    const uidsRaw = await imap.search(query, { uid: true })
    if (uidsRaw === false) return []
    const uids = uidsRaw.map((n) => String(n))
    if (maxResults !== null && uids.length > maxResults) {
      return uids.slice(uids.length - maxResults)
    }
    return uids
  } finally {
    lock.release()
  }
}

interface SearchQuery {
  all?: boolean
  unseen?: boolean
  body?: string
  text?: string
  subject?: string
  from?: string
  to?: string
  since?: Date
  before?: Date
}

function parseSearchCriteria(criteria: string): SearchQuery {
  if (criteria === 'ALL' || criteria === '') return { all: true }
  const out: SearchQuery = {}
  const tokens = tokenizeCriteria(criteria)
  let i = 0
  while (i < tokens.length) {
    const tok = (tokens[i] ?? '').toUpperCase()
    if (tok === 'UNSEEN') {
      out.unseen = true
      i += 1
      continue
    }
    if (
      tok === 'TEXT' ||
      tok === 'SUBJECT' ||
      tok === 'FROM' ||
      tok === 'TO' ||
      tok === 'SINCE' ||
      tok === 'BEFORE'
    ) {
      const v = tokens[i + 1] ?? ''
      if (tok === 'TEXT') out.text = v
      else if (tok === 'SUBJECT') out.subject = v
      else if (tok === 'FROM') out.from = v
      else if (tok === 'TO') out.to = v
      else if (tok === 'SINCE') {
        const d = parseImapDate(v)
        if (d !== null) out.since = d
      } else {
        const d = parseImapDate(v)
        if (d !== null) out.before = d
      }
      i += 2
      continue
    }
    i += 1
  }
  return out
}

function tokenizeCriteria(criteria: string): string[] {
  const tokens: string[] = []
  let i = 0
  while (i < criteria.length) {
    if (criteria[i] === ' ') {
      i += 1
      continue
    }
    if (criteria[i] === '"') {
      const end = criteria.indexOf('"', i + 1)
      if (end === -1) {
        tokens.push(criteria.slice(i + 1))
        break
      }
      tokens.push(criteria.slice(i + 1, end))
      i = end + 1
      continue
    }
    let end = criteria.indexOf(' ', i)
    if (end === -1) end = criteria.length
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
  const mon = months[monKey] ?? 0
  const year = Number.parseInt(m[3] ?? '1970', 10)
  return new Date(Date.UTC(year, mon, day))
}

export async function fetchMessage(
  accessor: EmailAccessor,
  folder: string,
  uid: string,
): Promise<FetchedMessage> {
  const imap = await accessor.getImap()
  const lock = await imap.getMailboxLock(folder)
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
  const lock = await imap.getMailboxLock(folder)
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
  const lock = await imap.getMailboxLock(folder)
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
