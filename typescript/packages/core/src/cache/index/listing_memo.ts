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

import { FileStat } from '../../types.ts'
import type { Clock } from '../../utils/clock.ts'
import type { ListResult } from './config.ts'
import { LISTING_TRUST_WINDOW, ROW_READ_BATCH } from './constants.ts'
import { soleCommandStarted } from './scope.ts'

const WRITES_BY_PREFIX = new Map<string, number>()
const ROW_WRITES_BY_PREFIX = new Map<string, number>()
// Each row written within the last window, with its write count and time.
const ROWS_WRITTEN_BY_PREFIX = new Map<string, Map<string, { count: number; at: number }>>()
const HOLDERS_BY_PREFIX = new Map<string, number>()

interface Read {
  readonly writesBefore: number
  readonly readAt: number
  readonly expiresAt: number
  readonly listing: ListResult
  rowWrites: number
  readonly rows: Map<string, FileStat | null>
  // Where each listed key sits, built on the first lookup of one.
  positions: Map<string, number> | null
}

function positions(kept: Read): ReadonlyMap<string, number> {
  const keys = kept.listing.entries ?? kept.listing.partialEntries ?? []
  kept.positions ??= new Map(keys.map((key, at) => [key, at]))
  return kept.positions
}

/**
 * A listing as `read` answers it: a kept one copied, so a caller's edit never
 * reaches it, or, given `child`, narrowed to that key where it is listed.
 */
function answer(listing: ListResult, child: string | undefined, kept: Read | null): ListResult {
  if (child === undefined && kept === null) return listing
  const named =
    child !== undefined &&
    (kept === null
      ? (listing.entries ?? listing.partialEntries ?? []).includes(child)
      : positions(kept).has(child))
  const keys = (entries: string[]): string[] =>
    child === undefined ? [...entries] : named ? [child] : []
  const copy = { ...listing }
  if (copy.entries != null) copy.entries = keys(copy.entries)
  if (copy.partialEntries != null) copy.partialEntries = keys(copy.partialEntries)
  return copy
}

/**
 * The listings one store read for the running commands.
 *
 * A read is served again only to the command that made it, only while no
 * listing write to the key prefix has finished since the read began, for
 * under LISTING_TRUST_WINDOW seconds, and never past the listing's own
 * expiry. Row reads batch at most ROW_READ_BATCH siblings and share this
 * lifetime, a row the batch did not find is left to a lookup of its own,
 * and a row-only write drops that row alone. Each fill drops the oldest
 * reads no command can be served any more, so a read stays held for about
 * one window. The key prefix's write count lives while an open memo holds
 * the prefix. On the fallback storage, while more than one command is live,
 * there is no sole stamp and every read goes to Redis.
 */
export class ListingMemo {
  private readonly reads = new Map<string, Read>()
  private closed = false

  /**
   * @param keyPrefix the store's key prefix, whose writes count.
   * @param clock the store's clock, whose wall time a listing's expiry is
   *   compared with.
   */
  constructor(
    private readonly keyPrefix: string,
    private readonly clock: Clock,
  ) {
    HOLDERS_BY_PREFIX.set(keyPrefix, (HOLDERS_BY_PREFIX.get(keyPrefix) ?? 0) + 1)
  }

  private written(): number {
    return WRITES_BY_PREFIX.get(this.keyPrefix) ?? 0
  }

  private live(kept: Read): boolean {
    return (
      kept.writesBefore === this.written() &&
      performance.now() - kept.readAt < LISTING_TRUST_WINDOW * 1000 &&
      this.clock.now() < kept.expiresAt
    )
  }

  /**
   * A folder's listing, read from Redis at most once per command.
   *
   * @param folder the listed folder's key.
   * @param fetch reads the listing from Redis and answers it with its
   *   expiry, or with null when there is no live listing to keep.
   * @param child the one key a lookup asks about, to narrow the entries to.
   */
  async read(
    folder: string,
    fetch: () => Promise<[ListResult, number | null]>,
    child?: string,
  ): Promise<ListResult> {
    const stamp = soleCommandStarted()
    if (stamp === null) return answer((await fetch())[0], child, null)
    const key = `${String(stamp)}:${folder}`
    const kept = this.reads.get(key)
    if (kept !== undefined && this.live(kept)) return answer(kept.listing, child, kept)
    const writes = this.written()
    const readAt = performance.now()
    const [listing, expiresAt] = await fetch()
    if (expiresAt === null || this.written() !== writes || soleCommandStarted() !== stamp) {
      return answer(listing, child, null)
    }
    for (const [held, read] of this.reads) {
      if (this.live(read)) break
      this.reads.delete(held)
    }
    const read: Read = {
      writesBefore: writes,
      readAt,
      expiresAt,
      listing,
      rowWrites: -1,
      rows: new Map(),
      positions: null,
    }
    this.reads.delete(key)
    this.reads.set(key, read)
    return answer(listing, child, read)
  }

  /** Batch a listed row with its siblings within the listing's lifetime. */
  async row(
    path: string,
    fetch: (paths: readonly string[]) => Promise<Map<string, FileStat>>,
  ): Promise<FileStat | null> {
    const stamp = soleCommandStarted()
    if (stamp === null) return null
    const folder = path.slice(0, path.lastIndexOf('/')) || '/'
    const key = `${String(stamp)}:${folder}`
    const kept = this.reads.get(key)
    if (kept === undefined || !this.live(kept)) return null
    const writes = ROW_WRITES_BY_PREFIX.get(this.keyPrefix) ?? 0
    if (kept.rowWrites !== writes) {
      for (const [done, write] of ROWS_WRITTEN_BY_PREFIX.get(this.keyPrefix) ?? []) {
        if (write.count > kept.rowWrites) kept.rows.delete(done)
      }
      kept.rowWrites = writes
    }
    let row = kept.rows.get(path)
    if (row === undefined) {
      const position = positions(kept).get(path)
      if (position === undefined) return null
      const paths = kept.listing.entries ?? kept.listing.partialEntries ?? []
      const start = Math.floor(position / ROW_READ_BATCH) * ROW_READ_BATCH
      const missing = paths.slice(start, start + ROW_READ_BATCH).filter((p) => !kept.rows.has(p))
      const fetched = await fetch(missing)
      if (
        this.live(kept) &&
        (ROW_WRITES_BY_PREFIX.get(this.keyPrefix) ?? 0) === writes &&
        soleCommandStarted() === stamp
      ) {
        for (const p of missing) kept.rows.set(p, fetched.get(p) ?? null)
      }
      row = fetched.get(path) ?? null
    }
    return row === null ? null : new FileStat(structuredClone(row))
  }

  /** Count a finished write of one row, keeping its siblings' reads. */
  rowWrote(path: string): void {
    const count = (ROW_WRITES_BY_PREFIX.get(this.keyPrefix) ?? 0) + 1
    ROW_WRITES_BY_PREFIX.set(this.keyPrefix, count)
    let written = ROWS_WRITTEN_BY_PREFIX.get(this.keyPrefix)
    if (written === undefined) {
      written = new Map()
      ROWS_WRITTEN_BY_PREFIX.set(this.keyPrefix, written)
    }
    const at = performance.now()
    written.delete(path)
    written.set(path, { count, at })
    for (const [held, write] of written) {
      if (at - write.at < LISTING_TRUST_WINDOW * 1000) break
      written.delete(held)
    }
  }

  /** Runs `fn` and counts a listing write once it is over, whether it threw or not. */
  async writing<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } finally {
      this.wrote()
    }
  }

  /** Counts a finished listing write to the key prefix. */
  wrote(): void {
    WRITES_BY_PREFIX.set(this.keyPrefix, this.written() + 1)
  }

  /**
   * Drops the kept listings and releases the key prefix. The last open memo
   * on a prefix drops its write count, so a host that cycles through
   * prefixes keeps none it no longer uses.
   */
  close(): void {
    this.reads.clear()
    if (this.closed) return
    this.closed = true
    const holders = (HOLDERS_BY_PREFIX.get(this.keyPrefix) ?? 0) - 1
    if (holders > 0) {
      HOLDERS_BY_PREFIX.set(this.keyPrefix, holders)
      return
    }
    HOLDERS_BY_PREFIX.delete(this.keyPrefix)
    WRITES_BY_PREFIX.delete(this.keyPrefix)
    ROW_WRITES_BY_PREFIX.delete(this.keyPrefix)
    ROWS_WRITTEN_BY_PREFIX.delete(this.keyPrefix)
  }
}
