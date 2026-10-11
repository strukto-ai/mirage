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

import { MountCore } from '@struktoai/mirage-node/mount/core'
import { STATUS } from '@struktoai/mirage-node/mount/constants'
import { SFTPStatusError } from '@struktoai/mirage-node/mount/errors'
import { MirageSFTPServer } from '@struktoai/mirage-node/mount/sftp'
import type { SFTPWrapper } from 'ssh2'
import type { WorkspaceEntry, WorkspaceRegistry } from '../registry.ts'
import { keyProfile, loginEntry, newSessionId, openSession } from './session.ts'

// ssh2 ends an SFTP channel with no exit status, which OpenSSH's ssh
// reports as 255 and scp (in its default SFTP mode) as a failed copy.
// sshd's internal-sftp reports 0; this sends it the way ssh2's own
// Channel.exit does for a session channel.
interface SFTPChannelInternals {
  _protocol: { exitStatus(id: number, status: number): void }
  outgoing: { id: number; state: string }
}

function exitZero(sftp: SFTPWrapper): void {
  const chan = sftp as unknown as SFTPChannelInternals
  if (chan.outgoing.state === 'open') chan._protocol.exitStatus(chan.outgoing.id, 0)
}

/**
 * Serve SFTP (and so modern scp) for one channel onto its workspace, as a
 * session of its own under the login key's profile, opened on the first
 * request and closed when the client exits.
 */
export function serveSFTP(
  registry: WorkspaceRegistry,
  workspaceId: string,
  profile: readonly string[],
  account: readonly string[],
  sftp: SFTPWrapper,
): void {
  const sessionId = newSessionId()
  let entry: WorkspaceEntry | null = null
  const makeCore = async (): Promise<MountCore> => {
    const found = loginEntry(registry, workspaceId, account)
    if (found === null) {
      throw new SFTPStatusError(STATUS.NO_SUCH_FILE, `no such workspace: ${workspaceId}`)
    }
    const ws = found.runner.ws
    await openSession(ws, sessionId, {}, keyProfile(profile))
    entry = found
    return new MountCore(ws.vfs, { session: ws.getSession(sessionId) })
  }
  const onExit = async (): Promise<void> => {
    try {
      if (entry !== null && registry.has(entry.id) && registry.get(entry.id) === entry) {
        await entry.runner.ws.closeSession(sessionId)
      }
    } finally {
      exitZero(sftp)
    }
  }
  new MirageSFTPServer(sftp, makeCore, onExit).attach()
}
