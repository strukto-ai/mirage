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

import type { JsonValue } from '../../kit/typescript/index.ts'
import type { GwsState } from '../store/state.ts'
import type { GmailLabel, GmailMessage } from '../store/types.ts'
import type { JsonObj } from '../wire/json.ts'
import { b64url, parseRfc822 } from './mime.ts'

const SNIPPET_LIMIT = 100

export function gmailHeader(msg: GmailMessage, name: string): string {
  const found = msg.headers.find((h) => h.name.toLowerCase() === name.toLowerCase())
  return found === undefined ? '' : found.value
}

export function gmailSnippet(text: string): string {
  const flat = text
    .split(/\s+/)
    .filter((w) => w !== '')
    .join(' ')
  return flat.length > SNIPPET_LIMIT ? flat.slice(0, SNIPPET_LIMIT) : flat
}

export function gmailSizeEstimate(msg: GmailMessage): number {
  return (
    Buffer.byteLength(msg.bodyText, 'utf-8') +
    msg.attachments.reduce((total, a) => total + a.data.length, 0)
  )
}

// The message as RFC 822 that parseRfc822 reads back to the same headers,
// body and attachments, so a raw read can be edited and saved again.
export function gmailRaw(msg: GmailMessage): Buffer {
  const head = msg.headers.map((h) => `${h.name}: ${h.value}\r\n`).join('')
  if (msg.attachments.length === 0) return Buffer.from(`${head}\r\n${msg.bodyText}\r\n`)
  const boundary = `part-${msg.id}`
  const parts = [
    `--${boundary}\r\nContent-Type: text/plain; charset="UTF-8"\r\n\r\n${msg.bodyText}\r\n`,
  ]
  for (const att of msg.attachments) {
    parts.push(
      `--${boundary}\r\nContent-Type: ${att.mimeType}\r\n` +
        `Content-Disposition: attachment; filename="${att.filename}"\r\n` +
        `Content-Transfer-Encoding: base64\r\n\r\n${att.data.toString('base64')}\r\n`,
    )
  }
  return Buffer.from(
    `${head}MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n` +
      `${parts.join('')}--${boundary}--\r\n`,
  )
}

// messages.get's `format`: `raw` gives the whole email in place of the parsed
// payload; any other format is served as `full`.
export function fmtGmailMessage(msg: GmailMessage, format: string | null = null): JsonObj {
  if (format === 'raw') {
    return {
      id: msg.id,
      threadId: msg.threadId,
      labelIds: [...msg.labelIds],
      snippet: gmailSnippet(msg.bodyText),
      internalDate: String(msg.internalDate),
      sizeEstimate: gmailSizeEstimate(msg),
      raw: b64url(gmailRaw(msg)),
    }
  }
  const headers: JsonValue[] = msg.headers.map((h) => ({ name: h.name, value: h.value }))
  const bodyData = Buffer.from(msg.bodyText, 'utf-8')
  let payload: JsonObj
  if (msg.attachments.length === 0) {
    payload = {
      partId: '',
      mimeType: 'text/plain',
      filename: '',
      headers,
      body: { size: bodyData.length, data: b64url(bodyData) },
    }
  } else {
    const parts: JsonValue[] = [
      {
        partId: '0',
        mimeType: 'text/plain',
        filename: '',
        headers: [],
        body: { size: bodyData.length, data: b64url(bodyData) },
      },
    ]
    msg.attachments.forEach((att, i) => {
      parts.push({
        partId: String(i + 1),
        mimeType: att.mimeType,
        filename: att.filename,
        headers: [],
        body: { attachmentId: att.attachmentId, size: att.data.length },
      })
    })
    payload = {
      partId: '',
      mimeType: 'multipart/mixed',
      filename: '',
      headers,
      body: { size: 0 },
      parts,
    }
  }
  return {
    id: msg.id,
    threadId: msg.threadId,
    labelIds: [...msg.labelIds],
    snippet: gmailSnippet(msg.bodyText),
    internalDate: String(msg.internalDate),
    sizeEstimate: gmailSizeEstimate(msg),
    payload,
  }
}

export function labelByName(st: GwsState, name: string): GmailLabel | undefined {
  const lower = name.toLowerCase()
  return [...st.labels.values()].find(
    (label) => label.name.toLowerCase() === lower || label.id.toLowerCase() === lower,
  )
}

export function ensureLabel(st: GwsState, name: string): GmailLabel {
  const existing = labelByName(st, name)
  if (existing !== undefined) return existing
  const label: GmailLabel = { id: st.nextId('label'), name, type: 'user' }
  st.labels.set(label.id, label)
  return label
}

export function insertGmailMessage(
  st: GwsState,
  raw: Buffer,
  labelIds: string[],
  threadId: string | undefined,
  useDateHeader: boolean,
): GmailMessage {
  const parsed = parseRfc822(raw)
  const id = st.nextId('msg')
  const dateHeader = parsed.headers.find((h) => h.name === 'Date')?.value
  const headerMs = dateHeader === undefined ? NaN : Date.parse(dateHeader)
  const msg: GmailMessage = {
    id,
    threadId: threadId !== undefined && threadId !== '' ? threadId : id,
    labelIds: labelIds.map((name) => ensureLabel(st, name).id),
    internalDate: useDateHeader && !Number.isNaN(headerMs) ? headerMs : st.nowMs(),
    headers: parsed.headers,
    bodyText: parsed.bodyText,
    attachments: parsed.attachments.map((att) => ({
      attachmentId: st.nextId('att'),
      filename: att.filename,
      mimeType: att.mimeType,
      data: att.data,
    })),
  }
  st.messages.set(id, msg)
  return msg
}
