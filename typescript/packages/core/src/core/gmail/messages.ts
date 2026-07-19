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

import { type TokenManager, gmailBase, googleGet } from '../google/_client.ts'

export interface GmailHeader {
  name?: string
  value?: string
}

interface GmailBody {
  data?: string
  size?: number
  attachmentId?: string
}

export interface GmailPayload {
  mimeType?: string
  body?: GmailBody
  headers?: GmailHeader[]
  filename?: string
  parts?: GmailPayload[]
}

export interface GmailMessageRaw {
  id?: string
  threadId?: string
  internalDate?: string
  labelIds?: string[]
  snippet?: string
  sizeEstimate?: number
  payload?: GmailPayload
}

export interface GmailMessageStub {
  id: string
  threadId?: string
}

interface ListMessagesResponse {
  messages?: GmailMessageStub[]
}

export interface GmailAttachmentInfo {
  filename: string
  attachmentId: string
  size: number
}

export interface GmailAddress {
  name: string
  email: string
}

interface GmailProcessedAttachment {
  id: string
  filename: string
  path: string
  mime_type: string
  size: number
}

export interface GmailMessageProcessed {
  id: string
  thread_id: string
  from: GmailAddress
  to: GmailAddress[]
  cc: GmailAddress[]
  subject: string
  date: string
  body_text: string
  snippet: string
  labels: string[]
  attachments: GmailProcessedAttachment[]
}

export interface ListMessagesOptions {
  labelId?: string | null
  query?: string | null
  maxResults?: number
}

export async function listMessages(
  tokenManager: TokenManager,
  opts: ListMessagesOptions = {},
): Promise<GmailMessageStub[]> {
  const params: Record<string, string | number> = { maxResults: opts.maxResults ?? 50 }
  if (opts.labelId !== undefined && opts.labelId !== null && opts.labelId !== '') {
    params.labelIds = opts.labelId
  }
  if (opts.query !== undefined && opts.query !== null && opts.query !== '') {
    params.q = opts.query
  }
  const url = `${gmailBase(tokenManager)}/users/me/messages`
  const data = (await googleGet(tokenManager, url, params)) as ListMessagesResponse
  return data.messages ?? []
}

export async function getMessageRaw(
  tokenManager: TokenManager,
  messageId: string,
): Promise<GmailMessageRaw> {
  const url = `${gmailBase(tokenManager)}/users/me/messages/${messageId}?format=full`
  return (await googleGet(tokenManager, url)) as GmailMessageRaw
}

function base64UrlDecodeToBytes(input: string): Uint8Array {
  const padded = input + '=='.slice((input.length + 2) % 4)
  const standard = padded.replace(/-/g, '+').replace(/_/g, '/')
  const binary =
    typeof atob === 'function' ? atob(standard) : Buffer.from(standard, 'base64').toString('binary')
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

const TEXT_DECODER = new TextDecoder('utf-8', { fatal: false })

export function decodeBody(payload: GmailPayload | undefined): string {
  if (payload === undefined) return ''
  if (payload.mimeType === 'text/plain') {
    const data = payload.body?.data ?? ''
    if (data !== '') {
      return TEXT_DECODER.decode(base64UrlDecodeToBytes(data))
    }
  }
  for (const part of payload.parts ?? []) {
    const text = decodeBody(part)
    if (text !== '') return text
  }
  return ''
}

export function extractHeader(headers: GmailHeader[] | undefined, name: string): string {
  if (headers === undefined) return ''
  const lower = name.toLowerCase()
  for (const h of headers) {
    if ((h.name ?? '').toLowerCase() === lower) return h.value ?? ''
  }
  return ''
}

export function parseAddress(raw: string): GmailAddress {
  if (raw.includes('<') && raw.includes('>')) {
    const lt = raw.indexOf('<')
    const gt = raw.indexOf('>')
    const name = raw.slice(0, lt).trim().replace(/^"|"$/g, '')
    const email = raw.slice(lt + 1, gt).trim()
    return { name, email }
  }
  return { name: '', email: raw.trim() }
}

export function parseAddressList(raw: string): GmailAddress[] {
  if (raw === '') return []
  return raw.split(',').map((a) => parseAddress(a.trim()))
}

export async function getAttachment(
  tokenManager: TokenManager,
  messageId: string,
  attachmentId: string,
): Promise<Uint8Array> {
  const url = `${gmailBase(tokenManager)}/users/me/messages/${messageId}/attachments/${attachmentId}`
  const data = (await googleGet(tokenManager, url)) as { data?: string }
  const raw = data.data ?? ''
  return base64UrlDecodeToBytes(raw)
}

export function extractAttachments(payload: GmailPayload | undefined): GmailAttachmentInfo[] {
  if (payload === undefined) return []
  const attachments: GmailAttachmentInfo[] = []
  const parts = payload.parts ?? []
  for (const part of parts) {
    const filename = part.filename ?? ''
    const body = part.body ?? {}
    const attachmentId = body.attachmentId ?? ''
    if (filename !== '' && attachmentId !== '') {
      attachments.push({ filename, attachmentId, size: body.size ?? 0 })
    }
    for (const sub of part.parts ?? []) {
      const fn = sub.filename ?? ''
      const bd = sub.body ?? {}
      const aid = bd.attachmentId ?? ''
      if (fn !== '' && aid !== '') {
        attachments.push({ filename: fn, attachmentId: aid, size: bd.size ?? 0 })
      }
    }
  }
  return attachments
}

function extractProcessedAttachments(
  payload: GmailPayload | undefined,
): GmailProcessedAttachment[] {
  if (payload === undefined) return []
  const result: GmailProcessedAttachment[] = []
  for (const part of payload.parts ?? []) {
    const filename = part.filename ?? ''
    const body = part.body ?? {}
    const attachmentId = body.attachmentId ?? ''
    if (filename !== '' && attachmentId !== '') {
      result.push({
        id: attachmentId,
        filename,
        path: `attachments/${attachmentId}_${filename}`,
        mime_type: part.mimeType ?? '',
        size: body.size ?? 0,
      })
    }
    for (const sub of part.parts ?? []) {
      const fn = sub.filename ?? ''
      const bd = sub.body ?? {}
      const aid = bd.attachmentId ?? ''
      if (fn !== '' && aid !== '') {
        result.push({
          id: aid,
          filename: fn,
          path: `attachments/${aid}_${fn}`,
          mime_type: sub.mimeType ?? '',
          size: bd.size ?? 0,
        })
      }
    }
  }
  return result
}

export async function getMessageProcessed(
  tokenManager: TokenManager,
  messageId: string,
): Promise<GmailMessageProcessed> {
  const raw = await getMessageRaw(tokenManager, messageId)
  const headers = raw.payload?.headers ?? []
  const bodyText = decodeBody(raw.payload)
  return {
    id: raw.id ?? '',
    thread_id: raw.threadId ?? '',
    from: parseAddress(extractHeader(headers, 'From')),
    to: parseAddressList(extractHeader(headers, 'To')),
    cc: parseAddressList(extractHeader(headers, 'Cc')),
    subject: extractHeader(headers, 'Subject'),
    date: extractHeader(headers, 'Date'),
    body_text: bodyText,
    snippet: raw.snippet ?? '',
    labels: raw.labelIds ?? [],
    attachments: extractProcessedAttachments(raw.payload),
  }
}
