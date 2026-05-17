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

const UNSAFE_CHARS = /[^\w\s\-.]/g
const MULTI_UNDERSCORE = /_+/g
const MAX_LEN = 100

export function sanitizeName(name: string): string {
  if (name.trim() === '') return 'unknown'
  let cleaned = name.replace(UNSAFE_CHARS, '_')
  cleaned = cleaned.replace(/ /g, '_')
  cleaned = cleaned.replace(MULTI_UNDERSCORE, '_')
  cleaned = cleaned.replace(/^_+|_+$/g, '')
  if (cleaned.length > MAX_LEN) cleaned = cleaned.slice(0, MAX_LEN)
  return cleaned
}

export function pathSafeName(name: string): string {
  if (name.trim() === '') return 'unknown'
  return name.replace(/\//g, '∕')
}

function makeIdName(name: string, id: string): string {
  return `${pathSafeName(name)}__${id}`
}

export function guildDirname(g: { id: string; name?: string }): string {
  return makeIdName(g.name ?? '', g.id)
}

export function channelDirname(c: { id: string; name?: string }): string {
  return makeIdName(c.name ?? '', c.id)
}

export function memberFilename(m: { id: string; name?: string }): string {
  return `${makeIdName(m.name ?? '', m.id)}.json`
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
  member(m: { id: string; name?: string }): IndexEntry {
    return new IndexEntry({
      id: m.id,
      name: m.name ?? '',
      resourceType: DiscordResourceType.MEMBER,
      vfsName: memberFilename(m),
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
