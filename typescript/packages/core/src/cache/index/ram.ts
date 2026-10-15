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

import type { FileStat} from '../../types.ts';
import { FileType } from '../../types.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import { underPath } from '../../utils/key_prefix.ts'
import { KeyLock } from '../lock.ts'
import {
  LookupStatus,
  type Evicted,
  type ListResult,
  type LookupResult,
  type SetDirOptions,
} from './config.ts'
import { IndexCacheStore } from './store.ts'

export class RAMIndexCacheStore extends IndexCacheStore {
  readonly ttl: number
  private readonly entryMap = new Map<string, FileStat>()
  private readonly children = new Map<string, string[]>()
  private readonly expiry = new Map<string, number>()
  private readonly partial = new Set<string>()
  private readonly windowed = new Set<string>()
  private readonly tombstones = new Map<string, Evicted[]>()
  private readonly versions = new Map<string, string>()
  private readonly lock = new KeyLock()

  constructor(options: { ttl?: number } = {}) {
    super()
    this.ttl = options.ttl ?? 600
  }

  seed(
    entries: ReadonlyMap<string, FileStat>,
    children: ReadonlyMap<string, readonly string[]>,
    expiresAt: Date,
    version: string | null = null,
  ): void {
    for (const [path, entry] of entries) this.entryMap.set(path, entry)
    for (const [path, keys] of children) {
      this.children.set(path, [...keys])
      this.expiry.set(path, expiresAt.getTime())
      this.partial.delete(path)
      this.windowed.delete(path)
      this.stamp(path, version)
    }
  }

  private stamp(vfsPath: string, version: string | null): void {
    if (version === null) this.versions.delete(vfsPath)
    else this.versions.set(vfsPath, version)
  }

  entries(): Promise<Map<string, FileStat>> {
    return Promise.resolve(new Map(this.entryMap))
  }

  get(vfsPath: string): Promise<LookupResult> {
    const entry = this.entryMap.get(vfsPath)
    if (entry === undefined) return Promise.resolve({ status: LookupStatus.NOT_FOUND })
    return Promise.resolve({ entry: entry })
  }

  put(vfsPath: string, entry: FileStat): Promise<void> {
    return this.lock.withLock(vfsPath, () => {
      this.entryMap.set(vfsPath, entry)
      return Promise.resolve()
    })
  }

  override addEntry(vfsPath: string, entry: FileStat): Promise<void> {
    const folder = vfsPath.slice(0, vfsPath.lastIndexOf('/')) || '/'
    return this.lock.withLock(folder, () => {
      const now = Date.now()
      this.entryMap.set(vfsPath, entry)
      const children = this.children.get(folder)
      const exp = this.expiry.get(folder)
      if (children === undefined || exp === undefined || now >= exp) {
        this.children.set(folder, [vfsPath])
        this.expiry.set(folder, now + this.ttl * 1000)
        this.partial.add(folder)
        this.windowed.delete(folder)
        this.versions.delete(folder)
      } else if (!children.includes(vfsPath)) {
        const at = children.findIndex((child) => compareCodePoints(child, vfsPath) > 0)
        children.splice(at === -1 ? children.length : at, 0, vfsPath)
      }
      return Promise.resolve()
    })
  }

  override replaceIfUnchanged(
    path: string,
    predecessor: string,
    entry: FileStat,
  ): Promise<boolean> {
    return this.lock.withLock(path, () => {
      const current = this.entryMap.get(path)
      if (current === undefined || JSON.stringify(current) !== predecessor)
        return Promise.resolve(false)
      this.entryMap.set(path, entry)
      return Promise.resolve(true)
    })
  }

  listDir(vfsPath: string): Promise<ListResult> {
    const exp = this.expiry.get(vfsPath)
    if (exp === undefined) return Promise.resolve({ status: LookupStatus.NOT_FOUND })
    if (Date.now() >= exp) return Promise.resolve({ status: LookupStatus.EXPIRED })
    const children = this.children.get(vfsPath) ?? []
    const version = this.versions.get(vfsPath) ?? null
    if (this.partial.has(vfsPath)) return Promise.resolve({ partialEntries: children, version })
    return Promise.resolve({ entries: children, version, window: this.windowed.has(vfsPath) })
  }

  setDir(
    vfsPath: string,
    entries: readonly [string, FileStat][],
    expiredAt?: Date | null,
    options: SetDirOptions = {},
  ): Promise<Evicted[]> {
    return this.storeDir(
      vfsPath,
      entries,
      expiredAt,
      false,
      options.window !== true,
      options.excluded ?? [],
      options.version ?? null,
    )
  }

  override setPartialDir(
    vfsPath: string,
    entries: readonly [string, FileStat][],
    expiredAt?: Date | null,
  ): Promise<void> {
    return this.storeDir(vfsPath, entries, expiredAt, true, false).then(() => undefined)
  }

  private storeDir(
    vfsPath: string,
    entries: readonly [string, FileStat][],
    expiredAt: Date | null | undefined,
    partial: boolean,
    evict: boolean,
    excluded: readonly string[] = [],
    version: string | null = null,
  ): Promise<Evicted[]> {
    return this.lock.withLock(vfsPath, () => {
      const now = Date.now()
      const exp = expiredAt ? expiredAt.getTime() : now + this.ttl * 1000
      const prefix = vfsPath === '/' ? '/' : `${vfsPath}/`
      const rows = new Map<string, FileStat>()
      for (const [name, entry] of entries) rows.set(prefix + name, entry)
      const childKeys = [...rows.keys()]
      // What the last full knowledge named: the current listing, plus a
      // tombstone an invalidation left (a partial since then cannot have
      // proven its other children gone).
      const buried = new Map<string, boolean>()
      if (!partial) {
        for (const child of this.tombstones.get(vfsPath) ?? []) buried.set(child.path, child.folder)
        this.tombstones.delete(vfsPath)
      }
      const candidates = new Set([
        ...(this.children.get(vfsPath) ?? []),
        ...buried.keys(),
        ...rows.keys(),
      ])
      const gone = evict
        ? [...candidates]
            .filter(
              (key) =>
                (!rows.has(key) ||
                  (rows.get(key)?.type === FileType.FILE &&
                    (buried.get(key) === true ||
                      this.children.has(key) ||
                      this.entryMap.get(key)?.type === FileType.DIRECTORY))) &&
                !excluded.some((prefix) => underPath(key, prefix)),
            )
            .map((key) => this.evict(key, buried.get(key) ?? false, excluded))
        : []
      for (const [path, row] of rows) this.entryMap.set(path, row)
      this.children.set(vfsPath, childKeys)
      this.expiry.set(vfsPath, exp)
      this.stamp(vfsPath, partial ? null : version)
      if (partial) this.partial.add(vfsPath)
      else this.partial.delete(vfsPath)
      if (partial || evict) this.windowed.delete(vfsPath)
      else this.windowed.add(vfsPath)
      return Promise.resolve(gone)
    })
  }

  /** Drop a child a complete listing no longer names. */
  private evict(key: string, buriedFolder = false, excluded: readonly string[] = []): Evicted {
    const entry = this.entryMap.get(key)
    this.entryMap.delete(key)
    const folder = buriedFolder || this.children.has(key) || entry?.type === FileType.DIRECTORY
    if (folder) this.dropPrefix(key, false, excluded)
    return { path: key, folder }
  }

  invalidateEntry(vfsPath: string): Promise<void> {
    this.entryMap.delete(vfsPath)
    return Promise.resolve()
  }

  invalidateDir(vfsPath: string): Promise<void> {
    // The child list is kept as a tombstone, so the next complete listing can
    // still tell which children went away.
    const children = this.children.get(vfsPath)
    if (children !== undefined) {
      const buried = new Map(
        this.partial.has(vfsPath)
          ? (this.tombstones.get(vfsPath) ?? []).map((child) => [child.path, child.folder])
          : [],
      )
      for (const child of children) {
        buried.set(
          child,
          buried.get(child) === true ||
            this.children.has(child) ||
            this.entryMap.get(child)?.type === FileType.DIRECTORY,
        )
      }
      this.tombstones.set(
        vfsPath,
        [...buried].map(([path, folder]) => ({ path, folder })),
      )
    }
    for (const child of children ?? []) {
      this.entryMap.delete(child)
    }
    this.expiry.delete(vfsPath)
    this.children.delete(vfsPath)
    this.partial.delete(vfsPath)
    this.windowed.delete(vfsPath)
    this.versions.delete(vfsPath)
    return Promise.resolve()
  }

  // Forgetting what is cached is not evidence that anything went away, so an
  // existing tombstone survives for the next complete listing.
  invalidatePrefix(vfsPath: string, excluded: readonly string[] = []): Promise<void> {
    this.dropPrefix(vfsPath, true, excluded)
    return Promise.resolve()
  }

  override holdsSubtree(vfsPath: string): Promise<boolean> {
    for (const key of this.children.keys()) {
      if (underPath(key, vfsPath)) return Promise.resolve(true)
    }
    return Promise.resolve(false)
  }

  private dropPrefix(
    vfsPath: string,
    keepTombstones = false,
    excluded: readonly string[] = [],
  ): void {
    if (!keepTombstones) {
      for (const key of [...this.tombstones.keys()]) {
        if (underPath(key, vfsPath) && !excluded.some((prefix) => underPath(key, prefix)))
          this.tombstones.delete(key)
      }
    }
    for (const key of [...this.entryMap.keys()]) {
      if (underPath(key, vfsPath) && !excluded.some((prefix) => underPath(key, prefix)))
        this.entryMap.delete(key)
    }
    for (const key of [...this.children.keys()]) {
      if (underPath(key, vfsPath) && !excluded.some((prefix) => underPath(key, prefix)))
        this.children.delete(key)
    }
    for (const key of [...this.expiry.keys()]) {
      if (underPath(key, vfsPath) && !excluded.some((prefix) => underPath(key, prefix))) {
        this.expiry.delete(key)
        this.partial.delete(key)
        this.windowed.delete(key)
        this.versions.delete(key)
      }
    }
  }

  invalidate(): Promise<void> {
    const past = Date.now() - 1000
    for (const key of this.expiry.keys()) this.expiry.set(key, past)
    return Promise.resolve()
  }

  clear(): Promise<void> {
    this.entryMap.clear()
    this.children.clear()
    this.expiry.clear()
    this.partial.clear()
    this.windowed.clear()
    this.tombstones.clear()
    this.versions.clear()
    this.lock.clear()
    return Promise.resolve()
  }
}

/**
 * The empty, throwaway store a `read: fresh` check stats through.
 *
 * The listing gate and the read probe pass it to say a request is what they
 * want. A root stat asks the backend for its head only through this store.
 * Through any other index it names no version and reads nothing, so a getattr
 * of the root never sends a request or reads the index. A backend that lists
 * a parent to answer a miss may ask for the one path instead, since the store
 * is dropped right after.
 *
 * Mirrors Python's `ListingCheckStore`.
 */
export class ListingCheckStore extends RAMIndexCacheStore {
  readonly hintedRows = new Map<string, string>()
  private readonly hints: IndexCacheStore | null

  constructor(options: { hints?: IndexCacheStore } = {}) {
    super()
    this.hints = options.hints ?? null
  }

  /** Offer the mount row as a lead that the backend must confirm live. */
  async hint(vfsPath: string): Promise<FileStat | null> {
    if (this.hints === null) return null
    const entry = (await this.hints.get(vfsPath)).entry ?? null
    if (entry !== null) this.hintedRows.set(vfsPath, JSON.stringify(entry))
    return entry
  }
}
