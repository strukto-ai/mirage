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

import type { fetchMessage } from './client.ts'

const encoder = new TextEncoder()

/**
 * Projects a fetched message onto the document mirage serves.
 *
 * INTERNALDATE is dropped: it is the mailbox's own arrival stamp, which
 * picks the date directory when the `Date:` header is missing, not a
 * field of the message. The gmail backend keeps its internalDate out of
 * the rendered JSON the same way.
 */
function messageDocument(
  message: Awaited<ReturnType<typeof fetchMessage>>,
): Partial<Awaited<ReturnType<typeof fetchMessage>>> {
  const transport: readonly string[] = TRANSPORT_KEYS
  return Object.fromEntries(
    Object.entries(message).filter(([key]) => !transport.includes(key)),
  ) as Partial<Awaited<ReturnType<typeof fetchMessage>>>
}

export function messageJsonText(message: Awaited<ReturnType<typeof fetchMessage>>): string {
  return JSON.stringify(messageDocument(message))
}

export function messageJsonBytes(message: Awaited<ReturnType<typeof fetchMessage>>): Uint8Array {
  // Single renderer for .email.json: the listing fetches the full message
  // source and parses it exactly like read() does, so sizing a listed
  // header dict here yields the byte length read() will return. Every
  // other serializer of a fetched message routes through here too, so
  // `himalaya message read` cannot drift from `cat`.
  return encoder.encode(messageJsonText(message))
}

const TRANSPORT_KEYS = ['internalDate', 'rawSize', 'attached'] as const
const IANA_FLAGS = [
  'seen',
  'answered',
  'flagged',
  'draft',
  'deleted',
  'forwarded',
  'junk',
  'not-junk',
  'phishing',
  'important',
  'mdn-sent',
]
const IANA_BY_BARE_NAME = new Map(IANA_FLAGS.map((name) => [name.replace('-', ''), name]))
export interface Envelope {
  id: string
  'message-id': string | null
  'in-reply-to': string[]
  flags: { raw: string; iana: string | null }[]
  subject: string
  from: { name: string | null; email: string }[]
  to: { name: string | null; email: string }[]
  date: string | null
  size: number
  'has-attachment': boolean | null
}

function normalizedId(raw: string): string | null {
  let trimmed = raw.trim()
  if (trimmed.startsWith('<') && trimmed.endsWith('>')) trimmed = trimmed.slice(1, -1).trim()
  return trimmed === '' ? null : trimmed
}

function messageIds(raw: string): string[] {
  const chunks = raw.includes('<')
    ? raw
        .split('<')
        .filter((chunk) => chunk.includes('>'))
        .map((chunk) => chunk.slice(0, chunk.indexOf('>')))
    : raw.split(/\s+/)
  return chunks.map(normalizedId).filter((id): id is string => id !== null)
}

function flagRank(flag: Envelope['flags'][number]): number {
  return flag.iana === null ? IANA_FLAGS.length : IANA_FLAGS.indexOf(flag.iana)
}

/**
 * A message's flags as upstream renders them: classified against the IANA
 * registry, one entry per flag, IANA flags first in the registry's order and
 * keywords after them by name. `\\Recent` is the server's own bookkeeping and is
 * left out.
 */
function flagDocuments(flags: readonly string[]): Envelope['flags'] {
  const found = new Map<string, Envelope['flags'][number]>()
  for (const raw of flags) {
    if (raw.toLowerCase() === '\\recent') continue
    const bare = raw.startsWith('\\') || raw.startsWith('$') ? raw.slice(1) : raw
    const iana = IANA_BY_BARE_NAME.get(bare.toLowerCase()) ?? null
    const key = iana ?? raw.toLowerCase()
    if (!found.has(key)) found.set(key, { raw, iana })
  }
  return [...found.values()].sort(
    (a, b) => flagRank(a) - flagRank(b) || a.raw.toLowerCase().localeCompare(b.raw.toLowerCase()),
  )
}

function addresses(entries: readonly { name: string; email: string }[]): Envelope['to'] {
  return entries
    .filter((entry) => entry.email !== '')
    .map((entry) => ({ name: entry.name === '' ? null : entry.name, email: entry.email }))
}

/** A `Date:` header as RFC 3339, null when it cannot be read. */
function rfc3339(date: string): string | null {
  const stamp = Date.parse(date)
  const shape = /^(?:[A-Za-z]{3},\s*)?\d{1,2}\s+[A-Za-z]{3}\s+\d{2,4}\s+\d{1,2}:\d{2}/
  if (Number.isNaN(stamp) || !shape.test(date.trim())) return null
  const named: Record<string, number> = {
    EST: -300,
    EDT: -240,
    CST: -360,
    CDT: -300,
    MST: -420,
    MDT: -360,
    PST: -480,
    PDT: -420,
  }
  const tokens = date
    .trim()
    .split(/\s+/)
    .filter((token) => !token.startsWith('('))
  const label = tokens[tokens.length - 1] ?? ''
  const numeric = /^([+-])(\d{2})(\d{2})$/.exec(label)
  const span = numeric === null ? 0 : Number(numeric[2]) * 60 + Number(numeric[3])
  const zone =
    numeric === null ? (named[label.toUpperCase()] ?? 0) : numeric[1] === '-' ? -span : span
  const local = new Date(stamp + zone * 60_000).toISOString().slice(0, 19)
  if (zone === 0) return `${local}Z`
  const hours = String(Math.floor(Math.abs(zone) / 60)).padStart(2, '0')
  const minutes = String(Math.abs(zone) % 60).padStart(2, '0')
  return `${local}${zone < 0 ? '-' : '+'}${hours}:${minutes}`
}

/** Projects a fetched message onto upstream himalaya's envelope. */
function envelopeDocument(
  message: Awaited<ReturnType<typeof fetchMessage>>,
  withAttachment: boolean,
): Envelope {
  return {
    id: message.uid,
    'message-id': normalizedId(message.message_id),
    'in-reply-to': messageIds(message.in_reply_to ?? ''),
    flags: flagDocuments(message.flags),
    subject: message.subject,
    from: addresses([message.from]),
    to: addresses(message.to),
    date: rfc3339(message.date),
    size: message.rawSize,
    'has-attachment': withAttachment ? message.attached : null,
  }
}

/** Renders fetched messages as upstream himalaya's envelope listing. */
export function envelopeDocuments(
  messages: readonly Awaited<ReturnType<typeof fetchMessage>>[],
  withAttachment = false,
): Envelope[] {
  return messages.map((m) => envelopeDocument(m, withAttachment))
}
