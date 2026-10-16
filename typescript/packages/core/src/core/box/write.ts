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

import { ByteSpool } from '../../io/spool.ts'
import type { ByteSource } from '../../io/types.ts'
import type { BoxAccessor } from '../../accessor/box.ts'
import { nativeCondition, writeCondition } from '../../cache/context.ts'
import { record, startOp } from '../../observe/context.ts'
import { type FileStat, FileType, type PathSpec } from '../../types.ts'
import type { Handed } from '../../vfs/types.ts'
import { eisdir } from '../../errors/fs.ts'
import { uploadStat } from '../../utils/upload.ts'
import { type BoxItem, refused, uploadFileVersion, uploadNewFile } from './api.ts'
import { BoxApiError } from './client.ts'
import { CONFLICT_STATUS } from './constants.ts'
import { liveOf } from './fingerprint.ts'
import { statFromItem } from './readdir.ts'
import { itemOf, liveItem, liveItemOf, parentFolder, pathParts } from './resolve.ts'

/**
 * Upload `data` as a new file at `path`, plainly. The listing named nothing
 * there; Box holding a file by that name now means the listing is older than
 * it, so the file found live gets a new version, as a write to a listed file
 * would. Mirrors Python's `_upload_new`.
 */
async function uploadNew(
  accessor: BoxAccessor,
  path: PathSpec,
  data: Uint8Array | ByteSpool,
  folderId: string,
): Promise<unknown> {
  const tm = accessor.tokenManager
  const parts = pathParts(path)
  try {
    return await uploadNewFile(tm, folderId, parts[parts.length - 1] ?? '', data)
  } catch (err) {
    if (
      !(err instanceof BoxApiError) ||
      err.status !== CONFLICT_STATUS ||
      (err.conflict !== null && err.conflict !== 'file')
    )
      throw err
    const found = await liveItem(accessor, path, null)
    if (found?.type !== 'file') throw err
    return uploadFileVersion(tm, found.id, found.name, data, null)
  }
}

/**
 * Upload a new file, or a new version of an existing one. A held version goes
 * out as the file's etag. Answers the stored file's stat, null for a reply
 * that names none. Mirrors Python's `write`.
 */
export async function write(
  accessor: BoxAccessor,
  path: PathSpec,
  data: Uint8Array | ByteSpool,
  handed: Handed = {},
): Promise<FileStat | null> {
  const parts = pathParts(path)
  if (parts.length === 0 || handed.entry?.type === FileType.DIRECTORY) throw eisdir(path.virtual)
  const tm = accessor.tokenManager
  const cond = await writeCondition(path, 'put')
  const timer = startOp()
  // What is there now: the listed row can be older than the path's file, and
  // older than the read a held version came from.
  const existing =
    cond !== null
      ? await liveItem(accessor, path, itemOf(handed.entry))
      : await liveItemOf(accessor, path, handed.entry)
  const etag = await nativeCondition(path, cond, liveOf(existing), 'put')
  let reply: unknown
  try {
    if (existing?.type === 'file') {
      // Overwrite uploads a new version under the same id, keeping Box's own
      // name so a box-native file isn't renamed with the vfs suffix.
      reply = await uploadFileVersion(tm, existing.id, existing.name, data, etag)
    } else if (cond === null) {
      reply = await uploadNew(accessor, path, data, parentFolder(accessor, path, handed.parent))
    } else {
      reply = await uploadNewFile(
        tm,
        parentFolder(accessor, path, handed.parent),
        parts[parts.length - 1] ?? '',
        data,
      )
    }
  } catch (err) {
    throw (await refused(path, err, cond, etag)) ?? err
  }
  const entries: unknown =
    typeof reply === 'object' && reply !== null && !Array.isArray(reply)
      ? (reply as { entries?: unknown }).entries
      : undefined
  const first = Array.isArray(entries) ? (entries[0] as BoxItem | undefined) : undefined
  const stored = uploadStat(first, statFromItem, path.virtual)
  record('write', path.virtual, 'box', data instanceof ByteSpool ? data.size : data.length, timer, {
    fingerprint: stored?.fingerprint ?? null,
  })
  return stored
}

export async function writeStream(
  accessor: BoxAccessor,
  path: PathSpec,
  data: ByteSource,
  handed: Handed = {},
): Promise<FileStat | null> {
  const spool = new ByteSpool()
  try {
    await spool.fill(data)
    return await write(accessor, path, spool, handed)
  } finally {
    await spool.close()
  }
}
