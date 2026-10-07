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
import { evictAfter, invalidateAfterWrite, invalidateAncestors } from '../../cache/context.ts'
import { activeRecorder, record, startOp } from '../../observe/context.ts'
import { enoent } from '../../errors/fs.ts'
import * as kp from '../../utils/key_prefix.ts'
import type { ExistsFn, ObjectStoreDriver, PairFn } from './driver.ts'

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
    const recorder = activeRecorder()
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
    const timer = startOp(recorder)
    const settle = async (copied: boolean | undefined): Promise<void> => {
      // undefined when the store threw: only a clean false, "nothing was
      // copied", is safe to skip -- a throw may have left a partial object
      // behind.
      if (copied === false) return
      // The destination, not the source: a copy replaces dst's bytes and
      // leaves src untouched, so only dst's token stops describing its
      // object. (dropbox records a copy against src; that is inert there
      // only because dropbox emits no read record at all, so no dropbox
      // path is ever pinned.)
      record('copy', dst.virtual, driver.vfs, 0, timer)
      // The eviction rides with the record, as in unlink.
      await invalidateAfterWrite(dst)
      // The copy can materialize the destination's missing ancestors.
      await invalidateAncestors(dst)
    }
    const { conn, close } = await driver.connect(accessor)
    const copied = await evictAfter(async () => {
      try {
        return await copyFile(conn, srcKey, dstKey)
      } finally {
        await close()
      }
    }, settle)
    if (!copied) throw enoent(src)
  }
}
