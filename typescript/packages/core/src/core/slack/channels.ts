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

import type { SlackAccessor } from '../../accessor/slack.ts'
import { cursorPages } from './paginate.ts'

export interface SlackChannel {
  id: string
  name?: string
  user?: string
  is_archived?: boolean
  created?: number
  [key: string]: unknown
}

export interface ListChannelsOptions {
  types?: string
  limit?: number
}

function channelBaseParams(types: string, limit: number): Record<string, string> {
  return { types, limit: String(limit), exclude_archived: 'true' }
}

export function listChannelsStream(
  accessor: SlackAccessor,
  options: ListChannelsOptions = {},
): AsyncIterableIterator<SlackChannel[]> {
  const types = options.types ?? 'public_channel,private_channel'
  const limit = options.limit ?? 200
  return cursorPages<SlackChannel>(
    accessor.transport,
    'conversations.list',
    channelBaseParams(types, limit),
    'channels',
  )
}

export async function listChannels(
  accessor: SlackAccessor,
  options: ListChannelsOptions = {},
): Promise<SlackChannel[]> {
  const out: SlackChannel[] = []
  for await (const page of listChannelsStream(accessor, options)) {
    out.push(...page)
  }
  return out
}

export function listDmsStream(
  accessor: SlackAccessor,
  options: { limit?: number } = {},
): AsyncIterableIterator<SlackChannel[]> {
  return listChannelsStream(accessor, { types: 'im,mpim', limit: options.limit ?? 200 })
}

export function listDms(
  accessor: SlackAccessor,
  options: { limit?: number } = {},
): Promise<SlackChannel[]> {
  return listChannels(accessor, { types: 'im,mpim', limit: options.limit ?? 200 })
}
