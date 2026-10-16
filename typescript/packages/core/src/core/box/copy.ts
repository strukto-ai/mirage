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
import { nativeCondition, stale, writeCondition } from '../../cache/context.ts'
import type { WriteCondition } from '../../cache/types.ts'
import type { FileStat, PathSpec } from '../../types.ts'
import type { Handed } from '../../vfs/types.ts'
import { childSpec } from '../../utils/key_prefix.ts'
import { uploadStat } from '../../utils/upload.ts'
import { eisdir, enoent, enotdir } from '../../errors/fs.ts'
import { liftLost, lostCount, record, startOp, type OpTimer } from '../../observe/context.ts'
import type { StaleWriteError } from '../../errors/types.ts'
import { BoxApiError } from './client.ts'
import { CONFLICT_STATUS } from './constants.ts'
import {
  absentOn404,
  copyFile,
  copyFolder,
  deleteFile,
  listFolderItems,
  refused,
  type BoxItem,
} from './api.ts'
import { liveOf } from './fingerprint.ts'
import { statFromItem } from './readdir.ts'
import { itemOf, liveItem, liveItemOf, parentFolder, pathParts } from './resolve.ts'

/**
 * Clear the file a copy or move lands on, held to the version read. Returns
 * the op's condition, null when unconditional. Mirrors Python's `replace_file`.
 */
export async function replaceFile(
  accessor: BoxAccessor,
  dst: PathSpec,
  lead: BoxItem | null,
): Promise<WriteCondition | null> {
  let existing = lead
  const cond = await writeCondition(dst, 'copy')
  if (cond !== null) existing = await liveItem(accessor, dst, existing)
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
 * meanwhile: recorded now, the retract stays older than that read, and the
 * dispatcher serves no cached bytes for a path the line retracted. Mirrors
 * Python's `_landed`.
 */
function landed(dst: PathSpec, whole: boolean, timer: OpTimer, upto: number): void {
  record(whole ? 'copy_prefix' : 'copy', dst.virtual, 'box', 0, timer)
  liftLost(dst, upto, whole)
}

/**
 * Copy `item` to `dst`, merging a folder into a folder: `folderId` is the
 * folder `dst` lands in, `existing` what is at `dst`. Answers the copy's stat,
 * null for a merge or a reply that names none. Mirrors Python's `_copy_into`.
 */
async function copyInto(
  accessor: BoxAccessor,
  item: BoxItem,
  dst: PathSpec,
  folderId: string,
  existing: BoxItem | null,
): Promise<FileStat | null> {
  const tm = accessor.tokenManager
  const timer = startOp()
  const upto = lostCount()
  if (item.type === 'folder' && existing !== null && existing.type === 'folder') {
    // Merge into an existing folder, as cp -r does: copy each child rather
    // than replacing the folder, so pre-existing entries survive. A folder the
    // listing named but Box no longer has is ENOENT, which has the mount list
    // again and copy into what is there now.
    const there = new Map(
      (await absentOn404(dst.virtual, () => listFolderItems(tm, existing.id))).map(
        (kid) => [kid.name, kid] as const,
      ),
    )
    const kids = await absentOn404(dst.virtual, () => listFolderItems(tm, item.id))
    for (const child of kids) {
      await copyInto(
        accessor,
        child,
        childSpec(dst, child.name),
        existing.id,
        there.get(child.name) ?? null,
      )
    }
    return null
  }
  const dstParts = pathParts(dst)
  const newName = dstParts[dstParts.length - 1] ?? ''
  let cond: WriteCondition | null = null
  if (existing !== null && existing.id !== item.id) {
    // Folder onto folder already merged above, so what is left is a type
    // mismatch or a file replacing a file. cp refuses either mismatch
    // (rename(2)'s own errnos), mirroring gdrive and the msgraph copyTree;
    // only a file gives way to a file.
    if (existing.type === 'folder') throw eisdir(dst.virtual)
    if (item.type === 'folder') throw enotdir(dst.virtual)
    cond = await replaceFile(accessor, dst, existing)
  } else if (existing === null && item.type === 'file') {
    cond = await replaceFile(accessor, dst, null)
  }
  let made: BoxItem
  try {
    if (item.type === 'folder') {
      made = await copyFolder(tm, item.id, folderId, newName)
      landed(dst, true, timer, upto)
    } else {
      made = await copyFile(tm, item.id, folderId, newName)
      landed(dst, false, timer, upto)
    }
  } catch (err) {
    throw (await retaken(err, cond, dst)) ?? err
  }
  return uploadStat(made, statFromItem, dst.virtual)
}

/**
 * Copy a file or folder server-side, recording each path it changed. Each path
 * is recorded as it lands; a replaced file only once its copy lands, so through
 * the clear the line keeps its version. A landed path also lifts the line's lost
 * marks on it, and beneath it for a folder copied whole. The dispatcher evicts
 * what the copy changed, also when it fails. Answers the copy's stat, null for
 * a merge or a reply that names none.
 */
export async function copy(
  accessor: BoxAccessor,
  src: PathSpec,
  dst: PathSpec,
  handed: Handed = {},
): Promise<FileStat | null> {
  const item = itemOf(handed.entry)
  if (item === null) throw enoent(src.virtual)
  return copyInto(
    accessor,
    item,
    dst,
    parentFolder(accessor, dst, handed.dstParent),
    await liveItemOf(accessor, dst, handed.dstEntry),
  )
}
