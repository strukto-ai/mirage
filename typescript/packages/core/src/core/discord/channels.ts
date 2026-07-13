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

export interface DiscordChannel {
  id: string
  name?: string
  type?: number
  last_message_id?: string
  [key: string]: unknown
}

const TEXT_CHANNEL_TYPES: ReadonlySet<number> = new Set([0, 5, 15])

async function* listChannelsStream(
  accessor: DiscordAccessor,
  guildId: string,
): AsyncIterableIterator<DiscordChannel[]> {
  const raw = await accessor.transport.call('GET', `/guilds/${guildId}/channels`)
  if (!Array.isArray(raw)) return
  const filtered = (raw as DiscordChannel[]).filter(
    (c) => c.type !== undefined && TEXT_CHANNEL_TYPES.has(c.type),
  )
  yield filtered
}

export async function listChannels(
  accessor: DiscordAccessor,
  guildId: string,
): Promise<DiscordChannel[]> {
  const out: DiscordChannel[] = []
  for await (const page of listChannelsStream(accessor, guildId)) {
    out.push(...page)
  }
  return out
}
