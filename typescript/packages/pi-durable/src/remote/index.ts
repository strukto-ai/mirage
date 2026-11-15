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
import type { MirageRemote } from '@struktoai/mirage-core/remote/client'
import { WorldExecutionEnv, type MirageExecutionEnvOptions } from '../env.ts'
import { remotePrompt } from '../extension.ts'
import { remoteWorld } from './world.ts'

/**
 * `MirageExecutionEnv` for a workspace a Mirage server holds, with no
 * workspace code of this process in its imports, so it bundles small for a
 * Worker or a browser.
 */
export class MirageExecutionEnv extends WorldExecutionEnv {
  /**
   * @param remote where the workspace lives and how to reach it.
   * @param options where commands start, the session, Pi's namespace and watch polling.
   */
  constructor(remote: MirageRemote, options: MirageExecutionEnvOptions = {}) {
    super(remoteWorld(remote, options.sessionId, options.id), options)
  }
}

/** The `mirage` extension for a server's workspace: its mounts, as the server describes them. */
export function mirageExtension(remote: MirageRemote): Extension {
  return defineExtension({
    name: 'mirage',
    sections: [section('mirage', () => remotePrompt(remote))],
  })
}

export type { MirageExecutionEnvOptions } from '../env.ts'
export {
  MirageClient,
  MirageRemoteError,
  type MirageRemote,
  type RemoteMount,
} from '@struktoai/mirage-core/remote/client'
