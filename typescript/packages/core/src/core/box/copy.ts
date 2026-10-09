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
import { record, startOp, type OpTimer } from '../../observe/context.ts'
import type { StaleWriteError } from '../../errors/types.ts'
import { BoxApiError } from './client.ts'
import { CONFLICT_STATUS } from './constants.ts'
import { copyFile, copyFolder, deleteFile, listFolderItems, refused, type BoxItem } from './api.ts'
import { liveOf } from './fingerprint.ts'
import { pathParts, resolveItem, resolveParentId } from './resolve.ts'

/**
 * Clear the file a copy or move lands on, conditioned when it must be: on a
 * `write: conditional` mount the delete carries the destination's etag when
 * mirage holds its version, so a destination changed since it was read is
 * refused, not destroyed. Returns the condition the op carries, null on an
 * unconditional mount: a destination that comes back before the copy lands is
 * then another writer's.
 * Mirrors Python's `replace_file`.
 *
 * @throws a stale-write error when the destination changed or went since it was read
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
      const lost = await refused(dst, err, cond, etag)
      if (lost !== null) throw lost
      throw err
    }
  }
  return cond
}

/**
 * The refusal for a copy or move whose cleared destination came back: another
 * writer took the name between the clear and the copy. Its file is not deleted
 * a second time, and the version held stays held, so a retry without a read is
 * refused again; a folder or web link there holds no file version, so it keeps
 * none. Null for any other failure. Mirrors Python's `retaken`.
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
 * Copy `item` to `dst`, merging a folder into a folder. `changed` receives each
 * path this copy changed (a destination cleared, a file landed, a folder copy
 * sent), with its step's timer and whether it is a folder; `sent` receives each
 * file path a request may have gone out for, landed or not. Mirrors Python's
 * `_copy_into`.
 */
async function copyInto(
  accessor: BoxAccessor,
  item: BoxItem,
  dst: PathSpec,
  changed: [PathSpec, OpTimer, boolean][],
  sent: PathSpec[],
): Promise<void> {
  const tm = accessor.tokenManager
  const timer = startOp()
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
    sent.push(dst)
    cond = await replaceFile(accessor, dst, existing)
    changed.push([dst, timer, false])
    cleared = true
  } else if (existing === null && item.type === 'file') {
    cond = await replaceFile(accessor, dst, null)
  }
  try {
    if (item.type === 'folder') {
      changed.push([dst, timer, true])
      await copyFolder(tm, item.id, dstParent, newName)
    } else {
      sent.push(dst)
      await copyFile(tm, item.id, dstParent, newName)
      if (!cleared) changed.push([dst, timer, false])
    }
  } catch (err) {
    throw (await retaken(err, cond, dst)) ?? err
  }
}

/**
 * Copy a file or folder server-side.
 *
 * The copy records the paths it changed: a file it cleared or landed, and a
 * folder it copied whole. The eviction runs also when the copy fails, since a
 * merge may have landed some children before one failed. On an unconditional
 * mount it evicts `dst` (its subtree for a folder). On a `write: conditional`
 * mount it evicts exactly what changed, so a merge leaves the versions of the
 * files it did not touch, and a file request that raised, which may or may not
 * have landed, loses its cached bytes and listing but keeps the version mirage
 * holds, so a change it did make is refused rather than written over.
 */
export async function copy(accessor: BoxAccessor, src: PathSpec, dst: PathSpec): Promise<void> {
  const item = await resolveItem(accessor, pathParts(src))
  if (item === null) throw enoent(src.virtual)
  const folder = item.type === 'folder'
  const changed: [PathSpec, OpTimer, boolean][] = []
  const sent: PathSpec[] = []
  await evictAfter(
    () => copyInto(accessor, item, dst, changed, sent),
    async () => {
      for (const [spec, timer] of changed) record('copy', spec.virtual, 'box', 0, timer)
      if (!writesConditioned(dst)) {
        await (folder ? invalidateSubtree(dst) : invalidateAfterWrite(dst))
        return
      }
      for (const [spec, , whole] of changed) {
        if (whole) await invalidateSubtree(spec)
        else await invalidateAfterWrite(spec)
      }
      const landed = new Set(changed.map(([spec]) => spec.virtual))
      for (const spec of sent) if (!landed.has(spec.virtual)) await evictKeepingVersion(spec)
    },
  )
}
