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

import { DATE, JSON_NAME } from '../hierarchy/codec.ts'
import { makeDetectScope, Scope, Slot } from '../hierarchy/scope.ts'
import { ContentType } from '../../types.ts'

const GUILD = [new Slot('guild', undefined, 'guild_id')] as const
const CHANNEL = [...GUILD, 'channels', new Slot('channel', undefined, 'channel_id')] as const
const DAY = [...CHANNEL, new Slot('day', DATE)] as const

// One description of the tree: readdir, stat, read and the search push-down
// all classify through it, so the file surface and the command surface cannot
// disagree about what a path means. Every dynamic level is a `name__id`
// dirname the tree itself mints, so the ids decode from the path and
// detection needs no index or network round-trip.
export const SCOPES: readonly Scope[] = [
  new Scope({ kind: 'guild', segments: GUILD }),
  new Scope({ kind: 'channels_dir', segments: [...GUILD, 'channels'] }),
  new Scope({ kind: 'members_dir', segments: [...GUILD, 'members'] }),
  new Scope({ kind: 'channel', segments: CHANNEL }),
  new Scope({
    kind: 'member',
    segments: [...GUILD, 'members', new Slot('member', JSON_NAME, 'user_id')],
    leaf: true,
    filetype: ContentType.JSON,
  }),
  new Scope({ kind: 'day', segments: DAY }),
  new Scope({
    kind: 'messages',
    segments: [...DAY, 'chat.jsonl'],
    leaf: true,
    filetype: ContentType.TEXT,
  }),
  new Scope({ kind: 'files', segments: [...DAY, 'files'] }),
  new Scope({
    kind: 'file_blob',
    segments: [...DAY, 'files', new Slot('blob')],
    leaf: true,
  }),
]

export const detectScope = makeDetectScope(SCOPES)

// Kinds the guild search push-down may answer for. A chat.jsonl operand is
// deliberately absent: `searchGuild` takes a channel but no date, so serving
// a one-day file from a channel-wide search would report messages the line
// did not ask for. Same doctrine for `file_blob` and `member`, whose bytes
// the message search does not carry.
export const NATIVE_KINDS: ReadonlySet<string> = new Set([
  'guild',
  'channels_dir',
  'channel',
  'day',
  'files',
])
