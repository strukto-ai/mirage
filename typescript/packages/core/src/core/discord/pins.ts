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

import type { DiscordAccessor } from '../../accessor/discord.ts'

const PIN_PAGE_SIZE = 50

export async function pinMessage(
  accessor: DiscordAccessor,
  channelId: string,
  messageId: string,
): Promise<void> {
  await accessor.transport.call('PUT', `/channels/${channelId}/messages/pins/${messageId}`)
}

export async function unpinMessage(
  accessor: DiscordAccessor,
  channelId: string,
  messageId: string,
): Promise<void> {
  await accessor.transport.call('DELETE', `/channels/${channelId}/messages/pins/${messageId}`)
}

/** Every pin of a channel, most recently pinned first. */
export async function listPins(
  accessor: DiscordAccessor,
  channelId: string,
): Promise<Record<string, unknown>[]> {
  const params: Record<string, string | number> = { limit: PIN_PAGE_SIZE }
  const pins: Record<string, unknown>[] = []
  for (;;) {
    const page = (await accessor.transport.call(
      'GET',
      `/channels/${channelId}/messages/pins`,
      params,
    )) as { items?: Record<string, unknown>[]; has_more?: boolean }
    const items = page.items ?? []
    pins.push(...items)
    const last = items[items.length - 1]
    if (page.has_more !== true || last === undefined) return pins
    params.before = String(last.pinned_at)
  }
}
