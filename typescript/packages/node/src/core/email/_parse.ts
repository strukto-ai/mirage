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

import { loadOptionalPeer } from '@struktoai/mirage-core'
import type {
  AddressObject,
  EmailAddress as MailparserEmailAddress,
  ParsedMail,
  simpleParser,
} from 'mailparser'

interface EmailAddress {
  name: string
  email: string
}

export interface ParsedAttachment {
  filename: string
  content_type: string
  size: number
}

export interface ParsedAttachmentWithPayload extends ParsedAttachment {
  payload: Uint8Array
}

export interface ParsedRfc822 {
  from: EmailAddress
  to: EmailAddress[]
  cc: EmailAddress[]
  subject: string
  date: string
  body_text: string
  body_html: string
  snippet: string
  message_id: string
  in_reply_to: string | null
  references: string[]
  has_attachments: boolean
  attachments: ParsedAttachment[]
}

let parserPromise: Promise<typeof simpleParser> | null = null

async function getParser(): Promise<typeof simpleParser> {
  parserPromise ??= (async () => {
    const mod = await loadOptionalPeer(
      () =>
        import('mailparser') as unknown as Promise<{
          simpleParser: typeof simpleParser
        }>,
      { feature: 'parseRfc822', packageName: 'mailparser' },
    )
    return mod.simpleParser
  })()
  return parserPromise
}

function toAddr(a: MailparserEmailAddress | undefined): EmailAddress {
  if (a === undefined) return { name: '', email: '' }
  return { name: a.name, email: a.address ?? '' }
}

function toAddrList(list: AddressObject | AddressObject[] | undefined): EmailAddress[] {
  if (list === undefined) return []
  const objs = Array.isArray(list) ? list : [list]
  return objs.flatMap((obj) => obj.value.map((a) => toAddr(a)))
}

// The rendered date must be the raw Date header text (python serves the
// header untouched); mailparser's parsed.date would re-format it.
function rawDateHeader(parsed: ParsedMail): string {
  const found = parsed.headerLines.find((h) => h.key === 'date')
  if (found === undefined) return ''
  const colon = found.line.indexOf(':')
  return colon === -1 ? '' : found.line.slice(colon + 1).trim()
}

function fromParsed(parsed: ParsedMail, headersOnly: boolean): ParsedRfc822 {
  const text = headersOnly ? '' : (parsed.text ?? '')
  const html = headersOnly ? '' : typeof parsed.html === 'string' ? parsed.html : ''
  const attachments = headersOnly
    ? []
    : parsed.attachments.map((a) => ({
        filename: a.filename ?? 'unnamed',
        content_type: a.contentType,
        size: a.size,
      }))
  const refsRaw = parsed.references
  const references =
    typeof refsRaw === 'string' ? refsRaw.split(/\s+/).filter((s) => s !== '') : (refsRaw ?? [])
  return {
    from: toAddr(parsed.from?.value[0]),
    to: toAddrList(parsed.to),
    cc: toAddrList(parsed.cc),
    subject: parsed.subject ?? '',
    date: rawDateHeader(parsed),
    body_text: text,
    body_html: html,
    snippet: text.slice(0, 100),
    message_id: parsed.messageId ?? '',
    in_reply_to:
      typeof parsed.inReplyTo === 'string' && parsed.inReplyTo !== '' ? parsed.inReplyTo : null,
    references,
    has_attachments: attachments.length > 0,
    attachments,
  }
}

export async function parseRfc822(raw: Uint8Array, headersOnly = false): Promise<ParsedRfc822> {
  const parser = await getParser()
  const parsed = await parser(Buffer.from(raw), { skipHtmlToText: false })
  return fromParsed(parsed, headersOnly)
}

export async function parseWithPayloads(raw: Uint8Array): Promise<ParsedAttachmentWithPayload[]> {
  const parser = await getParser()
  const parsed = await parser(Buffer.from(raw))
  return parsed.attachments.map((a) => ({
    filename: a.filename ?? 'unnamed',
    content_type: a.contentType,
    size: a.size,
    payload: new Uint8Array(a.content),
  }))
}
