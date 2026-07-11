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
import { afterIdPages } from './paginate.ts'

export interface DiscordGuild {
  id: string
  name?: string
  [key: string]: unknown
}

function listGuildsStream(
  accessor: DiscordAccessor,
  pageSize = 200,
): AsyncIterableIterator<DiscordGuild[]> {
  return afterIdPages<DiscordGuild & Record<string, unknown>>(accessor, {
    endpoint: '/users/@me/guilds',
    lastIdFn: (g) => (g as DiscordGuild).id,
    pageSize,
  })
}

export async function listGuilds(
  accessor: DiscordAccessor,
  pageSize = 200,
): Promise<DiscordGuild[]> {
  const out: DiscordGuild[] = []
  for await (const page of listGuildsStream(accessor, pageSize)) {
    out.push(...page)
  }
  return out
}
