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

export async function createThread(
  accessor: DiscordAccessor,
  channelId: string,
  name: string,
  messageId?: string,
): Promise<unknown> {
  if (messageId !== undefined && messageId !== '') {
    return accessor.transport.call(
      'POST',
      `/channels/${channelId}/messages/${messageId}/threads`,
      undefined,
      { name },
    )
  }
  // Standalone threads must state a type: the API otherwise defaults
  // to PRIVATE_THREAD, which needs extra permissions. 11 = PUBLIC_THREAD.
  return accessor.transport.call('POST', `/channels/${channelId}/threads`, undefined, {
    name,
    type: 11,
  })
}
