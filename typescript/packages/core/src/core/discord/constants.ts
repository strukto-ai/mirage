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

export const DISCORD_API = 'https://discord.com/api/v10'
export const MAX_RETRIES = 3

export const CHAT_FILE = 'chat.jsonl'
export const FILES_DIR = 'files'
export const THREAD_TYPES: ReadonlySet<number> = new Set([10, 11, 12])

export const MESSAGE_EVENTS: ReadonlySet<string> = new Set([
  'MESSAGE_CREATE',
  'MESSAGE_UPDATE',
  'MESSAGE_DELETE',
])
export const REACTION_EVENTS: ReadonlySet<string> = new Set([
  'MESSAGE_REACTION_ADD',
  'MESSAGE_REACTION_REMOVE',
  'MESSAGE_REACTION_REMOVE_ALL',
  'MESSAGE_REACTION_REMOVE_EMOJI',
])
export const CHANNEL_EVENTS: ReadonlySet<string> = new Set([
  'CHANNEL_CREATE',
  'CHANNEL_UPDATE',
  'CHANNEL_DELETE',
])
export const MEMBER_EVENTS: ReadonlySet<string> = new Set([
  'GUILD_MEMBER_ADD',
  'GUILD_MEMBER_UPDATE',
  'GUILD_MEMBER_REMOVE',
])
export const GUILD_EVENTS: ReadonlySet<string> = new Set([
  'GUILD_CREATE',
  'GUILD_UPDATE',
  'GUILD_DELETE',
])
