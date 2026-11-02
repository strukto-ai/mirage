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
import { ok } from '../wire/reply.ts'
import { matchGmailQuery } from './query.ts'

const DEFAULT_MAX_RESULTS = 100

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

// drafts.list: each draft with its message's ids, newest message first, and
// `q` matched against the message as messages.list matches it.
export function listGmailDrafts(st: GwsState, query: URLSearchParams): Reply {
  const q = query.get('q')
  const maxResults = parseInt(query.get('maxResults') ?? String(DEFAULT_MAX_RESULTS), 10)
  const held = new Map<string, string>()
  for (const draft of st.drafts.values()) held.set(draft.messageId, draft.id)
  let items = [...held.keys()].flatMap((id) => {
    const msg = st.messages.get(id)
    return msg === undefined ? [] : [msg]
  })
  if (q !== null && q.trim() !== '') {
    items = items.filter((msg) => matchGmailQuery(st, msg, q))
  }
  items = items.sort(newestFirst).slice(0, maxResults)
  const out: JsonObj = { resultSizeEstimate: items.length }
  if (items.length > 0) {
    out.drafts = items.map((msg): JsonValue => ({
      id: held.get(msg.id) ?? '',
      message: { id: msg.id, threadId: msg.threadId },
    }))
  }
  return ok(out)
}
