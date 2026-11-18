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

import { cursorPages as apiPages } from '../api/paginate.ts'
import type { SlackTransport } from './client.ts'

export async function* cursorPages<T = Record<string, unknown>>(
  transport: SlackTransport,
  endpoint: string,
  baseParams: Record<string, string>,
  itemsKey: string,
): AsyncIterableIterator<T[]> {
  const fetchPage = (cursor: string | null) =>
    transport.call(endpoint, cursor === null ? baseParams : { ...baseParams, cursor })
  for await (const page of apiPages(fetchPage, { itemsKey, nextCursor })) yield page as T[]
}

function nextCursor(data: Record<string, unknown>): string | null {
  const meta = data.response_metadata as { next_cursor?: unknown } | null | undefined
  const cursor = meta?.next_cursor
  return typeof cursor === 'string' && cursor !== '' ? cursor : null
}
