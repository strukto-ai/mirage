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

import { type Accessor, NOOPAccessor } from '../accessor/base.ts'
import type { IndexCacheStore } from '../cache/index/store.ts'
import type { PredNode } from '../core/generic/find_eval.ts'
import type { Command } from '../commands/config.ts'
import { enotsup } from '../errors/fs.ts'
import type { CapacityResult, FileStat, JsonValue, PathSpec, SetAttrFields } from '../types.ts'
import { CapacityState, ListingVersion } from '../types.ts'
import { DEFAULT_MAX_GLOB_MATCHES } from '../utils/glob_walk.ts'
import type { DeltaHook } from '../watch/base.ts'
import { vfsCall } from './call.ts'
import { DEFAULT_MAX_DU_ENTRIES } from './constants.ts'
import { type DuEntries, Effect, type SearchQuery, Target } from './types.ts'

export interface FindOptions {
  name?: string | null
  type?: string | null
  minSize?: number | null
  maxSize?: number | null
  maxDepth?: number | null
  minDepth?: number | null
  nameExclude?: string | null
  orNames?: string[] | null
  iname?: string | null
  pathPattern?: string | null
  empty?: boolean | null
  tree?: PredNode | null
  mtimeMin?: number | null
  mtimeMax?: number | null
}

/**
 * The two keys the snapshot machinery reads out of a VFS's state.
 *
 * `type` is the registry name, and it is what rebuilds the VFS:
 * Python's `_vfs_class_for` looks it up in the registry first and
 * only falls back to the mount's `vfs_class` import path when it
 * misses. `config` is what `vfsStateRequiresOverride` scans for the
 * `<REDACTED>` marker, which is what makes load demand a fresh config
 * instead of silently substituting an empty mount.
 *
 * This lived as a private interface in `workspace/snapshot/types.ts`,
 * where `VFSState` still widens it with each backend's own keys; it
 * moved here so the `BaseVFS` contract and the snapshot format name
 * one shape rather than two identical ones. Python needs no such type —
 * `get_state` is annotated `dict[str, Any]` — but a TS interface is not
 * assignable to `Record<string, unknown>` (no implicit index signature),
 * so the literal twin would reject every named `XVFSState`.
 */
export interface VFSStateBase {
  type: string
  config?: unknown
  // Set by a backend whose mount cannot be rebuilt from this state alone,
  // so `Workspace.load` asks for the live VFS back instead of
  // rebuilding one. See `vfsStateRequiresOverride`.
  needs_override?: boolean
}

// The accessor a driver that brings none runs over: the default Python's
// `BaseVFS.accessor` class attribute carries too, so a mount and a caller
// never branch on its absence.
const NO_ACCESSOR = new NOOPAccessor()

/**
 * The brand every driver carries, keyed through the symbol registry so a
 * script file that loaded its own copy of this package still passes the
 * loader's check: the class identity may differ, the brand does not.
 */
export const VFS_BRAND: unique symbol = Symbol.for('mirage.BaseVFS')

/**
 * The facts a subclass that does not declare them as members hands the
 * constructor. Every field is optional, so a class that declares its facts
 * as members calls `super()` bare. Mirrors the keyword arguments of
 * Python's `BaseVFS.__init__`.
 */
export interface VFSOptions<A extends Accessor = Accessor> {
  /**
   * VFS name commands register under, and the `type` key `getState`
   * writes into a snapshot. Also the registry key when the backend is
   * exposed through `registerVfsFactory`.
   */
  name?: string
  /** Backend handle the functions use. */
  accessor?: A
  /** LLM-facing description of the mounted layout. */
  prompt?: string
  /** Appended to `prompt` when the mount is writable. */
  writePrompt?: string
  /**
   * Generic command names the backend replaces. Pass the replacements
   * through `commands`.
   */
  overrides?: ReadonlySet<string>
  /**
   * Extra commands, from `command({...})`: bespoke verbs, or the
   * replacements for whatever `overrides` suppressed.
   */
  commands?: readonly Command[]
  /** Serve repeat reads from the file cache. Read-mostly content only. */
  cachesReads?: boolean
  /**
   * Whether `stat` sizes every regular file without fetching it, which is
   * also what makes the mount legal on FSKit.
   */
  sizesAlwaysKnown?: boolean
  /**
   * Whether `stat` fills `FileStat.fingerprint` with a stable per-path
   * version marker. Setting it without that is not drift detection.
   */
  supportsSnapshot?: boolean
  /**
   * Whether `stat` and the read record stamp the *same kind* of content
   * token, so a `read: fresh` mount can compare them. Setting it without
   * that makes every read verdict stale; a mount declaring `fresh` on a
   * backend that leaves it false is refused.
   */
  readRevalidatable?: boolean
}

/**
 * A backend: an accessor, the facts about it, and its functions.
 *
 * A VFS answers `readdir`, `read` and `stat`; every other function
 * (`write`, `unlink`, `readStream`, a native `find` or `search`, ...) is
 * optional, and a VFS answers exactly the ones it defines. Every generic
 * shell command (`ls`, `cat`, `grep`, `find`, `head`, `wc`, ...) runs on
 * the three required ones, and a line that needs a function the VFS does
 * not define answers `Operation not supported` at that call, so `gzip -c`
 * and `tar -t` still run as readers on a read-only backend. A method
 * marked `@vfsCall` is also reachable by name through the dispatcher
 * (`ws.dispatch('search_abc', path)`), with every check the door runs; the
 * built-in ones are marked here, and an override keeps the mark.
 *
 * Everything a tree needs to run one (the placement, the index store, the
 * registered commands, the reference it was built from) lives on the
 * mount, so an author never sees it.
 *
 * Snapshots and versions see one of two things, and a subclass picks
 * which by what it owns. Content the VFS holds itself (an in-memory
 * store) is mirage-owned state: override `getState` and `loadState` to
 * carry it, register the class under its name, and a snapshot or a
 * version rebuilds the mount with that content and no override. Content
 * that lives in a remote service is only observed: keep the default
 * state, set `supportsSnapshot` and fill `FileStat.fingerprint`, and a
 * snapshot pins what it read while `Workspace.load` asks for the live VFS
 * back. Mirrors Python's `BaseVFS`.
 */
export class BaseVFS<A extends Accessor = Accessor> {
  readonly [VFS_BRAND] = true as const
  readonly name: string = 'base'
  readonly prompt: string = ''
  readonly writePrompt: string = ''
  readonly indexTtl: number = 600
  /**
   * Whether reads of this VFS may be served from / written to the
   * local file cache. A network-backed VFS whose content is read-mostly
   * (e.g. object storage) sets this to true so reads can be cached; a
   * VFS whose content is live (e.g. a database collection) leaves it
   * false so reads always hit the backend and live follows (`tail -f`)
   * are not masked by a cached snapshot.
   */
  readonly cachesReads: boolean = false
  /**
   * Whether this VFS carries enough version information for
   * snapshot+replay drift detection. When true, the driver's `stat` op
   * must populate {@link FileStat.fingerprint}
   * (and optionally {@link FileStat.revision}) with stable per-path
   * markers. When false (the default), reads are treated as live-only
   * at replay time: no fingerprint is captured at snapshot, no drift
   * check fires at load.
   */
  readonly supportsSnapshot: boolean = false
  /**
   * Whether the driver's `stat` op can size every regular file without
   * fetching its content, i.e. {@link FileStat.size} is null only for
   * directories. True for byte stores that keep a length in their
   * metadata (ram, disk, redis, s3, gridfs); false for mounts that
   * render content on read, where the size is unknowable until the bytes
   * exist (slack, gmail, notion, postgres rows.jsonl, dify documents).
   *
   * FUSE does not need this: direct_io + attrTimeout '0' + hydrate-on-open
   * make size-unknown files read correctly anyway. FSKit has no direct_io
   * equivalent, so a mount there is driven entirely by the reported size
   * and a false VFS would serve silent empty files. Mirrors Python's
   * `BaseVFS.sizes_always_known`.
   */
  readonly sizesAlwaysKnown: boolean = false
  /**
   * Whether a `read: fresh` mount can actually be revalidated against this
   * backend: the driver's `stat` op and the read record must stamp the
   * *same kind* of content token, so the gate can compare them with `===`. False
   * (the default) is refused at mount time rather than degraded, because a
   * mount that declares fresh and silently serves bounded is the bug the
   * policy exists to prevent.
   *
   * Distinct from {@link BaseVFS.supportsSnapshot}, which asks whether a
   * token exists at all, and from {@link BaseVFS.cachesReads}, which asks
   * whether the gate can fire. A backend can have a token on both sides
   * and still fail this one, by stamping two different kinds.
   *
   * A declarer must stamp the token on every read, not only while a
   * recorder is active: node's read_revalidatable.test.ts holds each one to
   * that (#1165). onedrive and sharepoint qualify because every unpinned
   * byte read fetches the item's cTag before its bytes, recorded or not; a
   * stream stamps only under a recorder, the one place its token can land.
   *
   * Mirrors Python's `BaseVFS.read_revalidatable`.
   */
  readonly readRevalidatable: boolean = false
  /**
   * What a `read: fresh` mount checks a cached listing against before it
   * lists again: nothing (NONE, the default), one version for the whole mount
   * answered by a stat of its root (MOUNT), or each folder's own version
   * answered by a stat of that folder (FOLDER). A declarer stores with each
   * listing it writes a version no newer than its rows: taken from the same
   * response (github's tree names its head), or read first and the rows then
   * read at it or after it (hf walks the tree at the commit its revision
   * request answered; disk stats a folder before it scans), so a change in
   * between leaves the stored version behind and the next check re-lists.
   * Its `stat` must answer the same kind of token: node's
   * listing_version.test.ts holds each one to that.
   *
   * Mirrors Python's `BaseVFS.listing_version`.
   */
  readonly listingVersion: ListingVersion = ListingVersion.NONE
  /**
   * The version every listing of this mount is pinned at, when its ref names
   * a commit outright (github's full-sha ref; see `pinOf` in
   * vfs/github/github.ts for why that cannot move). A stored listing whose
   * version equals it is served without a check. It depends on the mount's config, so
   * an instance sets it; null pins nothing.
   */
  readonly listingsPin: string | null = null
  /**
   * How many entries a du walk of this mount visits before it stops and
   * reports a partial answer, null for no cap: the command table's own
   * `maxDuEntries`, read by a walk that crosses mounts through the
   * dispatcher, which charges each entry to the mount serving it.
   *
   * Mirrors Python's `BaseVFS.max_du_entries`.
   */
  readonly maxDuEntries: number | null = DEFAULT_MAX_DU_ENTRIES
  /**
   * Whether `read` fetches a byte window from the store itself. When false
   * the caller reads the whole file and slices it, so `read` is only ever
   * handed a window by a VFS that sets this.
   */
  readonly readsRanges: boolean = false
  /**
   * Whether the data lives on the host filesystem, which lets a command
   * aggregate on the host instead of streaming through mirage.
   */
  readonly local: boolean = false
  /** How many paths one glob may expand to before it stops. */
  readonly maxGlobMatches: number = DEFAULT_MAX_GLOB_MATCHES
  /**
   * What `search` supports, read by the consumers that opt in by namespace
   * (`{grep: {mode: 'literal'}}` lets grep and rg use it). Empty means no
   * consumer may assume anything.
   */
  readonly searchMeta: Readonly<Record<string, JsonValue>> = {}
  /**
   * Extensions whose `read` is a rendering rather than the stored bytes,
   * each to the name of the method that renders it, which takes `read`'s
   * arguments, window included. A rendered read is never served from or
   * kept in the file cache, and a `raw` read asks for `read` itself.
   */
  readonly renderers: Readonly<Record<string, string>> = {}
  /** The generic shell commands this VFS replaces with its own. */
  readonly overrides: ReadonlySet<string> = new Set()
  /**
   * The backend handle every function takes. A builtin declares and
   * assigns its own; one that brings none runs over a no-op accessor.
   */
  readonly accessor: A = NO_ACCESSOR as unknown as A

  readonly #commands: readonly Command[]
  #closed = false

  /**
   * Set the facts a subclass does not declare as members. Every option is
   * optional, so a class that declares its facts as members calls
   * `super()` bare.
   */
  constructor(options: VFSOptions<A> = {}) {
    if (options.name !== undefined) {
      if (options.name === '') throw new Error('a VFS needs a non-empty name')
      this.name = options.name
    }
    if (options.accessor !== undefined) this.accessor = options.accessor
    if (options.prompt !== undefined) this.prompt = options.prompt
    if (options.writePrompt !== undefined) this.writePrompt = options.writePrompt
    if (options.overrides !== undefined) this.overrides = new Set(options.overrides)
    if (options.cachesReads !== undefined) this.cachesReads = options.cachesReads
    if (options.sizesAlwaysKnown !== undefined) this.sizesAlwaysKnown = options.sizesAlwaysKnown
    if (options.supportsSnapshot !== undefined) this.supportsSnapshot = options.supportsSnapshot
    if (options.readRevalidatable !== undefined) {
      this.readRevalidatable = options.readRevalidatable
    }
    this.#commands = [...(options.commands ?? [])]
  }

  /**
   * Whether this VFS defines the function `name`. A function the base
   * declares is supported once a subclass or the instance itself replaces
   * it; one only a subclass declares (a custom `@vfsCall`) is supported
   * because it exists.
   */
  supports(name: string): boolean {
    const own: unknown = (this as unknown as Record<string, unknown>)[name]
    return (
      typeof own === 'function' &&
      own !== (BaseVFS.prototype as unknown as Record<string, unknown>)[name]
    )
  }

  /** The bespoke commands this VFS was handed. */
  commands(): readonly Command[] {
    return this.#commands
  }

  /** List the children of a directory. */
  @vfsCall({ effect: Effect.READ, target: Target.DIR })
  readdir(path: PathSpec, _index?: IndexCacheStore): Promise<string[]> {
    return Promise.reject(enotsup(this.name, 'readdir', path))
  }

  /**
   * Read a file's bytes, or a window of them. A window reaches this only
   * when `readsRanges` is set: the caller otherwise reads the whole file
   * and slices it.
   */
  @vfsCall({ effect: Effect.READ, target: Target.FILE })
  read(
    path: PathSpec,
    _index?: IndexCacheStore,
    _offset = 0,
    _size: number | null = null,
  ): Promise<Uint8Array> {
    return Promise.reject(enotsup(this.name, 'read', path))
  }

  /** Describe a path; rejects with ENOENT when nothing is there. */
  @vfsCall({ effect: Effect.METADATA })
  stat(path: PathSpec, _index?: IndexCacheStore): Promise<FileStat> {
    return Promise.reject(enotsup(this.name, 'stat', path))
  }

  /**
   * Stream a file's bytes as the caller pulls them. A VFS that does not
   * define it is read whole instead.
   */
  readStream(path: PathSpec, _index?: IndexCacheStore): AsyncIterable<Uint8Array> {
    throw enotsup(this.name, 'readStream', path)
  }

  /** Whether anything is at `path`; derived from `stat` when not defined. */
  exists(path: PathSpec): Promise<boolean> {
    return Promise.reject(enotsup(this.name, 'exists', path))
  }

  /** Answer `find` natively instead of walking `readdir`. */
  find(path: PathSpec, _options: FindOptions, _index?: IndexCacheStore): Promise<string[]> {
    return Promise.reject(enotsup(this.name, 'find', path))
  }

  /**
   * The recursive byte total under `path`, natively. Native `du` is both
   * `duSize` and `duEntries`: the generic derives its per-directory rows
   * from the entries, so one without the other is not served.
   */
  duSize(path: PathSpec, _index?: IndexCacheStore): Promise<number> {
    return Promise.reject(enotsup(this.name, 'du', path))
  }

  /**
   * Every stored file under `path` with its size, natively. A native answer
   * comes from one pass over the stored files, so a directory holding no
   * file never appears in the entries and gets no row, where the shared
   * readdir walk prints its `0` row. The difference is accepted for the
   * speed and pinned in `integ/unix/du/empty.json`.
   */
  duEntries(path: PathSpec, _index?: IndexCacheStore): Promise<DuEntries> {
    return Promise.reject(enotsup(this.name, 'du', path))
  }

  /** Replace a file's bytes, creating it when missing. */
  @vfsCall({ effect: Effect.WRITE, target: Target.FILE, creates: true })
  write(path: PathSpec, _data: Uint8Array): Promise<void> {
    return Promise.reject(enotsup(this.name, 'write', path))
  }

  /**
   * Add bytes to the end of a file, creating it when missing. A VFS that
   * defines `write` and not this is appended to by reading the file and
   * writing it back.
   */
  @vfsCall({ effect: Effect.WRITE, target: Target.FILE, creates: true })
  append(path: PathSpec, _data: Uint8Array, _index?: IndexCacheStore): Promise<void> {
    return Promise.reject(enotsup(this.name, 'append', path))
  }

  /**
   * Write bytes at an offset, keeping every byte outside them. As
   * pwrite(2): a gap past the end reads back as zeros and a missing file
   * is created. A VFS that defines `write` and not this is written by
   * reading the file and writing it back.
   */
  @vfsCall({ effect: Effect.WRITE, target: Target.FILE, creates: true })
  pwrite(
    path: PathSpec,
    _data: Uint8Array,
    _offset: number,
    _index?: IndexCacheStore,
  ): Promise<void> {
    return Promise.reject(enotsup(this.name, 'pwrite', path))
  }

  /** Create an empty file, leaving an existing one as it is. */
  @vfsCall({ effect: Effect.WRITE, target: Target.FILE, creates: true })
  create(path: PathSpec): Promise<void> {
    return Promise.reject(enotsup(this.name, 'create', path))
  }

  /** Make a directory; `parents` makes missing parents too, as `mkdir -p`. */
  @vfsCall({ effect: Effect.CREATE, target: Target.DIR })
  mkdir(path: PathSpec, _parents = false): Promise<void> {
    return Promise.reject(enotsup(this.name, 'mkdir', path))
  }

  /** Remove a file. */
  @vfsCall({ effect: Effect.REMOVE, target: Target.FILE })
  unlink(path: PathSpec): Promise<void> {
    return Promise.reject(enotsup(this.name, 'unlink', path))
  }

  /**
   * Remove an empty directory. The index is the mount's, which a refused
   * rmdir's hidden-remnant walk lists through.
   */
  @vfsCall({ effect: Effect.REMOVE, target: Target.DIR })
  rmdir(path: PathSpec, _index?: IndexCacheStore): Promise<void> {
    return Promise.reject(enotsup(this.name, 'rmdir', path))
  }

  /** Remove a subtree in one call instead of entry by entry. */
  rmR(path: PathSpec): Promise<void> {
    return Promise.reject(enotsup(this.name, 'rmR', path))
  }

  /** Move a name within this VFS. */
  @vfsCall({ effect: Effect.RENAME })
  rename(src: PathSpec, _dst: PathSpec): Promise<void> {
    return Promise.reject(enotsup(this.name, 'rename', src))
  }

  /** Copy a file within this VFS without moving its bytes through mirage. */
  copy(_src: PathSpec, dst: PathSpec): Promise<void> {
    return Promise.reject(enotsup(this.name, 'copy', dst))
  }

  /** Copy a directory tree within this VFS in one call. */
  dirCopy(_src: PathSpec, dst: PathSpec): Promise<void> {
    return Promise.reject(enotsup(this.name, 'dirCopy', dst))
  }

  /**
   * Resize a file, padding with zeros or cutting the end. `noCreate`
   * refuses a missing file instead of creating it; a VFS that cannot hold
   * that atomically rejects with ENOTSUP before writing.
   */
  @vfsCall({ effect: Effect.WRITE, target: Target.FILE, creates: true })
  truncate(path: PathSpec, _length: number, _noCreate = false): Promise<void> {
    return Promise.reject(enotsup(this.name, 'truncate', path))
  }

  /**
   * Store metadata fields the backend keeps itself. Resolves to the fields
   * it stored; the rest land in the namespace's attribute overlay.
   */
  @vfsCall({ effect: Effect.ATTR })
  setattr(path: PathSpec, _fields: SetAttrFields): Promise<Record<string, number | string>> {
    return Promise.reject(enotsup(this.name, 'setattr', path))
  }

  /**
   * Search the resource under `path`; null declines, [] is none. Results
   * are text records in the format `searchMeta` declares. Errors and
   * incomplete results reject, never answered as a miss.
   */
  search(path: PathSpec, _query: SearchQuery, _index?: IndexCacheStore): Promise<string[] | null> {
    return Promise.reject(enotsup(this.name, 'search', path))
  }

  /** Search several scopes as one ranked query. */
  searchMany(
    paths: PathSpec[],
    _query: SearchQuery,
    _index?: IndexCacheStore,
  ): Promise<string[] | null> {
    return Promise.reject(enotsup(this.name, 'search', paths[0] ?? ''))
  }

  /**
   * The files under `paths` a content index says may hold `query`, so a
   * recursive grep scans only those. A superset is harmless, since the
   * scan still runs over the answer; null means the index cannot answer
   * and the scan walks everything. Consulted only while
   * `contentSearchEnabled`.
   */
  narrowPaths(_query: string, _paths: PathSpec[]): Promise<PathSpec[] | null> {
    return Promise.resolve(null)
  }

  /** Whether this mount opted in to `narrowPaths`. */
  contentSearchEnabled(): boolean {
    return false
  }

  /** Whether the backend is there to answer at all. */
  isMounted(): boolean {
    return true
  }

  deltaHook?(): DeltaHook

  /**
   * Where this driver's bytes live, as one string a person can read:
   * `disk:/srv/data`, `s3:aws:my-bucket/prefix`. Two mounts with the
   * same location address the same bytes, which is how `cp` and `mv`
   * across mounts refuse to copy a file onto itself. Null, the default,
   * means unknown, and the mount then treats this instance as a location
   * of its own, which is the safe direction to be wrong in: a false
   * "different" only keeps the pre-existing behavior, while a false
   * "same" would refuse a legitimate move. A driver whose config pins
   * the storage (a disk root, a bucket and key prefix) overrides this so
   * two instances pointing at one target compare equal.
   */
  storageLocation(): string | null {
    return null
  }

  /**
   * How much space this backend has, for `df`. The default is UNKNOWN,
   * which `df` renders as `-`. A driver that can answer truthfully (a
   * real filesystem, a provider that exposes a storage quota) overrides
   * this. Never fabricate a number.
   */
  capacity(): Promise<CapacityResult> {
    return Promise.resolve({ state: CapacityState.UNKNOWN })
  }

  /**
   * What a snapshot records for this driver: its type and `needs_override`,
   * since the base cannot know a subclass's constructor, so both loaders
   * then require the mount to be handed back live (`load`'s overrides;
   * `copy()` does this itself). A driver that owns its content (an
   * in-memory store) overrides this and {@link BaseVFS.loadState} to carry
   * it and drops the flag; a driver over a remote service keeps the default
   * and pins what it read through `supportsSnapshot` fingerprints instead.
   * `toStateDict` calls this and `loadState` on every mount, which is why
   * neither is optional. Mirrors Python `BaseVFS.get_state`.
   */
  getState(): VFSStateBase | Promise<VFSStateBase> {
    return { type: this.name, needs_override: true }
  }

  /**
   * Take back what {@link BaseVFS.getState} put out. A no-op by
   * default, because the bare `{type}` carries nothing to restore.
   * Mirrors Python `BaseVFS.load_state`.
   */
  loadState(_state: VFSStateBase): void | Promise<void> {
    // Nothing to take back.
  }

  get isClosed(): boolean {
    return this.#closed
  }

  /**
   * Release what this driver owns, exactly once: its accessor's handles
   * are its own to close, since the Accessor seam carries no lifecycle.
   * A backend with handles of its own (a db pool, an ssh channel)
   * overrides this and calls `super.close()`. Mirrors Python
   * `BaseVFS.close`.
   */
  close(): Promise<void> {
    this.#closed = true
    return Promise.resolve()
  }
}
