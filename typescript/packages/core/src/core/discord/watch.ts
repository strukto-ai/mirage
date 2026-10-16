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
import { FileChangeKind, type FileEvent, type JsonValue, type PathSpec } from '../../types.ts'
import { eventAt, field, textField } from '../../watch/events.ts'
import { TEXT_CHANNEL_TYPES, type DiscordChannel } from './channels.ts'
import {
  CHANNEL_EVENTS,
  CHAT_FILE,
  FILES_DIR,
  GUILD_EVENTS,
  MEMBER_EVENTS,
  MESSAGE_EVENTS,
  REACTION_EVENTS,
  THREAD_TYPES,
} from './constants.ts'
import { channelDirname, guildDirname, snowflakeToDate } from './entry.ts'
import { fileBlobName, isListed } from './files.ts'

/**
 * The UTC day a message id was minted on, or null.
 *
 * Mirrors Python `_day_of` (`core/discord/watch.py`).
 */
function dayOf(messageId: string): string | null {
  if (!/^\d+$/.test(messageId)) return null
  return snowflakeToDate(messageId)
}

/**
 * Map one Discord gateway dispatch onto mount paths.
 *
 * The consumer holds the gateway connection, and passes each dispatch's `t`
 * with its `d`. Nothing here runs a loop.
 *
 * A message is a row of `chat.jsonl` in the day its id was minted on, in UTC
 * as `readdir` buckets it, so an edit, a delete or a reaction refreshes the day
 * the message was posted, never today. Every directory carries a name, and a
 * dispatch names a guild and a channel by id only, so each id is resolved once
 * through `/guilds/<id>` or `/channels/<id>` and remembered; a channel or guild
 * dispatch forgets what it renamed.
 *
 * A thread is not listed, and its messages are in no day file. What changes is
 * the thread's starter message in its parent channel, which carries the
 * thread's counts and has the thread's id, so a message in a thread refreshes
 * the parent's day of the thread id.
 *
 * A new message's attachments are created at the names `readdir` gives them.
 * An edit or a delete does not say which attachments went with it, so that
 * day's `files` directory is UNKNOWN. A channel, member or guild dispatch
 * changes a listing's names, so it is UNKNOWN on the listing: `channels`,
 * `members`, or the whole mount for a guild, which also fires for every guild
 * when the gateway reconnects and so re-inventories what the gap missed. A
 * direct message belongs to no guild and maps to nothing.
 *
 * Mirrors Python `DiscordEventHook` (`core/discord/watch.py`).
 */
export class DiscordEventHook {
  private readonly accessor: DiscordAccessor
  private readonly guilds = new Map<string, string>()
  private readonly channels = new Map<string, DiscordChannel>()

  constructor(accessor: DiscordAccessor) {
    this.accessor = accessor
  }

  private async get(endpoint: string): Promise<Record<string, unknown>> {
    const data = await this.accessor.transport.call('GET', endpoint)
    return data !== null && typeof data === 'object' && !Array.isArray(data)
      ? { ...(data as Record<string, unknown>) }
      : {}
  }

  private async guildDir(guildId: string): Promise<string> {
    let cached = this.guilds.get(guildId)
    if (cached === undefined) {
      const guild = await this.get(`/guilds/${guildId}`)
      cached = guildDirname({ ...guild, id: typeof guild.id === 'string' ? guild.id : guildId })
      this.guilds.set(guildId, cached)
    }
    return cached
  }

  private async channel(channelId: string): Promise<DiscordChannel> {
    let cached = this.channels.get(channelId)
    if (cached === undefined) {
      const channel = await this.get(`/channels/${channelId}`)
      cached = { ...channel, id: typeof channel.id === 'string' ? channel.id : channelId }
      this.channels.set(channelId, cached)
    }
    return cached
  }

  private async dayDir(
    channelId: string | undefined,
    messageId: string | undefined,
  ): Promise<[string, boolean] | null> {
    if (channelId === undefined || messageId === undefined) return null
    let channel = await this.channel(channelId)
    let id = messageId
    const thread = channel.type !== undefined && THREAD_TYPES.has(channel.type)
    if (thread) {
      const parentId = channel.parent_id
      if (typeof parentId !== 'string') return null
      id = channelId
      channel = await this.channel(parentId)
    }
    const guildId = channel.guild_id
    if (
      channel.type === undefined ||
      !TEXT_CHANNEL_TYPES.has(channel.type) ||
      typeof guildId !== 'string'
    ) {
      return null
    }
    const day = dayOf(id)
    if (day === null) return null
    const guild = await this.guildDir(guildId)
    return [`${guild}/channels/${channelDirname(channel)}/${day}`, thread]
  }

  private async messages(
    root: PathSpec,
    eventType: string,
    payload: JsonValue,
    messageIds: readonly string[],
  ): Promise<readonly FileEvent[]> {
    const changes = new Map<string, FileChangeKind>()
    for (const messageId of messageIds) {
      const place = await this.dayDir(textField(payload, 'channel_id'), messageId)
      if (place === null) continue
      const [dayDir, thread] = place
      changes.set(`${dayDir}/${CHAT_FILE}`, FileChangeKind.UPDATE)
      if (thread || REACTION_EVENTS.has(eventType)) continue
      if (eventType !== 'MESSAGE_CREATE') {
        changes.set(`${dayDir}/${FILES_DIR}`, FileChangeKind.UNKNOWN)
        continue
      }
      const attachments = field(payload, 'attachments')
      for (const att of Array.isArray(attachments) ? attachments : []) {
        if (att === null || typeof att !== 'object' || Array.isArray(att) || !isListed(att)) {
          continue
        }
        const name = fileBlobName({
          id: att.id,
          ...(typeof att.filename === 'string' ? { filename: att.filename } : {}),
          ...(typeof att.title === 'string' ? { title: att.title } : {}),
        })
        changes.set(`${dayDir}/${FILES_DIR}/${name}`, FileChangeKind.CREATE)
      }
    }
    return [...changes].map(([path, kind]) => eventAt(root, path, kind))
  }

  private async listing(
    root: PathSpec,
    payload: JsonValue,
    name: string,
  ): Promise<readonly FileEvent[]> {
    const guildId = textField(payload, 'guild_id')
    if (guildId === undefined) return []
    const guild = await this.guildDir(guildId)
    return [eventAt(root, `${guild}/${name}`, FileChangeKind.UNKNOWN)]
  }

  async toEvents(
    root: PathSpec,
    eventType: string,
    payload: JsonValue,
  ): Promise<readonly FileEvent[]> {
    if (MESSAGE_EVENTS.has(eventType) || REACTION_EVENTS.has(eventType)) {
      const own = textField(payload, MESSAGE_EVENTS.has(eventType) ? 'id' : 'message_id')
      return this.messages(root, eventType, payload, own !== undefined ? [own] : [])
    }
    if (eventType === 'MESSAGE_DELETE_BULK') {
      const listed = field(payload, 'ids')
      const ids = (Array.isArray(listed) ? listed : []).filter(
        (i): i is string => typeof i === 'string',
      )
      return this.messages(root, eventType, payload, ids)
    }
    const own = textField(payload, 'id')
    if (CHANNEL_EVENTS.has(eventType)) {
      if (own !== undefined && payload !== null && typeof payload === 'object') {
        this.channels.delete(own)
        if (eventType !== 'CHANNEL_DELETE') {
          this.channels.set(own, { ...(payload as Record<string, unknown>), id: own })
        }
      }
      return this.listing(root, payload, 'channels')
    }
    if (MEMBER_EVENTS.has(eventType)) return this.listing(root, payload, 'members')
    if (GUILD_EVENTS.has(eventType)) {
      if (own !== undefined) {
        this.guilds.delete(own)
        const name = textField(payload, 'name')
        if (name !== undefined) this.guilds.set(own, guildDirname({ id: own, name }))
      }
      return [eventAt(root, '', FileChangeKind.UNKNOWN)]
    }
    return []
  }
}
