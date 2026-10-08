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
  dropCached,
  evictAfter,
  invalidateAfterMove,
  invalidateAncestors,
  knownVersions,
  moveCondition,
  stale,
} from '../../cache/context.ts'
import { liftLost, lostCount, record, startOp } from '../../observe/context.ts'
import { enoent } from '../../errors/fs.ts'
import type { PathSpec } from '../../types.ts'
import * as kp from '../../utils/key_prefix.ts'
import {
  type ExistsFn,
  keepWalk,
  type ObjectStoreDriver,
  type PairFn,
  requireHook,
} from './driver.ts'
import type { Measured } from '../../cache/types.ts'
import { ConditionLostError } from './errors.ts'

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
    // Which of the two paths ran, because only the prefix walk moves a
    // subtree and capture retracts on the op name. A rejection from
    // moveFile leaves this 'rename': the walk never ran, so nothing under
    // the prefix can have moved.
    let op = 'rename'
    // A move is a copy then a delete, so both carry a condition.
    const [cond, source] = await moveCondition(src, dst)
    const move = async (conn: C): Promise<boolean> => {
      if (cond !== null) {
        const moveFileIf = requireHook(driver.moveFileIf)
        if (await moveFileIf(conn, srcKey, kp.apply(kpfx, dst.mountPath), cond, source)) return true
        op = 'rename_prefix'
        return requireHook(driver.movePrefixIf)(
          conn,
          kp.applyDir(kpfx, src.mountPath),
          kp.applyDir(kpfx, dst.mountPath),
          knownVersions(src, kpfx),
          knownVersions(dst, kpfx),
        )
      }
      if (await moveFile(conn, srcKey, kp.apply(kpfx, dst.mountPath))) return true
      // A directory owns no object of its own, so a clean false here is
      // the ordinary way into the prefix walk, not an answer about it.
      op = 'rename_prefix'
      return movePrefix(conn, kp.applyDir(kpfx, src.mountPath), kp.applyDir(kpfx, dst.mountPath))
    }
    const settle = async (moved: boolean | undefined): Promise<void> => {
      // undefined when the store threw: movePrefix is a paginated walk
      // that can fail having already moved keys, so only a clean false,
      // where nothing moved at all, is skipped.
      if (moved === false) return
      // Two records for one op, because a move invalidates the token of
      // both paths: src's object left, dst's was replaced by it. Order is
      // free -- both are pure retractions and deletions commute -- but it
      // stops being free if either carries a token.
      record(op, src.virtual, driver.vfs, 0, timer)
      record(op, dst.virtual, driver.vfs, 0, timer)
      // The eviction rides with the records, as in unlink. Only a clean
      // moveFile names a file, which has nothing beneath it; movePrefix
      // relocates every key under src, and a rejection leaves the kind
      // unknown, so those evict both subtrees.
      const folder = op !== 'rename' || moved === undefined
      await invalidateAfterMove(dst, folder)
      await invalidateAfterMove(src, folder)
      // The move can create the destination's missing ancestors and erase
      // the source's prefix-only ones in the same call.
      await invalidateAncestors(dst)
      await invalidateAncestors(src)
    }
    // The path a refusal names and the version its write sent.
    const named = (key: string, err: ConditionLostError): [PathSpec, Measured | null] => {
      if (key === kp.apply(kpfx, dst.mountPath)) return [dst, cond?.ifMatch ?? null]
      if (key === srcKey) return [src, err.versions.get(key) ?? source]
      return [kp.keyPath(src, kpfx, key), err.versions.get(key) ?? null]
    }
    const upto = lostCount()
    const { conn, close } = await driver.connect(accessor)
    let moved: boolean
    try {
      moved = await evictAfter(async () => {
        try {
          return await move(conn)
        } finally {
          await close()
        }
      }, settle)
    } catch (err) {
      if (!(err instanceof ConditionLostError)) throw err
      const [lost, sent] = named(await keepWalk(src, kpfx, err), err)
      // The untouched end of a refused move keeps its version.
      if (err.landed) await dropCached(dst)
      else if (lost === dst) {
        if (source !== null && source !== '') await dropCached(src, source)
      } else if (cond?.ifMatch !== undefined) await dropCached(dst, cond.ifMatch)
      throw await stale(lost, { landed: err.landed, gone: err.gone, version: sent })
    }
    if (!moved) throw enoent(src)
    liftLost(src, upto, op !== 'rename')
    liftLost(dst, upto, op !== 'rename')
  }
}
