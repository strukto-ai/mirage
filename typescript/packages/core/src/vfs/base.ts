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
import type { PredNode } from '../commands/builtin/find_eval.ts'
import { DEFAULT_MAX_DU_ENTRIES } from '../commands/builtin/generic/du.ts'
import type { Builder } from '../commands/builtin/generic_bind/adapter.ts'
import { type CommandIO, makeGenericCommands } from '../commands/builtin/generic_bind/index.ts'
import type { RegisteredCommand } from '../commands/config.ts'
import { makeGenericOps } from '../ops/generic/factory.ts'
import type { RegisteredOp } from '../ops/registry.ts'
import type { CapacityResult } from '../types.ts'
import { CapacityState, ListingVersion } from '../types.ts'
import type { DeltaHook } from '../watch/base.ts'
import { VFSAdapter } from './adapter.ts'

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
 * What a driver built from a table hands the constructor: the accessor,
 * the table of core functions over it, and the facts and prompts it
 * declares. A builtin declares the same things as class members instead
 * and passes nothing. Mirrors the keyword arguments of Python's
 * `BaseVFS.__init__`.
 */
export interface VFSOptions<A extends Accessor = Accessor> {
  /**
   * VFS name the commands and ops register under, and the `type` key
   * `getState` writes into a snapshot. Also the registry key when the
   * backend is exposed through `registerVfsFactory`.
   */
  name: string
  /** Backend handle passed to every core function on the table. */
  accessor: A
  /** The backend's resource capabilities, or a prebuilt IO table. */
  io: CommandIO<A> | VFSAdapter<A>
  /** LLM-facing description of the mounted layout. */
  prompt?: string
  /** Appended to `prompt` when the mount is writable. */
  writePrompt?: string
  /**
   * Replacement builders receive the factory's prepared IO.
   * A null value omits the generic command.
   */
  overrides?: Record<string, Builder<A> | null>
  /**
   * Extra commands, from `command({...})`: bespoke verbs, or the
   * replacements for whatever `overrides` suppressed.
   */
  commands?: readonly RegisteredCommand[]
  /**
   * Irregular VFS/FUSE handlers, layered over the derived set. One
   * carrying no filetype shadows the derived op of the same name.
   *
   * Plain records rather than Python's decorated functions: TypeScript's
   * `op` is a *method* decorator, so a standalone handler has no
   * decorator form to carry its registration.
   */
  ops?: readonly RegisteredOp[]
  /**
   * Derive the VFS/FUSE op set from the table (read/readdir/stat plus
   * whatever mutations the table carries). Set false to serve only the
   * explicit `ops`.
   */
  autoOps?: boolean
  /** Serve repeat reads from the file cache. Read-mostly content only. */
  cachesReads?: boolean
  /**
   * Whether `io.stat` sizes every regular file without fetching it. A
   * backend that renders its content on read leaves this false and rides
   * the unknown-size machinery; a byte store sets it, which is also what
   * makes the mount legal on FSKit.
   */
  sizesAlwaysKnown?: boolean
  /**
   * Whether `io.stat` fills `FileStat.fingerprint` with a stable
   * per-path version marker. Setting it without that is not drift
   * detection, it is a snapshot that claims to have one.
   */
  supportsSnapshot?: boolean
  /**
   * Whether `io.stat` and the read record stamp the *same kind* of content
   * token, so a `read: fresh` mount can compare them. Setting it without
   * that makes every read verdict stale and refetch forever; a mount
   * declaring `fresh` on a backend that leaves it false is refused at mount
   * time instead.
   */
  readRevalidatable?: boolean
}

/**
 * What a driver supplies, and nothing a mount runs it with. A driver is
 * an accessor and the tables it serves through: `ops()` for the
 * VFS/FUSE verbs and `commands()` for the shell. Everything a tree needs
 * to run one (the placement, the index store, the registered tables, the
 * reference it was built from) lives on the mount, so an author never
 * sees it.
 *
 * There are two ways to be one. A builtin declares its facts as members
 * and returns from `ops()` and `commands()` the tables its `ops/<name>`
 * and `commands/builtin/<name>` modules build, so it calls `super()`
 * bare. A custom backend hands the constructor a {@link VFSOptions}: an
 * accessor and a {@link VFSAdapter} (or a prebuilt {@link CommandIO}
 * table), from which the whole generic command set (`ls`, `cat`, `grep`,
 * `find`, `head`, `wc`, ...) plus glob resolution and the VFS/FUSE ops
 * are derived. That is the one-file path, which
 * `examples/typescript/other/custom_vfs.ts` walks end to end. Optional
 * capabilities unlock more surface (`writes` enables the byte-mutation
 * family, `find` and `du` become native fast paths). A table without an
 * op still gets every command: `gzip -c` and `tar -t` run as readers,
 * and a line that needs the missing op answers `Operation not supported`
 * at that op. The accessor generic type-checks the table against the
 * accessor the core functions actually take, which Python leaves as
 * `Any`.
 *
 * Snapshots and versions see one of two things, and a subclass picks
 * which by what it owns. Content the VFS holds itself (an in-memory
 * store) is mirage-owned state: override `getState` and `loadState` to
 * carry it, register the class under its name, and a snapshot or a
 * version rebuilds the mount with that content and no override. Content
 * that lives in a remote service is only observed: keep the default
 * state, set `supportsSnapshot` and fill `FileStat.fingerprint`, and a
 * snapshot pins what it read while `Workspace.load` asks for the live
 * VFS back. Mirrors Python's `BaseVFS`.
 */
export class BaseVFS<A extends Accessor = Accessor> {
  readonly [VFS_BRAND] = true as const
  readonly name: string
  declare readonly prompt?: string
  declare readonly writePrompt?: string
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
   * The backend handle every core function on the tables takes. A driver
   * built from a table takes it from its options; a builtin declares and
   * assigns its own. One that brings none runs over a no-op accessor.
   */
  readonly accessor: A

  // Whether this driver was built from a table, and the two tables
  // derived from it when it was.
  readonly #fromTable: boolean
  readonly #commands: readonly RegisteredCommand[]
  readonly #ops: readonly RegisteredOp[]
  #closed = false

  /**
   * Build a driver from a table, or nothing at all. A builtin declares
   * its facts as members and returns its tables from `ops()` and
   * `commands()`, so it calls `super()` bare. Given options, the whole
   * generic command set and the derived op set are wired from the
   * table.
   */
  constructor(options?: VFSOptions<A>) {
    // A builtin passes nothing and declares its facts as members. A
    // bare subclass of a builtin (`class WikiVFS extends RAMVFS {}`)
    // constructed from a config forwards that config here through the
    // implicit constructor; it is not a table, so it builds nothing and
    // the subclass's own members stand. Only a real options object,
    // which always carries `io`, builds the generic tables. Python is
    // immune to this by construction (its `__init__` is keyword-only, so
    // a forwarded positional raises rather than being read as a table).
    const io = (options as { io?: CommandIO<A> | VFSAdapter<A> } | undefined)?.io
    if (options === undefined || io === undefined) {
      this.name = 'base'
      this.accessor = NO_ACCESSOR as unknown as A
      this.#fromTable = false
      this.#commands = []
      this.#ops = []
      return
    }
    if (options.name === '') throw new Error('a VFS needs a non-empty name')
    this.name = options.name
    this.accessor = options.accessor
    this.#fromTable = true
    this.prompt = options.prompt ?? ''
    this.writePrompt = options.writePrompt ?? ''
    this.cachesReads = options.cachesReads ?? false
    this.sizesAlwaysKnown = options.sizesAlwaysKnown ?? false
    this.supportsSnapshot = options.supportsSnapshot ?? false
    this.readRevalidatable = options.readRevalidatable ?? false
    const table = io instanceof VFSAdapter ? io.toCommandIO() : io
    this.maxDuEntries =
      table.maxDuEntries === undefined ? DEFAULT_MAX_DU_ENTRIES : table.maxDuEntries
    this.#commands = [
      ...makeGenericCommands<A>(
        options.name,
        table,
        options.overrides !== undefined ? { overrides: options.overrides } : {},
      ),
      ...(options.commands ?? []),
    ]
    const userOps = options.ops ?? []
    // A user op carrying no filetype replaces the derived op of the same
    // name: the derived set is built with those names skipped, so
    // registering both cannot leave two handlers competing for one key.
    const shadowed = new Set(userOps.filter((ro) => ro.filetype === null).map((ro) => ro.name))
    const derived =
      options.autoOps === false
        ? []
        : makeGenericOps<A>(options.name, table, { overrides: shadowed })
    this.#ops = [...derived, ...userOps]
  }

  /**
   * The VFS/FUSE verbs this driver serves, as registered ops. A verb
   * that is not in this list is not served: the mount answers
   * `Operation not supported` for it. A driver built from a table serves
   * the set derived from it; a builtin returns the list its `ops/<name>`
   * module derives from the backend's table.
   */
  ops(): readonly RegisteredOp[] {
    return this.#ops
  }

  /** The shell commands this driver serves, as registered commands. */
  commands(): readonly RegisteredCommand[] {
    return this.#commands
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
   * What a snapshot records for this driver. The default carries only
   * the type, which is enough to rebuild a builtin that owns nothing. A
   * driver built from a table adds `needs_override`: the base cannot
   * know a subclass's constructor, so both loaders then require the
   * mount to be handed back live (`load`'s overrides; `copy()` does this
   * itself). A driver that owns its content (an in-memory store)
   * overrides this and {@link BaseVFS.loadState} to carry it and drops
   * the flag; a driver over a remote service keeps the default and pins
   * what it read through `supportsSnapshot` fingerprints instead.
   * `toStateDict` calls this and `loadState` on every mount, which is
   * why neither is optional. Mirrors Python `BaseVFS.get_state`.
   */
  getState(): VFSStateBase | Promise<VFSStateBase> {
    if (!this.#fromTable) return { type: this.name }
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
