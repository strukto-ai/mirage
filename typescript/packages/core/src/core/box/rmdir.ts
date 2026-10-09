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
  conditioned,
  evictAfter,
  heldVersions,
  invalidateAfterUnlink,
  invalidateSubtree,
  keepRefused,
} from '../../cache/context.ts'
import { liftLost, lostCount, record, startOp } from '../../observe/context.ts'
import type { PathSpec } from '../../types.ts'
import { childSpec } from '../../utils/key_prefix.ts'
import { enoent, enotdir, enotempty } from '../../errors/fs.ts'
import { BoxApiError, type BoxTokenManager } from './client.ts'
import { type BoxItem, deleteFile, deleteFolder, deleteWebLink, listFolderItems } from './api.ts'
import { GONE_STATUS, LOST_STATUS, CONFLICT_STATUS } from './constants.ts'
import { liveOf } from './fingerprint.ts'
import { pathParts, resolveItem } from './resolve.ts'
import { deleteResolved } from './unlink.ts'

export async function rmdir(accessor: BoxAccessor, path: PathSpec): Promise<void> {
  const item = await resolveItem(accessor, pathParts(path))
  if (item === null) throw enoent(path.virtual)
  if (item.type !== 'folder') throw enotdir(path.virtual)
  await deleteEmptyFolder(accessor.tokenManager, item.id, path)
  await invalidateAfterUnlink(path)
}

/**
 * Delete a folder only if it is empty, as POSIX rmdir does. Box answers 409
 * for a folder that still holds anything; naming that is ours, since a bare
 * BoxApiError reaches the caller as a condition `classify` cannot name (EIO
 * over FUSE). Mirrors Python's `delete_empty_folder`.
 *
 * @throws ENOTEMPTY when the folder still holds anything
 */
export async function deleteEmptyFolder(
  tm: BoxTokenManager,
  folderId: string,
  path: PathSpec,
): Promise<void> {
  try {
    await deleteFolder(tm, folderId, false)
  } catch (err) {
    if (err instanceof BoxApiError && err.status === CONFLICT_STATUS) throw enotempty(path)
    throw err
  }
}

/** Delete a web link plainly: it holds no content, so no version. Mirrors Python's `_delete_link`. */
async function deleteLink(tm: BoxTokenManager, linkId: string, path: PathSpec): Promise<void> {
  try {
    await deleteWebLink(tm, linkId)
  } catch (err) {
    if (!(err instanceof BoxApiError) || err.status !== GONE_STATUS) throw err
    console.debug(`${path.virtual} already gone: ${String(err)}`)
  }
}

/**
 * Delete a folder file by file, each only if it is still as measured: a file
 * the agent read is held to that version, any other to the sha1 its listing
 * row shows, and goes out with its etag as `If-Match`. A file that changed
 * stays, with the folders above it, and lands in `lost` with the version it
 * was measured on. Returns whether the folder itself was deleted.
 */
async function deleteTree(
  accessor: BoxAccessor,
  folder: BoxItem,
  path: PathSpec,
  lost: [PathSpec, string | null][],
): Promise<boolean> {
  const tm = accessor.tokenManager
  const kids = await listFolderItems(tm, folder.id)
  const walk = kids.map((kid) => [kid, childSpec(path, kid.name)] as const)
  const held = await heldVersions(walk.map(([, spec]) => spec))
  let emptied = true
  for (const [i, [kid, spec]] of walk.entries()) {
    if (kid.type === 'folder') {
      emptied = (await deleteTree(accessor, kid, spec, lost)) && emptied
      continue
    }
    if (kid.type === 'web_link') {
      await deleteLink(tm, kid.id, spec)
      continue
    }
    const live = liveOf(kid)
    const want = held[i] ?? live?.content ?? null
    if (want !== live?.content) {
      lost.push([spec, want])
      emptied = false
      continue
    }
    try {
      await deleteFile(tm, kid.id, want !== null ? live.native : null)
    } catch (err) {
      if (!(err instanceof BoxApiError)) throw err
      if (err.status === GONE_STATUS) {
        console.debug(`${spec.virtual} already gone: ${String(err)}`)
        continue
      }
      if (err.status !== LOST_STATUS) throw err
      lost.push([spec, want])
      emptied = false
    }
  }
  if (!emptied) return false
  await deleteEmptyFolder(tm, folder.id, path)
  return true
}

/** Delete `item`: a file alone, a folder walked or whole. Mirrors Python's `_remove`. */
async function remove(
  accessor: BoxAccessor,
  path: PathSpec,
  item: BoxItem,
  lost: [PathSpec, string | null][],
): Promise<boolean> {
  if (item.type !== 'folder') await deleteResolved(accessor, path, item)
  else if (conditioned(path, 'delete')) await deleteTree(accessor, item, path, lost)
  else await deleteFolder(accessor.tokenManager, item.id, true)
  return true
}

/**
 * Remove a file or a folder and everything under it. On a `write:
 * conditional` mount a folder is walked file by file, as `rm -r` walks an
 * object store: the files that changed since they were measured stay, and the
 * first is named. Mirrors Python's `rm_r`.
 */
export async function rmR(accessor: BoxAccessor, path: PathSpec): Promise<void> {
  const parts = pathParts(path)
  if (parts.length === 0) return
  const item = await resolveItem(accessor, parts)
  if (item === null) throw enoent(path.virtual)
  const upto = lostCount()
  const timer = startOp()
  const lost: [PathSpec, string | null][] = []
  await evictAfter(
    () => remove(accessor, path, item, lost),
    async (done) => {
      record('rm_r', path.virtual, 'box', 0, timer)
      await invalidateSubtree(path)
      const refusal = await keepRefused(lost)
      if (done === true && refusal !== null) throw refusal
    },
  )
  liftLost(path, upto, true)
}
