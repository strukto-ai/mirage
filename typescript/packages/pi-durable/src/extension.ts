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

import { defineExtension, section, type Extension } from '@earendil-works/pi-durable'
import { buildSystemPrompt } from '@struktoai/mirage-core/agents/prompt'
import { MirageClient, type MirageRemote } from '@struktoai/mirage-core/remote/client'
import type { Workspace } from '@struktoai/mirage-core/workspace/workspace/workspace'

/** Options for `mirageExtension`: `sessionId`, the session whose mounts the prompt describes. */
export interface MirageExtensionOptions {
  sessionId?: string
}

/**
 * The prompt section for a server's workspace: its mounts as the server
 * describes them, each by its description, or its VFS and mode when it has none.
 */
export async function remotePrompt(remote: MirageRemote): Promise<string> {
  const mounts = await new MirageClient(remote).mounts()
  const mountInfo = Object.fromEntries(
    mounts.map((mount) => [
      mount.prefix,
      mount.description !== '' ? mount.description : `${mount.vfs} (${mount.mode})`,
    ]),
  )
  return buildSystemPrompt({ mountInfo })
}

/**
 * Returns a Pi Durable extension named `mirage` whose prompt section
 * describes the workspace's mounts, as the session sees them; for a
 * server's workspace, as the server describes them.
 */
export function mirageExtension(
  source: Workspace | MirageRemote,
  opts: MirageExtensionOptions = {},
): Extension {
  const named = source as Partial<MirageRemote>
  const prompt =
    typeof named.url === 'string' && typeof named.workspace === 'string'
      ? () => remotePrompt(source as MirageRemote)
      : () => buildSystemPrompt({ workspace: source as Workspace, sessionId: opts.sessionId })
  return defineExtension({ name: 'mirage', sections: [section('mirage', prompt)] })
}
