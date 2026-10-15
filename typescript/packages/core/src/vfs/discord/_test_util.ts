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

import { DiscordAccessor, type DiscordResourceLike } from '../../accessor/discord.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { DiscordMethod, DiscordResponse, DiscordTransport } from '../../core/discord/client.ts'
import { FileStat, FileType, MountMode } from '../../types.ts'
import { getTestParser } from '../../workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { DiscordVFSBase } from './discord.ts'

const PARSER = await getTestParser()

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

class FakeDiscordVFS extends DiscordVFSBase implements DiscordResourceLike {
  override readonly name = 'discord'
  constructor(override readonly accessor: DiscordAccessor) {
    super()
  }
}

export function makeFakeVfs(transport: DiscordTransport): DiscordVFSBase {
  return new FakeDiscordVFS(new DiscordAccessor(transport))
}

/** The workspace a test asks the fake through, mounted at /mnt/discord. */
export function mountDiscord(transport: DiscordTransport): Workspace {
  return new Workspace(
    { '/mnt/discord/': makeFakeVfs(transport) },
    { mode: MountMode.WRITE, shellParser: PARSER },
  )
}

export async function seedChannel(
  index: IndexCacheStore,
  prefix: string,
  guildDirname: string,
  channelDirname: string,
  channelId: string,
  options: { dates?: string[] } = {},
): Promise<void> {
  const extra = { channel_id: channelId }
  const guildId = guildDirname.slice(guildDirname.lastIndexOf('__') + 2)
  await index.setDir(prefix, [
    [
      guildDirname,
      new FileStat({ name: guildDirname, type: FileType.DIRECTORY, extra: { guild_id: guildId } }),
    ],
  ])
  const channelsKey = `${prefix}/${guildDirname}/channels`
  await index.setDir(channelsKey, [
    [
      channelDirname,
      new FileStat({
        name: channelDirname,
        type: FileType.DIRECTORY,
        extra: { ...extra, last_message_id: '' },
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
    // The real day fetch seeds the files listing in the same write, so the
    // fixture does too; without it a walk would refetch the day.
    await index.setDir(`${dateKey}/files`, [])
  }
}

/**
 * Run `line` in a workspace with the fake mounted at /mnt/discord and
 * channel general__C1 of guild My Server__G1 listed with `dates`.
 */
export async function runDiscord(
  transport: DiscordTransport,
  line: string,
  dates: string[],
): Promise<{ stdout: string; exitCode: number }> {
  const ws = mountDiscord(transport)
  try {
    const index = ws.mount('/mnt/discord').index
    await seedChannel(index, '/mnt/discord', 'My Server__G1', 'general__C1', 'C1', { dates })
    const io = await ws.shell(line)
    return { stdout: new TextDecoder().decode(io.stdout), exitCode: io.exitCode }
  } finally {
    await ws.close()
  }
}
