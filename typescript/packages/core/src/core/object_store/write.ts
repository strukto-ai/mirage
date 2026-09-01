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
import { invalidateAfterWrite, invalidateAncestors } from '../../cache/context.ts'
import { record, startOp } from '../../observe/context.ts'
import type { PathSpec } from '../../types.ts'
import { enoent } from '../../utils/errors.ts'
import * as kp from '../../utils/key_prefix.ts'
import type { MkdirFn, ObjectStoreDriver, PathFn, TruncateFn, WriteFn } from './driver.ts'

// Put one object, translating a missing container to ENOENT. The driver
// primitives speak keys, so a store error for a missing repository or
// bucket names the backend key, and only the factory holds the PathSpec
// the message has to carry.
async function put<A extends Accessor, C>(
  driver: ObjectStoreDriver<A, C>,
  conn: C,
  key: string,
  data: Uint8Array,
  path: PathSpec,
): Promise<void> {
  try {
    await driver.put(conn, key, data)
  } catch (err) {
    if (driver.isNotFound(err)) throw enoent(path)
    throw err
  }
}

/** Build the whole-object write over one driver. */
export function makeWriteBytes<A extends Accessor, C>(driver: ObjectStoreDriver<A, C>): WriteFn<A> {
  return async function writeBytes(accessor, path, data) {
    const key = kp.apply(driver.keyPrefixOf(accessor), path.mountPath)
    const timer = startOp()
    const { conn, close } = await driver.connect(accessor)
    try {
      await put(driver, conn, key, data, path)
    } finally {
      await close()
    }
    record('write', path.virtual, driver.resource, data.byteLength, timer)
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
    const timer = startOp()
    const { conn, close } = await driver.connect(accessor)
    try {
      await put(driver, conn, key, new Uint8Array(0), path)
    } finally {
      await close()
    }
    record('create', path.virtual, driver.resource, 0, timer)
    await invalidateAfterWrite(path)
    // An empty put materializes missing parents exactly like write.
    await invalidateAncestors(path)
  }
}

/** Build read-slice-pad-rewrite truncation over one driver. */
export function makeTruncate<A extends Accessor, C>(
  driver: ObjectStoreDriver<A, C>,
): TruncateFn<A> {
  return async function truncate(accessor, path, length) {
    const key = kp.apply(driver.keyPrefixOf(accessor), path.mountPath)
    const timer = startOp()
    const { conn, close } = await driver.connect(accessor)
    try {
      const data = (await driver.get(conn, key)) ?? new Uint8Array(0)
      const result = new Uint8Array(length)
      result.set(data.subarray(0, Math.min(data.byteLength, length)), 0)
      // Remaining bytes are already zero-filled (Uint8Array default).
      await put(driver, conn, key, result, path)
    } finally {
      await close()
    }
    record('truncate', path.virtual, driver.resource, 0, timer)
    await invalidateAfterWrite(path)
    // Truncating a missing key creates it, parents included.
    await invalidateAncestors(path)
  }
}

/** Build the marker-object mkdir over one driver. */
export function makeMkdir<A extends Accessor, C>(driver: ObjectStoreDriver<A, C>): MkdirFn<A> {
  return async function mkdir(accessor, path, parents = false) {
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
      await driver.put(conn, pfx, new Uint8Array(0))
    } finally {
      await close()
    }
    await invalidateAfterWrite(path)
    if (parents) await invalidateAncestors(path)
  }
}
