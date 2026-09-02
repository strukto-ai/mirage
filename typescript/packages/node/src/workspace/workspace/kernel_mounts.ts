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

import { MountBackend } from '@struktoai/mirage-core/types'
import type { Workspace } from '@struktoai/mirage-core/workspace/workspace/workspace'
import type { NFSConfig } from '../../nfs/config.ts'
import { KernelRoute, routeOf } from '../../mount/backend.ts'
import { FuseManager } from '../fuse.ts'
import { NFSManager } from '../nfs.ts'

/**
 * The workspace's real mountpoints, one manager per subtree.
 *
 * A `vfs` mount lives only inside mirage; a `fuse`, `fskit` or `nfs`
 * mount also registers a mountpoint with the kernel. This owns the set of
 * those: which prefix is exposed where, and the manager serving it. Keys
 * are `prefix` or `prefix@sessionId`, so the same subtree can be exposed
 * both unbound and bound to a session.
 *
 * The nfs tier differs in what serves it: one {@link NFSManager} backs
 * every nfs prefix of the workspace, because one server can export any
 * number of them, which is the macOS one-mount-per-process limit
 * dissolved. It is created on the first nfs mount and stopped by
 * {@link close}.
 *
 * Twin of python's `workspace/workspace/kernel_mounts.py`. Python takes
 * `(ops, sessions)` because its FuseManager mounts the ops facade; the
 * node one mounts the workspace itself, so that is what is held here.
 */
export class KernelMounts {
  private readonly workspace: Workspace
  private readonly mountpointsMap = new Map<string, string>()
  private readonly managers = new Map<string, FuseManager>()
  private readonly backends = new Map<string, MountBackend>()
  // One manager per session, keyed by session id ('' is the unscoped
  // one). A server serves one delegate, so a scoped mount cannot narrow
  // an existing server -- it needs its own.
  private readonly nfs = new Map<string, NFSManager>()

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
   * @param backend fuse, fskit or nfs
   */
  async add(
    prefix: string,
    mountpoint?: string,
    sessionId?: string,
    backend?: MountBackend,
    nfsConfig?: NFSConfig,
  ): Promise<string> {
    if (routeOf(backend ?? MountBackend.FUSE) === KernelRoute.LOOP) {
      return this.addNfs(prefix, mountpoint, sessionId, nfsConfig)
    }
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
      this.backends.set(key, backend ?? MountBackend.FUSE)
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
   * Expose `prefix` over nfs and return its mountpoint.
   *
   * A session-bound mount is refused rather than silently unscoped: one
   * server serves one delegate, so narrowing per session needs a second
   * server, which is a deliberate follow-up.
   *
   * @param prefix the virtual prefix to expose
   * @param mountpoint where to mount; undefined picks a path
   * @param sessionId must be undefined; see above
   * @param config server knobs; one server backs every prefix, so the
   *   first mount fixes them and a later config is ignored
   */
  async addNfs(
    prefix: string,
    mountpoint?: string,
    sessionId?: string,
    config?: NFSConfig,
  ): Promise<string> {
    const key = sessionId === undefined ? prefix : `${prefix}@${sessionId}`
    const session = sessionId !== undefined ? this.workspace.getSession(sessionId) : undefined
    if (mountpoint !== undefined) this.register(key, mountpoint)
    const managerKey = sessionId ?? ''
    let manager = this.nfs.get(managerKey)
    if (manager === undefined) {
      manager = new NFSManager()
      this.nfs.set(managerKey, manager)
    }
    try {
      const resolved = await manager.setup(this.workspace, prefix, mountpoint, config, session)
      this.register(key, resolved)
      this.backends.set(key, MountBackend.NFS)
      return resolved
    } catch (err) {
      this.mountpointsMap.delete(key)
      if (Object.keys(manager.mountpoints).length === 0) this.nfs.delete(managerKey)
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
    if (this.routeOfKey(key) === KernelRoute.LOOP) {
      const managerKey = sessionId ?? ''
      const nfs = this.nfs.get(managerKey)
      if (nfs !== undefined) {
        await nfs.unmount(prefix)
        // A session's server exists to serve that session's view; past
        // the last mount of it, nothing can reach the delegate. The
        // unscoped server outlives its mounts on purpose -- it is the
        // workspace's own, and a remove-then-add cycle should not cost
        // a restart.
        if (managerKey !== '' && Object.keys(nfs.mountpoints).length === 0) {
          await nfs.close()
          this.nfs.delete(managerKey)
        }
      }
      this.mountpointsMap.delete(key)
      this.backends.delete(key)
      return
    }
    const manager = this.managers.get(key)
    this.managers.delete(key)
    if (manager !== undefined) await manager.unmount()
    this.mountpointsMap.delete(key)
    this.backends.delete(key)
  }

  /**
   * Unmount everything this workspace exposed.
   *
   * The nfs server stops last: unmounting makes the kernel client flush
   * its dirty pages as final WRITEs, which a stopped server cannot take.
   */
  async close(): Promise<void> {
    for (const manager of this.managers.values()) await manager.unmount()
    this.managers.clear()
    for (const nfs of this.nfs.values()) await nfs.close()
    this.nfs.clear()
    this.mountpointsMap.clear()
    this.backends.clear()
  }

  /** The single active fuse or fskit mountpoint, when there is exactly one. */
  get mountpoint(): string | null {
    const fuse = Object.values(this.mountpoints)
    if (fuse.length === 0) return null
    if (fuse.length > 1) {
      throw new Error('multiple FUSE mounts active; use fuseMountpoints to select one by prefix')
    }
    return fuse[0] ?? null
  }

  /** The fuse and fskit mountpoints, keyed as they were added. */
  get mountpoints(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [key, path] of this.mountpointsMap) {
      if (this.routeOfKey(key) === KernelRoute.THREAD) out[key] = path
    }
    return out
  }

  /** The nfs mountpoints, keyed by prefix. */
  get nfsMountpoints(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [key, path] of this.mountpointsMap) {
      if (this.routeOfKey(key) === KernelRoute.LOOP) out[key] = path
    }
    return out
  }

  /**
   * How the mount registered under `key` was brought up. A key with no
   * backend recorded is one nothing mounted, which is the same answer
   * as a vfs mount: no kernel route.
   */
  private routeOfKey(key: string): KernelRoute {
    const backend = this.backends.get(key)
    return backend === undefined ? KernelRoute.NONE : routeOf(backend)
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
