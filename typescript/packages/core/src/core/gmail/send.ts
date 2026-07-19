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

import { type TokenManager, gmailBase, googlePost } from '../google/_client.ts'
import { extractHeader, getMessageProcessed, getMessageRaw } from './messages.ts'

const ENC = new TextEncoder()

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  const std =
    typeof btoa === 'function' ? btoa(binary) : Buffer.from(binary, 'binary').toString('base64')
  return std.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function buildMime(headers: Record<string, string>, body: string): string {
  const lines: string[] = []
  lines.push('MIME-Version: 1.0')
  lines.push('Content-Type: text/plain; charset="utf-8"')
  lines.push('Content-Transfer-Encoding: 7bit')
  for (const [k, v] of Object.entries(headers)) {
    if (v !== '') lines.push(`${k}: ${v}`)
  }
  lines.push('')
  lines.push(body)
  return lines.join('\r\n')
}

export async function sendMessage(
  tokenManager: TokenManager,
  to: string,
  subject: string,
  body: string,
): Promise<unknown> {
  const mime = buildMime({ To: to, Subject: subject }, body)
  const raw = base64UrlEncode(ENC.encode(mime))
  const url = `${gmailBase(tokenManager)}/users/me/messages/send`
  return googlePost(tokenManager, url, { raw })
}

export async function replyMessage(
  tokenManager: TokenManager,
  messageId: string,
  body: string,
): Promise<unknown> {
  const rawMsg = await getMessageRaw(tokenManager, messageId)
  const headers = rawMsg.payload?.headers ?? []
  const to = extractHeader(headers, 'From')
  let subject = extractHeader(headers, 'Subject')
  if (!subject.toLowerCase().startsWith('re:')) subject = `Re: ${subject}`
  const threadId = rawMsg.threadId ?? ''
  const msgIdHeader = extractHeader(headers, 'Message-ID')

  const mimeHeaders: Record<string, string> = { To: to, Subject: subject }
  if (msgIdHeader !== '') {
    mimeHeaders['In-Reply-To'] = msgIdHeader
    mimeHeaders.References = msgIdHeader
  }
  const mime = buildMime(mimeHeaders, body)
  const raw = base64UrlEncode(ENC.encode(mime))
  const payload: Record<string, string> = { raw }
  if (threadId !== '') payload.threadId = threadId
  const url = `${gmailBase(tokenManager)}/users/me/messages/send`
  return googlePost(tokenManager, url, payload)
}

export async function replyAllMessage(
  tokenManager: TokenManager,
  messageId: string,
  body: string,
): Promise<unknown> {
  const rawMsg = await getMessageRaw(tokenManager, messageId)
  const headers = rawMsg.payload?.headers ?? []
  const sender = extractHeader(headers, 'From')
  const originalTo = extractHeader(headers, 'To')
  const originalCc = extractHeader(headers, 'Cc')
  let subject = extractHeader(headers, 'Subject')
  if (!subject.toLowerCase().startsWith('re:')) subject = `Re: ${subject}`
  const threadId = rawMsg.threadId ?? ''
  const msgIdHeader = extractHeader(headers, 'Message-ID')

  const allTo = [sender, originalTo].filter((s) => s !== '').join(', ')
  const mimeHeaders: Record<string, string> = { To: allTo, Subject: subject }
  if (originalCc !== '') mimeHeaders.Cc = originalCc
  if (msgIdHeader !== '') {
    mimeHeaders['In-Reply-To'] = msgIdHeader
    mimeHeaders.References = msgIdHeader
  }
  const mime = buildMime(mimeHeaders, body)
  const raw = base64UrlEncode(ENC.encode(mime))
  const payload: Record<string, string> = { raw }
  if (threadId !== '') payload.threadId = threadId
  const url = `${gmailBase(tokenManager)}/users/me/messages/send`
  return googlePost(tokenManager, url, payload)
}

export async function forwardMessage(
  tokenManager: TokenManager,
  messageId: string,
  to: string,
): Promise<unknown> {
  const processed = await getMessageProcessed(tokenManager, messageId)
  let subject = processed.subject
  if (!subject.toLowerCase().startsWith('fwd:')) subject = `Fwd: ${subject}`
  const fwdBody =
    `---------- Forwarded message ----------\n` +
    `From: ${processed.from.email}\n` +
    `Date: ${processed.date}\n` +
    `Subject: ${processed.subject}\n\n` +
    processed.body_text
  return sendMessage(tokenManager, to, subject, fwdBody)
}
