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

import type { ByteSource } from '../../io/types.ts'
import type { Accessor } from '../../accessor/base.ts'
import { dropCached, stale } from '../../cache/context.ts'
import { type KnownVersions, OwnRead, type WriteCondition } from '../../cache/types.ts'
import type { StaleWriteError } from '../../errors/types.ts'
import type { FileStat, PathSpec } from '../../types.ts'
import * as kp from '../../utils/key_prefix.ts'
import type { ConditionLostError } from './errors.ts'

export type ReaddirFn<A extends Accessor> = (accessor: A, path: PathSpec) => Promise<FileStat[]>

export type TreeFn<A extends Accessor> = (
  accessor: A,
  path: PathSpec,
) => Promise<Map<string, FileStat> | null>

export type StatFn<A extends Accessor> = (accessor: A, path: PathSpec) => Promise<FileStat>

export type ExistsFn<A extends Accessor> = (accessor: A, path: PathSpec) => Promise<boolean>

export type PathFn<A extends Accessor> = (accessor: A, path: PathSpec) => Promise<void>

export type CreateFn<A extends Accessor> = (accessor: A, path: PathSpec) => Promise<FileStat | null>

export type PairFn<A extends Accessor> = (
  accessor: A,
  src: PathSpec,
  dst: PathSpec,
) => Promise<void>

export type WriteFn<A extends Accessor> = (
  accessor: A,
  path: PathSpec,
  data: ByteSource,
  signal?: AbortSignal,
) => Promise<FileStat | null>

export type MkdirFn<A extends Accessor> = (
  accessor: A,
  path: PathSpec,
  parents?: boolean,
) => Promise<void>

export type TruncateFn<A extends Accessor> = (
  accessor: A,
  path: PathSpec,
  length: number,
  noCreate?: boolean,
) => Promise<FileStat | null>

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
 * the mutation family — derives from
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
  /**
   * The key at `stem` itself plus every key under `stem + '/'` — du's
   * walk, which must not match sibling keys sharing the stem as a
   * name prefix.
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
   * store's write response carries one. A response without a token can
   * still confirm size. The write factory returns these facts as a
   * FileStat for index retention.
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
   * Point lookup of one revision of a key by the token `head` spells, null
   * when it is gone. A stat pinned by a snapshot asks this, so a revision
   * the store still holds under another name (a trash, a version) answers.
   */
  headRevision?: (conn: C, key: string, revision: string) => Promise<ObjectMeta | null>
  /**
   * Whether the store accepts the zero-byte `key/` marker object;
   * absent means true. False when the store refuses one client-side
   * (hf): an empty directory cannot exist there, `makeMkdir` has
   * nothing to write, and a directory exists exactly while it holds a
   * key.
   */
  markersSupported?: boolean
  /**
   * `put` carrying a write condition; a lost one throws `ConditionLostError`.
   * Absent when the store cannot condition a write.
   */
  putStream?: (conn: C, key: string, data: ByteSource, cond: WriteCondition) => Promise<ObjectMeta>
  putIf?: (
    conn: C,
    key: string,
    data: Uint8Array,
    cond: WriteCondition,
  ) => Promise<ObjectMeta | null>
  /** `get` plus the token of the bytes returned, for an op that writes back what it read; a revision reads that revision. */
  getVersioned?: (
    conn: C,
    key: string,
    revision: string | null,
  ) => Promise<[Uint8Array, string | null] | null>
  /** `copyFile` with the destination's condition. */
  copyIf?: (conn: C, srcKey: string, dstKey: string, cond: WriteCondition) => Promise<boolean>
  /** `deleteFile` with a condition. */
  deleteIf?: (conn: C, key: string, cond: WriteCondition) => Promise<void>
  /**
   * `moveFile` whose copy and delete are both conditioned on the source's
   * version (the one given, else the one its own lookup sees), and whose
   * copy carries the destination's.
   */
  moveFileIf?: (
    conn: C,
    srcKey: string,
    dstKey: string,
    cond: WriteCondition,
    source: string | null,
  ) => Promise<boolean>
  /**
   * `movePrefix` moving each key only if it is still the version the mount
   * saw (`known`), else the one listed, onto a destination key the mount
   * holds a version for (`dstKnown`) only if it is still that version; the
   * keys that changed stay where they were and are thrown in a ConditionLostError.
   */
  movePrefixIf?: (
    conn: C,
    srcPfx: string,
    dstPfx: string,
    known: KnownVersions,
    dstKnown: KnownVersions,
  ) => Promise<boolean>
  /**
   * `deletePrefix` deleting each key only if it is still the version the
   * mount saw, else the one listed.
   */
  deletePrefixIf?: (conn: C, pfx: string, known: KnownVersions) => Promise<void>
}

/** The refusal for a one-path op whose condition lost. Mirrors Python's `refused`. */
export function refused(
  path: PathSpec,
  err: ConditionLostError,
  cond: WriteCondition | null,
): Promise<StaleWriteError> {
  return stale(path, { gone: err.gone, version: cond?.ifMatch ?? null })
}

/**
 * Keep every lost key's version, then throw the walk's later error. Mirrors
 * Python's `keep_all_lost`.
 */
export async function keepAllLost(
  root: PathSpec,
  keyPrefix: string,
  err: ConditionLostError,
): Promise<never> {
  await keepLost(root, keyPrefix, err, null)
  throw err.error
}

/**
 * Keep what a walk's refusal measured, and name the key it reports: every
 * lost key but the named one keeps its version; a later error that stopped
 * the walk is thrown instead, with every version kept. Mirrors Python's
 * `keep_walk`.
 */
export async function keepWalk(
  root: PathSpec,
  keyPrefix: string,
  err: ConditionLostError,
): Promise<string> {
  if (err.error !== null) await keepAllLost(root, keyPrefix, err)
  const key = err.keys[0] ?? ''
  await keepLost(root, keyPrefix, err, key)
  return key
}

/**
 * Keep the version of each key a walk lost on, except `skip`, which the
 * refusal itself names and keeps. Mirrors Python's `keep_lost`.
 */
export async function keepLost(
  root: PathSpec,
  keyPrefix: string,
  err: ConditionLostError,
  skip: string | null,
): Promise<void> {
  for (const [key, version] of err.versions) {
    const kept = version === OwnRead.ABSENT ? null : version
    if (key !== skip) await dropCached(kp.keyPath(root, keyPrefix, key), kept)
  }
}

/**
 * The `*If` hook a conditional op calls. Every `write: conditional` object
 * store is on the S3 driver, which carries them all; Box and Dropbox condition
 * their own ops and never reach here.
 */
export function requireHook<F>(hook: F | undefined): F {
  if (hook === undefined) throw new Error('conditional op on a driver without its hook')
  return hook
}
