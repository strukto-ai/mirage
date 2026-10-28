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
import type { Command } from '../commands/config.ts'
import type { CLI } from '../commands/cli/types.ts'
import { enotsup } from '../errors/fs.ts'
import type { ByteSource } from '../io/types.ts'
import type {
  CapacityResult,
  DirListing,
  FileStat,
  PathSpec,
  SearchQuery,
  SetAttrFields,
} from '../types.ts'
import { CapacityState, ListingVersion } from '../types.ts'
import type { DeltaHook } from '../events/base.ts'
import { methodName, vfsCall } from './call.ts'
import type { StorageUsage } from './capacity.ts'
import { WALK_LIMIT } from './constants.ts'
import { Effect, type Handed, Target } from './types.ts'

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
   * exposed through `registerVfs`.
   */
  name?: string
  /** Backend handle the functions use. */
  accessor?: A
  /**
   * This VFS's part of VFS.md: its layout and file formats, `{prefix}`
   * standing for the mount path.
   */
  vfsMd?: string
  /**
   * Extra commands, from `command({...})`, or `CLI` trees: bespoke verbs, a
   * program's verbs as one command tree under its root's name, or
   * replacements that win over the generic command of the same name.
   */
  commands?: readonly (Command | CLI)[]
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
 * (`write`, `unlink`, a native `find` or `search`, ...) is optional, and a VFS answers exactly the ones it defines. Every generic
 * shell command (`ls`, `cat`, `grep`, `find`, `head`, `wc`, ...) runs on
 * the three required ones, and a line that needs a function the VFS does
 * not define answers `Operation not supported` at that call, so `gzip -c`
 * and `tar -t` still run as readers on a read-only backend. A method
 * marked `@vfsCall` is also reachable by name through the dispatcher
 * (`ws.dispatch('search_abc', path)`), with every check the dispatcher runs; the
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
  vfsMd = ''
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
   * The stats each of this VFS's functions is handed, by method name: a
   * function named here gets a `Handed` holding each stat it lists, found
   * in the mount's stored listings, where it takes its index otherwise.
   * Python reads the same off each function's parameters.
   */
  readonly handed: Readonly<Partial<Record<string, readonly (keyof Handed)[]>>> = {}

  /**
   * The version every listing of this mount is pinned at, when its ref names
   * a commit outright (github's full-sha ref; see `pinOf` in
   * vfs/github/github.ts for why that cannot move). A stored listing whose
   * version equals it is served without a check. It depends on the mount's config, so
   * an instance sets it; null pins nothing.
   */
  readonly listingsPin: string | null = null
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

  /** The store's capacity and counted bytes, set by a backend whose config
   * caps it; null when uncapped. */
  readonly usage: StorageUsage | null = null
  /**
   * The files `filesContaining` answers for, as mount-relative globs matched
   * segment by segment (a glob naming a directory covers what is below it);
   * null for every file. grep and rg read any other file whatever the
   * answer, as a full scan would.
   */
  readonly searchable: readonly string[] | null = null
  /**
   * `filesContaining` answers only a whole-word search (grep -w, rg -w);
   * any other pattern reads every file.
   */
  readonly wholeWordSearch: boolean = false
  /**
   * The most files one command walks under a directory of this mount: grep
   * -r, rg and git grep stop reading there, find, ls -R, tree, du and
   * getfattr -R stop listing, git status and the other verbs that walk a
   * work tree fail, a glob matching more is refused, and so are tar -c, zip
   * -r, cp -r, rm -r, chmod -R, chown -R, chgrp -R, mv to another mount and
   * diff -r of a directory holding more (`beforeFullWalk`); -1 for no cap.
   * This is the backend's own value: the mount's `'@all'` command limit, else
   * the workspace's, replaces it when the VFS is mounted.
   */
  walkLimit: number = WALK_LIMIT
  /**
   * Extensions whose `read` is a rendering rather than the stored bytes,
   * each to the name of the method that renders it, which takes `read`'s
   * arguments, window included. A rendered read is never served from or
   * kept in the file cache, and a `raw` read asks for `read` itself.
   */
  readonly renderers: Readonly<Record<string, string>> = {}
  /**
   * The backend handle every function takes. A builtin declares and
   * assigns its own; one that brings none runs over a no-op accessor.
   */
  readonly accessor: A = NO_ACCESSOR as unknown as A

  readonly #commands: readonly (Command | CLI)[]
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
    if (options.vfsMd !== undefined) this.vfsMd = options.vfsMd
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
    const method = methodName(name)
    const own: unknown = (this as unknown as Record<string, unknown>)[method]
    return (
      typeof own === 'function' &&
      own !== (BaseVFS.prototype as unknown as Record<string, unknown>)[method]
    )
  }

  /** The bespoke commands and command trees this VFS was handed. */
  commands(): readonly (Command | CLI)[] {
    return this.#commands
  }

  /**
   * List the children of a directory, each as its stat answers it.
   *
   * On a walk, `handed.limit` is the most entries the walk can still use;
   * a readdir may stop once it holds that many and answer them as
   * `new DirListing({ entries, partial: true })`. A glob hands the word it
   * matches as `path.pattern`; a backend that filters by it answers
   * `partial: true` too. Mirrors Python's `readdir`.
   */
  @vfsCall({ effect: Effect.READ, target: Target.DIR })
  readdir(path: PathSpec, _handed?: Handed): Promise<readonly FileStat[] | DirListing> {
    return Promise.reject(enotsup(this.name, 'readdir', path))
  }

  /**
   * Read a file's bytes, or a window of them. Answer with the bytes, or with
   * an async iterable that hands them out as the caller pulls, so a large
   * file never sits in memory: an `async` method that resolves to either, or
   * an `async *` one that yields chunks. Mirage collects a stream for a
   * caller that needs the bytes whole and hands bytes to a streaming caller
   * as one chunk. A window reaches this only when `readsRanges` is set: the
   * caller otherwise reads the whole file and slices it.
   */
  @vfsCall({ effect: Effect.READ, target: Target.FILE })
  read(
    path: PathSpec,
    _handed?: Handed,
    _offset = 0,
    _size: number | null = null,
    _signal?: AbortSignal,
  ): Promise<ByteSource> | AsyncIterable<Uint8Array> {
    return Promise.reject(enotsup(this.name, 'read', path))
  }

  /** Describe a path; rejects with ENOENT when nothing is there. */
  @vfsCall({ effect: Effect.METADATA })
  stat(path: PathSpec, _handed?: Handed): Promise<FileStat> {
    return Promise.reject(enotsup(this.name, 'stat', path))
  }

  /** Whether anything is at `path`; derived from `stat` when not defined. */
  exists(path: PathSpec, _handed?: Handed): Promise<boolean> {
    return Promise.reject(enotsup(this.name, 'exists', path))
  }

  /**
   * The first `n` lines of a file, without reading the rest.
   *
   * `head -n N` asks this before it reads, so a backend that can fetch the
   * start of a file on its own (a `LIMIT` on a table) does not send the whole
   * file. The answer stands in for the file: exactly the first `n` lines a
   * read gives, each with its newline, and the whole file when it has fewer.
   * A file the read cache holds is read instead. Resolves null to have the
   * file read the usual way; rejects with the file's read error otherwise
   * (`EFBIG` when the answer passes a ceiling on one read, such as
   * `max_read_rows`).
   */
  @vfsCall({ effect: Effect.READ, target: Target.FILE })
  firstLines(path: PathSpec, _n: number, _handed?: Handed): Promise<Uint8Array | null> {
    return Promise.reject(enotsup(this.name, 'firstLines', path))
  }

  /**
   * The last `n` lines of a file, without reading the rest.
   *
   * `tail -n N` asks this before it reads, and `tail -f` for its first print.
   * The answer stands in for the file: exactly the last `n` lines a read
   * gives, each with its newline, and the whole file when it has fewer. A
   * file the read cache holds is read instead. Resolves null to have the file
   * read the usual way; rejects with the file's read error otherwise (`EFBIG`
   * when the answer passes a ceiling on one read).
   */
  @vfsCall({ effect: Effect.READ, target: Target.FILE })
  lastLines(path: PathSpec, _n: number, _handed?: Handed): Promise<Uint8Array | null> {
    return Promise.reject(enotsup(this.name, 'lastLines', path))
  }

  /**
   * How many newlines a read of the file gives, without reading it.
   *
   * `wc -l` asks this before it reads (a `COUNT(*)` on a table), and only
   * when it counts lines alone. A file the read cache holds is read instead.
   * Resolves null to have the file read the usual way; rejects with the
   * file's read error otherwise.
   */
  @vfsCall({ effect: Effect.READ, target: Target.FILE })
  lineCount(path: PathSpec, _handed?: Handed): Promise<number | null> {
    return Promise.reject(enotsup(this.name, 'lineCount', path))
  }

  /**
   * The digest the backend keeps for a file, without reading it.
   *
   * `md5sum` and its siblings ask this before they read, except under `-c`,
   * which checks the bytes themselves, so a backend that stores a file's
   * digest (an object's MD5 ETag, a drive's `md5Checksum`) does not send the
   * file. Answer only a digest of exactly the bytes a read gives, in
   * lowercase hex: a stored value that can be anything else (a multipart or
   * encrypted object's ETag) is null. `algorithm` is the hashlib name, `md5`,
   * `sha1`, `sha224`, `sha256`, `sha384`, `sha512` or `blake2b`, or
   * `blake2b-N` for BLAKE2b at N bits. A file the read cache holds is read
   * instead. Resolves null to have the file read and hashed; rejects
   * with the file's read error otherwise.
   */
  @vfsCall({ effect: Effect.READ, target: Target.FILE })
  checksum(path: PathSpec, _algorithm: string, _handed?: Handed): Promise<string | null> {
    return Promise.reject(enotsup(this.name, 'checksum', path))
  }

  /**
   * The last `n` lines of a file, then each line added to it, as it lands.
   *
   * `tail -f` on one file asks this for all it prints, so a backend that can
   * be told about new data (a change stream) does not have to be polled, one
   * that can be asked for only what is new does not read the whole file again
   * on each poll, and the lines it prints first and the ones it follows meet
   * at one point: none is lost or printed twice. The stream yields whole
   * lines, each with its newline, in the order a read would show them, and
   * ends only when the caller closes it; closing it ends a wait for the next
   * line. `interval` is `tail -s`, the seconds between two asks for what is
   * new; a change stream has no use for it. Resolves null to have `tail` read
   * the file and poll it every `-s` seconds; rejects with the file's read
   * error otherwise.
   */
  @vfsCall({ effect: Effect.READ, target: Target.FILE })
  follow(
    path: PathSpec,
    _n: number,
    _interval: number,
    _handed?: Handed,
  ): Promise<AsyncIterable<Uint8Array> | null> {
    return Promise.reject(enotsup(this.name, 'follow', path))
  }

  /**
   * Every entry under a directory, in one answer.
   *
   * `find`, `du`, `ls -R`, `tree`, `grep -r` and `rg` ask this before they
   * walk a directory, so a backend that can list a subtree on its own (a
   * recursive listing, one query over many folders) does not take a
   * `readdir` per directory. The answer stands in for the walk: every file and
   * directory below `path`, keyed by its path below `path` (`a`, `a/b.txt`),
   * each with the stat `stat` gives for it. The walk lists each directory from it in name order.
   * Resolve null to have the command walk `readdir` the usual way; reject with
   * what `readdir` of `path` rejects with otherwise. `handed.limit` is the
   * most entries the walk can still use; resolve null once the tree holds
   * more. A walk that reads one directory at a time asks with `level: true`,
   * which the mount answers from its own listing (the directory's children,
   * each with its stat) and never asks this function. Mirrors Python's
   * `read_tree`.
   */
  @vfsCall({ effect: Effect.READ, target: Target.DIR, subtree: true })
  readTree(path: PathSpec, _handed?: Handed): Promise<Map<string, FileStat> | null> {
    return Promise.reject(enotsup(this.name, 'readTree', path))
  }

  /**
   * Replace a file's bytes, creating it when missing. `data` is the whole
   * content, or an async iterable that hands it over as it is produced (a
   * program's output redirected into the file); `materialize(data)` collects
   * it for a store that takes one body. A stream that lands as it arrives
   * lets a reader watch the file grow, and `atomic` asks that nothing show
   * until it has ended whole, which a write that collects first already does.
   */
  @vfsCall({ effect: Effect.WRITE, target: Target.FILE, creates: true })
  write(
    path: PathSpec,
    _data: ByteSource,
    _signal?: AbortSignal,
    _handed?: Handed,
    _atomic = false,
  ): Promise<unknown> {
    return Promise.reject(enotsup(this.name, 'write', path))
  }

  /**
   * Add bytes to the end of a file, creating it when missing. `data` is
   * bytes or a stream, as `write` takes it. A VFS that defines `write` and
   * not this is appended to by reading the file and writing it back.
   */
  @vfsCall({ effect: Effect.WRITE, target: Target.FILE, creates: true })
  append(
    path: PathSpec,
    _data: ByteSource,
    _handed?: Handed,
    _signal?: AbortSignal,
  ): Promise<unknown> {
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
    _handed?: Handed,
    _signal?: AbortSignal,
  ): Promise<unknown> {
    return Promise.reject(enotsup(this.name, 'pwrite', path))
  }

  /** Create an empty file, leaving an existing one as it is. */
  @vfsCall({ effect: Effect.WRITE, target: Target.FILE, creates: true })
  create(path: PathSpec, _handed?: Handed): Promise<unknown> {
    return Promise.reject(enotsup(this.name, 'create', path))
  }

  /** Make a directory; `parents` makes missing parents too, as `mkdir -p`. */
  @vfsCall({ effect: Effect.CREATE, target: Target.DIR })
  mkdir(path: PathSpec, _parents = false, _handed?: Handed): Promise<unknown> {
    return Promise.reject(enotsup(this.name, 'mkdir', path))
  }

  /** Remove a file. */
  @vfsCall({ effect: Effect.REMOVE, target: Target.FILE })
  unlink(path: PathSpec, _handed?: Handed): Promise<void> {
    return Promise.reject(enotsup(this.name, 'unlink', path))
  }

  /**
   * Remove an empty directory. The index is the mount's, which a refused
   * rmdir's hidden-remnant walk lists through.
   */
  @vfsCall({ effect: Effect.REMOVE, target: Target.DIR })
  rmdir(path: PathSpec, _handed?: Handed): Promise<void> {
    return Promise.reject(enotsup(this.name, 'rmdir', path))
  }

  /** Remove a subtree in one call instead of entry by entry. */
  @vfsCall({ effect: Effect.REMOVE, target: Target.DIR, subtree: true })
  rmR(path: PathSpec, _handed?: Handed): Promise<void> {
    return Promise.reject(enotsup(this.name, 'rmR', path))
  }

  /** Move a name within this VFS. */
  @vfsCall({ effect: Effect.RENAME, subtree: true })
  rename(src: PathSpec, _dst: PathSpec, _handed?: Handed): Promise<unknown> {
    return Promise.reject(enotsup(this.name, 'rename', src))
  }

  /** Copy a file within this VFS without moving its bytes through mirage. */
  @vfsCall({ effect: Effect.COPY, target: Target.FILE })
  copy(_src: PathSpec, dst: PathSpec, _signal?: AbortSignal, _handed?: Handed): Promise<unknown> {
    return Promise.reject(enotsup(this.name, 'copy', dst))
  }

  /** Copy a directory tree within this VFS in one call. */
  /**
   * Copy a file from another mount onto this one without moving its bytes
   * through mirage.
   *
   * `cp` and `mv` between two mounts ask this before they read the file and
   * write it here, once the dispatcher has judged the source as a read and
   * the destination as a create. It is no dispatcher call of its own, so
   * nothing reaches it unjudged. `source` is the source mount's VFS and `src`
   * the file there. Reject EXDEV when this backend cannot copy from `source`
   * (another kind of store, other credentials, a refusal), and the bytes move
   * through the read and the write instead.
   */
  copyFrom(_source: BaseVFS, _src: PathSpec, dst: PathSpec): Promise<void> {
    return Promise.reject(enotsup(this.name, 'copyFrom', dst))
  }

  @vfsCall({ effect: Effect.COPY, target: Target.DIR, subtree: true })
  dirCopy(_src: PathSpec, dst: PathSpec, _handed?: Handed): Promise<unknown> {
    return Promise.reject(enotsup(this.name, 'dirCopy', dst))
  }

  /**
   * Resize a file, padding with zeros or cutting the end. `noCreate`
   * refuses a missing file instead of creating it; a VFS that cannot hold
   * that atomically rejects with ENOTSUP before writing.
   */
  @vfsCall({ effect: Effect.WRITE, target: Target.FILE, creates: true })
  truncate(path: PathSpec, _length: number, _noCreate = false, _handed?: Handed): Promise<unknown> {
    return Promise.reject(enotsup(this.name, 'truncate', path))
  }

  /**
   * Store metadata fields the backend keeps itself. Resolves to the fields
   * it stored; the rest land in the namespace's attribute overlay.
   */
  @vfsCall({ effect: Effect.ATTR })
  setattr(
    path: PathSpec,
    _fields: SetAttrFields,
    _handed?: Handed,
  ): Promise<Record<string, number | string>> {
    return Promise.reject(enotsup(this.name, 'setattr', path))
  }

  /**
   * Search the resource under `path`; null declines, [] is none. One
   * `[path, record]` pair per hit: the hit's virtual path, which the
   * dispatcher drops the hit for when the session hides it, and the record
   * the `search` CLI prints, a header line naming the path (`path:score`
   * where the store ranks) and then the hit's text. Errors and incomplete
   * results reject, never answered as a miss.
   */
  @vfsCall({ effect: Effect.READ, subtree: true })
  search(
    path: PathSpec,
    _query: SearchQuery,
    _handed?: Handed,
  ): Promise<[string, string][] | null> {
    return Promise.reject(enotsup(this.name, 'search', path))
  }

  /** Search several scopes as one ranked query. */
  searchMany(
    paths: PathSpec[],
    _query: SearchQuery,
    _handed?: Handed,
  ): Promise<[string, string][] | null> {
    return Promise.reject(enotsup(this.name, 'search', paths[0] ?? ''))
  }

  /**
   * Read several whole files in one request, for a read-ahead. Keyed by each
   * answered path's `virtual`. A file may be left out (one larger than
   * `limit` bytes, one the request could not read), and its own read answers
   * it later; an error of the whole request rejects. Each file read is
   * recorded as `read` records it, fingerprint included, so the read cache
   * keeps its token. A VFS that needs what the listings hold declares
   * `readMany` in `handed` and gets each path's `Handed`, in the order of
   * `paths`. Mirrors Python's `read_many`.
   */
  readMany(
    paths: PathSpec[],
    _limit: number,
    _handed?: readonly Handed[],
  ): Promise<Map<string, Uint8Array>> {
    return Promise.reject(enotsup(this.name, 'read', paths[0] ?? ''))
  }

  /**
   * Files under `path` whose content may contain `text`. grep and rg still
   * walk, filter, order and label every file, and read only the ones answered
   * here, matched on `vfsPath` without case, so an extra file costs a read and
   * a missing one is a wrong answer. A search that holds only keys names each one with
   * `mountedPath(path, '/' + key)`. Resolve null when the answer may be
   * incomplete (an error, a truncated result, an index that lags writes), and
   * every file is read; reject to refuse the command, and the error's message
   * is what it prints. The dispatcher drops every file the session hides
   * from the answer.
   *
   * @param path a directory walked: one of grep's directory operands under -r
   *   or -R, or of rg's operands or the cwd; asked once per directory.
   * @param text plain text every match holds, never a pattern: the pattern
   *   or each -e of grep and rg, or for a regex a fixed piece of at least
   *   three characters every match contains. Asked once per text; a file any
   *   answer holds is read.
   * @param opts `wholeWord` is true under -w or -x with a plain-text
   *   pattern, where `text` is a whole word of every match, and false
   *   otherwise, where it may sit inside a word. `ignoreCase` is true under
   *   -i, and under rg -S with a lowercase pattern; folding case when false
   *   is fine.
   */
  @vfsCall({ effect: Effect.READ, target: Target.DIR, subtree: true })
  filesContaining(
    _path: PathSpec,
    _text: string,
    _opts: { wholeWord: boolean; ignoreCase: boolean },
    _handed?: Handed,
  ): Promise<PathSpec[] | null> {
    return Promise.resolve(null)
  }

  /**
   * The lines of `path` that may contain `text`, in file order. grep and rg
   * match each line themselves, so an extra line is fine and a missing one is
   * a wrong answer. Each line keeps the newline the file has, whole or
   * streamed. The lines stand in for the file when the output shows no line
   * positions (no -n, -b, --column, --vimgrep), no context (no -A, -B, -C) and
   * there is one text; otherwise the file is read only when some answer holds
   * a line, and only a stream's first chunk is pulled. null reads the file;
   * answer null for a file that may hold a NUL byte, since grep and rg call
   * such a file binary from bytes outside its matching lines. Reject to refuse
   * the command.
   *
   * @param path the file.
   * @param text plain text every match holds, as `filesContaining` gets it.
   * @param opts `ignoreCase` is true under -i, and under rg -S with a
   *   lowercase pattern.
   */
  @vfsCall({ effect: Effect.READ, target: Target.FILE })
  linesContaining(
    _path: PathSpec,
    _text: string,
    _opts: { ignoreCase: boolean },
    _handed?: Handed,
  ): Promise<ByteSource | null> {
    return Promise.resolve(null)
  }

  /**
   * Called before a command acts on every file under `path`, once per
   * directory a command copies, compares, changes or removes whole, before
   * the first file it touches there: tar -c, zip -r, cp -r, mv across
   * mounts, diff -r, rm -r, chmod -R, chown -R and chgrp -R. Resolve to let
   * the walk run; reject to refuse it, and the error's message is what the
   * command prints. The dispatcher has already refused more than the
   * command's `walkLimit` files, so the default lets the walk run. Searches
   * and listings are never refused: they stop after `walkLimit` files.
   *
   * @param path the directory about to be walked.
   * @param files how many files the session sees under `path`, with every
   *   hidden file dropped: the mount's `readTree`, or under a
   *   `walkLimit` a walk of its listings that stops one file past it;
   *   null when neither counts, and the guard counts them itself.
   */
  @vfsCall({ effect: Effect.READ, target: Target.DIR })
  beforeFullWalk(_path: PathSpec, _files: number | null, _handed?: Handed): Promise<void> {
    return Promise.resolve()
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
