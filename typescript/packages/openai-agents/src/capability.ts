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

import { Capability, type Manifest, type SandboxSessionLike } from '@openai/agents/sandbox'
import { MOUNTS_INTRO, NOT_MIRAGE_SESSION } from './constants.ts'
import { MirageSandboxSession } from './sandbox.ts'

/**
 * Tell a SandboxAgent's model which Mirage mounts it is working in.
 *
 * The SDK describes the filesystem from its manifest alone, so the mounts
 * behind a Mirage sandbox never reach the model. This adds the workspace's
 * own mount listing (backend, mode, commands) to the agent's instructions.
 * It binds only to a session from `MirageSandboxClient`.
 */
export class MirageCapability extends Capability {
  readonly type = 'mirage'

  override bind(session: SandboxSessionLike): this {
    mirageSession(session)
    return super.bind(session)
  }

  override async instructions(_manifest: Manifest): Promise<string> {
    const session = mirageSession(this._session)
    return `${MOUNTS_INTRO}\n\n${await session.workspace.vfsMd(undefined, { sessionId: session.sessionId })}`
  }
}

export function mirageSession(session: SandboxSessionLike | undefined): MirageSandboxSession {
  if (!(session instanceof MirageSandboxSession)) throw new TypeError(NOT_MIRAGE_SESSION)
  return session
}
