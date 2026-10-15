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

import { ContentType, FileStat, FileType } from '../../types.ts'
import { epochToIso } from '../../utils/dates.ts'
import { makeIdName } from '../../utils/naming.ts'
import { compactJsonBytes } from '../render/json.ts'
import type { DiscordChannel } from './channels.ts'
import type { DiscordGuild } from './guilds.ts'
import { DISCORD_EPOCH } from './history.ts'
import type { DiscordMember } from './members.ts'

export function guildDirname(g: { id: string; name?: string }): string {
  return makeIdName(g.name ?? '', g.id, true)
}

export function channelDirname(c: { id: string; name?: string }): string {
  return makeIdName(c.name ?? '', c.id, true)
}

export function memberFilename(m: { id: string; name?: string }): string {
  return makeIdName(m.name ?? '', m.id, true, '.json')
}

export function snowflakeToDate(snowflake: string): string {
  if (snowflake === '') return ''
  const ms = (BigInt(snowflake) >> 22n) + DISCORD_EPOCH
  const d = new Date(Number(ms))
  const yyyy = d.getUTCFullYear().toString().padStart(4, '0')
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, '0')
  const dd = d.getUTCDate().toString().padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

export function snowflakeToIso(snowflake: string): string | null {
  if (snowflake === '') return null
  let ms: bigint
  try {
    ms = (BigInt(snowflake) >> 22n) + DISCORD_EPOCH
  } catch {
    return null
  }
  return epochToIso(Number(ms / 1000n))
}

export function guildEntry(g: DiscordGuild): FileStat {
  return new FileStat({
    name: guildDirname(g),
    type: FileType.DIRECTORY,
    extra: { guild_id: g.id },
  })
}

export function channelEntry(c: DiscordChannel): FileStat {
  const last = typeof c.last_message_id === 'string' ? c.last_message_id : ''
  return new FileStat({
    name: channelDirname(c),
    type: FileType.DIRECTORY,
    modified: snowflakeToIso(last),
    extra: { channel_id: c.id, last_message_id: last },
  })
}

export function memberEntry(m: DiscordMember): FileStat {
  const id = m.user?.id ?? ''
  return new FileStat({
    name: memberFilename({ id, name: m.user?.username ?? '' }),
    type: FileType.FILE,
    content: ContentType.JSON,
    size: compactJsonBytes(m).byteLength,
    extra: { user_id: id },
  })
}

// channel_id rides extra so the day and files listers can query the history
// API without re-resolving the channel through its parent.
export function historyEntry(channelId: string, date: string): FileStat {
  return new FileStat({ name: date, type: FileType.DIRECTORY, extra: { channel_id: channelId } })
}
