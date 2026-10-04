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

import { newWorkspaceId } from '@struktoai/mirage-core/utils/ids'
import { WorkspaceRunner } from '@struktoai/mirage-core/workspace/runner'
import type { DiskRecordClient, Workspace } from '@struktoai/mirage-node'

// Under the daemon's state root: one record per workspace id naming the
// account that owns it.
export const OWNERS_PREFIX = 'owners'

/**
 * One registered workspace. `owner` is the account that created it; null
 * when it was created by a caller with no account.
 */
export class WorkspaceEntry {
  readonly id: string
  readonly runner: WorkspaceRunner
  readonly owner: string | null
  readonly createdAt: number
  /** The fingerprint of the config it was created from, when it was. */
  configDigest: string | null = null

  constructor(id: string, runner: WorkspaceRunner, owner: string | null = null) {
    this.id = id
    this.runner = runner
    this.owner = owner
    this.createdAt = Date.now() / 1000
  }
}

export interface WorkspaceRegistryOptions {
  idleGraceSeconds?: number
  onIdleExit?: () => void
  /**
   * Refuse callers with no account (jwt mode); otherwise such a caller
   * may use every workspace.
   */
  accountsRequired?: boolean
  /**
   * Where each workspace id's owning account is kept across restarts, so
   * a stored workspace is only ever reopened by its owner. Absent keeps
   * ownership in memory.
   */
  owners?: DiskRecordClient
}

export class WorkspaceRegistry {
  private entries = new Map<string, WorkspaceEntry>()
  private readonly removals = new Map<string, Promise<WorkspaceEntry>>()
  private readonly creates = new Map<string, { digest: string; done: Promise<unknown> }>()
  private readonly idleGraceSeconds: number
  private readonly onIdleExit: (() => void) | null
  private idleTimer: NodeJS.Timeout | null = null
  accountsRequired: boolean
  private readonly owners: DiskRecordClient | null

  constructor(options: WorkspaceRegistryOptions = {}) {
    this.idleGraceSeconds = options.idleGraceSeconds ?? 30
    this.onIdleExit = options.onIdleExit ?? null
    this.accountsRequired = options.accountsRequired ?? false
    this.owners = options.owners ?? null
  }

  has(id: string): boolean {
    return this.entries.has(id)
  }

  /**
   * Run one create of `id` at a time. A create of the same config that
   * arrives while another is building waits for it, then finds the
   * workspace it registered, rather than building a second over its
   * state; it would stall on the same secrets and mounts anyway. A
   * create of another config is not admitted and does not wait, so a
   * stuck create never holds it: `run` gets `admitted` false.
   */
  async creating<T>(
    id: string,
    configDigest: string,
    run: (admitted: boolean) => Promise<T>,
  ): Promise<T> {
    for (
      let pending = this.creates.get(id);
      pending !== undefined;
      pending = this.creates.get(id)
    ) {
      if (pending.digest !== configDigest) return run(false)
      await Promise.allSettled([pending.done])
    }
    const done = run(true)
    this.creates.set(id, { digest: configDigest, done })
    try {
      return await done
    } finally {
      this.creates.delete(id)
    }
  }

  /** Whether `id` is still registered only to be deleted. */
  removing(id: string): boolean {
    return this.removals.has(id)
  }

  get(id: string): WorkspaceEntry {
    const e = this.entries.get(id)
    if (e === undefined) throw new Error(`workspace not found: ${id}`)
    return e
  }

  list(): WorkspaceEntry[] {
    return Array.from(this.entries.values())
  }

  size(): number {
    return this.entries.size
  }

  /**
   * The live entry `account` may use, else null. The one access rule
   * every door asks: a caller with no account may use every workspace
   * unless accounts are required; an account may use only the workspaces
   * it owns, so one created by a caller with no account is closed to
   * every account. A workspace that exists but belongs to another
   * account answers null like a missing one, so its id does not leak.
   */
  visible(id: string, account: string | null): WorkspaceEntry | null {
    const entry = this.entries.get(id)
    if (entry === undefined) return null
    if (account === null) return this.accountsRequired ? null : entry
    return entry.owner === account ? entry : null
  }

  /**
   * Whether `account` may reach `id`'s records: the same rule as
   * `visible`, for an id that may not be live. A deleted workspace's
   * jobs, or a stored workspace after a restart, answer to the owner its
   * claim names.
   */
  async allows(id: string, account: string | null): Promise<boolean> {
    if (account === null) return !this.accountsRequired
    if (this.entries.has(id)) return this.visible(id, account) !== null
    if (this.owners === null) return false
    const [stored] = await this.owners.get(id)
    return stored !== null && stored.account === account
  }

  /**
   * Record `account` as the owner of `id`. The claim outlives the
   * daemon, so after a restart the stored workspace under that id reopens
   * only for the same account. A caller with no account claims nothing.
   * False when another account already owns the id.
   */
  async claim(id: string, account: string | null): Promise<boolean> {
    if (account === null || this.owners === null) return true
    if (await this.owners.casPut(id, { account, generation: 1 }, 0)) return true
    const [stored] = await this.owners.get(id)
    return stored !== null && stored.account === account
  }

  add(ws: Workspace, id?: string, owner: string | null = null): WorkspaceEntry {
    const wid = id ?? newWorkspaceId()
    if (this.entries.has(wid)) throw new Error(`workspace id already exists: ${wid}`)
    const entry = new WorkspaceEntry(wid, new WorkspaceRunner(ws), owner)
    this.entries.set(wid, entry)
    this.cancelIdleTimer()
    return entry
  }

  /**
   * Delete `id`: stop its runner and drop its state. The workspace's
   * links, history, sessions, metadata and owner leave with it, so a
   * workspace created later under the same id starts empty, for any
   * account.
   * `closeAll` (daemon shutdown) keeps them. The id stays registered
   * until the deletion is done, so a create under it is refused rather
   * than registering a workspace whose state this deletion would then
   * remove. An overlapping remove of
   * the same id joins the deletion in flight, so it never unregisters a
   * workspace created after it.
   */
  async remove(id: string): Promise<WorkspaceEntry> {
    let removal = this.removals.get(id)
    if (removal === undefined) {
      const entry = this.entries.get(id)
      if (entry === undefined) throw new Error(`workspace not found: ${id}`)
      removal = this.drop(entry)
      this.removals.set(id, removal)
    }
    return removal
  }

  /** Run one deletion, releasing the id once it is done. */
  private async drop(entry: WorkspaceEntry): Promise<WorkspaceEntry> {
    try {
      await entry.runner.stop({ delete: true })
      if (this.owners !== null) await this.owners.delete([entry.id])
    } finally {
      this.removals.delete(entry.id)
      this.entries.delete(entry.id)
      if (this.entries.size === 0) this.startIdleTimer()
    }
    return entry
  }

  /**
   * Close `id` and keep its state. The runner stops, which cancels its
   * lines and closes its sessions; the stored sessions, links, history
   * and owner stay, so the owner creating the same id later picks them
   * up. The id is released first, so no new request reaches the closing
   * runner.
   */
  async close(id: string): Promise<WorkspaceEntry> {
    const removal = this.removals.get(id)
    if (removal !== undefined) return removal
    const entry = this.entries.get(id)
    if (entry === undefined) throw new Error(`workspace not found: ${id}`)
    this.entries.delete(id)
    try {
      await entry.runner.stop()
    } finally {
      if (this.entries.size === 0) this.startIdleTimer()
    }
    return entry
  }

  async closeAll(): Promise<void> {
    this.cancelIdleTimer()
    const ids = Array.from(this.entries.keys())
    for (const id of ids) {
      const entry = this.entries.get(id)
      this.entries.delete(id)
      if (entry !== undefined) await entry.runner.stop()
    }
  }

  private startIdleTimer(): void {
    if (this.onIdleExit === null) return
    if (this.idleGraceSeconds <= 0) {
      this.onIdleExit()
      return
    }
    if (this.idleTimer !== null) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (this.entries.size === 0 && this.onIdleExit !== null) this.onIdleExit()
    }, this.idleGraceSeconds * 1000)
  }

  private cancelIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }
}
