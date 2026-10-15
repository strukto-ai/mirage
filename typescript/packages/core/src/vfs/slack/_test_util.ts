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

import { SlackAccessor, type SlackResourceLike } from '../../accessor/slack.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { SlackResponse, SlackTransport } from '../../core/slack/client.ts'
import { FileStat, FileType } from '../../types.ts'
import { getTestParser } from '../../workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { SlackVFSBase } from './slack.ts'

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

/**
 * Run `line` in a workspace with the fake mounted at /mnt/slack and channel
 * general__C1 listed with `dates`.
 */
export async function runSlack(
  transport: FakeSlackTransport,
  line: string,
  dates: string[],
): Promise<{ stdout: string; exitCode: number }> {
  const ws = new Workspace(
    { '/mnt/slack/': makeFakeVfs(transport) },
    { shellParser: await getTestParser() },
  )
  try {
    await seedChannel(ws.mount('/mnt/slack').index, '/mnt/slack', 'general__C1', 'C1', { dates })
    const io = await ws.shell(line)
    return { stdout: new TextDecoder().decode(io.stdout), exitCode: io.exitCode }
  } finally {
    await ws.close()
  }
}
