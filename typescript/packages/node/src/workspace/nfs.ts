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

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MountBackend } from '@struktoai/mirage-core/types'
import type { SessionState } from '@struktoai/mirage-core/workspace/session/session'
import type { Workspace } from '@struktoai/mirage-core/workspace/workspace/workspace'
import { checkSizes } from '../fuse/backend.ts'
import { MountCore } from '../mount/core.ts'
import { MirageNFSServer, mountNfs, unmountArgs, unmountNfs } from '../mount/nfs.ts'
import { CLEANUP, type CleanupEntry, removeMountpointIfOwned } from './fuse.ts'

/**
 * Mounts one workspace subtree through the operating system's own NFS
 * client: a `MirageNFSServer` on this process's event loop, and the system
 * `mount` pointed at it. As with a FUSE mount, never read the mountpoint
 * synchronously from this process: the server answers on the same loop.
 * Mirrors Python's NFSManager.
 */
export class NFSManager {
  private server: MirageNFSServer | null = null
  private entry: CleanupEntry | null = null

  get mountpoint(): string | null {
    return this.entry?.mountpoint ?? null
  }

  /** Serve the workspace's files over NFS, mount them, and return the live mountpoint. */
  async setup(
    ws: Workspace,
    options: { mountpoint?: string; rootPrefix?: string; session?: SessionState } = {},
  ): Promise<string> {
    if (this.entry !== null) return this.entry.mountpoint
    checkSizes(MountBackend.NFS, ws, options.rootPrefix ?? '')
    const owns = options.mountpoint === undefined
    const mountpoint = options.mountpoint ?? mkdtempSync(join(tmpdir(), 'mirage-'))
    if (!owns) mkdirSync(mountpoint, { recursive: true })
    const server = new MirageNFSServer(
      new MountCore(ws.vfs, {
        ...(options.rootPrefix !== undefined ? { rootPrefix: options.rootPrefix } : {}),
        ...(options.session !== undefined ? { session: options.session } : {}),
      }),
    )
    const entry: CleanupEntry = { mountpoint, ownsMountpoint: owns, release: NFSManager.release }
    try {
      await mountNfs(await server.start(), mountpoint)
    } catch (err) {
      await server.close()
      removeMountpointIfOwned(entry)
      throw err
    }
    this.server = server
    this.entry = entry
    CLEANUP.register(entry)
    return mountpoint
  }

  /** Unmount, then stop the server: the other order would leave the kernel waiting on a server that is gone. */
  async unmount(): Promise<void> {
    const entry = this.entry
    if (entry === null) return
    await unmountNfs(entry.mountpoint)
    await this.server?.close()
    this.server = null
    CLEANUP.unregister(entry)
    this.entry = null
    removeMountpointIfOwned(entry)
  }

  /**
   * The exit-time teardown: the server dies with this process, so only the
   * forced unmount can still finish.
   */
  private static readonly release = (mountpoint: string): void => {
    const forced = unmountArgs(mountpoint).at(-1) ?? []
    try {
      execFileSync(forced[0] ?? '', forced.slice(1), { stdio: 'ignore' })
    } catch (err) {
      console.debug(`nfs: force unmount of ${mountpoint} failed: ${String(err)}`)
    }
  }
}
