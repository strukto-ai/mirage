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

import { createHash } from 'node:crypto'

import {
  assertHeaderValue,
  encodeBase64Lines,
  encodeMimeText as encodeText,
  foldAddressList,
  foldContentDisposition,
  foldUnstructured,
  materialize,
  type ByteSource,
  type FlagView,
} from '@struktoai/mirage-core'
import type { FetchedMessage } from '../../../../core/email/_client.ts'

type SourceMode = 'reply' | 'forward'
export type PostingStyle = 'top' | 'bottom'

const PREFIXES: Record<SourceMode, string> = { reply: 'Re: ', forward: 'Fwd: ' }
const ENC = new TextEncoder()

/** One file attached to an outgoing message. */
export interface Attachment {
  filename: string
  contentType: string
  data: Uint8Array
}

export interface Compose {
  sender: string
  to: readonly string[]
  cc: readonly string[]
  bcc: readonly string[]
  subject: string | null
  body: string
  signature: string | null
  attachments?: readonly Attachment[]
}

/**
 * A deterministic multipart boundary for the message's content.
 *
 * A random boundary would break byte-for-byte parity with the python
 * builder and make the no-send stdout non-reproducible. Hashing the
 * content gives a boundary that cannot occur inside it (the content
 * would have to contain its own hash) while staying stable across runs
 * and languages.
 */
export function mixedBoundary(body: string, attachments: readonly Attachment[]): string {
  const digest = createHash('sha256').update(Buffer.from(body, 'utf8'))
  for (const attachment of attachments) {
    digest.update(Buffer.from(attachment.filename, 'utf8'))
    digest.update(Buffer.from(attachment.contentType, 'utf8'))
    digest.update(attachment.data)
  }
  return digest.digest('hex').slice(0, 32)
}

export interface Source {
  message: FetchedMessage
  mode: SourceMode
  postingStyle: PostingStyle
  quoteHeadline: string
}

interface EmailAddress {
  name: string
  email: string
}

/** Flattens repeated address flags, splitting comma-separated lists. */
export function splitAddresses(values: readonly string[]): string[] {
  return values.flatMap((value) =>
    value
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== ''),
  )
}

/** Renders one parsed address as a header value. */
function formatAddress(entry: EmailAddress): string {
  const email = entry.email.trim()
  const name = entry.name.trim()
  return name !== '' && email !== '' ? `${name} <${email}>` : email
}

/**
 * Whether a subject already carries a Re:/Fwd: prefix. The colon is part
 * of the comparison: matching on the letters alone would read "Ready to
 * ship" as already prefixed with "Re:".
 */
export function hasPrefix(subject: string, prefix: string): boolean {
  const head = subject.trimStart()
  const marker = prefix.trim()
  return head.slice(0, marker.length).toLowerCase() === marker.toLowerCase()
}

/** Derives a reply's To from the source's Reply-To, else its From. */
function replyRecipients(message: FetchedMessage): string[] {
  if (message.reply_to.length > 0) return message.reply_to.map((entry) => formatAddress(entry))
  const rendered = formatAddress(message.from)
  return rendered === '' ? [] : [rendered]
}

/** Quotes a source body, one leading '>' per line. */
export function quoteText(sourceText: string, headline: string): string {
  const trimmed = sourceText.trim()
  if (trimmed === '') return ''
  const lines: string[] = []
  if (headline.trim() !== '') lines.push(headline.replace(/\n+$/, ''))
  for (const line of trimmed.split('\n')) {
    lines.push(line.startsWith('>') ? `>${line}` : `> ${line}`)
  }
  return lines.join('\n')
}

/** Lays out the user's body, the quoted source and the signature. */
export function composeBody(
  userBody: string,
  quote: string,
  signature: string,
  style: PostingStyle,
): string {
  let body = userBody.replace(/\n+$/, '')
  if (quote !== '') {
    if (body === '') body = quote
    else if (style === 'bottom') body = `${quote}\n\n${body}`
    else body = `${body}\n\n${quote}`
  }
  if (signature.trim() !== '') body = `${body}\n\n-- \n${signature.replace(/\n+$/, '')}`
  return body
}

/**
 * Assembles an RFC 5322 message from flags and an optional source.
 *
 * Hand-built rather than routed through nodemailer's composer: the raw
 * bytes are the command's output when --send is absent, so they must
 * exist before any transport does. Every header and the body ride the
 * mime module's ports of python's serializers, so the output stays
 * byte-identical to EmailMessage.as_bytes(policy=SMTP) - header order,
 * encoded words, folding, transfer encoding and all (pinned in
 * integ/fixtures/himalaya/mime_parity.json).
 */
export function build(compose: Compose, source: Source | null = null): Uint8Array {
  let recipients = [...compose.to]
  let subject = compose.subject
  let sourceText = ''
  const headLines: string[] = [foldAddressList('From', [compose.sender])]
  if (source !== null) {
    const original = source.message
    const prefix = PREFIXES[source.mode]
    subject ??= hasPrefix(original.subject, prefix)
      ? original.subject
      : `${prefix}${original.subject}`
    if (source.mode === 'reply' && recipients.length === 0) {
      recipients = replyRecipients(original)
    }
    if (original.message_id !== '') {
      // Threading headers land before To, matching python's insertion
      // order in the reference builder.
      if (source.mode === 'reply') {
        headLines.push(foldUnstructured('In-Reply-To', original.message_id))
      }
      headLines.push(
        foldUnstructured('References', [...original.references, original.message_id].join(' ')),
      )
    }
    sourceText = original.body_text
  }
  if (recipients.length === 0) throw new Error('no recipient: pass --to')
  // EmailMessage refuses these outright (header injection), so the
  // reference implementation never serializes them.
  for (const value of [
    compose.sender,
    ...recipients,
    ...compose.cc,
    ...compose.bcc,
    subject ?? '',
  ]) {
    assertHeaderValue(value)
  }
  headLines.push(foldAddressList('To', recipients))
  if (compose.cc.length > 0) headLines.push(foldAddressList('Cc', compose.cc))
  if (compose.bcc.length > 0) headLines.push(foldAddressList('Bcc', compose.bcc))
  headLines.push(foldUnstructured('Subject', subject ?? ''))
  const style: PostingStyle = source !== null ? source.postingStyle : 'top'
  const headline = source !== null ? source.quoteHeadline : ''
  const body = composeBody(
    compose.body,
    quoteText(sourceText, headline),
    compose.signature ?? '',
    style,
  )
  // SMTP is a CRLF protocol and these bytes go straight onto the wire
  // (or into `message send`), so the LF-built payload cannot stay
  // LF-only.
  const { cte, payload } = encodeText(body)
  const rendered = payload.replaceAll('\n', '\r\n')
  const attachments = compose.attachments ?? []
  if (attachments.length === 0) {
    headLines.push('Content-Type: text/plain; charset="utf-8"')
    headLines.push(`Content-Transfer-Encoding: ${cte}`)
    headLines.push('MIME-Version: 1.0')
    return ENC.encode(`${headLines.join('\r\n')}\r\n\r\n${rendered}`)
  }
  // Multipart layout matches EmailMessage.add_attachment: MIME-Version
  // moves above the multipart Content-Type at the top, the body part
  // keeps its single-part headers, and each attachment part carries its
  // own MIME-Version after Content-Disposition.
  const boundary = mixedBoundary(body, attachments)
  headLines.push('MIME-Version: 1.0')
  headLines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`)
  const parts = [
    `Content-Type: text/plain; charset="utf-8"\r\nContent-Transfer-Encoding: ${cte}\r\n\r\n${rendered}`,
  ]
  for (const attachment of attachments) {
    const attachmentHead =
      `Content-Type: ${attachment.contentType}\r\n` +
      `Content-Transfer-Encoding: base64\r\n` +
      `${foldContentDisposition(attachment.filename)}\r\n` +
      `MIME-Version: 1.0`
    // The base64 payload is line-terminated (EmailMessage semantics),
    // so empty data serializes as zero lines, not one blank line.
    const encoded = encodeBase64Lines(attachment.data).replaceAll('\n', '\r\n')
    parts.push(`${attachmentHead}\r\n\r\n${encoded}`)
  }
  const head = headLines.join('\r\n')
  const joined = parts.join(`\r\n--${boundary}\r\n`)
  return ENC.encode(`${head}\r\n\r\n--${boundary}\r\n${joined}\r\n--${boundary}--\r\n`)
}

/** Resolves the body from --body, falling back to piped stdin. */
export async function readBody(fl: FlagView, stdin: ByteSource | null): Promise<string> {
  const inline = fl.asStr('body')
  if (inline !== undefined) return inline
  if (stdin === null) return ''
  return new TextDecoder().decode(await materialize(stdin))
}
