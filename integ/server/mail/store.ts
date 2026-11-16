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

import type { DatabaseSync } from 'node:sqlite'
import { BYTES, all, bytes, exec, one } from '../kit/typescript/index.ts'
import { INBOX } from './config.ts'
import { parseSource, type SearchMsg } from './search.ts'

// The run's file over node:sqlite (kit sql.ts), on the tables
// prisma/mail.prisma declares.
export type Db = DatabaseSync

const MAILBOX = 'SELECT tenant, name, uidNext, uidValidity, seq FROM MailMailbox'
const MESSAGE = 'SELECT tenant, mailbox, uid, internalDate, flags, source, seq FROM MailMessage'

export interface MailboxRow {
  tenant: string
  name: string
  uidNext: number
  uidValidity: number
  seq: number
}

export interface MessageRow {
  tenant: string
  mailbox: string
  uid: number
  internalDate: bigint
  flags: string
  source: Uint8Array
  seq: number
}

// INBOX is the one mailbox name RFC 3501 declares case-insensitive; every other
// name is compared verbatim. A fake that lower-cased everything would let
// `sent` and `Sent` be one mailbox, which no real server does.
export function canonicalName(name: string): string {
  return name.toUpperCase() === INBOX ? INBOX : name
}

export async function mailboxOf(db: Db, tenant: string, name: string): Promise<MailboxRow | null> {
  return one<MailboxRow>(
    db,
    `${MAILBOX} WHERE tenant = ? AND name = ?`,
    tenant,
    canonicalName(name),
  )
}

export async function mailboxesOf(db: Db, tenant: string): Promise<MailboxRow[]> {
  const rows = all<MailboxRow>(db, `${MAILBOX} WHERE tenant = ? ORDER BY seq`, tenant)
  // INBOX first, then insertion order, which is what every server this stands
  // in for lists and what makes a golden listing stable.
  return [...rows].sort((a, b) => {
    if (a.name === INBOX) return -1
    if (b.name === INBOX) return 1
    return a.seq - b.seq
  })
}

// UIDVALIDITY a DELETE reserved for whatever CREATE remakes the name. Keyed
// by the run's connection, which the kit pool caches per run and whose database
// file lives in a per-process temp root, so the reservation is exactly as
// durable as the rows it protects.
const reservedValidity = new WeakMap<Db, Map<string, number>>()

function validityKey(tenant: string, name: string): string {
  return `${tenant}\u0000${name}`
}

export async function createMailbox(db: Db, tenant: string, name: string): Promise<MailboxRow> {
  const canonical = canonicalName(name)
  const reserved = reservedValidity.get(db)?.get(validityKey(tenant, canonical))
  exec(
    db,
    'INSERT INTO MailMailbox (tenant, name, uidValidity, seq) ' +
      'VALUES (?, ?, ?, (SELECT COUNT(*) FROM MailMailbox WHERE tenant = ?))',
    tenant,
    canonical,
    reserved ?? 1,
    tenant,
  )
  const made = await mailboxOf(db, tenant, canonical)
  if (made === null) throw new Error(`mail fake: mailbox ${canonical} vanished as it was made`)
  return made
}

// Throws when nothing matched, as Prisma's update and delete did.
function changeOne(db: Db, sql: string, ...params: (string | number)[]): void {
  if (exec(db, sql, ...params) === 0) throw new Error('mail fake: no row matched')
}

/**
 * Delete a mailbox and everything in it.
 *
 * The UIDVALIDITY of a mailbox later recreated under the same name must not
 * repeat, or a client caching by (mailbox, uid) serves the dead mailbox's
 * messages for the new one's. The counter is kept on the row that is about to
 * disappear, so it is read here and parked in `reservedValidity` for whatever
 * CREATE makes next under this name.
 */
export async function deleteMailbox(db: Db, tenant: string, name: string): Promise<number> {
  const canonical = canonicalName(name)
  const row = await mailboxOf(db, tenant, canonical)
  exec(db, 'DELETE FROM MailMessage WHERE tenant = ? AND mailbox = ?', tenant, canonical)
  changeOne(db, 'DELETE FROM MailMailbox WHERE tenant = ? AND name = ?', tenant, canonical)
  const next = (row?.uidValidity ?? 0) + 1
  let byName = reservedValidity.get(db)
  if (byName === undefined) {
    byName = new Map()
    reservedValidity.set(db, byName)
  }
  byName.set(validityKey(tenant, canonical), next)
  return next
}

export async function messagesOf(db: Db, tenant: string, mailbox: string): Promise<MessageRow[]> {
  const rows = all<Omit<MessageRow, 'internalDate'> & { internalDate: number }>(
    db,
    `${MESSAGE} WHERE tenant = ? AND mailbox = ? ORDER BY uid`,
    tenant,
    canonicalName(mailbox),
  )
  return rows.map((row) => ({ ...row, internalDate: BigInt(row.internalDate) }))
}

// The sequence number is the message's POSITION in the mailbox, one-based and
// recomputed on every listing: an EXPUNGE renumbers everything after the hole,
// which is the difference between a sequence number and a UID and the reason
// both addressing modes exist.
export function withSequence(rows: MessageRow[]): SearchMsg[] {
  return rows.map((row, i) => {
    const source = Buffer.from(row.source)
    const parsed = parseSource(source)
    return {
      seq: i + 1,
      uid: row.uid,
      internalDate: Number(row.internalDate),
      flags: row.flags === '' ? [] : row.flags.split(' '),
      headers: parsed.headers,
      body: parsed.body,
      source,
      // TEXT is header plus body, and the body half is the DECODED one: a
      // server that matched the transferred octets would answer `TEXT
      // "forecast"` with nothing for a base64 part and would match a search
      // for the base64 itself, neither of which any real server does. It is a
      // field of its own because FETCH serves `source` and must keep the raw
      // bytes -- sharing one field made every fetched message arrive decoded.
      text: `${parsed.head}\n\n${parsed.body}`,
    }
  })
}

export async function appendMessage(
  db: Db,
  tenant: string,
  mailbox: string,
  source: Buffer,
  flags: string[],
  internalDate: number,
): Promise<number> {
  const canonical = canonicalName(mailbox)
  const box = await mailboxOf(db, tenant, canonical)
  if (box === null) throw new Error(`no mailbox ${canonical}`)
  const uid = box.uidNext
  exec(
    db,
    'INSERT INTO MailMessage (tenant, mailbox, uid, internalDate, flags, source, seq) ' +
      `VALUES (?, ?, ?, ?, ?, ${BYTES}, ` +
      '(SELECT COUNT(*) FROM MailMessage WHERE tenant = ? AND mailbox = ?))',
    tenant,
    canonical,
    uid,
    internalDate,
    flags.join(' '),
    ...bytes(source),
    tenant,
    canonical,
  )
  // Advanced whether or not the message is later expunged: RFC 3501 forbids
  // reusing a UID within one UIDVALIDITY, so this is a high-water mark and not
  // a count.
  changeOne(
    db,
    'UPDATE MailMailbox SET uidNext = ? WHERE tenant = ? AND name = ?',
    uid + 1,
    tenant,
    canonical,
  )
  return uid
}

export async function setFlags(
  db: Db,
  tenant: string,
  mailbox: string,
  uid: number,
  flags: string[],
): Promise<void> {
  changeOne(
    db,
    'UPDATE MailMessage SET flags = ? WHERE tenant = ? AND mailbox = ? AND uid = ?',
    flags.join(' '),
    tenant,
    canonicalName(mailbox),
    uid,
  )
}

export async function removeMessage(
  db: Db,
  tenant: string,
  mailbox: string,
  uid: number,
): Promise<void> {
  changeOne(
    db,
    'DELETE FROM MailMessage WHERE tenant = ? AND mailbox = ? AND uid = ?',
    tenant,
    canonicalName(mailbox),
    uid,
  )
}
