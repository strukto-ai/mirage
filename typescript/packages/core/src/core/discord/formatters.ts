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

export interface DiscordSearchMessage {
  timestamp?: string
  channel_id?: string
  author?: { username?: string }
  content?: string
}

export function formatGrepResults(
  messages: DiscordSearchMessage[],
  opts: {
    prefix: string
    guildDirname: string
    channelNames?: Record<string, string>
  },
): string[] {
  const { prefix, guildDirname, channelNames = {} } = opts
  const out: string[] = []
  for (const msg of messages) {
    const ts = (msg.timestamp ?? '').slice(0, 10)
    const chId = msg.channel_id ?? ''
    const chName = channelNames[chId] ?? chId
    const author = msg.author?.username ?? '?'
    const content = (msg.content ?? '').replace(/\n/g, ' ')
    out.push(`${prefix}/${guildDirname}/channels/${chName}/${ts}.jsonl:[${author}] ${content}`)
  }
  return out
}
