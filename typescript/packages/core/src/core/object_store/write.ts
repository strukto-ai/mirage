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
import {
  runWithOwnVersion,
  invalidateAfterWrite,
  invalidateAncestors,
  writeCondition,
} from '../../cache/context.ts'
import { OwnRead, type WriteCondition } from '../../cache/types.ts'
import { record, revisionFor, startOp } from '../../observe/context.ts'
import type { FileStat, PathSpec } from '../../types.ts'
import { eexist, enoent, enotdir, enotsup, isMissingPath } from '../../errors/fs.ts'
import * as kp from '../../utils/key_prefix.ts'
import { ancestors, norm, parent } from '../../utils/path.ts'
import { isDir } from '../../utils/stat_view.ts'
import {
  type MkdirFn,
  type ObjectMeta,
  type ObjectStoreDriver,
  type PathFn,
  type StatFn,
  type TruncateFn,
  type WriteFn,
  refused,
  requireHook,
} from './driver.ts'
import { ConditionLostError } from './errors.ts'
import { makeStat } from './stat.ts'

// Put one object, translating a missing container to ENOENT. The driver
// primitives speak keys, so a store error for a missing repository or
// bucket names the backend key, and only the factory holds the PathSpec
// the message has to carry.
//
// Callers stamp `meta.fingerprint` on the op record and deliberately
// leave `meta.revision` off it. captureFingerprints reads a write record
// now, and an entry carrying a revision is pinned by installFingerprints
// instead of drift-checked, so on a versioned store stamping one here
// would pin replay to the revision preceding this write.
async function put<A extends Accessor, C>(
  driver: ObjectStoreDriver<A, C>,
  conn: C,
  key: string,
  data: Uint8Array,
  path: PathSpec,
  cond: WriteCondition | null = null,
): Promise<ObjectMeta | null> {
  try {
    if (cond === null) return await driver.put(conn, key, data)
    return await requireHook(driver.putIf)(conn, key, data, cond)
  } catch (err) {
    if (err instanceof ConditionLostError) throw await refused(path, err, cond)
    if (driver.isNotFound(err)) throw enoent(path)
    throw err
  }
}

/** Build the whole-object write over one driver. */
export function makeWrite<A extends Accessor, C>(driver: ObjectStoreDriver<A, C>): WriteFn<A> {
  return async function write(accessor, path, data) {
    const key = kp.apply(driver.keyPrefixOf(accessor), path.mountPath)
    const cond = await writeCondition(path, 'put')
    const timer = startOp()
    const { conn, close } = await driver.connect(accessor)
    let meta: ObjectMeta | null
    try {
      meta = await put(driver, conn, key, data, path, cond)
    } finally {
      await close()
    }
    record('write', path.virtual, driver.vfs, data.byteLength, timer, {
      fingerprint: meta?.fingerprint ?? null,
    })
    await invalidateAfterWrite(path)
    // A put materializes every missing level of the key at once, so the
    // listings above the immediate parent gained entries too.
    await invalidateAncestors(path)
  }
}

/** Build the empty-object create over one driver. */
export function makeCreate<A extends Accessor, C>(driver: ObjectStoreDriver<A, C>): PathFn<A> {
  return async function create(accessor, path) {
    const key = kp.apply(driver.keyPrefixOf(accessor), path.mountPath)
    const cond = await writeCondition(path, 'put')
    const timer = startOp()
    const { conn, close } = await driver.connect(accessor)
    let meta: ObjectMeta | null
    try {
      meta = await put(driver, conn, key, new Uint8Array(0), path, cond)
    } finally {
      await close()
    }
    record('create', path.virtual, driver.vfs, 0, timer, {
      fingerprint: meta?.fingerprint ?? null,
    })
    await invalidateAfterWrite(path)
    // An empty put materializes missing parents exactly like write.
    await invalidateAncestors(path)
  }
}

/** Build read-slice-pad-rewrite truncation over one driver. */
export function makeTruncate<A extends Accessor, C>(
  driver: ObjectStoreDriver<A, C>,
): TruncateFn<A> {
  return async function truncate(accessor, path, length, noCreate = false) {
    if (noCreate) throw enotsup(driver.vfs, 'truncate --no-create', path)
    const key = kp.apply(driver.keyPrefixOf(accessor), path.mountPath)
    const timer = startOp()
    const { conn, close } = await driver.connect(accessor)
    let meta: ObjectMeta | null
    try {
      if (length === 0) {
        // Emptying reads nothing, so it carries the agent's version.
        const cond = await writeCondition(path, 'put')
        meta = await put(driver, conn, key, new Uint8Array(0), path, cond)
      } else {
        let existing: Uint8Array | null
        let own: string | OwnRead | null = null
        if (driver.getVersioned !== undefined) {
          let got: [Uint8Array, string | null] | null
          try {
            got = await driver.getVersioned(conn, key, revisionFor(path.virtual))
          } catch (err) {
            if (isMissingPath(err)) throw enoent(path)
            throw err
          }
          existing = got?.[0] ?? null
          own = got === null ? OwnRead.ABSENT : got[1]
        } else {
          existing = await driver.get(conn, key)
        }
        const data = existing ?? new Uint8Array(0)
        const result = new Uint8Array(length)
        result.set(data.subarray(0, Math.min(data.byteLength, length)), 0)
        // Remaining bytes are already zero-filled (Uint8Array default).
        const cond = await runWithOwnVersion(path, own, () => writeCondition(path, 'put'))
        meta = await put(driver, conn, key, result, path, cond)
      }
    } finally {
      await close()
    }
    record('truncate', path.virtual, driver.vfs, 0, timer, {
      fingerprint: meta?.fingerprint ?? null,
    })
    await invalidateAfterWrite(path)
    // Truncating a missing key creates it, parents included.
    await invalidateAncestors(path)
  }
}

/** What the store holds at `path`, as a key or a prefix. */
async function rowAt<A extends Accessor>(
  stat: StatFn<A>,
  accessor: A,
  path: PathSpec,
): Promise<FileStat | null> {
  try {
    return await stat(accessor, path)
  } catch (err) {
    if (isMissingPath(err)) return null
    throw err
  }
}

/** The outermost ancestor of `path` the store holds as a file. */
async function fileAbove<A extends Accessor, C>(
  driver: ObjectStoreDriver<A, C>,
  accessor: A,
  path: PathSpec,
): Promise<string | null> {
  const prefix = driver.keyPrefixOf(accessor)
  const { conn, close } = await driver.connect(accessor)
  try {
    for (const ancestor of ancestors(norm(path.mountPath))) {
      if ((await driver.head(conn, kp.apply(prefix, ancestor))) !== null) return ancestor
    }
  } finally {
    await close()
  }
  return null
}

/** Build the marker-object mkdir over one driver. */
export function makeMkdir<A extends Accessor, C>(driver: ObjectStoreDriver<A, C>): MkdirFn<A> {
  const stat = makeStat(driver)
  return async function mkdir(accessor, path, parents = false) {
    const row = await rowAt(stat, accessor, path)
    if (row !== null && !(parents && isDir(row))) {
      // mkdir(2) refuses a name that exists, file or directory, and
      // `mkdir -p` passes only a directory. Rewriting the marker answered
      // success instead, and only the command builders check first: a
      // guest, FUSE and ws.vfs reach the op directly, the same callers
      // `makeRmdir` protects.
      throw eexist(path)
    }
    if (row === null) {
      const above = await fileAbove(driver, accessor, path)
      // A directory cannot sit under a file, and a marker below one made
      // both unreadable. mkdir(2) blames the operand; the walk `-p` makes
      // stops at the file and names it.
      if (above !== null) throw enotdir(parents ? kp.mountedPath(path, above) : path)
      const up = parent(norm(path.mountPath))
      // mkdir(2) makes one directory, under one that exists; only `-p`
      // makes the chain, so a marker under a missing parent answers
      // ENOENT however the caller reached it. A store without markers
      // holds no empty directory, so a parent made a moment ago has no
      // row to find.
      if (
        !parents &&
        driver.markersSupported !== false &&
        up !== '/' &&
        (await rowAt(stat, accessor, kp.mountedPath(path, up))) === null
      ) {
        throw enoent(path)
      }
    }
    if (driver.markersSupported === false) {
      // The store refuses the marker client-side (hf: create_dir is
      // unsupported and a slash-terminated write is IsADirectory), so a
      // directory exists only while it holds a key and mkdir has
      // nothing to write: `mkdir x` then `rmdir x` is ENOENT here but
      // fine on a marker store.
      return
    }
    // Object stores have no real directories; parents is implicit. A
    // zero-byte marker keyed at the prefix makes the empty directory
    // visible.
    const pfx = kp.applyDir(driver.keyPrefixOf(accessor), path.mountPath)
    if (pfx === '') return
    const { conn, close } = await driver.connect(accessor)
    try {
      // `-p` on a directory that holds its marker leaves the marker as it
      // is: a rewrite replaces its metadata and, in a versioned bucket, adds
      // a version. A directory only a key below implies still gets one.
      if (row !== null && (await driver.head(conn, pfx)) !== null) return
      await driver.put(conn, pfx, new Uint8Array(0))
    } finally {
      await close()
    }
    await invalidateAfterWrite(path)
    if (parents) await invalidateAncestors(path)
  }
}
