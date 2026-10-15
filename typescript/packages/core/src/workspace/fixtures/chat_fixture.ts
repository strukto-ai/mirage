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

import type { DiscordTransport } from '../../core/discord/client.ts'
import { MountMode } from '../../types.ts'
import {
  makeFakeVfs as makeFakeDiscord,
  seedChannel as seedDiscord,
} from '../../vfs/discord/_test_util.ts'
import {
  makeFakeVfs as makeFakeSlack,
  seedChannel as seedSlack,
} from '../../vfs/slack/_test_util.ts'
import type { FakeSlackTransport } from '../../vfs/slack/_test_util.ts'
import { Workspace } from '../workspace/workspace.ts'
import { getTestParser } from './workspace_fixture.ts'

const PARSER = await getTestParser()

/** The workspace a test asks the fake through, mounted at /mnt/discord. */
export function mountDiscord(transport: DiscordTransport): Workspace {
  return new Workspace(
    { '/mnt/discord/': makeFakeDiscord(transport) },
    { mode: MountMode.WRITE, shellParser: PARSER },
  )
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
    await seedDiscord(index, '/mnt/discord', 'My Server__G1', 'general__C1', 'C1', { dates })
    const io = await ws.shell(line)
    return { stdout: new TextDecoder().decode(io.stdout), exitCode: io.exitCode }
  } finally {
    await ws.close()
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
  const ws = new Workspace({ '/mnt/slack/': makeFakeSlack(transport) }, { shellParser: PARSER })
  try {
    await seedSlack(ws.mount('/mnt/slack').index, '/mnt/slack', 'general__C1', 'C1', { dates })
    const io = await ws.shell(line)
    return { stdout: new TextDecoder().decode(io.stdout), exitCode: io.exitCode }
  } finally {
    await ws.close()
  }
}
