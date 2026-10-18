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

import { SlackAccessor, type SlackResourceLike } from '../../../src/accessor/slack.ts'
import type { IndexCacheStore } from '../../../src/cache/index/store.ts'
import type { SlackResponse, SlackTransport } from '../../../src/core/slack/client.ts'
import { FileStat, FileType } from '../../../src/types.ts'
import { SlackVFSBase } from '../../../src/vfs/slack/slack.ts'

export interface FakeCall {
  endpoint: string
  params?: Record<string, string>
  body?: unknown
}

export type Responder = (endpoint: string, params?: Record<string, string>) => SlackResponse

export class FakeSlackTransport implements SlackTransport {
  public readonly calls: FakeCall[] = []
  constructor(private readonly responder: Responder = () => ({ ok: true })) {}
  call(endpoint: string, params?: Record<string, string>, body?: unknown): Promise<SlackResponse> {
    this.calls.push({
      endpoint,
      ...(params !== undefined ? { params } : {}),
      ...(body !== undefined ? { body } : {}),
    })
    return Promise.resolve(this.responder(endpoint, params))
  }
}

class FakeSlackVFS extends SlackVFSBase implements SlackResourceLike {
  override readonly name = 'slack'
  constructor(override readonly accessor: SlackAccessor) {
    super()
  }
}

export function makeFakeVfs(transport: SlackTransport): SlackVFSBase {
  return new FakeSlackVFS(new SlackAccessor(transport))
}

export async function seedChannel(
  index: IndexCacheStore,
  prefix: string,
  channelDirname: string,
  channelId: string,
  options: { dates?: string[] } = {},
): Promise<void> {
  const extra = { channel_id: channelId }
  const channelsKey = `${prefix}/channels`
  await index.setDir(channelsKey, [
    [
      channelDirname,
      new FileStat({
        name: channelDirname,
        type: FileType.DIRECTORY,
        extra: { ...extra, name: channelDirname.split('__')[0] ?? channelDirname, created: 0 },
      }),
    ],
  ])
  const dates = options.dates ?? []
  const childKey = `${channelsKey}/${channelDirname}`
  await index.setDir(
    childKey,
    dates.map((d) => [d, new FileStat({ name: d, type: FileType.DIRECTORY, extra })]),
  )
  for (const d of dates) {
    const dateKey = `${childKey}/${d}`
    await index.setDir(dateKey, [
      ['chat.jsonl', new FileStat({ name: 'chat.jsonl', type: FileType.FILE, extra })],
      [
        'files',
        new FileStat({ name: 'files', type: FileType.DIRECTORY, extra: { ...extra, date: d } }),
      ],
    ])
    await index.setDir(`${dateKey}/files`, [])
  }
}
