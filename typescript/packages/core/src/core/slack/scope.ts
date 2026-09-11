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

import { Codec, DATE, JSON_NAME } from '../hierarchy/codec.ts'
import { makeDetectScope, ROOT, Scope, type ScopeMatch, Slot } from '../hierarchy/scope.ts'
import { ContentType } from '../../types.ts'

/** Whether a segment names a message container. */
export function isContainer(text: string): boolean {
  return text === 'channels' || text === 'dms'
}

// Channels and DMs share every level below the container, so the container
// is a validated slot rather than two parallel scope families; the decoded
// value rides the slots the way an id does.
const CONTAINER = new Codec({ validate: isContainer })

const CHANNEL = [
  new Slot('container', CONTAINER),
  new Slot('channel', undefined, 'channel_id'),
] as const
const DAY = [...CHANNEL, new Slot('day', DATE)] as const

// One description of the tree: readdir, stat, read and the search push-down
// all classify through it, so the file surface and the command surface
// cannot disagree about what a path means.
export const SCOPES: readonly Scope[] = [
  new Scope({ kind: 'channels_root', segments: ['channels'], probed: false }),
  new Scope({ kind: 'dms_root', segments: ['dms'], probed: false }),
  new Scope({ kind: 'users_root', segments: ['users'], probed: false }),
  new Scope({
    kind: 'user',
    segments: ['users', new Slot('user', JSON_NAME, 'user_id')],
    leaf: true,
    filetype: ContentType.JSON,
  }),
  new Scope({ kind: 'channel', segments: CHANNEL }),
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

// Kinds the workspace search push-down may answer for. Slack search is
// workspace-wide, so the root qualifies; a chat.jsonl or blob operand names
// one day's file, which a channel-wide search cannot stand in for, and the
// files directory is excluded because search.files has no per-day filter
// either.
export const NATIVE_KINDS: ReadonlySet<string> = new Set([
  ROOT,
  'channels_root',
  'dms_root',
  'channel',
  'day',
])

/** The channel coordinates a search push-down carries. */
export interface SearchTarget {
  container?: string
  channelName?: string
  channelId?: string
}

/** The coordinates a native search should scope itself to. */
export function searchTarget(match: ScopeMatch): SearchTarget {
  if (match.kind === 'channels_root') return { container: 'channels' }
  if (match.kind === 'dms_root') return { container: 'dms' }
  return {
    ...(match.slots.container !== undefined ? { container: match.slots.container } : {}),
    ...(match.slots.channel !== undefined ? { channelName: match.slots.channel } : {}),
    ...(match.slots.channel_id !== undefined ? { channelId: match.slots.channel_id } : {}),
  }
}
