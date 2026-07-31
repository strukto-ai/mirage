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

import { IndexEntry } from '../../cache/index/config.ts'
import { makeIdName } from '../../utils/naming.ts'

export const DiscordResourceType = Object.freeze({
  GUILD: 'discord/guild',
  CHANNEL: 'discord/channel',
  MEMBER: 'discord/member',
  HISTORY: 'discord/history',
  DATE_DIR: 'discord/date_dir',
  CHAT_JSONL: 'discord/chat_jsonl',
  FILES_DIR: 'discord/files_dir',
  FILE: 'discord/file',
} as const)

export type DiscordResourceType = (typeof DiscordResourceType)[keyof typeof DiscordResourceType]

export function guildDirname(g: { id: string; name?: string }): string {
  return makeIdName(g.name ?? '', g.id, true)
}

export function channelDirname(c: { id: string; name?: string }): string {
  return makeIdName(c.name ?? '', c.id, true)
}

export function memberFilename(m: { id: string; name?: string }): string {
  return `${makeIdName(m.name ?? '', m.id, true)}.json`
}

export const DiscordIndexEntry = {
  guild(g: { id: string; name?: string }): IndexEntry {
    return new IndexEntry({
      id: g.id,
      name: g.name ?? '',
      resourceType: DiscordResourceType.GUILD,
      vfsName: guildDirname(g),
    })
  },
  channel(c: { id: string; name?: string }): IndexEntry {
    return new IndexEntry({
      id: c.id,
      name: c.name ?? '',
      resourceType: DiscordResourceType.CHANNEL,
      vfsName: channelDirname(c),
    })
  },
  member(m: { id: string; name?: string }, size?: number): IndexEntry {
    return new IndexEntry({
      id: m.id,
      name: m.name ?? '',
      resourceType: DiscordResourceType.MEMBER,
      vfsName: memberFilename(m),
      ...(size !== undefined ? { size } : {}),
    })
  },
  history(channelId: string, date: string): IndexEntry {
    return new IndexEntry({
      id: `${channelId}:${date}`,
      name: date,
      resourceType: DiscordResourceType.HISTORY,
      vfsName: `${date}.jsonl`,
    })
  },
}
