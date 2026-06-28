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

import { rmdirSync } from 'node:fs'
import type { Workspace } from '@struktoai/mirage-core'
import { forceUnmount, mount, type FuseHandle, type MountOptions } from '../fuse/mount.ts'

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const
type Signal = (typeof SIGNALS)[number]
interface CleanupEntry {
  mountpoint: string
  handle: FuseHandle
  // Cleanup owns only generated temp directories, never explicit mountpoints.
  ownsMountpoint: boolean
}

function removeMountpointIfOwned(entry: { mountpoint: string; ownsMountpoint: boolean }): void {
  if (!entry.ownsMountpoint) return
  try {
    // Empty-directory cleanup only. Recursive removal is unsafe because a
    // still-mounted FUSE path can make deletes hit the mounted backend.
    rmdirSync(entry.mountpoint)
  } catch {
    // mountpoint may still be busy, non-empty, or already gone; caller can retry
  }
}

/**
 * Tracks auto-mounted FUSE handles and installs a single process-wide cleanup
 * path on SIGINT / SIGTERM / SIGHUP / `process.exit` so the kernel never ends
 * up with a stale mountpoint after the node process dies. Mirrors Python's
 * KeyboardInterrupt → `diskutil unmount force` / `fusermount -u` in mount.py.
 */
class FuseCleanupRegistry {
  private readonly mounts = new Set<CleanupEntry>()
  private installed = false
  private exiting = false

  register(entry: CleanupEntry): void {
    this.mounts.add(entry)
    this.install()
  }

  unregister(entry: CleanupEntry): void {
    this.mounts.delete(entry)
  }

  private install(): void {
    if (this.installed) return
    this.installed = true
    for (const sig of SIGNALS) {
      process.on(sig, this.onSignal)
    }
    process.on('beforeExit', this.onExit)
    process.on('exit', this.onExit)
  }

  private readonly onSignal = (sig: Signal): void => {
    if (this.exiting) return
    this.exiting = true
    this.drainSync()
    // Re-raise the signal so the default termination action runs after we've
    // unmounted. Node suppresses the default when a listener is attached.
    process.kill(process.pid, sig)
  }

  private readonly onExit = (): void => {
    if (this.exiting) return
    this.exiting = true
    this.drainSync()
  }

  private drainSync(): void {
    for (const entry of this.mounts) {
      forceUnmount(entry.mountpoint)
      removeMountpointIfOwned(entry)
    }
    this.mounts.clear()
  }
}

const CLEANUP = new FuseCleanupRegistry()

// Passive mounting primitive: it mounts a workspace subtree and tears it down.
// Registry/lifecycle ownership lives on the node Workspace (addFuseMount /
// removeFuseMount), mirroring Python's FuseManager.
export class FuseManager {
  private handle: FuseHandle | null = null
  private cleanupEntry: CleanupEntry | null = null

  get mountpoint(): string | null {
    return this.handle?.mountpoint ?? null
  }

  async setup(ws: Workspace, options: MountOptions = {}): Promise<string> {
    if (this.handle !== null) return this.handle.mountpoint
    const handle = await mount(ws, options)
    this.handle = handle
    this.cleanupEntry = {
      mountpoint: handle.mountpoint,
      handle,
      // Preserve the ownership decision made by mount(); unmount cleanup must
      // not infer ownership from path shape or whether the directory exists.
      ownsMountpoint: handle.ownsMountpoint,
    }
    CLEANUP.register(this.cleanupEntry)
    return handle.mountpoint
  }

  async unmount(): Promise<void> {
    if (this.handle === null) {
      return
    }
    const mp = this.handle.mountpoint
    try {
      await this.handle.unmount()
    } finally {
      const cleanupEntry = this.cleanupEntry
      if (cleanupEntry !== null) {
        CLEANUP.unregister(cleanupEntry)
        this.cleanupEntry = null
      }
      this.handle = null
      removeMountpointIfOwned({
        mountpoint: mp,
        ownsMountpoint: cleanupEntry?.ownsMountpoint ?? false,
      })
    }
  }

  async close(): Promise<void> {
    await this.unmount()
  }
}
