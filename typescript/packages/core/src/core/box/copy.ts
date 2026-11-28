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
import { conditionVersion, nativeCondition, stale, writeCondition } from '../../cache/context.ts'
import type { WriteCondition } from '../../cache/types.ts'
import type { FileStat, PathSpec } from '../../types.ts'
import type { Handed } from '../../vfs/types.ts'
import { childSpec } from '../../utils/key_prefix.ts'
import { uploadStat } from '../../utils/upload.ts'
import { eisdir, enoent, enotdir } from '../../errors/fs.ts'
import { liftLost, lostCount, record, startOp, type OpTimer } from '../../observe/context.ts'
import type { StaleWriteError } from '../../errors/types.ts'
import { asideName, landThenRetire, setAside } from '../api/replace.ts'
import { BoxApiError, type BoxTokenManager } from './client.ts'
import { CONFLICT_STATUS, GONE_STATUS } from './constants.ts'
import {
  absentOn404,
  copyFile,
  copyFolder,
  deleteFile,
  getFileInfo,
  getFolderInfo,
  listFolderItems,
  refused,
  updateFile,
  updateFolder,
  type BoxItem,
} from './api.ts'
import { liveOf } from './fingerprint.ts'
import { statFromItem } from './readdir.ts'
import { itemOf, liveItem, liveItemOf, parentFolder, pathParts } from './resolve.ts'
import { deleteEmptyFolder } from './rmdir.ts'

/**
 * What a copy or move onto `dst` is held to, refusing a stale one: the op's
 * condition (null when unconditional), the file there as the condition saw
 * it, and the etag its delete carries. Mirrors Python's `held_file`.
 */
export async function heldFile(
  accessor: BoxAccessor,
  dst: PathSpec,
  lead: BoxItem | null,
): Promise<[WriteCondition | null, BoxItem | null, string | null]> {
  let existing = lead
  const cond = await writeCondition(dst, 'copy')
  if (cond !== null) existing = await liveItem(accessor, dst, existing)
  const etag = await nativeCondition(dst, cond, liveOf(existing), 'copy')
  return [cond, existing, etag]
}

/**
 * Delete the file a copy or move replaces, held to `etag`. Mirrors Python's
 * `clear_file`.
 */
export async function clearFile(
  accessor: BoxAccessor,
  dst: PathSpec,
  existing: BoxItem,
  cond: WriteCondition | null,
  etag: string | null,
): Promise<void> {
  try {
    await deleteFile(accessor.tokenManager, existing.id, etag)
  } catch (err) {
    throw (await refused(dst, err, cond, etag)) ?? err
  }
}

/**
 * Clear the file a copy or move lands on, held to the version read. Returns
 * the op's condition, null when unconditional. Mirrors Python's `replace_file`.
 */
export async function replaceFile(
  accessor: BoxAccessor,
  dst: PathSpec,
  lead: BoxItem | null,
): Promise<WriteCondition | null> {
  const [cond, existing, etag] = await heldFile(accessor, dst, lead)
  if (existing !== null) await clearFile(accessor, dst, existing, cond, etag)
  return cond
}

/**
 * The refusal for a copy or move whose cleared destination came back. The
 * condition the op sent stays held, whatever took the name. Mirrors Python's
 * `retaken`.
 */
export async function retaken(
  err: unknown,
  cond: WriteCondition | null,
  dst: PathSpec,
): Promise<StaleWriteError | null> {
  if (cond === null || !(err instanceof BoxApiError) || err.status !== CONFLICT_STATUS) return null
  const held = conditionVersion(cond)
  return stale(dst, { version: held === '' ? null : held })
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
 * Give `item` a name, and a folder unless `folderId` is undefined, the move
 * held to `etag` when one is given. Mirrors Python's `place`.
 */
export async function place(
  tm: BoxTokenManager,
  item: BoxItem,
  name: string,
  folderId: string | undefined,
  etag: string | null = null,
): Promise<BoxItem> {
  const opts = folderId === undefined ? { name, etag } : { name, parentId: folderId, etag }
  return item.type === 'folder' ? updateFolder(tm, item.id, opts) : updateFile(tm, item.id, opts)
}

/** Whether a file or folder is gone from Box, or sits in its trash. Mirrors Python's `gone`. */
export async function gone(tm: BoxTokenManager, item: BoxItem): Promise<boolean> {
  let info: BoxItem & { item_status?: string }
  try {
    info =
      item.type === 'folder' ? await getFolderInfo(tm, item.id) : await getFileInfo(tm, item.id)
  } catch (err) {
    if (err instanceof BoxApiError && err.status === GONE_STATUS) return true
    throw err
  }
  return info.item_status === 'trashed'
}

/**
 * Land an item on the name `existing` holds, replacing it, answering what the
 * landing answered. Box refuses a taken name, so `existing` moves aside under a
 * staged name first, a file held to `etag`, then the item lands on the name,
 * and what moved aside is deleted last: a file held to the version its move
 * answered, a folder only while it is empty. A refused or lost step puts both
 * back, and a landing whose answer was lost but which went through
 * (`arrived`) is finished (`landThenRetire`). `takeBack` is held to the
 * version a landing landed as. Mirrors Python's `replace_item`.
 */
export async function replaceItem(
  accessor: BoxAccessor,
  dst: PathSpec,
  existing: BoxItem,
  cond: WriteCondition | null,
  etag: string | null,
  land: () => Promise<BoxItem>,
  takeBack: (landed: BoxItem) => Promise<unknown>,
  arrived: () => Promise<BoxItem | null>,
): Promise<BoxItem> {
  const tm = accessor.tokenManager
  const parts = pathParts(dst)
  const name = parts[parts.length - 1] ?? ''
  let moved: BoxItem
  try {
    moved = await setAside(
      () => place(tm, existing, asideName(name), undefined, etag),
      () => place(tm, existing, name, undefined),
    )
  } catch (err) {
    throw (await refused(dst, err, cond, etag)) ?? err
  }
  const retire = async (): Promise<void> => {
    if (existing.type === 'folder') await deleteEmptyFolder(tm, existing.id, dst)
    else await clearFile(accessor, dst, moved, cond, moved.etag ?? null)
  }
  try {
    return await landThenRetire(
      land,
      takeBack,
      retire,
      () => gone(tm, existing),
      () => place(tm, existing, name, undefined),
      arrived,
    )
  } catch (err) {
    throw (await retaken(err, cond, dst)) ?? err
  }
}

/**
 * The copy of `item` a copy onto `name` landed: a file of that name in
 * `folderId` with `item`'s sha1, null when there is none, or no sha1 to tell it
 * by. Mirrors Python's `_copied_as`.
 */
async function copiedAs(
  tm: BoxTokenManager,
  item: BoxItem,
  folderId: string,
  name: string,
): Promise<BoxItem | null> {
  const sha1 = item.sha1
  if (sha1 === undefined || sha1 === '') return null
  const found = (await listFolderItems(tm, folderId)).find(
    (entry) => entry.type === 'file' && entry.name === name && entry.sha1 === sha1,
  )
  return found ?? null
}

/**
 * Copy a file onto the file that holds `dst`'s name. A stale destination is
 * refused before anything is sent; the rest is `replaceItem`, whose undo for a
 * landed copy is its delete, held to the version it landed as, so a write onto
 * it since is kept. A copy whose answer was lost is found by its sha1
 * (`copiedAs`). Mirrors Python's `_copy_over`.
 */
async function copyOver(
  accessor: BoxAccessor,
  item: BoxItem,
  dst: PathSpec,
  folderId: string,
  existing: BoxItem,
): Promise<BoxItem> {
  const tm = accessor.tokenManager
  const dstParts = pathParts(dst)
  const newName = dstParts[dstParts.length - 1] ?? ''
  const [cond, live, etag] = await heldFile(accessor, dst, existing)
  if (live === null) {
    try {
      return await copyFile(tm, item.id, folderId, newName)
    } catch (err) {
      throw (await retaken(err, cond, dst)) ?? err
    }
  }
  return replaceItem(
    accessor,
    dst,
    live,
    cond,
    etag,
    () => copyFile(tm, item.id, folderId, newName),
    (made) => deleteFile(tm, made.id, made.etag ?? null),
    () => copiedAs(tm, item, folderId, newName),
  )
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
  if (existing !== null && existing.id !== item.id) {
    // Folder onto folder already merged above, so what is left is a type
    // mismatch or a file replacing a file. cp refuses either mismatch
    // (rename(2)'s own errnos), mirroring gdrive and the msgraph copyTree;
    // only a file gives way to a file.
    if (existing.type === 'folder') throw eisdir(dst.virtual)
    if (item.type === 'folder') throw enotdir(dst.virtual)
    const made = await copyOver(accessor, item, dst, folderId, existing)
    landed(dst, false, timer, upto)
    return uploadStat(made, statFromItem, dst.virtual)
  }
  const cond =
    existing === null && item.type === 'file' ? await replaceFile(accessor, dst, null) : null
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
