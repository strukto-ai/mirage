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

import { withCacheMutation } from '../file/io.ts'
import type { FileCache } from '../file/mixin.ts'
import {
  LookupStatus,
  type Evicted,
  type IndexEntry,
  type IndexSnapshot,
  type ListResult,
  type LookupResult,
  type SetDirOptions,
} from './config.ts'
import { IndexCacheStore } from './store.ts'
import { rstripSlash } from '../../utils/slash.ts'

interface IndexViewOptions {
  readonly excludedPrefixes?: () => readonly string[]
  /**
   * Skip the non-reentrant mutation lock already held by the caller.
   * The view must not outlive that hold.
   */
  readonly locked?: boolean
  /** The mount's cleanup for a child a re-list found gone. */
  readonly onGone?: (gone: readonly Evicted[]) => Promise<void>
  /** Seconds a listing may live under this mount; unset means no cap. */
  readonly readTtl?: number
  /**
   * The mount's listing gate, asked before a cached listing is served;
   * unset serves every cached listing.
   */
  readonly mayServeListing?: (folder: string, version: string | null) => Promise<boolean>
  /** Told each folder whose listing this view has just written. */
  readonly noteWritten?: (folder: string) => void
  /** Whether the running command fetched a folder's listing; unset answers false. */
  readonly listedThisCommand?: (folder: string) => boolean
}

/** A mount-owned index view; delayed backend writes retain their original owner. */
export class IndexView extends IndexCacheStore {
  private readonly locked: boolean
  private readonly readTtl: number | undefined
  private readonly onGone: ((gone: readonly Evicted[]) => Promise<void>) | undefined
  private readonly mayServeListing:
    | ((folder: string, version: string | null) => Promise<boolean>)
    | undefined
  private readonly excludedPrefixes: () => readonly string[]
  private readonly noteWritten: ((folder: string) => void) | undefined
  private readonly commandListed: ((folder: string) => boolean) | undefined

  constructor(
    private readonly inner: IndexCacheStore,
    private readonly cache: FileCache,
    private readonly prefix: string,
    private readonly owns: (path: string) => boolean,
    options: IndexViewOptions = {},
  ) {
    super()
    this.locked = options.locked ?? false
    this.readTtl = options.readTtl
    this.onGone = options.onGone
    this.mayServeListing = options.mayServeListing
    this.noteWritten = options.noteWritten
    this.commandListed = options.listedThisCommand
    this.excludedPrefixes = options.excludedPrefixes ?? (() => [])
  }

  override listedThisCommand(folder: string): boolean {
    return this.commandListed?.(folder) ?? false
  }

  /** The store this view writes through. */
  get store(): IndexCacheStore {
    return this.inner
  }

  get ttl(): number {
    return this.readTtl === undefined ? this.inner.ttl : Math.min(this.inner.ttl, this.readTtl)
  }

  private fence<T>(fn: () => Promise<T>): Promise<T> {
    return this.locked ? fn() : withCacheMutation(this.cache, fn)
  }

  /** Cap the expiry, preserving the store default when it is shorter. */
  private deadline(expiredAt: Date | null | undefined): Date | null | undefined {
    if (expiredAt !== null && expiredAt !== undefined) return this.cap(expiredAt)
    if (this.readTtl === undefined || this.inner.ttl <= this.readTtl) return expiredAt
    return new Date(Date.now() + this.readTtl * 1000)
  }

  /** Shorten an explicit expiry to this mount's bound. */
  private cap(at: Date): Date {
    if (this.readTtl === undefined) return at
    const bound = Date.now() + this.readTtl * 1000
    return at.getTime() > bound ? new Date(bound) : at
  }

  override scopeSnapshot(snapshot: IndexSnapshot): IndexSnapshot {
    return {
      entries: new Map([...snapshot.entries].filter(([path]) => this.owns(path))),
      children: new Map(
        [...snapshot.children]
          .filter(([path]) => this.owns(path))
          .map(([path, keys]) => [path, keys.filter((key) => this.owns(key))]),
      ),
      version: snapshot.version ?? null,
    }
  }

  seed(
    entries: ReadonlyMap<string, IndexEntry>,
    children: ReadonlyMap<string, readonly string[]>,
    expiresAt: Date,
    version: string | null = null,
  ): void {
    if (!this.owns(this.prefix)) return
    const snapshot = this.scopeSnapshot({ entries, children, version })
    this.inner.seed(
      snapshot.entries,
      snapshot.children,
      this.cap(expiresAt),
      snapshot.version ?? null,
    )
    for (const folder of snapshot.children.keys()) this.noted(folder)
  }

  entries(): Promise<Map<string, IndexEntry>> {
    return this.fence(async () => {
      if (!this.owns(this.prefix)) return new Map<string, IndexEntry>()
      const entries = await this.inner.entries()
      return new Map([...entries].filter(([path]) => this.owns(path)))
    })
  }

  async get(path: string): Promise<LookupResult> {
    // Index lookups may flush queued state; keep them inside the write fence too.
    return this.fence(async () => {
      if (!this.owns(path)) return { status: LookupStatus.NOT_FOUND }
      const result = await this.inner.get(path)
      return this.owns(path) ? result : { status: LookupStatus.NOT_FOUND }
    })
  }

  async listDir(path: string): Promise<ListResult> {
    const result = await this.fencedListDir(path)
    // Asked outside the fence, since a gate may reach the backend, and only
    // about a listing the store has: a NOT_FOUND must stay one. A refusal
    // leaves the listing stored for the re-list to diff.
    if (
      this.mayServeListing !== undefined &&
      (result.entries != null || result.partialEntries != null) &&
      !(await this.mayServeListing(path, result.version ?? null))
    ) {
      return { status: LookupStatus.EXPIRED }
    }
    return result
  }

  private fencedListDir(path: string): Promise<ListResult> {
    return this.fence(async () => {
      if (!this.owns(path)) return { status: LookupStatus.NOT_FOUND }
      const result = await this.inner.listDir(path)
      if (!this.owns(path)) return { status: LookupStatus.NOT_FOUND }
      return {
        ...result,
        ...(result.entries == null
          ? {}
          : { entries: result.entries.filter((key) => this.owns(key)) }),
        ...(result.partialEntries == null
          ? {}
          : { partialEntries: result.partialEntries.filter((key) => this.owns(key)) }),
      }
    })
  }

  put(path: string, entry: IndexEntry): Promise<void> {
    return this.fence(async () => {
      if (this.owns(path)) await this.inner.put(path, entry)
    })
  }

  override replaceIfUnchanged(
    path: string,
    predecessor: string,
    entry: IndexEntry,
  ): Promise<boolean> {
    return this.fence(() =>
      this.owns(path)
        ? this.inner.replaceIfUnchanged(path, predecessor, entry)
        : Promise.resolve(false),
    )
  }

  setDir(
    path: string,
    entries: readonly [string, IndexEntry][],
    expiredAt?: Date | null,
    options: SetDirOptions = {},
  ): Promise<Evicted[]> {
    return this.storeDir(
      path,
      entries,
      expiredAt,
      false,
      options.window === true,
      options.excluded ?? [],
      options.version ?? null,
    ).then(async (gone) => {
      await this.reportGone(gone)
      return gone
    })
  }

  override setPartialDir(
    path: string,
    entries: readonly [string, IndexEntry][],
    expiredAt?: Date | null,
  ): Promise<void> {
    return this.storeDir(path, entries, expiredAt, true, false).then(() => undefined)
  }

  private storeDir(
    path: string,
    entries: readonly [string, IndexEntry][],
    expiredAt: Date | null | undefined,
    partial: boolean,
    window: boolean,
    excluded: readonly string[] = [],
    version: string | null = null,
  ): Promise<Evicted[]> {
    return this.fence(async () => {
      if (!this.owns(path)) return []
      const prefix = rstripSlash(path) + '/'
      const owned = entries.filter(([name]) => this.owns(prefix + name))
      const deadline = this.deadline(expiredAt)
      if (partial) {
        await this.inner.setPartialDir(path, owned, deadline)
        this.noted(path)
        return []
      }
      const gone = await this.inner.setDir(path, owned, deadline, {
        window,
        excluded: [...excluded, ...this.excludedPrefixes()],
        version,
      })
      this.noted(path)
      return gone.filter((child) => this.owns(child.path))
    })
  }

  // After the store holds it, never before: a reader trusting the note must
  // find the listing the note is about.
  private noted(path: string): void {
    this.noteWritten?.(path)
  }

  // Outside the fence: cleanup evicts file-cache entries, and the mount table
  // can change after the write, so ownership is asked again at cleanup time.
  override async reportGone(gone: readonly Evicted[]): Promise<void> {
    if (this.onGone === undefined) return
    const owned = gone.filter((child) => this.owns(child.path))
    if (owned.length > 0) await this.onGone(owned)
  }

  invalidateEntry(vfsPath: string): Promise<void> {
    return this.fence(async () => {
      if (this.owns(vfsPath)) await this.inner.invalidateEntry(vfsPath)
    })
  }

  invalidateDir(path: string): Promise<void> {
    return this.fence(async () => {
      if (this.owns(path)) await this.inner.invalidateDir(path)
    })
  }

  invalidatePrefix(path: string, excluded: readonly string[] = []): Promise<void> {
    return this.fence(async () => {
      if (this.owns(path))
        await this.inner.invalidatePrefix(path, [...excluded, ...this.excludedPrefixes()])
    })
  }

  // No ownership filter: answering false for a path a nested mount owns would
  // keep that subtree cached, the non-conservative way.
  override holdsSubtree(path: string): Promise<boolean> {
    return this.fence(() => this.inner.holdsSubtree(path))
  }

  invalidate(): Promise<void> {
    return this.fence(async () => {
      if (this.owns(this.prefix)) await this.inner.invalidate()
    })
  }

  clear(): Promise<void> {
    return this.invalidatePrefix(this.prefix)
  }
}
