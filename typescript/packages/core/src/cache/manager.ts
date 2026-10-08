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

import { captureRead } from './context.ts'
import { activeRecords, lineVersion, lostPaths, recordIndex } from '../observe/context.ts'
import { DEFAULT_READ_TTL, type FileStat, PathSpec } from '../types.ts'
import { mountKey } from '../utils/key_prefix.ts'
import { rstripSlash } from '../utils/slash.ts'
import type { FileCache } from './file/mixin.ts'
import type { IndexCacheStore } from './index/store.ts'
import type { Evicted, IndexEntry } from './index/config.ts'
import { CHECKED_LIMIT, LISTING_TRUST_WINDOW, PROBED_LIMIT } from './index/constants.ts'
import { commandStarted, tick } from './index/scope.ts'
import { IndexView } from './index/view.ts'
import { withCacheMutation, latestFingerprint } from './file/io.ts'

/**
 * Default read gate: trust the cache. A manager built outside a workspace
 * has no reconciler to ask.
 */
function alwaysServe(_key: string): Promise<boolean> {
  return Promise.resolve(true)
}

/**
 * Post-mutation cache coherence for one mount.
 *
 * A backend mutation has two cache consequences: the file-cache entry
 * for the path is stale, and the parent directory listing in the index
 * cache (including negative knowledge that the path does not exist) is
 * stale. This class discharges both, synchronously, at the mutation
 * site: core backend mutators report through `cache/context.ts` so
 * invalidation happens before the next command in a pipeline runs
 * instead of after the whole command tree.
 */
export class CacheManager {
  private readonly fileCache: FileCache | null
  private readonly index: IndexCacheStore | null
  private readonly prefix: string
  private readonly cachesReads: boolean
  private readonly ownsPath: (path: string) => boolean
  // The read gate, injected because this class holds no mount and no
  // dispatcher and `cache/context.ts` documents that dependency as one-way.
  // Answers whether a warm entry may still be served.
  private readonly mayServeCached: (key: string) => Promise<boolean>

  private readGeneration = 0
  private view: IndexView | null = null
  // Folder to the tick and the monotonic millisecond its listing was last
  // written at, by any view of this mount, shared or lock-held.
  private readonly written = new Map<string, [number, number]>()
  // Cache key to what the freshness probe got from the backend: its command
  // identity, the read generation then, and the stat.
  private readonly probed = new Map<string, [number, number, FileStat]>()
  private probeBound = PROBED_LIMIT
  // What a listing version check covers (the mount root or a folder) to the
  // version the backend answered, the tick taken just before it was sent and
  // the monotonic millisecond it was sent at.
  private readonly checked = new Map<string, [string, number, number]>()
  // The newest check in flight per key, with its tick and send time.
  private readonly checking = new Map<string, [number, number, Promise<string | null>]>()
  private checkEpoch = 0
  private checkBound = CHECKED_LIMIT

  constructor(
    fileCache: FileCache | null,
    index: IndexCacheStore | null,
    prefix: string,
    cachesReads: boolean,
    ownsPath: (path: string) => boolean = () => true,
    mayServeCached: (key: string) => Promise<boolean> = alwaysServe,
    private readonly readTtl: number = DEFAULT_READ_TTL,
    // Cleanup for a child a re-list found gone, injected for the same
    // one-way reason as the read gate; undefined cleans nothing.
    private readonly onGone?: (gone: readonly Evicted[]) => Promise<void>,
    // The listing gate every view of this mount asks before serving a
    // cached listing; undefined serves them all.
    private readonly mayServeListing?: (folder: string, version: string | null) => Promise<boolean>,
    private readonly excludedPrefixes: () => readonly string[] = () => [],
  ) {
    this.fileCache = fileCache
    this.index = index
    this.prefix = rstripSlash(prefix)
    this.cachesReads = cachesReads
    this.ownsPath = ownsPath
    this.mayServeCached = mayServeCached
  }

  /** Drain raw backend index access before mount cache eviction. */
  withMutation<T>(call: () => Promise<T>): Promise<T> {
    return this.fileCache === null ? call() : withCacheMutation(this.fileCache, call)
  }

  /**
   * Clear the whole backend index while this mount still owns it.
   *
   * The clear that follows native code (an external program, a remote runtime
   * line) that may have changed the mount, so it also retires what the
   * running command's probes saw.
   */
  clearIndex(index: IndexCacheStore | undefined): Promise<void> {
    return this.withMutation(async () => {
      this.retire()
      if (this.ownsPath(this.prefix || '/')) await index?.clear()
    })
  }

  /**
   * Retire every in-flight read and every remembered probe answer.
   *
   * The one step every cache drop takes: a read that began before it must not
   * stamp the cache after it, and a probe answer from before it must not be
   * served after it.
   */
  private retire(): void {
    this.readGeneration += 1
    this.probed.clear()
    this.probeBound = PROBED_LIMIT
  }

  // A re-list found children gone: the backend changed under the command, so
  // nothing its probes saw is safe to serve.
  private async goneLocked(gone: readonly Evicted[]): Promise<void> {
    if (gone.length === 0) return
    this.retire()
    await this.onGone?.(gone)
  }

  /**
   * Bind backend metadata writes to this mount's lifetime.
   *
   * Reuse the view because refill locks are keyed by index identity.
   */
  scopeIndex(index: IndexCacheStore): IndexCacheStore {
    if (this.fileCache === null || index instanceof IndexView) return index
    if (this.view?.store !== index) {
      this.written.clear()
      if (this.view !== null) this.forgetChecks()
      this.view = new IndexView(
        index,
        this.fileCache,
        this.prefix || '/',
        this.ownsPath,
        this.viewOptions(),
      )
    }
    return this.view
  }

  private viewOptions(locked = false): {
    excludedPrefixes: () => readonly string[]
    readTtl: number
    onGone?: (gone: readonly Evicted[]) => Promise<void>
    mayServeListing?: (folder: string, version: string | null) => Promise<boolean>
    noteWritten: (folder: string) => void
  } {
    return {
      readTtl: this.readTtl,
      excludedPrefixes: this.excludedPrefixes,
      onGone: locked
        ? (gone: readonly Evicted[]) => this.goneLocked(gone)
        : (gone: readonly Evicted[]) =>
            this.withMutation(() => this.goneLocked(gone.filter((c) => this.ownsPath(c.path)))),
      ...(this.mayServeListing === undefined ? {} : { mayServeListing: this.mayServeListing }),
      noteWritten: (folder) => {
        this.noteWritten(folder)
      },
    }
  }

  private noteWritten(folder: string): void {
    this.written.set(folder, [tick(), performance.now()])
  }

  /**
   * Whether `folder`'s listing is recent enough to serve under fresh.
   *
   * Inside a command: only if the command wrote it itself, so one command
   * re-lists a folder once however often it reads it. Outside any command
   * (FUSE, a programmatic op) there is no command to belong to, so a listing
   * written within `LISTING_TRUST_WINDOW` seconds is trusted instead: one
   * `ls -l` over FUSE is a burst of calls that can share a re-list until
   * the window expires.
   *
   * Every view of the mount, shared or lock-held, records into one map, so
   * a glob's write counts for the `ls` that follows it.
   */
  listingTrusted(folder: string): boolean {
    const written = this.written.get(folder)
    if (written === undefined) return false
    const [stamp, at] = written
    const started = commandStarted()
    if (started !== null) return stamp > started
    return performance.now() - at < LISTING_TRUST_WINDOW * 1000
  }

  // A check answers only a caller inside its window, so the rest are dead
  // weight; the next prune waits for the map to double.
  private pruneChecks(): void {
    for (const [key, [, sentTick, sentAt]] of this.checked) {
      if (!this.sentRecently(sentTick, sentAt)) this.checked.delete(key)
    }
    this.checkBound = Math.max(CHECKED_LIMIT, 2 * this.checked.size)
  }

  // The versions were checked against listings of the old store, so none of
  // them says anything about the new one. The first view has no old store,
  // and a check may be what builds it.
  private forgetChecks(): void {
    this.checked.clear()
    this.checking.clear()
    this.checkEpoch += 1
  }

  /**
   * Whether a version check is recent enough to answer for the caller.
   *
   * The rule `listingTrusted` applies to listings: inside a command, only a
   * check sent after the command started, since one sent before may predate a
   * change the command must see; outside any command, one sent within
   * `LISTING_TRUST_WINDOW` seconds.
   */
  private sentRecently(sentTick: number, sentAt: number): boolean {
    const started = commandStarted()
    if (started !== null) return sentTick > started
    return performance.now() - sentAt < LISTING_TRUST_WINDOW * 1000
  }

  /**
   * The backend's listing version for `key`, asking at most once.
   *
   * A check recent enough for the caller (`sentRecently`) that answered
   * `stored` is reused, so one command checks a mount once however many of
   * its folders it lists. Otherwise a check in flight that is recent enough
   * is shared, and only then is a new one sent; the newest in flight is the
   * one later callers find. A remembered answer that differs from `stored` is
   * asked again rather than trusted, since the listing may have been written
   * since. `check` answers null when the backend gives no version.
   */
  checkedVersion(
    key: string,
    stored: string,
    check: () => Promise<string | null>,
  ): Promise<string | null> {
    const checked = this.checked.get(key)
    if (checked?.[0] === stored && this.sentRecently(checked[1], checked[2])) {
      return Promise.resolve(checked[0])
    }
    const flight = this.checking.get(key)
    if (flight !== undefined && this.sentRecently(flight[0], flight[1])) return flight[2]
    return this.sendCheck(key, check)
  }

  private sendCheck(key: string, check: () => Promise<string | null>): Promise<string | null> {
    const sentTick = tick()
    const sentAt = performance.now()
    const epoch = this.checkEpoch
    const answer = check().then((version) => {
      const checked = this.checked.get(key)
      // An older check that lands late never replaces a newer one.
      if (version !== null && epoch === this.checkEpoch && (checked?.[1] ?? 0) < sentTick) {
        if (checked === undefined && this.checked.size >= this.checkBound) this.pruneChecks()
        this.checked.set(key, [version, sentTick, sentAt])
      }
      return version
    })
    const flight: [number, number, Promise<string | null>] = [sentTick, sentAt, answer]
    this.checking.set(key, flight)
    const done = (): void => {
      if (this.checking.get(key) === flight) this.checking.delete(key)
    }
    // Each waiter receives the outcome from `answer` itself; this branch only
    // drops the finished check from the map.
    void answer.then(done, done)
    return answer
  }

  /**
   * Remember what the freshness probe got from the backend for `path`.
   *
   * Only the reconciler's probe calls this, and only with an answer it got
   * from the backend, so a stat served from an index row -- which may carry
   * no content token -- never lands here. A path the backend reports gone
   * records nothing: the probe asks the backend only when no answer is
   * servable, so there is nothing left to take back.
   */
  noteProbed(path: PathSpec, stat: FileStat): void {
    const started = commandStarted()
    if (started === null) return
    if (this.probed.size >= this.probeBound) {
      this.pruneProbes(started)
      // What is left is all the running command's; the next prune waits for
      // the map to double, so one large walk stays linear.
      this.probeBound = Math.max(PROBED_LIMIT, 2 * this.probed.size)
    }
    this.probed.set(this.cacheKey(path), [started, this.readGeneration, stat])
  }

  // Only the probing command is ever served an answer, so the other commands'
  // entries are dead weight here.
  private pruneProbes(started: number): void {
    for (const [key, [stamp]] of this.probed) {
      if (stamp !== started) this.probed.delete(key)
    }
  }

  /** Mutation generation, captured before a freshness probe starts. */
  get generation(): number {
    return this.readGeneration
  }

  /**
   * The backend's answer for `path` from this command's probe.
   *
   * A read command stats its own operand after the probe already asked the
   * backend; under fresh, asking again resolves through listings the command
   * has not re-checked, and re-lists every folder on the path. The answer is
   * served only inside the command that probed, and only while no cache drop
   * has landed since: a write in the command (`sed -i`, `> f`), the clear
   * after an external program, and a re-list that found the path gone all
   * retire it (`retire()`), so the next stat goes back to the backend.
   */
  probedStat(path: PathSpec): FileStat | null {
    const probed = this.probed.get(this.cacheKey(path))
    const started = commandStarted()
    if (probed === undefined || started === null) return null
    const [stamp, generation, stat] = probed
    if (stamp !== started || generation !== this.readGeneration) return null
    return stat
  }

  /** Retain a live fallback row only while its predecessor still owns the slot. */
  retainResolvedEntry(
    path: PathSpec,
    generation: number,
    predecessor: string,
    entry: IndexEntry,
  ): Promise<void> {
    const key = this.cacheKey(path)
    return this.withMutation(async () => {
      if (generation !== this.readGeneration || !this.ownsPath(key) || this.index === null) return
      await this.scopeIndexLocked(this.index).replaceIfUnchanged(key, predecessor, entry)
    })
  }

  /**
   * A view for a caller already inside `withMutation`.
   *
   * Never share or retain it beyond that hold. A distinct refill lock
   * avoids lock inversion with readers of the shared view.
   */
  scopeIndexLocked(index: IndexCacheStore): IndexCacheStore {
    if (this.fileCache === null) return index
    if (index instanceof IndexView) {
      throw new Error('scopeIndexLocked needs a raw store; a view would take the lock again')
    }
    return new IndexView(index, this.fileCache, this.prefix || '/', this.ownsPath, {
      locked: true,
      ...this.viewOptions(true),
    })
  }

  /**
   * Drop one directory's cached listing.
   *
   * Both spellings of the directory go, because a backend may have keyed
   * it with or without its trailing slash and an eviction that hits no
   * key is silent.
   */
  private async evictDir(key: string): Promise<void> {
    if (this.index === null) return
    await this.index.invalidateDir(key)
    await this.index.invalidateDir(key + '/')
  }

  /**
   * Cache key for a path, derived rather than inferred.
   *
   * Both caches this class evicts from are keyed by the mount-absolute virtual
   * path, so that is what this returns: the mount prefix still attached, not
   * the mount-relative spelling `mountKey` produces on the way there.
   *
   * Only `virtual` is read, and the key is rebuilt against this manager's own
   * prefix, exactly as `Mount.call` rebuilds one before handing a path to
   * a backend. The caller's `vfsPath` is deliberately ignored: it is not
   * a fact this class can trust, because `PathSpec.fromStrPath` fabricates one
   * ("assumed root-mounted") for any caller that does not know its mount.
   *
   * The earlier version inferred which convention had arrived by comparing the
   * two strings, which cannot be done: under a `/d` mount a mount-relative `/d`
   * and an absolute `/d` are the same characters naming different files.
   * Inferring wrong is quiet rather than loud -- a key one level off simply
   * evicts nothing -- which is why it survived. Deriving asks no question that
   * has no answer.
   *
   * Mirrors Python `CacheManager._cache_key`.
   */
  private cacheKey(path: string | PathSpec): string {
    const virtual = path instanceof PathSpec ? path.virtual : path
    const relative = mountKey(virtual, this.prefix)
    if (relative === '') return this.prefix === '' ? '/' : this.prefix
    return `${this.prefix}/${relative}`
  }

  /** The file cache this manager may read `key` from, if any. */
  private readableCache(key: string): FileCache | null {
    if (!this.cachesReads || !this.ownsPath(key)) return null
    return this.fileCache
  }

  /**
   * Return cached bytes for `path` if present and still valid.
   *
   * Never fetches content from the backend. The single read-cache check the
   * shared read-through wrappers (`cache/read_through.ts`) read through, so
   * warm reads are served from the file cache without the command knowing
   * about it. No-op for local or non-caching mounts.
   *
   * This is the second of the two doors that serve cached bytes, and it is
   * the one every shell read uses; the gate runs the same verdict function
   * as the dispatcher's door, so the two cannot drift apart. Order is
   * load-bearing: `exists` first, so a cold path costs no backend stat, and
   * `get` only after the gate, so a STALE verdict's eviction is not raced by
   * a fetch.
   */
  async cachedBytes(path: PathSpec): Promise<Uint8Array | null> {
    // The key drops a trailing slash; only the backend answers its ENOTDIR.
    if (path.dotted?.endsWith('/') === true) return null
    const key = this.cacheKey(path)
    const cache = this.readableCache(key)
    if (cache === null) return null
    if (!(await cache.exists(key))) return null
    if (!(await this.mayServeCached(key))) return null
    const cached = await cache.get(key)
    return this.ownsPath(key) ? cached : null
  }

  /**
   * Keep `version` for `path` without bytes, if this mount caches: a refused
   * write keeps the version it lost on, so the next write without a read
   * sends it again. A cache that refuses the entry is logged, never thrown:
   * the refusal itself already stands. Mirrors python's `keep_version`.
   */
  async keepVersion(path: PathSpec, version: string): Promise<void> {
    const key = this.cacheKey(path)
    const cache = this.fileCache
    if (cache === null || !this.ownsPath(key)) return
    try {
      await withCacheMutation(cache, () => cache.setVersions({ [key]: version }))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`version not kept for ${key}: ${msg}`)
    }
  }

  /**
   * The version this mount last saw for `path`, null when none. The running
   * line's own records come first, newest first: a read or write earlier in
   * the line names the exact bytes it saw, and a streamed read is not in the
   * cache until the line ends. Then the cached copy's backend token. Mirrors
   * Python's `CacheManager.read_version`.
   */
  async readVersion(path: PathSpec): Promise<string | null> {
    return (await this.readVersions([path]))[0] ?? null
  }

  /** `readVersion` for many paths, asking the cache once. */
  async readVersions(paths: readonly PathSpec[]): Promise<(string | null)[]> {
    const out: (string | null)[] = paths.map(() => null)
    const pending: [number, string][] = []
    const records = activeRecords()
    const lost = lostPaths(records)
    const index = records !== undefined ? recordIndex(records) : undefined
    paths.forEach((path, i) => {
      const key = this.cacheKey(path)
      if (index !== undefined) {
        const [known, version] = lineVersion(index, lost, key)
        if (known) {
          out[i] = version
          return
        }
      }
      if (this.fileCache !== null && this.ownsPath(key)) pending.push([i, key])
    })
    if (pending.length > 0 && this.fileCache !== null) {
      const tokens = await this.fileCache.fingerprints(pending.map(([, key]) => key))
      pending.forEach(([i], j) => {
        out[i] = tokens[j] ?? null
      })
    }
    return out
  }

  /** Cache a complete backend read before a consumer transforms it. */
  async readThrough(path: PathSpec, fetch: () => Promise<Uint8Array>): Promise<Uint8Array> {
    const cached = await this.cachedBytes(path)
    if (cached !== null) return cached
    return this.fill(path, fetch)
  }

  /**
   * Run a cold whole-file read and keep its bytes for the next one.
   *
   * The fill half of `readThrough`, for a door that probed the cache
   * itself (the dispatcher's). A write that lands while the fetch runs
   * retires the generation, so the bytes it read are not kept; an answer
   * that is not bytes is returned and kept nowhere. `keep`, when given, is
   * asked after the fetch with the cache's mutation lock held and has the
   * last say over whether the bytes are kept; the dispatcher passes "no
   * renderer resolves for the read". It must be synchronous; omitted, the
   * bytes are kept. Mirrors Python's `CacheManager.fill`.
   */
  async fill<T>(path: PathSpec, fetch: () => Promise<T>, keep?: () => boolean): Promise<T> {
    const generation = this.readGeneration
    const records = activeRecords()
    const start = records?.length ?? 0
    const key = this.cacheKey(path)
    const [data, facts] = await captureRead(key, fetch)
    if (!(data instanceof Uint8Array)) return data
    const cache = this.readableCache(key)
    if (cache !== null && data.byteLength <= cache.cacheLimit) {
      await withCacheMutation(cache, async () => {
        if (
          this.ownsPath(key) &&
          generation === this.readGeneration &&
          (keep === undefined || keep())
        ) {
          let fingerprint = latestFingerprint(records?.slice(start), key)
          if (facts.length > 0) {
            fingerprint = facts.every((fp) => fp === facts[0]) ? (facts[0] ?? null) : null
          }
          try {
            await cache.set(key, data, { fingerprint, ttl: this.readTtl })
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            console.warn(`cache fill refused for ${key}: ${msg}`)
          }
        }
      })
    }
    return data
  }

  /**
   * Return the cached render's byte length, without revalidating.
   *
   * The size backfill a render-dependent backend cannot answer for itself
   * (`generic_bind/factory.ts`) runs only where the backend reported no
   * size, which is exactly the API mounts, so gating it would turn a stat
   * into a backend stat. It answers a length rather than content, so nothing
   * can serve unverified bytes through it.
   */
  async cachedSize(path: PathSpec): Promise<number | null> {
    const key = this.cacheKey(path)
    const cache = this.readableCache(key)
    if (cache === null) return null
    const cached = await cache.get(key)
    return cached === null ? null : cached.length
  }

  /** Invalidate caches after a write to `path`; only `virtual` is read. */
  async invalidateAfterWrite(path: string | PathSpec): Promise<void> {
    const key = await this.invalidatePath(path)
    await this.invalidateParent(key)
  }

  /** Invalidate caches after a deletion of `path`; only `virtual` is read. */
  async invalidateAfterUnlink(path: string | PathSpec): Promise<void> {
    const key = await this.invalidatePath(path)
    await this.invalidateRemoved(key)
  }

  /**
   * Drop `path` and everything cached beneath it.
   *
   * Two callers, one shape. A push notification often says only which folder
   * moved, and a recursive delete or a directory rename takes a whole tree
   * with it; either way the listings and bodies below the path were cached
   * independently, so evicting the path and its parent leaves stale entries
   * one level down. The cheaper `invalidateAfterWrite` cannot be widened to do
   * this, because it also runs on every ordinary write, where a file has no
   * subtree to drop.
   *
   * Mirrors Python `CacheManager.invalidate_subtree`.
   */
  async invalidateSubtree(path: string | PathSpec): Promise<void> {
    const key = await this.invalidatePath(path)
    await this.dropBelow(key)
    await this.invalidateRemoved(key)
  }

  /**
   * Invalidate caches after `path` was removed, folder or file.
   *
   * For a remover that cannot say which it removed: a watched DELETE, or the
   * vacated side of a MOVE, names a path and nothing more. A folder needs what
   * was cached beneath it dropped, since each nested listing and body was
   * cached under its own key. Every removal retires this manager's reads. The
   * subtree drop additionally invalidates the file store's pending fills and,
   * on a Redis file cache, scans the whole keyspace, which a plain file must
   * not pay on every event. So the index is asked whether a listing
   * is still cached at the path or under it, and only then does the subtree go;
   * otherwise this is `invalidateAfterUnlink`.
   *
   * The body goes before the index is asked, so an index that cannot answer
   * still leaves the removed file unserved. The own and parent listing
   * evictions are attempted even if the probe or subtree drop fails; failures
   * remain visible to the caller. A folder with no listing cached at
   * or under it keeps any bodies cached beneath it until their ttl: nothing
   * there was listed, or every such listing was evicted since. Each event
   * evicts the listing of the changed path's folder and of every folder above
   * it, not their other subfolders, and a write evicts at least its own
   * folder's listing. Without an index no listing is known, so a removal reads
   * as a file and bodies beneath it stay until their ttl.
   *
   * Mirrors Python `CacheManager.invalidate_after_remove`.
   */
  async invalidateAfterRemove(path: string | PathSpec): Promise<void> {
    const key = await this.invalidatePath(path)
    try {
      if (this.index !== null && (await this.index.holdsSubtree(key))) await this.dropBelow(key)
    } catch (error) {
      try {
        await this.invalidateRemoved(key)
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'removal invalidation and cleanup failed')
      }
      throw error
    }
    await this.invalidateRemoved(key)
  }

  /**
   * Evict the listing of every directory above `path`'s parent.
   *
   * `invalidateAfterWrite` refreshes the immediate parent only. A keyed store
   * materializes every missing level of a key in a single put, so the listings
   * further up gained entries too and would keep serving the pre-write view
   * until the index TTL expires. A backend with real directories cannot gain a
   * level that way, so there this is a handful of spare evictions.
   */
  async invalidateAncestors(path: string | PathSpec): Promise<void> {
    if (this.index === null) return
    const key = this.cacheKey(path)
    let parent = key.slice(0, Math.max(key.lastIndexOf('/'), 0))
    while (parent !== '' && parent !== this.prefix) {
      parent = parent.slice(0, Math.max(parent.lastIndexOf('/'), 0))
      await this.evictDir(parent === '' ? '/' : parent)
    }
  }

  /**
   * Drop every cached body under this mount, path unspecified.
   *
   * For a mutation that names no path: an account CLI writes to its service by
   * id, so nothing here can say which file changed, only that this mount's
   * bytes may no longer match the service. Clearing the listing alone is not
   * enough, because an already-read body is served warm and would keep
   * answering with the pre-write content.
   *
   * Over-evicts when this mount is the root and another mount sits beneath it,
   * since keys are compared by prefix. That costs a refetch, which is the safe
   * direction to be wrong in.
   */
  async dropPrefix(): Promise<void> {
    this.retire()
    if (!this.cachesReads || this.fileCache === null) return
    await this.fileCache.evictPrefix(this.prefix + '/')
  }

  private async invalidatePath(path: string | PathSpec): Promise<string> {
    this.retire()
    const key = this.cacheKey(path)
    if (this.cachesReads && this.fileCache !== null) {
      await this.fileCache.remove(key)
    }
    return key
  }

  private async invalidateRemoved(key: string): Promise<void> {
    await this.evictDir(key)
    await this.invalidateParent(key)
  }

  private async dropBelow(key: string): Promise<void> {
    if (this.cachesReads && this.fileCache !== null) {
      await this.fileCache.evictPrefix(rstripSlash(key) + '/')
    }
    if (this.index !== null) await this.index.invalidatePrefix(key)
  }

  private async invalidateParent(key: string): Promise<void> {
    const lastSlash = key.lastIndexOf('/')
    await this.evictDir(lastSlash > 0 ? key.slice(0, lastSlash) : '/')
  }
}
