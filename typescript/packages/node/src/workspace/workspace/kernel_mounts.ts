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

import type { MountBackend } from '@struktoai/mirage-core/types'
import type { Workspace } from '@struktoai/mirage-core/workspace/workspace/workspace'
import { FuseManager } from '../fuse.ts'

/**
 * The workspace's real mountpoints, one {@link FuseManager} per subtree.
 *
 * A `workspace` mount lives only inside mirage; a `fuse` or `fskit` mount also
 * registers a mountpoint with the kernel. This owns the set of those:
 * which prefix is exposed where, and the manager serving it. Keys are
 * `prefix` or `prefix@sessionId`, so the same subtree can be exposed
 * both unbound and bound to a session.
 *
 * Twin of python's `workspace/workspace/kernel_mounts.py`. Python takes
 * `(ops, sessions)` because its FuseManager mounts the ops facade; the
 * node one mounts the workspace itself, so that is what is held here.
 */
export class KernelMounts {
  private readonly workspace: Workspace
  private readonly mountpointsMap = new Map<string, string>()
  private readonly managers = new Map<string, FuseManager>()

  constructor(workspace: Workspace) {
    this.workspace = workspace
  }

  /**
   * Expose `prefix` at a real mountpoint and return its path.
   *
   * A session-bound mount runs every op under that session's mount
   * grants (the kernel-tier primitive: bind-mount the tree into a
   * container and the narrowing travels with it).
   *
   * @param prefix the virtual prefix to expose
   * @param mountpoint where to mount; undefined picks a path
   * @param sessionId session whose grants scope the ops
   * @param backend fuse or fskit
   */
  async add(
    prefix: string,
    mountpoint?: string,
    sessionId?: string,
    backend?: MountBackend,
  ): Promise<string> {
    const session = sessionId !== undefined ? this.workspace.getSession(sessionId) : undefined
    const key = sessionId === undefined ? prefix : `${prefix}@${sessionId}`
    // Register a pinned path BEFORE mounting so a collision is rejected
    // without leaving a partial mount.
    if (mountpoint !== undefined) this.register(key, mountpoint)
    const manager = new FuseManager()
    this.managers.set(key, manager)
    try {
      const resolved = await manager.setup(this.workspace, {
        rootPrefix: prefix,
        ...(mountpoint !== undefined ? { mountpoint } : {}),
        ...(session !== undefined ? { session } : {}),
        ...(backend !== undefined ? { backend } : {}),
      })
      if (mountpoint === undefined) this.register(key, resolved)
      return resolved
    } catch (err) {
      // The mount never came up; drop the manager and any registered path
      // so mountpoints does not misreport it as live.
      this.managers.delete(key)
      this.mountpointsMap.delete(key)
      throw err
    }
  }

  /**
   * Unmount one exposed subtree.
   *
   * @param prefix the virtual prefix that was exposed
   * @param sessionId session the mount was bound to
   */
  async remove(prefix: string, sessionId?: string): Promise<void> {
    const key = sessionId === undefined ? prefix : `${prefix}@${sessionId}`
    const manager = this.managers.get(key)
    this.managers.delete(key)
    if (manager !== undefined) await manager.unmount()
    this.mountpointsMap.delete(key)
  }

  /** Unmount everything this workspace exposed. */
  async close(): Promise<void> {
    for (const manager of this.managers.values()) await manager.unmount()
    this.managers.clear()
    this.mountpointsMap.clear()
  }

  /** The single active mountpoint, when there is exactly one. */
  get mountpoint(): string | null {
    if (this.mountpointsMap.size === 0) return null
    if (this.mountpointsMap.size > 1) {
      throw new Error('multiple FUSE mounts active; use fuseMountpoints to select one by prefix')
    }
    return this.mountpointsMap.values().next().value ?? null
  }

  get mountpoints(): Record<string, string> {
    return Object.fromEntries(this.mountpointsMap)
  }

  private register(key: string, mountpoint: string): void {
    for (const [otherKey, otherMountpoint] of this.mountpointsMap) {
      if (otherMountpoint === mountpoint && otherKey !== key) {
        throw new Error(
          `FUSE mountpoint ${mountpoint} already used by prefix ${otherKey}; mounts need distinct paths`,
        )
      }
    }
    this.mountpointsMap.set(key, mountpoint)
  }
}
