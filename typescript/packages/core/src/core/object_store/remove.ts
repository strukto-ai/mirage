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
  invalidateAfterUnlink,
  invalidateAncestors,
  invalidateSubtree,
} from '../../cache/context.ts'
import { enoent, enotempty } from '../../utils/errors.ts'
import * as kp from '../../utils/key_prefix.ts'
import { rstripSlash } from '../../utils/slash.ts'
import type { ObjectStoreDriver, PathFn } from './driver.ts'

/** Build single-key deletion over one driver. */
export function makeUnlink<A extends Accessor, C>(driver: ObjectStoreDriver<A, C>): PathFn<A> {
  return async function unlink(accessor, path) {
    const key = kp.apply(driver.keyPrefixOf(accessor), path.mountPath)
    const { conn, close } = await driver.connect(accessor)
    try {
      await driver.deleteFile(conn, key)
    } finally {
      await close()
    }
    await invalidateAfterUnlink(path)
    // Deleting the last key under a prefix makes every ancestor that
    // existed only as that prefix disappear, so their cached listings are
    // stale symmetrically to the write case.
    await invalidateAncestors(path)
  }
}

/**
 * Build recursive prefix deletion over one driver.
 *
 * Serves both the `rmR` and `rmdir` slots: on a keyed store an empty
 * directory is its marker object, so removing it and removing a subtree
 * are the same prefix delete.
 */
export function makeRemovePrefix<A extends Accessor, C>(
  driver: ObjectStoreDriver<A, C>,
): PathFn<A> {
  return async function removePrefix(accessor, path) {
    const pfx = kp.applyDir(driver.keyPrefixOf(accessor), path.mountPath)
    const { conn, close } = await driver.connect(accessor)
    try {
      await driver.deletePrefix(conn, pfx)
    } finally {
      await close()
    }
    // Not invalidateAfterUnlink: a prefix delete takes every key below
    // with it, and each of those listings and bodies was cached under
    // its own key, so nothing above them evicts one.
    await invalidateSubtree(path)
    // Same rationale as unlink: ancestors that existed only as this
    // prefix are gone now.
    await invalidateAncestors(path)
  }
}

/**
 * Build POSIX `rmdir` over one driver: refuse a non-empty prefix.
 *
 * Not `makeRemovePrefix`. On a keyed store an empty directory is its
 * zero-byte marker object, so a prefix delete removes an empty directory
 * correctly and a *non-empty* one recursively, which is `rm -r`, not
 * `rmdir`. Sharing one function between the two slots made `rmdir` destroy
 * a whole subtree for every caller that does not pre-check emptiness
 * itself, and the command builders are the only callers that do: FUSE,
 * `ws.fs` and the sandbox runtimes all reach the op directly.
 *
 * The listing is the same one `readdir` reads, so the two agree on what a
 * child is: a `marker` entry is the prefix's own marker (or a key the
 * delimiter listing could not classify) and proves only that the directory
 * exists, while any `f` or `d` entry is a child and makes this ENOTEMPTY.
 * The walk stops at the first child rather than listing the whole directory
 * to answer a yes/no question.
 *
 * A prefix holding no key at all -- not even the marker -- is a directory
 * the store does not have, and rmdir(2) reports ENOENT for it.
 * `makeRemovePrefix` stays silent there on purpose, because `rm -r` owns
 * that refusal through its own `-f` handling.
 */
export function makeRmdir<A extends Accessor, C>(driver: ObjectStoreDriver<A, C>): PathFn<A> {
  return async function rmdir(accessor, path) {
    const pfx = kp.applyDir(driver.keyPrefixOf(accessor), path.mountPath)
    const isRoot = rstripSlash(path.mountPath) === ''
    const { conn, close } = await driver.connect(accessor)
    let sawKey = false
    let hasChild = false
    try {
      for await (const child of driver.listChildren(conn, pfx)) {
        sawKey = true
        if (child.kind !== 'marker') {
          hasChild = true
          break
        }
      }
      // The marker only, never the prefix: a child created between the
      // listing above and this delete would be taken down with it, which
      // is the subtree loss this function exists to stop in a smaller
      // window. A root holding no key has no marker and falls through as
      // the no-op the prefix delete already was.
      if (!hasChild && sawKey) await driver.deleteFile(conn, pfx)
    } finally {
      await close()
    }
    if (hasChild) throw enotempty(path)
    if (!sawKey && !isRoot) throw enoent(path)
    await invalidateAfterUnlink(path)
    await invalidateAncestors(path)
  }
}
