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
import { invalidateAncestors, invalidateSubtree } from '../../cache/context.ts'
import { record, startOp } from '../../observe/context.ts'
import { enoent } from '../../utils/errors.ts'
import * as kp from '../../utils/key_prefix.ts'
import type { ExistsFn, ObjectStoreDriver, PairFn } from './driver.ts'

/**
 * Build file-or-prefix relocation over one driver.
 *
 * A single object moves with the driver's native file move. A directory
 * owns no object of its own, so it moves as a prefix walk; a source that
 * is neither is ENOENT rather than the raw store error. The driver must
 * carry a native move — a store without one leaves rename unwired,
 * which the dispatcher surfaces as ENOTSUP.
 */
export function makeRename<A extends Accessor, C>(
  driver: ObjectStoreDriver<A, C>,
  exists: ExistsFn<A>,
): PairFn<A> {
  const { moveFile, movePrefix } = driver
  if (moveFile === undefined || movePrefix === undefined) {
    throw new Error(
      `${driver.vfs} driver has no native move; leave rename unwired instead of building it`,
    )
  }
  return async function rename(accessor, src, dst) {
    const kpfx = driver.keyPrefixOf(accessor)
    const srcKey = kp.apply(kpfx, src.mountPath)
    if (srcKey === kp.apply(kpfx, dst.mountPath)) {
      // POSIX rename(2): the same existing file succeeds and performs no
      // other action. Reaching the move below would instead delete the
      // object on any store that accepts the self-copy, and error on the
      // ones that reject it (#150).
      if (!(await exists(accessor, src))) throw enoent(src)
      return
    }
    const timer = startOp()
    const { conn, close } = await driver.connect(accessor)
    // null until the store answers: false means it told us cleanly that
    // nothing moved, and only a clean "nothing" is safe to skip.
    let moved: boolean | null = null
    // Which of the two paths ran, because only the prefix walk moves a
    // subtree and capture retracts on the op name. A rejection from
    // moveFile leaves this 'rename': the walk below never ran, so
    // nothing under the prefix can have moved.
    let op = 'rename'
    try {
      try {
        moved = await moveFile(conn, srcKey, kp.apply(kpfx, dst.mountPath))
        if (!moved) {
          // A directory owns no object of its own, so a clean false here
          // is the ordinary way into the prefix walk, not an answer about
          // it. Back to unanswered before asking, or a walk that rejects
          // having already moved keys reads as "nothing moved" and skips
          // the record it is in `finally` for.
          moved = null
          op = 'rename_prefix'
          moved = await movePrefix(
            conn,
            kp.applyDir(kpfx, src.mountPath),
            kp.applyDir(kpfx, dst.mountPath),
          )
        }
      } finally {
        if (moved !== false) {
          // Two records for one op, because a move invalidates the token
          // of both paths: src's object left, dst's was replaced by it.
          // In the `finally` because movePrefix is a paginated walk that
          // can fail having already moved keys; skipped only on a clean
          // false, where nothing moved at all. Order is free -- both are
          // pure retractions and deletions commute -- but it stops being
          // free if either carries a token.
          record(op, src.virtual, driver.vfs, 0, timer)
          record(op, dst.virtual, driver.vfs, 0, timer)
        }
        await close()
      }
    } finally {
      if (moved !== false) {
        // The eviction rides with the records, on the same condition, as
        // in unlink. Subtrees, not single paths: movePrefix relocates
        // every key under src, so each listing and body cached below the
        // old name names something that is no longer there, and each one
        // below the new name predates the move.
        await invalidateSubtree(dst)
        await invalidateSubtree(src)
        // The move can create the destination's missing ancestors and
        // erase the source's prefix-only ones in the same call.
        await invalidateAncestors(dst)
        await invalidateAncestors(src)
      }
    }
    if (!moved) throw enoent(src)
  }
}
