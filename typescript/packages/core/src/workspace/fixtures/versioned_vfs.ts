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

import { vi } from 'vitest'
import { FileStat, FileType, MountMode, type PathSpec, ReadPolicy } from '../../types.ts'
import { enotsup } from '../../errors/fs.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import type { MountEntry } from '../mount/mount.ts'
import { Reconciler } from '../reconcile.ts'
import { Workspace } from '../workspace/workspace.ts'

/**
 * A RAM mount whose listing version and folder stat a test controls.
 *
 * `indexTtl` is positive so a `fresh` mount keeps listings for the gate to
 * check. `stats` is the ledger of every stat the backend was sent, `sent()`
 * resolves when the next one arrives, and a stat waits on `hold` when one is
 * set, so a test orders concurrent checks with promises.
 */
export class VersionedVFS extends RAMVFS {
  override readonly indexTtl: number = 600
  remote: string | null
  readonly remotes = new Map<string, string | null>()
  rejects: Error | null = null
  hasStat = true
  readonly stats: string[] = []
  private holding: Promise<void> | null = null
  private releaseHold: (() => void) | null = null
  private waiters: (() => void)[] = []

  constructor(kind = 'none', remote: string | null = 'v1') {
    super()
    this.remote = remote
    if (kind !== 'none') this.declare(kind)
  }

  /** Declare a listing version by value, as a backend's class would. */
  declare(kind: string): void {
    Object.defineProperty(this, 'listingVersion', { value: kind, configurable: true })
  }

  /** Make every stat wait until `release()`. */
  hold(): void {
    this.holding = new Promise((resolve) => {
      this.releaseHold = resolve
    })
  }

  release(): void {
    this.releaseHold?.()
  }

  /** Resolve when the next stat is sent, or fail after two seconds. */
  sent(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('no stat was sent'))
      }, 2000)
      this.waiters.push(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  override async stat(path: PathSpec): Promise<FileStat> {
    if (!this.hasStat) throw enotsup(this.name, 'stat', path)
    this.stats.push(path.virtual)
    const waiters = this.waiters
    this.waiters = []
    for (const wake of waiters) wake()
    if (this.holding !== null) await this.holding
    if (this.rejects !== null) throw this.rejects
    const fingerprint = this.remotes.has(path.virtual)
      ? (this.remotes.get(path.virtual) ?? null)
      : this.remote
    return new FileStat({
      name: path.virtual.split('/').pop() ?? '/',
      type: FileType.DIRECTORY,
      fingerprint,
    })
  }
}

/**
 * Mount `vfs` at `/m`, its stat the stub's. `asked` names every op the
 * mount's door was called for. Restore with vi.restoreAllMocks().
 */
export function versionedWorkspace(
  vfs: VersionedVFS,
  policy: ReadPolicy = ReadPolicy.FRESH,
): { ws: Workspace; mount: MountEntry; rec: Reconciler; asked: string[] } {
  const ws = new Workspace({ '/m': vfs }, { mode: MountMode.WRITE, read: { policy, ttl: 600 } })
  const mount = ws.namespace.mountFor('/m/a')
  const call = mount.callKeyed.bind(mount)
  const asked: string[] = []
  vi.spyOn(mount, 'callKeyed').mockImplementation((name, ...rest) => {
    asked.push(name)
    return call(name, ...rest)
  })
  return { ws, mount, rec: new Reconciler(ws.cache, ws.namespace), asked }
}
