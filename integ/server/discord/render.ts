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

import type {
  DiscordChannel,
  DiscordGuild,
  DiscordMember,
  DiscordMessage,
} from '../../generated/discord/index.js'
import type { JsonValue } from '../kit/typescript/types.ts'

// Key order is the wire contract here: a caller diffing this fake against the
// python one it replaces reads the serialized bytes, so every object below is
// written in the order the python dict literal was.

export function renderGuild(row: DiscordGuild): JsonValue {
  return { id: row.id, name: row.name, owner: false, permissions: '0', features: [] }
}

export function renderChannel(row: DiscordChannel): JsonValue {
  return {
    id: row.id,
    type: row.type,
    guild_id: row.guildId,
    name: row.name,
    position: row.position,
    topic: row.topic,
    parent_id: null,
    last_message_id: row.lastMessageId,
  }
}

// A member is handed back exactly as the fixture wrote it, nick and roles and
// joined_at included, so it is stored whole rather than rebuilt from columns.
export function renderMember(row: DiscordMember): JsonValue {
  return JSON.parse(row.payloadJson) as JsonValue
}

export function renderMessage(row: DiscordMessage): JsonValue {
  const out: { [key: string]: JsonValue } = {
    id: row.id,
    channel_id: row.channelId,
    author: JSON.parse(row.authorJson) as JsonValue,
    content: row.content,
    timestamp: row.timestamp,
    edited_timestamp: row.editedTimestamp,
    tts: false,
    pinned: row.pinnedAt !== null,
    mention_everyone: false,
    mentions: [],
    mention_roles: [],
    attachments: JSON.parse(row.attachmentsJson) as JsonValue,
    embeds: [],
    type: 0,
  }
  // The created message carries the poll object after `type`, because that is
  // where python's assignment put it in the dict.
  if (row.pollJson !== null) out.poll = JSON.parse(row.pollJson) as JsonValue
  return out
}

export function renderThread(
  id: string,
  guildId: string,
  channelId: string,
  ownerId: string,
  name: string,
  messageId: string | undefined,
): JsonValue {
  const out: { [key: string]: JsonValue } = {
    id,
    type: 11,
    guild_id: guildId,
    parent_id: channelId,
    owner_id: ownerId,
    name,
    message_count: 0,
    member_count: 1,
  }
  if (messageId !== undefined) out.last_message_id = messageId
  return out
}
