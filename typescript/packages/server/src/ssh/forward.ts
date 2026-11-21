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

import type { ServerChannel } from 'ssh2'
import type { WorkspaceEntry, WorkspaceRegistry } from '../registry.ts'
import { FORWARD_LINE } from './constants.ts'
import { LoginRefusedError } from './errors.ts'
import { loginSession } from './login.ts'
import { servePipe } from './pipe.ts'
import type { Login } from './types.ts'

/**
 * Carry one forward to `port` on the loopback of the machine the login's
 * lines run on. The forward opens a session as a channel does
 * (`loginSession`) and pipes the channel through its one line,
 * `FORWARD_LINE`, which relays between its stdin and stdout and the port
 * (`servePipe`). Mirrors Python's `serve_forward`.
 */
export async function serveForward(
  registry: WorkspaceRegistry,
  login: Login,
  port: number,
  channel: ServerChannel,
  gone: AbortSignal,
): Promise<void> {
  let opened: [WorkspaceEntry, string]
  try {
    opened = await loginSession(registry, login, {}, 'forward')
  } catch (err) {
    if (!(err instanceof LoginRefusedError)) throw err
    console.debug(`ssh: forward to port ${String(port)} refused: ${err.message}`)
    channel.end()
    return
  }
  const [entry, sessionId] = opened
  try {
    await servePipe(
      registry,
      entry,
      sessionId,
      FORWARD_LINE.replaceAll('{port}', String(port)),
      channel,
      gone,
      `forward to port ${String(port)}`,
    )
  } finally {
    channel.end()
  }
}
