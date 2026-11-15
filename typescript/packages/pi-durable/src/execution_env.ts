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

import type { MirageRemote } from '@struktoai/mirage-core/remote/client'
import type { Workspace } from '@struktoai/mirage-core/workspace/workspace/workspace'
import { WorldExecutionEnv, type MirageExecutionEnvOptions } from './env.ts'
import { localWorld } from './local.ts'
import { remoteWorld } from './remote/world.ts'

/** Whether a source names a workspace on a Mirage server rather than one in this process. */
export function isRemote(source: Workspace | MirageRemote): source is MirageRemote {
  const named = source as Partial<MirageRemote>
  return typeof named.url === 'string' && typeof named.workspace === 'string'
}

/**
 * Pi Durable's `ExecutionEnv` over a Mirage workspace: Pi's tools read and
 * write the workspace's mounts and run their commands in its shell, as one
 * session. The workspace is one in this process, or one a Mirage server
 * holds, reached over its HTTP API.
 */
export class MirageExecutionEnv extends WorldExecutionEnv {
  /**
   * @param source a workspace in this process, or where a server's workspace lives.
   * @param options where commands start, the session, Pi's namespace and watch polling.
   */
  constructor(source: Workspace | MirageRemote, options: MirageExecutionEnvOptions = {}) {
    super(
      isRemote(source)
        ? remoteWorld(source, options.sessionId, options.id)
        : localWorld(source, options.sessionId, options.id),
      options,
    )
  }
}
