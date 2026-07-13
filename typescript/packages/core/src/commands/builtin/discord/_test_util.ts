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

import { DiscordAccessor, type DiscordResourceLike } from '../../../accessor/discord.ts'
import { IndexEntry } from '../../../cache/index/config.ts'
import type { RAMIndexCacheStore } from '../../../cache/index/ram.ts'
import type {
  DiscordMethod,
  DiscordResponse,
  DiscordTransport,
} from '../../../core/discord/_client.ts'
import type { Resource } from '../../../resource/base.ts'

export interface FakeCall {
  method: DiscordMethod
  endpoint: string
  params?: Record<string, string | number>
  body?: Record<string, unknown>
}

export type Responder = (
  method: DiscordMethod,
  endpoint: string,
  params?: Record<string, string | number>,
) => DiscordResponse

export class FakeDiscordTransport implements DiscordTransport {
  public readonly calls: FakeCall[] = []
  constructor(private readonly responder: Responder = () => null) {}
  call(
    method: DiscordMethod,
    endpoint: string,
    params?: Record<string, string | number>,
    body?: Record<string, unknown>,
  ): Promise<DiscordResponse> {
    this.calls.push({
      method,
      endpoint,
      ...(params !== undefined ? { params } : {}),
      ...(body !== undefined ? { body } : {}),
    })
    return Promise.resolve(this.responder(method, endpoint, params))
  }
}

export function makeFakeResource(transport: DiscordTransport): DiscordResourceLike {
  const accessor = new DiscordAccessor(transport)
  const resource: Resource & { accessor: DiscordAccessor } = {
    kind: 'discord',
    accessor,
    open: () => Promise.resolve(),
    close: () => Promise.resolve(),
  }
  return resource as DiscordResourceLike
}

export async function seedGuild(
  index: RAMIndexCacheStore,
  prefix: string,
  guildDirname: string,
  guildId: string,
): Promise<void> {
  await index.setDir(prefix, [
    [
      guildDirname,
      new IndexEntry({
        id: guildId,
        name: guildDirname.split('__')[0] ?? guildDirname,
        resourceType: 'discord/guild',
        vfsName: guildDirname,
      }),
    ],
  ])
}

export async function seedChannel(
  index: RAMIndexCacheStore,
  prefix: string,
  guildDirname: string,
  channelDirname: string,
  channelId: string,
  options: { dates?: string[]; remoteTime?: string } = {},
): Promise<void> {
  const channelsKey = `${prefix}/${guildDirname}/channels`
  await index.setDir(channelsKey, [
    [
      channelDirname,
      new IndexEntry({
        id: channelId,
        name: channelDirname.split('__')[0] ?? channelDirname,
        resourceType: 'discord/channel',
        vfsName: channelDirname,
        remoteTime: options.remoteTime ?? '',
      }),
    ],
  ])
  const dates = options.dates
  if (dates !== undefined) {
    const childKey = `${prefix}/${guildDirname}/channels/${channelDirname}`
    const entries: [string, IndexEntry][] = dates.map((d) => [
      d,
      new IndexEntry({
        id: `${channelDirname}:${d}`,
        name: d,
        resourceType: 'discord/date_dir',
        vfsName: d,
      }),
    ])
    await index.setDir(childKey, entries)
    // Seed each date's chat.jsonl placeholder so reads via index work
    for (const d of dates) {
      const dateKey = `${childKey}/${d}`
      await index.setDir(dateKey, [
        [
          'chat.jsonl',
          new IndexEntry({
            id: `${channelDirname}:${d}:chat`,
            name: 'chat.jsonl',
            resourceType: 'discord/chat_jsonl',
            vfsName: 'chat.jsonl',
          }),
        ],
        [
          'files',
          new IndexEntry({
            id: `${channelDirname}:${d}:files`,
            name: 'files',
            resourceType: 'discord/files_dir',
            vfsName: 'files',
          }),
        ],
      ])
    }
  }
}
