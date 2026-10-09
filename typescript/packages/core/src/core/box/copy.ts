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

import type { BoxAccessor } from '../../accessor/box.ts'
import {
  evictAfter,
  evictKeepingVersion,
  writesConditioned,
  invalidateAfterWrite,
  invalidateSubtree,
  nativeCondition,
  stale,
  writeCondition,
} from '../../cache/context.ts'
import type { WriteCondition } from '../../cache/types.ts'
import type { PathSpec } from '../../types.ts'
import { childSpec } from '../../utils/key_prefix.ts'
import { eisdir, enoent, enotdir } from '../../errors/fs.ts'
import { liftLost, lostCount, record, startOp, type OpTimer } from '../../observe/context.ts'
import type { StaleWriteError } from '../../errors/types.ts'
import { BoxApiError } from './client.ts'
import { CONFLICT_STATUS } from './constants.ts'
import { copyFile, copyFolder, deleteFile, listFolderItems, refused, type BoxItem } from './api.ts'
import { liveOf } from './fingerprint.ts'
import { pathParts, resolveItem, resolveParentId } from './resolve.ts'

/**
 * Clear the file a copy or move lands on, held to the version read. Returns
 * the op's condition, null when unconditional. Mirrors Python's `replace_file`.
 */
export async function replaceFile(
  accessor: BoxAccessor,
  dst: PathSpec,
  existing: BoxItem | null,
): Promise<WriteCondition | null> {
  const cond = await writeCondition(dst, 'copy')
  const etag = await nativeCondition(dst, cond, liveOf(existing), 'copy')
  if (existing !== null) {
    try {
      await deleteFile(accessor.tokenManager, existing.id, etag)
    } catch (err) {
      throw (await refused(dst, err, cond, etag)) ?? err
    }
  }
  return cond
}

/**
 * The refusal for a copy or move whose cleared destination came back. The held
 * version stays held; a folder or web link there keeps none. Mirrors Python's
 * `retaken`.
 */
export async function retaken(
  err: unknown,
  cond: WriteCondition | null,
  dst: PathSpec,
): Promise<StaleWriteError | null> {
  if (cond === null || !(err instanceof BoxApiError) || err.status !== CONFLICT_STATUS) return null
  if (
    cond.ifMatch !== undefined &&
    cond.ifMatch !== '' &&
    (err.conflict === null || err.conflict === 'file')
  ) {
    return stale(dst, { version: cond.ifMatch })
  }
  return stale(dst, { gone: true })
}

/**
 * Record a path the copy changed, as soon as it changed. A later step of the
 * same copy can take a while, and another stage of the line may read the path
 * meanwhile: recorded now, the retract stays older than that read. Mirrors
 * Python's `_landed`.
 */
function landed(
  changed: [PathSpec, boolean][],
  dst: PathSpec,
  whole: boolean,
  timer: OpTimer,
  upto: number,
): void {
  changed.push([dst, whole])
  record(whole ? 'copy_prefix' : 'copy', dst.virtual, 'box', 0, timer)
  if (whole) liftLost(dst, upto, true)
}

/**
 * Copy `item` to `dst`, merging a folder into a folder. `changed` receives each
 * path this copy changed (a destination cleared, a file or a whole folder
 * landed), recorded as it changed, and whether it is a folder; `sent` receives
 * each path a request may have gone out for, landed or not, and whether it is
 * a folder. Mirrors Python's `_copy_into`.
 */
async function copyInto(
  accessor: BoxAccessor,
  item: BoxItem,
  dst: PathSpec,
  changed: [PathSpec, boolean][],
  sent: [PathSpec, boolean][],
): Promise<void> {
  const tm = accessor.tokenManager
  const timer = startOp()
  const upto = lostCount()
  const dstParts = pathParts(dst)
  const existing = await resolveItem(accessor, dstParts)
  if (item.type === 'folder' && existing !== null && existing.type === 'folder') {
    // Merge into an existing folder, as cp -r does: copy each child
    // rather than replacing the folder, so pre-existing entries survive.
    for (const child of await listFolderItems(tm, item.id)) {
      await copyInto(accessor, child, childSpec(dst, child.name), changed, sent)
    }
    return
  }
  const dstParent = await resolveParentId(accessor, dstParts)
  if (dstParent === null) throw enoent(dst.virtual)
  const newName = dstParts[dstParts.length - 1] ?? ''
  let cond: WriteCondition | null = null
  let cleared = false
  if (existing !== null && existing.id !== item.id) {
    // Folder onto folder already merged above, so what is left is a type
    // mismatch or a file replacing a file. cp refuses either mismatch
    // (rename(2)'s own errnos), mirroring gdrive and the msgraph copyTree;
    // only a file gives way to a file.
    if (existing.type === 'folder') throw eisdir(dst.virtual)
    if (item.type === 'folder') throw enotdir(dst.virtual)
    sent.push([dst, false])
    cond = await replaceFile(accessor, dst, existing)
    landed(changed, dst, false, timer, upto)
    cleared = true
  } else if (existing === null && item.type === 'file') {
    cond = await replaceFile(accessor, dst, null)
  }
  try {
    if (item.type === 'folder') {
      sent.push([dst, true])
      await copyFolder(tm, item.id, dstParent, newName)
      landed(changed, dst, true, timer, upto)
    } else {
      sent.push([dst, false])
      await copyFile(tm, item.id, dstParent, newName)
      if (!cleared) landed(changed, dst, false, timer, upto)
    }
  } catch (err) {
    throw (await retaken(err, cond, dst)) ?? err
  }
}

/**
 * Copy a file or folder server-side, recording each path it changed. Each path
 * is recorded as it changes; the eviction runs once the copy ends, also when it
 * fails. A conditional mount evicts only what
 * changed, and a request that raised keeps its held version. A folder copied
 * whole also lifts the line's lost marks beneath it; one whose request raised
 * evicts its subtree and records nothing.
 */
export async function copy(accessor: BoxAccessor, src: PathSpec, dst: PathSpec): Promise<void> {
  const item = await resolveItem(accessor, pathParts(src))
  if (item === null) throw enoent(src.virtual)
  const folder = item.type === 'folder'
  const changed: [PathSpec, boolean][] = []
  const sent: [PathSpec, boolean][] = []
  await evictAfter(
    () => copyInto(accessor, item, dst, changed, sent),
    async () => {
      if (!writesConditioned(dst)) {
        await (folder ? invalidateSubtree(dst) : invalidateAfterWrite(dst))
        return
      }
      for (const [spec, whole] of changed) {
        if (whole) await invalidateSubtree(spec)
        else await invalidateAfterWrite(spec)
      }
      const done = new Set(changed.map(([spec]) => spec.virtual))
      for (const [spec, whole] of sent) {
        if (done.has(spec.virtual)) continue
        if (whole) await invalidateSubtree(spec)
        else await evictKeepingVersion(spec)
      }
    },
  )
}
