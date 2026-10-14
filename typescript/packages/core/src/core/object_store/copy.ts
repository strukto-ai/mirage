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
import { settleAfter, writeCondition } from '../../cache/context.ts'
import { type OpTimer, record, startOp } from '../../observe/context.ts'
import type { PathSpec } from '../../types.ts'
import { enoent } from '../../errors/fs.ts'
import * as kp from '../../utils/key_prefix.ts'
import {
  type ExistsFn,
  type ObjectStoreDriver,
  type PairFn,
  refused,
  requireHook,
} from './driver.ts'
import { ConditionLostError } from './errors.ts'

/**
 * Account for a copy onto `dst`: the change is recorded, so a snapshot drops
 * the destination's earlier pin. Mirrors Python's settle_copy.
 */
export function settleCopy(dst: PathSpec, vfs: string, timer: OpTimer): void {
  // The destination, not the source: a copy replaces dst's bytes and leaves
  // src untouched, so only dst's token stops describing its object.
  record('copy', dst.virtual, vfs, 0, timer)
}

/**
 * Build single-object copy over one driver. The driver must carry a
 * native copy — a store without one leaves copy unwired, which the
 * dispatcher surfaces as ENOTSUP.
 */
export function makeCopy<A extends Accessor, C>(
  driver: ObjectStoreDriver<A, C>,
  exists: ExistsFn<A>,
): PairFn<A> {
  const { copyFile } = driver
  if (copyFile === undefined) {
    throw new Error(
      `${driver.vfs} driver has no native copy; leave copy unwired instead of building it`,
    )
  }
  return async function copy(accessor, src, dst) {
    const kpfx = driver.keyPrefixOf(accessor)
    const srcKey = kp.apply(kpfx, src.mountPath)
    const dstKey = kp.apply(kpfx, dst.mountPath)
    if (srcKey === dstKey) {
      // Copying an object onto its own key is a no-op we must not send:
      // AWS and MinIO reject it, and on a versioned store it would only
      // stack an identical revision. A missing source still has to fail
      // (#150).
      if (!(await exists(accessor, src))) throw enoent(src)
      return
    }
    const timer = startOp()
    const settle = (copied: boolean | undefined): Promise<void> => {
      // undefined when the store threw: only a clean false, "nothing was
      // copied", is safe to skip -- a throw may have left a partial object
      // behind.
      if (copied !== false) settleCopy(dst, driver.vfs, timer)
      return Promise.resolve()
    }
    const cond = await writeCondition(dst, 'copy')
    const { conn, close } = await driver.connect(accessor)
    let copied: boolean
    try {
      copied = await settleAfter(async () => {
        try {
          return cond !== null
            ? await requireHook(driver.copyIf)(conn, srcKey, dstKey, cond)
            : await copyFile(conn, srcKey, dstKey)
        } finally {
          await close()
        }
      }, settle)
    } catch (err) {
      if (err instanceof ConditionLostError) throw await refused(dst, err, cond)
      throw err
    }
    if (!copied) throw enoent(src)
  }
}
