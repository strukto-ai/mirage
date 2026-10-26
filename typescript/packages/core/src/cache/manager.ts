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
import type { OpRecord } from '../observe/record.ts'
import { DEFAULT_READ_TTL, FileChangeKind, type FileStat, PathSpec } from '../types.ts'
import { type Clock, SystemClock } from '../utils/clock.ts'
import { mountKey } from '../utils/key_prefix.ts'
import { rstripSlash } from '../utils/slash.ts'
import { drainBudget, type FileCache } from './file/mixin.ts'
import { concat } from '../utils/bytes.ts'
import type { IndexCacheStore } from './index/store.ts'
import type { Evicted } from './index/config.ts'
import { CHECKED_LIMIT, LISTING_TRUST_WINDOW, PROBED_LIMIT } from './index/constants.ts'
import { commandStarted, soleCommandStarted, tick } from './index/scope.ts'
import { IndexView } from './index/view.ts'
import { mutationLock, latestFingerprint } from './file/io.ts'

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
  private readonly clock: Clock
  private readonly prefix: string
  private readonly cachesReads: boolean
  private readonly ownsPath: (path: string) => boolean
  private readGeneration = 0
  private view: IndexView | null = null
  // Folder to the tick, the monotonic millisecond and the command stamp of
  // its listing's last write, by any view of this mount, shared or lock-held.
  private readonly written = new Map<string, [number, number, number | null]>()
  // Cache key to what the freshness probe got from the backend: its command
  // identity, the read generation then, and the stat.
  private readonly probed = new Map<string, [number, number, FileStat]>()
  private probeBound = PROBED_LIMIT
  // What a listing version check covers (the mount root or a folder) to the
  // version the backend answered, the tick taken just before it was sent and
  // the monotonic millisecond it was sent at.
  private readonly checked = new Map<string, [string, number, number]>()
  // The stored version each remembered answer refused, by that answer's tick.
  private readonly refused = new Map<string, [string, number]>()
  // The newest check in flight per key, with its tick and send time.
  private readonly checking = new Map<string, [number, number, Promise<string | null>]>()
  private checkBound = CHECKED_LIMIT

  constructor(
    fileCache: FileCache | null,
    index: IndexCacheStore | null,
    prefix: string,
    cachesReads: boolean,
    ownsPath: (path: string) => boolean = () => true,
    private readonly readTtl: number = DEFAULT_READ_TTL,
    // Cleanup for a child a re-list found gone, injected because this class
    // holds no mount and no dispatcher; undefined cleans nothing.
    private readonly onGone?: (gone: readonly Evicted[]) => Promise<void>,
    // The listing gate every view of this mount asks before serving a
    // cached listing; undefined serves them all.
    private readonly mayServeListing?: (folder: string, version: string | null) => Promise<boolean>,
    private readonly excludedPrefixes: () => readonly string[] = () => [],
    // The managers of the other live mounts of this mount's VFS, whose caches
    // hold the same files under other names.
    private readonly aliases: () => readonly CacheManager[] = () => [],
  ) {
    this.fileCache = fileCache
    this.index = index
    this.clock = index?.clock ?? new SystemClock()
    this.prefix = rstripSlash(prefix)
    this.cachesReads = cachesReads
    this.ownsPath = ownsPath
  }

  private millis(): number {
    return this.clock.monotonic() * 1000
  }

  /** Drain raw backend index access before mount cache eviction. */
  mutation<T>(call: () => Promise<T>): Promise<T> {
    return this.fileCache === null ? call() : mutationLock(this.fileCache, call)
  }

  /**
   * Drop this mount's listings and bodies, path unspecified.
   *
   * For a write that went past the dispatcher, so nothing here can say which
   * file changed, only that this mount may no longer match its backend:
   * native code (an external program, a remote runtime line), an account CLI
   * writing to its service by id, or a mount command writing through its own
   * client. Both caches go, because the two hide different writes: a stale
   * listing hides a create or a delete, a stale body an edit. It also retires
   * what the running command's probes saw.
   *
   * The index is expired rather than cleared, while this mount still owns it:
   * a cleared index reads exactly like one that was never filled, so a
   * backend whose index *is* its listing (github seeds the whole tree once)
   * could not tell the drop from an empty repository. A VFS mounted at
   * several prefixes holds each file under each of them, so the bodies under
   * every alias go too. Over-evicts when this mount is the root and another
   * mount sits beneath it, since keys are compared by prefix; a refetch is
   * the safe direction to be wrong in. Mirrors Python's `CacheManager.drop`.
   *
   * @param bodies drop the bodies too; false when the caller clears the whole
   *   file cache itself.
   */
  drop(bodies = true): Promise<void> {
    return this.mutation(async () => {
      this.retire()
      if (this.ownsPath(this.prefix || '/')) await this.index?.invalidate()
      if (!bodies || !this.cachesReads || this.fileCache === null) return
      for (const manager of [this, ...this.aliases()]) {
        await this.fileCache.remove(manager.prefix || '/', { subtree: true })
      }
    })
  }

  /**
   * Retire every in-flight read and every remembered probe answer.
   *
   * The one step every cache drop takes: a read that began before it must not
   * stamp the cache after it, and a probe answer from before it must not be
   * served after it.
   */
  retire(): void {
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
   * This mount's index, its backend metadata writes bound to the mount's
   * lifetime; null when the mount has none.
   *
   * The view is reused because refill locks are keyed by index identity.
   */
  scopeIndex(): IndexCacheStore | null {
    if (this.fileCache === null || this.index === null) return this.index
    this.view ??= new IndexView(
      this.index,
      this.fileCache,
      this.prefix || '/',
      this.ownsPath,
      this.viewOptions(),
    )
    return this.view
  }

  private viewOptions(locked = false): {
    excludedPrefixes: () => readonly string[]
    readTtl: number
    onGone?: (gone: readonly Evicted[]) => Promise<void>
    mayServeListing?: (folder: string, version: string | null) => Promise<boolean>
    noteWritten: (folder: string) => void
    listedThisCommand: (folder: string) => boolean
  } {
    return {
      readTtl: this.readTtl,
      excludedPrefixes: this.excludedPrefixes,
      onGone: locked
        ? (gone: readonly Evicted[]) => this.goneLocked(gone)
        : (gone: readonly Evicted[]) =>
            this.mutation(() => this.goneLocked(gone.filter((c) => this.ownsPath(c.path)))),
      ...(this.mayServeListing === undefined ? {} : { mayServeListing: this.mayServeListing }),
      noteWritten: (folder) => {
        this.noteWritten(folder)
      },
      listedThisCommand: (folder) => this.listedThisCommand(folder),
    }
  }

  private noteWritten(folder: string): void {
    this.written.set(folder, [tick(), this.millis(), soleCommandStarted()])
  }

  /**
   * Whether the running command fetched `folder`'s listing itself.
   *
   * Stricter than `listingTrusted`: outside a command no listing is the
   * caller's own, and inside one only a listing fetched under the same command
   * stamp is: not one another session fetched meanwhile, nor one a nested
   * `$(...)` or function body fetched. A listing the command fetched stays its
   * own until the command ends, so a long-running command does not see a name
   * another client creates after it listed the folder. Mirrors Python's
   * `listed_this_command`.
   */
  listedThisCommand(folder: string): boolean {
    const written = this.written.get(folder)
    const started = soleCommandStarted()
    return written !== undefined && started !== null && written[2] === started
  }

  /**
   * Whether `folder`'s listing is recent enough to serve under fresh.
   *
   * Inside a command: only if it was fetched since the command started, so
   * one command re-lists a folder once however often it reads it. Outside
   * any command (FUSE, a programmatic op) there is no command to belong to,
   * so a listing fetched within `LISTING_TRUST_WINDOW` seconds is trusted
   * instead: one `ls -l` over FUSE is a burst of calls that can share a
   * re-list until the window expires.
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
    return this.millis() - at < LISTING_TRUST_WINDOW * 1000
  }

  // A check answers only a caller inside its window, so the rest are dead
  // weight; the next prune waits for the map to double.
  private pruneChecks(): void {
    for (const [key, [, sentTick, sentAt]] of this.checked) {
      if (!this.sentRecently(sentTick, sentAt)) this.checked.delete(key)
    }
    for (const [key, [, sentTick]] of this.refused) {
      if (this.checked.get(key)?.[1] !== sentTick) this.refused.delete(key)
    }
    this.checkBound = Math.max(CHECKED_LIMIT, 2 * this.checked.size)
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
    return this.millis() - sentAt < LISTING_TRUST_WINDOW * 1000
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
   * since, unless that answer already refused this same `stored`: nothing
   * about that listing changed. `check` answers null when the backend gives
   * no version.
   */
  async checkedVersion(
    key: string,
    stored: string,
    check: () => Promise<string | null>,
  ): Promise<string | null> {
    const checked = this.checked.get(key)
    if (checked !== undefined && this.sentRecently(checked[1], checked[2])) {
      const refused = this.refused.get(key)
      if (checked[0] === stored || (refused?.[0] === stored && refused[1] === checked[1])) {
        return checked[0]
      }
    }
    const flight = this.checking.get(key)
    const version = await (flight !== undefined && this.sentRecently(flight[0], flight[1])
      ? flight[2]
      : this.sendCheck(key, check))
    const answered = this.checked.get(key)
    if (version !== stored && answered?.[0] === version) {
      this.refused.set(key, [stored, answered[1]])
    }
    return version
  }

  private sendCheck(key: string, check: () => Promise<string | null>): Promise<string | null> {
    const sentTick = tick()
    const sentAt = this.millis()
    const answer = check().then((version) => {
      const checked = this.checked.get(key)
      // An older check that lands late never replaces a newer one.
      if (version !== null && (checked?.[1] ?? 0) < sentTick) {
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
    entry: FileStat,
  ): Promise<void> {
    const key = this.cacheKey(path)
    return this.mutation(async () => {
      const index = this.lockedIndex()
      if (generation !== this.readGeneration || !this.ownsPath(key) || index === null) return
      await index.replaceIfUnchanged(key, predecessor, entry)
    })
  }

  /**
   * A view for a caller already inside `mutation`.
   *
   * Never share or retain it beyond that hold. A distinct refill lock
   * avoids lock inversion with readers of the shared view.
   */
  private lockedIndex(): IndexCacheStore | null {
    if (this.fileCache === null || this.index === null) return this.index
    return new IndexView(this.index, this.fileCache, this.prefix || '/', this.ownsPath, {
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
    return this.name(mountKey(path instanceof PathSpec ? path.virtual : path, this.prefix))
  }

  /** The cache key of a mount-relative `key` (no leading slash) under this mount. */
  private name(key: string): string {
    if (key === '') return this.prefix === '' ? '/' : this.prefix
    return `${this.prefix}/${key}`
  }

  /** The file cache this manager may read `key` from, if any. */
  private readableCache(key: string): FileCache | null {
    if (!this.cachesReads || !this.ownsPath(key)) return null
    return this.fileCache
  }

  /**
   * Keep `version` for `path` without bytes, if this mount caches: a refused
   * write keeps the version it lost on, so the next write without a read
   * sends it again. A cache that refuses the entry is logged, never thrown:
   * the refusal itself already stands. Mirrors Python's `keep_version`.
   */
  async keepVersion(path: PathSpec, version: string): Promise<void> {
    const key = this.cacheKey(path)
    const cache = this.fileCache
    if (cache === null || !this.ownsPath(key)) return
    try {
      await mutationLock(cache, () => cache.keepFingerprints({ [key]: version }))
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

  /**
   * Run a cold whole-file read and keep its bytes for the next one.
   *
   * For the dispatcher, which probed the cache itself. A write that lands
   * while the fetch runs
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
    await this.keep(
      key,
      data,
      () =>
        facts.length > 0
          ? facts.every((fp) => fp === facts[0])
            ? (facts[0] ?? null)
            : null
          : latestFingerprint(records?.slice(start), key),
      this.admits(generation, keep),
    )
    return data
  }

  /**
   * Pass a cold streamed read through and keep its bytes for the next one.
   *
   * The streamed twin of `fill`: the bytes are kept once the last chunk is
   * pulled, under the same rules (a write that lands while the stream runs
   * retires the generation, and `keep` has the last say), labelled with the
   * token this stream's backend recorded (`records`). A stream closed early,
   * or larger than the cache's drain budget, keeps nothing, so the cache never
   * reads past what the caller pulled and never holds more than it could.
   * Mirrors Python's `fill_stream`.
   */
  fillStream(
    path: PathSpec,
    source: AsyncIterable<Uint8Array>,
    records: readonly OpRecord[],
    keep?: () => boolean,
  ): AsyncIterable<Uint8Array> {
    const key = this.cacheKey(path)
    const cache = this.readableCache(key)
    if (cache === null) return source
    return this.filling(cache, key, source, records, keep)
  }

  private async *filling(
    cache: FileCache,
    key: string,
    source: AsyncIterable<Uint8Array>,
    records: readonly OpRecord[],
    keep: (() => boolean) | undefined,
  ): AsyncGenerator<Uint8Array> {
    const generation = this.readGeneration
    const budget = drainBudget(cache)
    let chunks: Uint8Array[] | null = []
    let size = 0
    for await (const chunk of source) {
      if (chunks !== null) {
        size += chunk.byteLength
        chunks = size <= budget ? chunks : null
        chunks?.push(chunk)
      }
      yield chunk
    }
    if (chunks !== null) {
      await this.keep(
        key,
        concat(chunks),
        () => latestFingerprint(records, key),
        this.admits(generation, keep),
      )
    }
  }

  // A cold read's last say: no write landed since it began, and `keep` agrees.
  private admits(generation: number, keep: (() => boolean) | undefined): () => boolean {
    return () => generation === this.readGeneration && (keep === undefined || keep())
  }

  /**
   * Keep a write's bytes for the next read, as a read keeps its own.
   * `fingerprint` is the token the write's backend answered, null when it
   * vouched for none. Mirrors Python's `keep_written`.
   */
  async keepWritten(path: PathSpec, data: Uint8Array, fingerprint: string | null): Promise<void> {
    await this.keep(
      this.cacheKey(path),
      data,
      () => fingerprint,
      () => true,
    )
  }

  /**
   * Store bytes a read or a write settled on, unless they went stale.
   *
   * The one way bytes enter the file cache. The checks run under the cache's
   * mutation lock, so a name this mount stopped owning or caching keeps
   * nothing, nor do bytes `admit` refuses. Bytes over the whole cache limit
   * would evict every warm entry, so the copy held for the key, now stale,
   * goes instead; a store that refuses the bytes (out of memory, a value over
   * its size limit) costs only the next read a fetch, so the refusal is
   * logged, never thrown, and the stale copy goes too. Mirrors Python's
   * `_keep`.
   */
  private async keep(
    key: string,
    data: Uint8Array,
    token: () => string | null,
    admit: () => boolean,
  ): Promise<void> {
    const cache = this.fileCache
    if (cache === null) return
    await mutationLock(cache, async () => {
      if (!(this.cachesReads && this.ownsPath(key) && admit())) return
      try {
        if (data.byteLength > cache.cacheLimit) await cache.remove(key)
        else await cache.set(key, data, { fingerprint: token(), ttl: this.readTtl })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`cache fill refused for ${key}: ${msg}`)
        try {
          await cache.remove(key)
        } catch (dropErr) {
          const why = dropErr instanceof Error ? dropErr.message : String(dropErr)
          console.warn(`stale copy not dropped for ${key}: ${why}`)
        }
      }
    })
  }

  /**
   * Return each cached render's byte length, in path order, without
   * revalidating or fetching the bytes.
   *
   * The size backfill a render-dependent backend cannot answer for itself
   * (the dispatcher's stat) runs only where the backend reported no size,
   * which is exactly the API mounts, so gating it would turn a stat into a
   * backend stat. It answers a length rather than content, so nothing can
   * serve unverified bytes through it.
   */
  async cachedSizes(paths: readonly PathSpec[]): Promise<(number | null)[]> {
    const keys = paths.map((path) => this.cacheKey(path))
    const held = keys.filter((key) => this.readableCache(key) !== null)
    if (held.length === 0 || this.fileCache === null) return keys.map(() => null)
    const got = await this.fileCache.sizes(held)
    const sizes = new Map(held.map((key, i) => [key, got[i] ?? null]))
    return keys.map((key) => sizes.get(key) ?? null)
  }

  /**
   * Whether a read of `path` would be served from the cache, asked of the
   * store without fetching the bytes.
   */
  async isCached(path: PathSpec): Promise<boolean> {
    const key = this.cacheKey(path)
    const cache = this.readableCache(key)
    return cache !== null && (await cache.exists(key))
  }

  /**
   * Drop what a change at `path` made stale, under every name its store has
   * here.
   *
   * One store mounted at several prefixes holds one file under each, so the
   * change lands under every name a live mount of it owns. The kind decides
   * how far down it reaches:
   *
   * - CREATE, UPDATE, and MOVE at its landing: the body, and the path's entry
   *   in its parent's listing. A CREATE that answered its new entry's stat
   *   (`row`) keeps that entry where the parent's listing names it instead, so
   *   a listing of the parent and the next level of a nested create need no
   *   request; a row naming another file (a store that matches names without
   *   case wrote the one it holds) proves nothing, so the parent is listed
   *   again.
   * - DELETE: the body, the path's own listing and its parent entry, and what
   *   is cached beneath it when a listing at or under it is still cached. That
   *   probe is for a remover that cannot say it removed a folder (a notified
   *   DELETE, the vacated side of a MOVE): a folder's nested listings and
   *   bodies were cached under keys of their own, while a plain file must not
   *   pay a subtree drop, which on a Redis file cache scans the whole keyspace.
   *   A remover that knows nothing was below (`leaf`: unlink, rmdir) skips it.
   *   A folder with no listing cached at or under it keeps the bodies cached
   *   beneath it until their ttl.
   * - UNKNOWN: everything cached at and below the path, as a push notification
   *   that names only a folder, a recursive delete or a directory rename needs.
   *
   * Then the path's ancestors drop their entries in their parents' listings: a
   * keyed store materializes every missing level of a key in one put, so those
   * listings gained entries too. Each affected listing becomes partial and
   * keeps its unaffected siblings. Every change retires this mount's in-flight
   * reads and probe answers, all but `probed`. Mirrors Python's
   * `CacheManager.invalidate`.
   *
   * @param path the changed path; only `virtual` is read.
   * @param kind what happened, which decides the reach.
   * @param row a CREATE's new entry, kept in its parent's listing; null drops
   *   that entry.
   * @param options.leaf a DELETE whose remover knows nothing was below the path.
   * @param options.probed the backend's answer the change was found by, which
   *   this command's probe keeps serving for `path` (`probedStat`) past the
   *   retire.
   * @param options.own only this mount's name, as a freshness probe drops what
   *   it found: the store's other names answer to their own mount's read
   *   policy.
   */
  async invalidate(
    path: string | PathSpec,
    kind: FileChangeKind,
    row: FileStat | null = null,
    options: { leaf?: boolean; probed?: FileStat | null; own?: boolean } = {},
  ): Promise<void> {
    const key = mountKey(path instanceof PathSpec ? path.virtual : path, this.prefix)
    for (const manager of options.own === true ? [this] : [this, ...this.aliases()]) {
      const name = manager.name(key)
      if (manager === this || manager.ownsPath(name)) {
        await manager.invalidateKey(
          name,
          kind,
          row,
          options.leaf === true,
          manager === this ? (options.probed ?? null) : null,
        )
      }
    }
  }

  // The ancestors go even when the path's own invalidation fails; a failure of
  // both throws both.
  private async invalidateKey(
    key: string,
    kind: FileChangeKind,
    row: FileStat | null,
    leaf: boolean,
    probed: FileStat | null,
  ): Promise<void> {
    try {
      await this.invalidateOwn(key, kind, row, leaf, probed)
    } catch (error) {
      try {
        await this.invalidateAncestors(key)
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'invalidation and ancestor cleanup failed')
      }
      throw error
    }
    await this.invalidateAncestors(key)
  }

  private async invalidateOwn(
    key: string,
    kind: FileChangeKind,
    row: FileStat | null,
    leaf: boolean,
    probed: FileStat | null,
  ): Promise<void> {
    this.retire()
    const started = commandStarted()
    if (probed !== null && started !== null) {
      this.probed.set(key, [started, this.readGeneration, probed])
    }
    if (this.cachesReads && this.fileCache !== null) await this.fileCache.remove(key)
    if (kind === FileChangeKind.UNKNOWN) {
      await this.dropBelow(key)
      await this.invalidateRemoved(key)
    } else if (kind === FileChangeKind.DELETE) {
      await this.removed(key, leaf)
    } else if (
      kind === FileChangeKind.CREATE &&
      row !== null &&
      row.name === key.slice(key.lastIndexOf('/') + 1)
    ) {
      await this.index?.addEntry(
        key,
        row,
        new Date(this.index.clock.now() * 1000 + this.readTtl * 1000),
      )
    } else {
      await this.index?.invalidateEntry(key)
    }
  }

  // The body went before the index is asked, so an index that cannot answer
  // still leaves the removed file unserved; the own and parent invalidations
  // run even when the probe or the subtree drop fails.
  private async removed(key: string, leaf: boolean): Promise<void> {
    try {
      if (!leaf && this.index !== null && (await this.index.holdsSubtree(key))) {
        await this.dropBelow(key)
      }
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

  private async invalidateAncestors(key: string): Promise<void> {
    let parent = key.slice(0, Math.max(key.lastIndexOf('/'), 0))
    while (this.index !== null && parent !== '' && parent !== this.prefix) {
      await this.index.invalidateEntry(parent)
      parent = parent.slice(0, Math.max(parent.lastIndexOf('/'), 0))
    }
  }

  private async invalidateRemoved(key: string): Promise<void> {
    await this.evictDir(key)
    await this.index?.invalidateEntry(key)
  }

  private async dropBelow(key: string): Promise<void> {
    if (this.cachesReads && this.fileCache !== null) {
      await this.fileCache.remove(key, { subtree: true, excluded: this.excludedPrefixes() })
    }
    if (this.index !== null) await this.index.invalidatePrefix(key, this.excludedPrefixes())
  }
}
