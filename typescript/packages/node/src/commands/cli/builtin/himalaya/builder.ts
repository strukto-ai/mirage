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

import { materialize, type ByteSource, type FlagView } from '@struktoai/mirage-core'
import type { FetchedMessage } from '../../../../core/email/_client.ts'

type SourceMode = 'reply' | 'forward'
export type PostingStyle = 'top' | 'bottom'

const PREFIXES: Record<SourceMode, string> = { reply: 'Re: ', forward: 'Fwd: ' }
const ENC = new TextEncoder()

export interface Compose {
  sender: string
  to: readonly string[]
  cc: readonly string[]
  bcc: readonly string[]
  subject: string | null
  body: string
  signature: string | null
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

function isAscii(value: string): boolean {
  for (const char of value) {
    if ((char.codePointAt(0) ?? 0) > 127) return false
  }
  return true
}

function encodeHeader(value: string): string {
  if (isAscii(value)) return value
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`
}

function wrapBase64(value: string): string {
  return (value.match(/.{1,76}/g) ?? []).join('\r\n')
}

/**
 * Assembles an RFC 5322 message from flags and an optional source.
 *
 * Hand-built rather than routed through nodemailer's composer: the raw
 * bytes are the command's output when --send is absent, so they must
 * exist before any transport does.
 */
export function build(compose: Compose, source: Source | null = null): Uint8Array {
  let recipients = [...compose.to]
  let subject = compose.subject
  let sourceText = ''
  const headers: [string, string][] = [['From', compose.sender]]
  const threading: [string, string][] = []
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
      if (source.mode === 'reply') threading.push(['In-Reply-To', original.message_id])
      threading.push(['References', [...original.references, original.message_id].join(' ')])
    }
    sourceText = original.body_text
  }
  if (recipients.length === 0) throw new Error('no recipient: pass --to')
  headers.push(['To', recipients.join(', ')])
  if (compose.cc.length > 0) headers.push(['Cc', compose.cc.join(', ')])
  if (compose.bcc.length > 0) headers.push(['Bcc', compose.bcc.join(', ')])
  headers.push(...threading)
  headers.push(['Subject', encodeHeader(subject ?? '')])
  const style: PostingStyle = source !== null ? source.postingStyle : 'top'
  const headline = source !== null ? source.quoteHeadline : ''
  const body = composeBody(
    compose.body,
    quoteText(sourceText, headline),
    compose.signature ?? '',
    style,
  )
  // Header order matches python's EmailMessage.set_content so the two
  // implementations serialize the same message byte for byte.
  const ascii = isAscii(body)
  headers.push(['Content-Type', 'text/plain; charset="utf-8"'])
  headers.push(['Content-Transfer-Encoding', ascii ? '7bit' : 'base64'])
  headers.push(['MIME-Version', '1.0'])
  // SMTP is a CRLF protocol and these bytes go straight onto the wire
  // (or into `message send`), so the body cannot stay LF-only.
  const rendered = ascii
    ? body.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n')
    : wrapBase64(Buffer.from(body, 'utf8').toString('base64'))
  const head = headers.map(([key, value]) => `${key}: ${value}`).join('\r\n')
  return ENC.encode(`${head}\r\n\r\n${rendered}\r\n`)
}

/** Resolves the body from --body, falling back to piped stdin. */
export async function readBody(fl: FlagView, stdin: ByteSource | null): Promise<string> {
  const inline = fl.asStr('body')
  if (inline !== undefined) return inline
  if (stdin === null) return ''
  return new TextDecoder().decode(await materialize(stdin))
}
