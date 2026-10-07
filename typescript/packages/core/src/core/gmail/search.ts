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

import { PathSpec } from '../../types.ts'
import type { SearchResult } from '../../vfs/types.ts'
import type { TokenManager } from '../google/client.ts'
import { decodeBody, extractHeader, getMessageRaw, listMessages } from './messages.ts'
import { msgFilename } from './readdir.ts'

const EXCERPT_WINDOW = 120
const EXCERPT_MAX = 240

export interface GmailSearchRow {
  id: string
  subject: string
  snippet: string
  sender: string
  date: string
  label: string
  bodyText: string
}

// Every offset below is a python string index, and python counts code points
// where `String.length` and `String.indexOf` count UTF-16 units. Measuring in
// units halves the budget for astral text -- a 200-emoji body excerpts to all
// 200 in python and to 117 here -- and the cut lands inside the 118th
// surrogate pair, whose lone half encodes as U+FFFD.
function extractExcerpt(text: string, pattern: string): string {
  if (text === '' || pattern === '') return ''
  const flat = text.replace(/\s+/g, ' ').trim()
  const lower = flat.toLowerCase()
  const hit = lower.indexOf(pattern.toLowerCase())
  const points = Array.from(flat)
  if (hit < 0) return points.slice(0, EXCERPT_MAX).join('')
  const idx = Array.from(lower.slice(0, hit)).length
  const start = Math.max(0, idx - EXCERPT_WINDOW)
  const end = Math.min(points.length, idx + Array.from(pattern).length + EXCERPT_WINDOW)
  const prefix = start > 0 ? '...' : ''
  const suffix = end < points.length ? '...' : ''
  return `${prefix}${points.slice(start, end).join('')}${suffix}`
}

function buildQuery(pattern: string, labelName: string | null, dateStr: string | null): string {
  const parts: string[] = [pattern]
  if (labelName !== null && labelName !== '') parts.push(`label:${labelName}`)
  if (dateStr !== null && dateStr !== '') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr)
    if (m !== null) parts.push(`after:${m[1] ?? ''}/${m[2] ?? ''}/${m[3] ?? ''}`)
  }
  return parts.join(' ')
}

function dateFromInternal(internalDate: string | undefined): string {
  if (internalDate === undefined || internalDate === '') return ''
  const ts = Number.parseInt(internalDate, 10)
  if (!Number.isFinite(ts)) return ''
  const d = new Date(ts)
  const yyyy = d.getUTCFullYear().toString().padStart(4, '0')
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, '0')
  const dd = d.getUTCDate().toString().padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

export async function searchMessages(
  tokenManager: TokenManager,
  pattern: string,
  labelName: string | null = null,
  dateStr: string | null = null,
  maxResults = 50,
): Promise<GmailSearchRow[]> {
  const query = buildQuery(pattern, labelName, dateStr)
  const stubs = await listMessages(tokenManager, { query, maxResults })
  const rows: GmailSearchRow[] = []
  for (const stub of stubs) {
    const mid = stub.id
    if (mid === '') continue
    const raw = await getMessageRaw(tokenManager, mid)
    const headers = raw.payload?.headers ?? []
    const subject = extractHeader(headers, 'Subject') || 'No Subject'
    const sender = extractHeader(headers, 'From') || '?'
    const snippet = raw.snippet ?? ''
    const bodyText = decodeBody(raw.payload)
    const msgDate = dateFromInternal(raw.internalDate)
    rows.push({
      id: mid,
      subject,
      snippet,
      sender,
      date: msgDate,
      label: labelName ?? '',
      bodyText,
    })
  }
  return rows
}

export function formatGrepResults(
  rows: GmailSearchRow[],
  labelName: string | null,
  prefix: string,
  pattern = '',
): SearchResult[] {
  const lines: SearchResult[] = []
  for (const row of rows) {
    const label = row.label !== '' ? row.label : (labelName ?? 'INBOX')
    const date = row.date
    const mid = row.id
    // The same builder readdir names the file with, not a second spelling of
    // it: the subject's budget depends on the id and the suffix, so a hit
    // composed from a bare `sanitize` pointed at a path that does not exist
    // once a long subject was trimmed.
    const filename = msgFilename(row.subject || 'No Subject', mid)
    const sender = row.sender !== '' ? row.sender : '?'
    const haystack = `${row.subject}\n${row.bodyText}`
    let excerpt = pattern !== '' ? extractExcerpt(haystack, pattern) : ''
    if (excerpt === '') excerpt = row.snippet.replace(/\n/g, ' ')
    const path =
      date !== '' ? `${prefix}/${label}/${date}/${filename}` : `${prefix}/${label}/${filename}`
    lines.push([
      PathSpec.fromStrPath(path, path.slice(prefix.length).replace(/^\//, '')),
      `${path}:[${sender}] ${excerpt}`,
    ])
  }
  return lines
}
