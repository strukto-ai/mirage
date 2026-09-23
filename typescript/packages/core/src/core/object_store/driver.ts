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

import type { Accessor } from '../../accessor/base.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { FileStat, PathSpec } from '../../types.ts'

export type ReaddirFn<A extends Accessor> = (
  accessor: A,
  path: PathSpec,
  index?: IndexCacheStore,
) => Promise<string[]>

export type StatFn<A extends Accessor> = (
  accessor: A,
  path: PathSpec,
  index?: IndexCacheStore,
) => Promise<FileStat>

export type ExistsFn<A extends Accessor> = (accessor: A, path: PathSpec) => Promise<boolean>

export type PathFn<A extends Accessor> = (accessor: A, path: PathSpec) => Promise<void>

export type PairFn<A extends Accessor> = (
  accessor: A,
  src: PathSpec,
  dst: PathSpec,
) => Promise<void>

export type WriteFn<A extends Accessor> = (
  accessor: A,
  path: PathSpec,
  data: Uint8Array,
) => Promise<void>

export type MkdirFn<A extends Accessor> = (
  accessor: A,
  path: PathSpec,
  parents?: boolean,
) => Promise<void>

export type TruncateFn<A extends Accessor> = (
  accessor: A,
  path: PathSpec,
  length: number,
) => Promise<void>

export type DuEntriesFn<A extends Accessor> = (
  accessor: A,
  path: PathSpec,
  index?: IndexCacheStore,
) => Promise<[[string, number][], number]>

export type DuSizeFn<A extends Accessor> = (
  accessor: A,
  path: PathSpec,
  index?: IndexCacheStore,
) => Promise<number>

/**
 * One entry a driver saw while listing the immediate children of a
 * prefix.
 *
 * `marker` entries carry no name of their own (the zero-byte marker
 * keyed at the listed prefix itself, or a key the delimiter listing
 * cannot classify); they still prove the prefix holds a key, which is
 * what separates an empty directory from a missing one.
 */
export interface ChildEntry {
  /** Raw backend key, no trailing slash for files and directories. */
  key: string
  /** File, directory, or a key that only proves existence. */
  kind: 'f' | 'd' | 'marker'
  /** File byte size; null/absent when the store did not report one. */
  size?: number | null
  /** ISO-8601 mtime; empty/absent when unknown. */
  modified?: string
}

/** One key of a recursive listing, directory markers included. */
export interface TreeEntry {
  /** Raw backend key; a directory marker keeps its trailing slash. */
  key: string
  /** Byte size; markers report 0 and may omit it. */
  size?: number
  modified?: string
}

/** What a point lookup of one key returned. */
export interface ObjectMeta {
  /** Byte size of the object; null when the store omitted it. */
  size: number | null
  /** ISO-8601 mtime, when the store has one. */
  modified?: string | null
  /** Content identity (ETag, revision id). */
  fingerprint?: string | null
  /** Addressable revision id, when the store versions objects. */
  revision?: string | null
  /** Backend-shaped stat extras, forwarded into `FileStat.extra` verbatim. */
  extra?: Record<string, string>
}

/**
 * The find predicates a driver may push into its native query.
 *
 * Every pushed condition must select a superset of the GNU semantics;
 * the shared client-side `keep()` pass stays authoritative.
 */
export interface FindHints {
  name: string | null
  iname: string | null
  type: string | null
  minSize: number | null
  maxSize: number | null
  /**
   * False when a complex predicate tree is present; only the prefix
   * condition may be used then.
   */
  pushdown: boolean
}

/**
 * One open connection a kit op holds for its whole body.
 *
 * Python's driver exposes `connect` as an async context manager; the
 * TS equivalent is this open/close handle consumed with try/finally.
 * The existing `withClient(config, fn)` callback style was not reused
 * because a callback cannot live in a record field without fixing the
 * callback's return type, and the handle lets every kit op scope one
 * connection over listings, probes and mutations alike. A store that
 * keeps a live client on its accessor returns the accessor itself with
 * a no-op close.
 */
export interface ObjectStoreConnection<C> {
  conn: C
  close: () => Promise<void>
}

/**
 * The native surface of one keyed byte store.
 *
 * Everything above this line — readdir with its index write-back,
 * stat's probe ladder, find's implicit-directory synthesis, du, and
 * the mutation family with its cache invalidation — derives from
 * these primitives in `core/object_store`; a backend supplies only
 * the raw store calls.
 *
 * Directory semantics the primitives must honor: a directory is a key
 * prefix, an empty directory is a zero-byte marker object keyed at the
 * prefix itself (`key/`) on stores that accept one (`markersSupported`),
 * and symlinks or hardlinks do not exist — ops that would need them
 * stay unwired, which the dispatcher already surfaces as ENOTSUP.
 */
export interface ObjectStoreDriver<A extends Accessor, C> {
  /** VFS name, used in op records and log lines. */
  vfs: string
  /** Listing size above which readdir logs a warning. */
  scopeError: number
  /** Mount key prefix from the accessor's config ('' for the whole store). */
  keyPrefixOf: (accessor: A) => string
  /** Per-op connection handle; see {@link ObjectStoreConnection}. */
  connect: (accessor: A) => Promise<ObjectStoreConnection<C>>
  /**
   * One-level listing of a prefix as {@link ChildEntry} items; may
   * repeat directories, the kit deduplicates.
   */
  listChildren: (conn: C, pfx: string) => AsyncIterable<ChildEntry>
  /** Recursive listing of every key under a prefix, markers included. */
  listTree: (conn: C, pfx: string) => AsyncIterable<TreeEntry>
  /**
   * The key at `stem` itself plus every key under `stem + '/'` — du's
   * walk, which unlike `listTree` must not match sibling keys sharing
   * the stem as a name prefix.
   */
  listSubtree: (conn: C, stem: string) => AsyncIterable<TreeEntry>
  /**
   * Point lookup of one key, null when absent; classification failures
   * propagate.
   */
  head: (conn: C, key: string) => Promise<ObjectMeta | null>
  /** Full object bytes, null when absent. */
  get: (conn: C, key: string) => Promise<Uint8Array | null>
  /**
   * Write one object, returning what the store's write response said
   * about it, or null when the store's write API reports nothing at all
   * (opendal). The meta is partial: `size` is the bytes written and
   * `fingerprint` is the store's token, spelled exactly as `head` spells
   * it so the two can be compared; `modified` is absent, because no
   * store's write response carries one. A store that answers without a
   * token gives a meta whose `fingerprint` is null; callers read only
   * that field, so they cannot tell it from null and do not need to.
   * A store error meaning the container is absent
   * (`isNotFound`) propagates, and the write factory restates it as
   * ENOENT on the path.
   */
  put: (conn: C, key: string, data: Uint8Array) => Promise<ObjectMeta | null>
  /**
   * Delete one key (every revision on a versioned store); silent on a
   * missing key.
   */
  deleteFile: (conn: C, key: string) => Promise<void>
  /** Delete every key under a prefix. */
  deletePrefix: (conn: C, pfx: string) => Promise<void>
  /** Whether any key sits under a prefix. */
  probePrefix: (conn: C, pfx: string) => Promise<boolean>
  /** Whether a store error means the key is absent. */
  isNotFound: (err: unknown) => boolean
  /**
   * Relocate one object; false when the source names no object. Absent
   * when the store has no native move — rename stays unwired then,
   * which the dispatcher surfaces as ENOTSUP.
   */
  moveFile?: (conn: C, srcKey: string, dstKey: string) => Promise<boolean>
  /**
   * Relocate every key under a prefix; false when the source prefix
   * holds nothing. Absence follows `moveFile`.
   */
  movePrefix?: (conn: C, srcPfx: string, dstPfx: string) => Promise<boolean>
  /**
   * Copy one object; false when the source names no object, if the
   * store can tell cheaply. Absent when the store has no native copy —
   * copy stays unwired then.
   */
  copyFile?: (conn: C, srcKey: string, dstKey: string) => Promise<boolean>
  /**
   * Whether the store accepts the zero-byte `key/` marker object;
   * absent means true. False when the store refuses one client-side
   * (hf): an empty directory cannot exist there, `makeMkdir` has
   * nothing to write, and a directory exists exactly while it holds a
   * key.
   */
  markersSupported?: boolean
  /**
   * Find's listing with native predicate push-down, returning the
   * iterator and whether the query was narrowed beyond the prefix;
   * absent means find walks `listTree` unnarrowed.
   */
  findTree?: (conn: C, pfx: string, hints: FindHints) => [AsyncIterable<TreeEntry>, boolean]
}
