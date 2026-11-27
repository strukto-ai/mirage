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

import type { JsonValue, Reply } from '../../kit/typescript/index.ts'
import type { GwsState } from '../store/state.ts'
import type { GmailLabel, GmailMessage } from '../store/types.ts'
import type { JsonObj } from '../wire/json.ts'
import { OWNER } from '../wire/mime.ts'
import { googleError, ok } from '../wire/reply.ts'

const DEFAULT_HISTORY_RESULTS = 100
const MAX_HISTORY_RESULTS = 500

// The history id the mailbox is at: the last change recorded, which is where
// a sync starts from.
export function historyId(st: GwsState): string {
  return String(st.counters.get('history') ?? 0)
}

export function profile(st: GwsState): Reply {
  return ok({
    emailAddress: String(OWNER.emailAddress),
    messagesTotal: st.messages.size,
    threadsTotal: new Set([...st.messages.values()].map((msg) => msg.threadId)).size,
    historyId: historyId(st),
  })
}

// history.list: each change after `startHistoryId`, oldest first, a record
// per change as Gmail gives one, paged on an offset token as drafts.list
// pages. Every change is kept, so no start is too old; a test that wants
// Gmail's 404 for one arms it.
export function listHistory(st: GwsState, query: URLSearchParams): Reply {
  const raw = query.get('startHistoryId') ?? ''
  if (!/^\d+$/.test(raw)) {
    return googleError(400, 'Invalid startHistoryId', 'INVALID_ARGUMENT')
  }
  const after = Number(raw)
  const parsedMax = parseInt(query.get('maxResults') ?? '', 10)
  const maxResults =
    Number.isNaN(parsedMax) || parsedMax < 1
      ? DEFAULT_HISTORY_RESULTS
      : Math.min(parsedMax, MAX_HISTORY_RESULTS)
  const rawToken = query.get('pageToken')
  const start = rawToken === null ? 0 : parseInt(rawToken, 10)
  if (Number.isNaN(start) || start < 0) {
    return googleError(400, `Invalid page token: ${rawToken ?? ''}`, 'INVALID_ARGUMENT')
  }
  const changes = st.gmailChanges.filter((c) => c.seq > after)
  const page = changes.slice(start, start + maxResults)
  const history = page.map((c): JsonValue => {
    const message: JsonObj = { id: c.messageId, threadId: c.threadId }
    const now = st.messages.get(c.messageId)
    if (c.kind === 'messagesAdded' && now !== undefined) message.labelIds = [...now.labelIds]
    const item: JsonObj =
      c.kind === 'labelsAdded' || c.kind === 'labelsRemoved'
        ? { message, labelIds: [...c.labelIds] }
        : { message }
    return {
      id: String(c.seq),
      messages: [{ id: c.messageId, threadId: c.threadId }],
      [c.kind]: [item],
    }
  })
  const out: JsonObj = { historyId: historyId(st) }
  if (history.length > 0) out.history = history
  if (start + maxResults < changes.length) out.nextPageToken = String(start + maxResults)
  return ok(out)
}

// Set a message's labels to `next`, recording the labels it gained and the
// labels it lost, as messages.modify and messages.trash do.
export function relabel(st: GwsState, msg: GmailMessage, next: string[]): void {
  const added = next.filter((id) => !msg.labelIds.includes(id))
  const removed = msg.labelIds.filter((id) => !next.includes(id))
  msg.labelIds = next
  st.noteGmail('labelsAdded', msg, [...new Set(added)])
  st.noteGmail('labelsRemoved', msg, [...new Set(removed)])
}

export function fmtLabel(label: GmailLabel): JsonObj {
  return { id: label.id, name: label.name, type: label.type }
}
