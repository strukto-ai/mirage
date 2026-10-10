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

import type { GwsState } from '../store/state.ts'
import type { GmailMessage } from '../store/types.ts'
import { gmailHeader, labelByName } from './message.ts'

// A written date is midnight UTC here, where Gmail reads it as midnight PST;
// the epoch-second form the API documents for naming an instant is exact, and
// is the form mirage emits, so both are accepted.
export function gmailDateMs(token: string): number {
  const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(token)
  if (m !== null) {
    return Date.UTC(
      parseInt(m[1] as string, 10),
      parseInt(m[2] as string, 10) - 1,
      parseInt(m[3] as string, 10),
    )
  }
  if (/^\d+$/.test(token)) return parseInt(token, 10) * 1000
  return NaN
}

// AND-only Gmail query subset: label:, from:, to:, subject:, filename:,
// is:unread, is:read, after:<date|epoch>, before:<date|epoch>, and bare terms
// matching the From, To, Cc and Subject headers or the body as
// case-insensitive substrings, as Gmail searches every one of them.
export function matchGmailQuery(st: GwsState, msg: GmailMessage, q: string): boolean {
  for (const token of q.split(/\s+/)) {
    if (token === '') continue
    const lower = token.toLowerCase()
    if (lower.startsWith('label:')) {
      const label = labelByName(st, token.slice(6))
      if (label === undefined || !msg.labelIds.includes(label.id)) return false
    } else if (lower.startsWith('from:')) {
      if (!gmailHeader(msg, 'From').toLowerCase().includes(lower.slice(5))) return false
    } else if (lower.startsWith('to:')) {
      if (!gmailHeader(msg, 'To').toLowerCase().includes(lower.slice(3))) return false
    } else if (lower.startsWith('subject:')) {
      if (!gmailHeader(msg, 'Subject').toLowerCase().includes(lower.slice(8))) return false
    } else if (lower.startsWith('filename:')) {
      const name = lower.slice(9)
      if (!msg.attachments.some((a) => a.filename.toLowerCase().includes(name))) return false
    } else if (lower === 'is:unread') {
      if (!msg.labelIds.includes('UNREAD')) return false
    } else if (lower === 'is:read') {
      if (msg.labelIds.includes('UNREAD')) return false
    } else if (lower.startsWith('after:')) {
      const ms = gmailDateMs(token.slice(6))
      if (Number.isNaN(ms) || msg.internalDate < ms) return false
    } else if (lower.startsWith('before:')) {
      const ms = gmailDateMs(token.slice(7))
      if (Number.isNaN(ms) || msg.internalDate >= ms) return false
    } else {
      const headers = ['From', 'To', 'Cc', 'Subject'].map((name) => gmailHeader(msg, name))
      const haystack = [...headers, msg.bodyText].join('\n').toLowerCase()
      if (!haystack.includes(lower)) return false
    }
  }
  return true
}
