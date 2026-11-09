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

export async function addReaction(
  accessor: DiscordAccessor,
  channelId: string,
  messageId: string,
  emoji: string,
): Promise<void> {
  const encoded = encodeURIComponent(emoji)
  await accessor.transport.call(
    'PUT',
    `/channels/${channelId}/messages/${messageId}/reactions/${encoded}/@me`,
  )
}

/** The reactions on a message; Discord leaves the field out when none. */
export async function messageReactions(
  accessor: DiscordAccessor,
  channelId: string,
  messageId: string,
): Promise<unknown[]> {
  const message = (await accessor.transport.call(
    'GET',
    `/channels/${channelId}/messages/${messageId}`,
  )) as unknown as { reactions?: unknown[] }
  return message.reactions ?? []
}
