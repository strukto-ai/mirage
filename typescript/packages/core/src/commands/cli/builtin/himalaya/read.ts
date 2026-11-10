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

import type { CommandFnResult, Context } from '../../../config.ts'
import type { PathSpec } from '../../../../types.ts'
import { FlagView } from '../../../spec/index.ts'
import { IOResult } from '../../../../io/types.ts'
import type { EmailAccessor } from '../../../../accessor/email.ts'
import { storeFlags } from '../../../../core/email/client.ts'
import {
  contentTypeOf,
  headerValue,
  parseMime,
  partAt,
  type ContentFields,
  type MimeMessage,
  type MimePart,
  type MimeValue,
} from '../../../../core/email/mime.ts'
import { compactJsonBytes } from '../../../../core/render/json.ts'
import { MONTHS } from '../../../builtin/utils/constants.ts'
import { PARSE_FAILURE, partMime, partName, partPayload } from './attachment.ts'
import { SEEN_FLAG } from './deliver.ts'
import { notice } from './printer.ts'
import { formatSize } from './table.ts'
import { fetchSource } from './util.ts'

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const ENC = new TextEncoder()

interface DateFields {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  tz_before_gmt: boolean
  tz_hour: number
  tz_minute: number
}

interface MailAddress {
  name: string | null
  address: string | null
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0')
}

function dayOfWeek(year: number, month: number, day: number): number {
  const offsets = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4]
  const y = month < 3 ? year - 1 : year
  return (
    (y +
      Math.floor(y / 4) -
      Math.floor(y / 100) +
      Math.floor(y / 400) +
      (offsets[month - 1] ?? 0) +
      day) %
    7
  )
}

function rfc822(value: DateFields): string {
  const negative = value.tz_before_gmt && (value.tz_hour > 0 || value.tz_minute > 0)
  return (
    `${DAYS[dayOfWeek(value.year, value.month, value.day)] ?? ''}, ${String(value.day)} ` +
    `${MONTHS[value.month - 1] ?? ''} ${pad(value.year, 4)} ${pad(value.hour)}:${pad(value.minute)}:` +
    `${pad(value.second)} ${negative ? '-' : '+'}${pad(value.tz_hour)}${pad(value.tz_minute)}`
  )
}

function addressText(entry: MailAddress): string {
  const email = entry.address ?? ''
  return entry.name !== null && entry.name !== '' ? `${entry.name} <${email}>` : email
}

function addresses(value: MimeValue): string | null {
  if (value === null || typeof value !== 'object' || !('Address' in value)) return null
  const address = (
    value as unknown as {
      Address: { List?: MailAddress[]; Group?: { addresses: MailAddress[] }[] }
    }
  ).Address
  if (address.List !== undefined) return address.List.map(addressText).join(', ')
  return (address.Group ?? []).flatMap((group) => group.addresses.map(addressText)).join(', ')
}

function formatContent(content: ContentFields): string {
  let out = content.c_subtype !== null ? `${content.c_type}/${content.c_subtype}` : content.c_type
  for (const attribute of content.attributes ?? []) out += `; ${attribute.name}=${attribute.value}`
  return out
}

function textOf(value: MimeValue): string | null {
  if (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { Text?: unknown }).Text === 'string'
  ) {
    return (value as { Text: string }).Text
  }
  return null
}

function firstText(value: MimeValue): string | null {
  if (
    value !== null &&
    typeof value === 'object' &&
    Array.isArray((value as { TextList?: unknown }).TextList)
  ) {
    return String((value as { TextList: unknown[] }).TextList[0])
  }
  return textOf(value)
}

function renderPart(part: MimePart, position: number, htmlOnly: boolean): string {
  const { headers, body } = part
  const mime =
    partMime(headers) ??
    ('Html' in body ? 'text/html' : 'Text' in body ? 'text/plain' : 'application/octet-stream')
  const size = formatSize(partPayload(body).length)
  const name = partName(headers)
  const label =
    name !== null
      ? `[${String(position)}] ${mime} — ${name} (${size})`
      : `[${String(position)}] ${mime} (${size})`
  const lines = ['', label]
  const content = contentTypeOf(headers, 'content_type')
  if (content !== null) lines.push(`    Content-Type: ${formatContent(content)}`)
  const encoding = textOf(headerValue(headers, 'content_transfer_encoding'))
  if (encoding !== null) lines.push(`    Content-Transfer-Encoding: ${encoding}`)
  const disposition = contentTypeOf(headers, 'content_disposition')
  if (disposition !== null) lines.push(`    Content-Disposition: ${formatContent(disposition)}`)
  const contentId = firstText(headerValue(headers, 'content_id'))
  if (contentId !== null) lines.push(`    Content-ID: ${contentId}`)
  const description = textOf(headerValue(headers, 'content_description'))
  if (description !== null) lines.push(`    Content-Description: ${description}`)
  const shown =
    htmlOnly && 'Html' in body ? body.Html : !htmlOnly && 'Text' in body ? body.Text : null
  if (shown !== null && shown.trim() !== '') lines.push('', shown.trim())
  return `${lines.join('\n')}\n`
}

function isHtmlOnly(message: MimeMessage): boolean {
  const html = message.parts.filter((part) => 'Html' in part.body).length
  const plain = message.parts.filter((part) => 'Text' in part.body).length
  return html === 1 && plain === 0
}

/** A message as `message read` shows it. */
export function messageView(message: MimeMessage): string {
  const top = partAt(message, 0).headers
  let out = ''
  const date = headerValue(top, 'date')
  if (date !== null && typeof date === 'object' && 'DateTime' in date) {
    out += `Date: ${rfc822((date as unknown as { DateTime: DateFields }).DateTime)}\n`
  }
  for (const [title, name] of [
    ['From', 'from'],
    ['To', 'to'],
    ['Cc', 'cc'],
  ] as const) {
    const shown = addresses(headerValue(top, name))
    if (shown !== null) out += `${title}: ${shown}\n`
  }
  const subject = textOf(headerValue(top, 'subject'))
  if (subject !== null) out += `Subject: ${subject}\n`
  const htmlOnly = isHtmlOnly(message)
  message.parts.forEach((part, index) => {
    if (!('Multipart' in part.body)) out += renderPart(part, index + 1, htmlOnly)
  })
  return out
}

export async function read(
  accessor: EmailAccessor,
  _paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags, ctx.spec)
  const uid = texts[0] ?? ''
  const mailbox = fl.asStr('mailbox', 'INBOX')
  const raw = await fetchSource(accessor, mailbox, uid)
  if (fl.asBool('seen')) await storeFlags(accessor, mailbox, [uid], [SEEN_FLAG], 'add')
  if (fl.asBool('raw')) {
    if (fl.asBool('json')) return [notice(fl, new TextDecoder().decode(raw)), new IOResult()]
    return [raw, new IOResult()]
  }
  const message = parseMime(raw)
  if (message === null) throw new Error(PARSE_FAILURE)
  if (fl.asBool('json')) return [compactJsonBytes(message.asDocument()), new IOResult()]
  return [ENC.encode(messageView(message)), new IOResult()]
}
