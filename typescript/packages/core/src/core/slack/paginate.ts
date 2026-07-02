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

import type { SlackTransport } from './_client.ts'

export async function* cursorPages<T = Record<string, unknown>>(
  transport: SlackTransport,
  endpoint: string,
  baseParams: Record<string, string>,
  itemsKey: string,
): AsyncIterableIterator<T[]> {
  let cursor: string | undefined
  for (;;) {
    const params: Record<string, string> = { ...baseParams }
    if (cursor !== undefined && cursor !== '') params.cursor = cursor
    const data = await transport.call(endpoint, params)
    const items = (data[itemsKey] as T[] | undefined) ?? []
    yield items
    const meta = data.response_metadata as { next_cursor?: string } | undefined
    cursor = meta?.next_cursor
    if (cursor === undefined || cursor === '') return
  }
}
