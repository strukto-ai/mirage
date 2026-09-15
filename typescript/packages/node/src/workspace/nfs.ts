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

import type { Session } from '@struktoai/mirage-core/workspace/session/session'
import type { Workspace } from '@struktoai/mirage-core/workspace/workspace/workspace'

import { NFSConfig } from '../nfs/config.ts'
import {
  prepareMountpoint,
  runMount,
  runUmount,
  startServer,
  type NFSServerHandle,
} from '../nfs/mount.ts'

/** What the manager needs of the adapter: the teardown flush. */
export interface NFSFlushTarget {
  flushAll: () => Promise<void>
}

export type StartFn = (
  ws: Workspace,
  config: NFSConfig,
  session?: Session | null,
) => Promise<[NFSFlushTarget, NFSServerHandle]>
export type MountFn = (
  mountpoint: string,
  port: number,
  exportPath: string,
  config: NFSConfig,
) => Promise<void>
export type UnmountFn = (mountpoint: string) => Promise<void>

/** Injection seams, so a test drives the manager without a kernel mount. */
export interface NFSManagerOptions {
  startFn?: StartFn
  mountFn?: MountFn
  unmountFn?: UnmountFn
}

/**
 * One NFS server, many kernel mounts.
 *
 * The MOUNT protocol takes a path, so a single server exposing the whole
 * op tree can back any number of kernel mountpoints, each mounting a
 * different export (`127.0.0.1:/` here, `:/docs` there). That is the
 * one-per-process limit macOS FUSE lives under, dissolved: the server
 * starts lazily on the first mount and every later mount reuses it.
 *
 * The twin of python's `workspace/nfs.py`, with the same seam difference
 * the FUSE managers already carry: python mounts the ops facade, node
 * mounts the workspace itself.
 *
 * One manager is one session's view, because one server serves one
 * delegate. A session-scoped mount therefore does not narrow this
 * server; it gets a second one, which is what `KernelMounts` keeps a
 * manager per session for. The session is fixed by the first mount for
 * the same reason the config is.
 */
export class NFSManager {
  private readonly startFn: StartFn
  private readonly mountFn: MountFn
  private readonly unmountFn: UnmountFn
  private fs: NFSFlushTarget | null = null
  private handle: NFSServerHandle | null = null
  private config: NFSConfig | null = null
  private session: Session | null = null
  private readonly mounts = new Map<string, [string, boolean]>()

  constructor(options: NFSManagerOptions = {}) {
    this.startFn = options.startFn ?? startServer
    this.mountFn = options.mountFn ?? runMount
    this.unmountFn = options.unmountFn ?? runUmount
  }

  /** Live mounts, prefix to mountpoint. */
  get mountpoints(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [prefix, [path]] of this.mounts) out[prefix] = path
    return out
  }

  /**
   * Expose `prefix` at a kernel mountpoint and return its path.
   *
   * The first call starts the server and fixes its config; later calls
   * reuse both, so `config` is honored only once.
   */
  async setup(
    ws: Workspace,
    prefix = '/',
    mountpoint?: string,
    config?: NFSConfig,
    session?: Session | null,
  ): Promise<string> {
    // Collision answers from the registry BEFORE the path is touched: a
    // colliding mountpoint may be a live mount served by this very loop,
    // and prepareMountpoint stats it (mkdir -> isdir), which is the
    // self-touch deadlock in miniature.
    if (mountpoint !== undefined) {
      for (const [otherPrefix, [otherPath]] of this.mounts) {
        if (otherPath === mountpoint) {
          throw new Error(
            `nfs mountpoint ${JSON.stringify(mountpoint)} already serves ` +
              JSON.stringify(otherPrefix),
          )
        }
      }
    }
    // And the prefix, for the same reason from the other side. The
    // registry is keyed by prefix, so a second setup of one already
    // mounted overwrote its entry -- and close() unmounts what the
    // registry holds, so the first mountpoint stayed live with no
    // server behind it, which is the exact state the soft-mount and
    // teardown work exists to prevent.
    const existing = this.mounts.get(prefix)
    if (existing !== undefined) {
      throw new Error(
        `nfs prefix ${JSON.stringify(prefix)} is already mounted at ` +
          `${JSON.stringify(existing[0])}; unmount it before mounting it again`,
      )
    }
    if (this.handle !== null && (session ?? null) !== this.session) {
      throw new Error(
        'this nfs server is bound to a different session; a session-scoped ' +
          'mount needs its own manager',
      )
    }
    const [resolved, owns] = prepareMountpoint(mountpoint)
    // One server backs every prefix, so the first mount fixes the knobs
    // -- the mount options included, since a second mountpoint into the
    // same server must not answer to different timeouts than the first.
    this.config ??= config ?? new NFSConfig()
    if (this.handle === null) {
      this.session = session ?? null
      const [fs, handle] = await this.startFn(ws, this.config, this.session)
      this.fs = fs
      this.handle = handle
    }
    const bare = prefix.replace(/^\/+/, '').replace(/\/+$/, '')
    const exportPath = bare === '' ? '/' : `/${bare}`
    try {
      await this.mountFn(resolved, this.handle.port(), exportPath, this.config)
    } catch (err) {
      this.discardMountpoint(resolved, owns)
      throw err
    }
    this.mounts.set(prefix, [resolved, owns])
    return resolved
  }

  /** Tear down one exposed prefix. Missing prefixes are a no-op. */
  async unmount(prefix: string): Promise<void> {
    const entry = this.mounts.get(prefix)
    if (entry === undefined) return
    this.mounts.delete(prefix)
    const [path, owns] = entry
    await this.unmountFn(path)
    this.discardMountpoint(path, owns)
  }

  /**
   * Unmount everything, flush buffered writes, stop the server.
   *
   * The order is load-bearing: unmounting makes the kernel client flush
   * its dirty pages as final WRITEs, which need a live server;
   * `flushAll` then stores whatever is still buffered; only then does
   * the server stop. Idempotent.
   *
   * Stopping releases node's event loop too, so a script that mounts and
   * closes exits on its own. It did not always: the addon's idle flusher
   * looped forever, and the threadsafe function it held kept the loop
   * referenced for the process's lifetime. `smoke.mjs` fails now if that
   * comes back.
   */
  async close(): Promise<void> {
    for (const prefix of [...this.mounts.keys()]) await this.unmount(prefix)
    if (this.fs !== null) await this.fs.flushAll()
    if (this.handle !== null) this.handle.stop()
    this.fs = null
    this.handle = null
    this.config = null
    this.session = null
  }

  /** Remove a mirage-owned, now-empty mountpoint directory. */
  private discardMountpoint(path: string, owns: boolean): void {
    if (!owns) return
    try {
      rmdirSync(path)
    } catch {
      // busy or non-empty: the caller/admin's to clean, never ours to force
    }
  }
}
