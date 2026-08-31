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

import { INBOX, type C } from './config.ts'
import { parseSource, type SearchMsg } from './search.ts'

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

export async function mailboxOf(db: C, tenant: string, name: string): Promise<MailboxRow | null> {
  return db.mailMailbox.findUnique({
    where: { tenant_name: { tenant, name: canonicalName(name) } },
  })
}

export async function mailboxesOf(db: C, tenant: string): Promise<MailboxRow[]> {
  const rows = await db.mailMailbox.findMany({ where: { tenant }, orderBy: { seq: 'asc' } })
  // INBOX first, then insertion order, which is what every server this stands
  // in for lists and what makes a golden listing stable.
  return [...rows].sort((a, b) => {
    if (a.name === INBOX) return -1
    if (b.name === INBOX) return 1
    return a.seq - b.seq
  })
}

// UIDVALIDITY a DELETE reserved for whatever CREATE remakes the name. Keyed
// by the run's client, which the kit pool caches per run and whose database
// file lives in a per-process temp root, so the reservation is exactly as
// durable as the rows it protects.
const reservedValidity = new WeakMap<C, Map<string, number>>()

function validityKey(tenant: string, name: string): string {
  return `${tenant}\u0000${name}`
}

export async function createMailbox(db: C, tenant: string, name: string): Promise<MailboxRow> {
  const canonical = canonicalName(name)
  const reserved = reservedValidity.get(db)?.get(validityKey(tenant, canonical))
  return db.mailMailbox.create({
    data: {
      tenant,
      name: canonical,
      ...(reserved === undefined ? {} : { uidValidity: reserved }),
      seq: await db.mailMailbox.count({ where: { tenant } }),
    },
  })
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
export async function deleteMailbox(db: C, tenant: string, name: string): Promise<number> {
  const canonical = canonicalName(name)
  const row = await mailboxOf(db, tenant, canonical)
  await db.mailMessage.deleteMany({ where: { tenant, mailbox: canonical } })
  await db.mailMailbox.delete({ where: { tenant_name: { tenant, name: canonical } } })
  const next = (row?.uidValidity ?? 0) + 1
  let byName = reservedValidity.get(db)
  if (byName === undefined) {
    byName = new Map()
    reservedValidity.set(db, byName)
  }
  byName.set(validityKey(tenant, canonical), next)
  return next
}

export async function messagesOf(db: C, tenant: string, mailbox: string): Promise<MessageRow[]> {
  return db.mailMessage.findMany({
    where: { tenant, mailbox: canonicalName(mailbox) },
    orderBy: { uid: 'asc' },
  })
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
  db: C,
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
  await db.mailMessage.create({
    data: {
      tenant,
      mailbox: canonical,
      uid,
      internalDate: BigInt(internalDate),
      flags: flags.join(' '),
      source: new Uint8Array(source),
      seq: await db.mailMessage.count({ where: { tenant, mailbox: canonical } }),
    },
  })
  // Advanced whether or not the message is later expunged: RFC 3501 forbids
  // reusing a UID within one UIDVALIDITY, so this is a high-water mark and not
  // a count.
  await db.mailMailbox.update({
    where: { tenant_name: { tenant, name: canonical } },
    data: { uidNext: uid + 1 },
  })
  return uid
}

export async function setFlags(
  db: C,
  tenant: string,
  mailbox: string,
  uid: number,
  flags: string[],
): Promise<void> {
  await db.mailMessage.update({
    where: { tenant_mailbox_uid: { tenant, mailbox: canonicalName(mailbox), uid } },
    data: { flags: flags.join(' ') },
  })
}

export async function removeMessage(
  db: C,
  tenant: string,
  mailbox: string,
  uid: number,
): Promise<void> {
  await db.mailMessage.delete({
    where: { tenant_mailbox_uid: { tenant, mailbox: canonicalName(mailbox), uid } },
  })
}
