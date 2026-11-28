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

import type { DiscordAccessor } from '../../../src/accessor/discord.ts'
import { MountMode } from '../../../src/types.ts'
import { DiscordVFS } from '../../../src/vfs/discord/discord.ts'
import { Workspace } from '../../../src/workspace/workspace/workspace.ts'

/** The workspace a test asks the Discord fake through, mounted at /mnt/discord. */
export function mountDiscord(accessor: DiscordAccessor): Workspace {
  return new Workspace({ '/mnt/discord/': new DiscordVFS({ accessor }) }, { mode: MountMode.WRITE })
}

/** Run `line` in a workspace with the Discord fake mounted at /mnt/discord. */
export async function runDiscord(
  accessor: DiscordAccessor,
  line: string,
): Promise<{ stdout: string; exitCode: number }> {
  const ws = mountDiscord(accessor)
  try {
    const io = await ws.shell(line)
    return { stdout: new TextDecoder().decode(io.stdout), exitCode: io.exitCode }
  } finally {
    await ws.close()
  }
}
