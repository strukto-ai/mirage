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

import { type TokenManager, gmailBase, googleGet } from '../google/client.ts'

const MAX_PAGES = 50

/** The mailbox's history id now, where a delta starts from. Mirrors Python's `current_history_id`. */
export async function currentHistoryId(tokenManager: TokenManager): Promise<string> {
  const url = `${gmailBase(tokenManager)}/users/me/profile`
  const data = (await googleGet(tokenManager, url)) as { historyId?: string | number }
  if (data.historyId === undefined) throw new Error('gmail: the profile names no historyId')
  return String(data.historyId)
}

/**
 * The mailbox's history records after `start`, and the history id they reach.
 * Gmail answers 404 for a start older than the history it keeps, which
 * rejects as any failed call does. Mirrors Python's `list_history`.
 */
export async function listHistory(
  tokenManager: TokenManager,
  start: string,
): Promise<[Record<string, unknown>[], string]> {
  const url = `${gmailBase(tokenManager)}/users/me/history`
  const records: Record<string, unknown>[] = []
  let latest = start
  let token: string | null = null
  for (let i = 0; i < MAX_PAGES; i += 1) {
    const params: Record<string, string> = { startHistoryId: start, maxResults: '500' }
    if (token !== null) params.pageToken = token
    const data = (await googleGet(tokenManager, url, params)) as {
      history?: Record<string, unknown>[]
      historyId?: string | number
      nextPageToken?: unknown
    }
    records.push(...(data.history ?? []))
    if (data.historyId !== undefined) latest = String(data.historyId)
    token =
      typeof data.nextPageToken === 'string' && data.nextPageToken !== ''
        ? data.nextPageToken
        : null
    if (token === null) return [records, latest]
  }
  throw new Error('gmail: history exceeded 50 pages')
}
