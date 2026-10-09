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
  evictKeepingVersion,
  heldVersions,
  invalidateAfterUnlink,
  invalidateSubtree,
  keepRefused,
} from '../../cache/context.ts'
import { liftLost, lostCount, record, startOp, type OpTimer } from '../../observe/context.ts'
import type { PathSpec } from '../../types.ts'
import { childSpec, outermost } from '../../utils/key_prefix.ts'
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
 * Delete a folder only if it is empty: Box's 409 becomes ENOTEMPTY. Mirrors
 * Python's `delete_empty_folder`.
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

/** Delete a web link plainly, since it holds no content. Mirrors Python's `_delete_link`. */
async function deleteLink(tm: BoxTokenManager, linkId: string, path: PathSpec): Promise<void> {
  try {
    await deleteWebLink(tm, linkId)
  } catch (err) {
    if (!(err instanceof BoxApiError) || err.status !== GONE_STATUS) throw err
    console.debug(`${path.virtual} already gone: ${String(err)}`)
  }
}

/**
 * Record a path the walk removed, the moment its delete landed. Recorded now,
 * the retract stays older than a read another stage of the line makes of a
 * file recreated there while the walk goes on. Mirrors Python's `_removed`.
 */
async function removed(
  path: PathSpec,
  op: 'unlink' | 'rm_r',
  upto: number,
  timer: OpTimer,
): Promise<void> {
  record(op, path.virtual, 'box', 0, timer)
  liftLost(path, upto, op === 'rm_r')
  await invalidateAfterUnlink(path)
}

/**
 * Delete a folder file by file, each held to the version read or listed. A file
 * that changed stays, with the folders above it. Each file and folder is
 * recorded as its delete lands. Returns whether the folder itself was deleted.
 */
async function deleteTree(
  accessor: BoxAccessor,
  folder: BoxItem,
  path: PathSpec,
  lost: [PathSpec, string | null][],
  swept: PathSpec[],
): Promise<boolean> {
  const tm = accessor.tokenManager
  const kids = await listFolderItems(tm, folder.id)
  const walk = kids.map((kid) => [kid, childSpec(path, kid.name)] as const)
  const held = await heldVersions(walk.map(([, spec]) => spec))
  let emptied = true
  for (const [i, [kid, spec]] of walk.entries()) {
    if (kid.type === 'folder') {
      emptied = (await deleteTree(accessor, kid, spec, lost, swept)) && emptied
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
    const upto = lostCount()
    const timer = startOp()
    try {
      await deleteFile(tm, kid.id, want !== null ? live.native : null)
    } catch (err) {
      if (!(err instanceof BoxApiError)) {
        await evictKeepingVersion(spec)
        throw err
      }
      if (err.status !== GONE_STATUS) {
        if (err.status !== LOST_STATUS) {
          await evictKeepingVersion(spec)
          throw err
        }
        lost.push([spec, want])
        emptied = false
        continue
      }
      console.debug(`${spec.virtual} already gone: ${String(err)}`)
    }
    await removed(spec, 'unlink', upto, timer)
  }
  if (!emptied) return false
  const upto = lostCount()
  const timer = startOp()
  swept.push(path)
  await deleteEmptyFolder(tm, folder.id, path)
  await removed(path, 'rm_r', upto, timer)
  return true
}

/** Delete `item`: a file alone, a folder walked or whole. Mirrors Python's `_remove`. */
async function remove(
  accessor: BoxAccessor,
  path: PathSpec,
  item: BoxItem,
  walked: boolean,
  lost: [PathSpec, string | null][],
  swept: PathSpec[],
): Promise<boolean> {
  if (item.type !== 'folder') await deleteResolved(accessor, path, item)
  else if (walked) await deleteTree(accessor, item, path, lost, swept)
  else await deleteFolder(accessor.tokenManager, item.id, true)
  return true
}

/**
 * Remove a file or folder; a conditional mount walks it file by file. A walk
 * records each file and folder (the operand among them) as its delete lands,
 * never the operand's subtree up front or at the end, so a file it never reached
 * keeps its version, and a read another stage makes after a removal outranks it. Anything else is recorded once, for
 * the operand's whole subtree. Mirrors Python's `rm_r`.
 */
export async function rmR(accessor: BoxAccessor, path: PathSpec): Promise<void> {
  const parts = pathParts(path)
  if (parts.length === 0) return
  const item = await resolveItem(accessor, parts)
  if (item === null) throw enoent(path.virtual)
  const walked = item.type === 'folder' && conditioned(path, 'delete')
  const upto = lostCount()
  const timer = startOp()
  const lost: [PathSpec, string | null][] = []
  const swept: PathSpec[] = []
  await evictAfter(
    () => remove(accessor, path, item, walked, lost, swept),
    async (done) => {
      if (!walked) {
        record('rm_r', path.virtual, 'box', 0, timer)
        await invalidateSubtree(path)
      }
      for (const folder of outermost(swept)) await invalidateSubtree(folder)
      const refusal = await keepRefused(lost)
      if (done === true && refusal !== null) throw refusal
    },
  )
  if (!walked) liftLost(path, upto, true)
}
