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
import type { GmailMessage } from '../store/types.ts'
import type { JsonObj } from '../wire/json.ts'
import { googleError, ok } from '../wire/reply.ts'
import { matchGmailQuery } from './query.ts'

const DEFAULT_MAX_RESULTS = 100
const MAX_DRAFT_RESULTS = 500

function newestFirst(a: GmailMessage, b: GmailMessage): number {
  return a.internalDate === b.internalDate
    ? b.id.localeCompare(a.id)
    : b.internalDate - a.internalDate
}

export function listGmailMessages(st: GwsState, query: URLSearchParams): Reply {
  const q = query.get('q')
  const labelParam = query.get('labelIds')
  const maxResults = parseInt(query.get('maxResults') ?? String(DEFAULT_MAX_RESULTS), 10)
  let items = [...st.messages.values()]
  if (labelParam !== null) {
    items = items.filter((msg) => msg.labelIds.includes(labelParam))
  } else if (q === null || !q.includes('label:TRASH')) {
    // Real messages.list hides TRASH unless it is asked for explicitly.
    items = items.filter((msg) => !msg.labelIds.includes('TRASH'))
  }
  if (q !== null && q.trim() !== '') {
    items = items.filter((msg) => matchGmailQuery(st, msg, q))
  }
  items.sort(newestFirst)
  items = items.slice(0, maxResults)
  const out: JsonObj = { resultSizeEstimate: items.length }
  if (items.length > 0) {
    out.messages = items.map((msg): JsonValue => ({ id: msg.id, threadId: msg.threadId }))
  }
  return ok(out)
}

// drafts.list: each draft with its message's ids, newest message first,
// `q` matched against the message as messages.list matches it, paged on an
// offset token as files.list pages: a page size below 1 is the default one.
export function listGmailDrafts(st: GwsState, query: URLSearchParams): Reply {
  const q = query.get('q')
  const parsedMax = parseInt(query.get('maxResults') ?? '', 10)
  const maxResults =
    Number.isNaN(parsedMax) || parsedMax < 1
      ? DEFAULT_MAX_RESULTS
      : Math.min(parsedMax, MAX_DRAFT_RESULTS)
  const rawToken = query.get('pageToken')
  const start = rawToken === null ? 0 : parseInt(rawToken, 10)
  if (Number.isNaN(start) || start < 0) {
    return googleError(400, `Invalid page token: ${rawToken ?? ''}`, 'INVALID_ARGUMENT')
  }
  const held = new Map<string, string>()
  for (const draft of st.drafts.values()) held.set(draft.messageId, draft.id)
  let items = [...held.keys()].flatMap((id) => {
    const msg = st.messages.get(id)
    return msg === undefined ? [] : [msg]
  })
  if (q !== null && q.trim() !== '') {
    items = items.filter((msg) => matchGmailQuery(st, msg, q))
  }
  items.sort(newestFirst)
  const page = items.slice(start, start + maxResults)
  const out: JsonObj = { resultSizeEstimate: items.length }
  if (page.length > 0) {
    out.drafts = page.map((msg): JsonValue => ({
      id: held.get(msg.id) ?? '',
      message: { id: msg.id, threadId: msg.threadId },
    }))
  }
  if (start + maxResults < items.length) out.nextPageToken = String(start + maxResults)
  return ok(out)
}
