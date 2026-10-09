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

import type { DropboxAccessor } from '../../accessor/dropbox.ts'
import {
  conditioned,
  evictAfter,
  heldVersions,
  invalidateAncestors,
  invalidateSubtree,
  keepRefused,
} from '../../cache/context.ts'
import { liftLost, lostCount, record, startOp } from '../../observe/context.ts'
import type { PathSpec } from '../../types.ts'
import { enoent, enotempty } from '../../errors/fs.ts'
import { childSpec } from '../../utils/key_prefix.ts'
import { DropboxApiError } from './client.ts'
import { deletePath, listFolder, lookup, type DropboxEntry } from './api.ts'
import { GONE_SUMMARIES, LOST_SUMMARIES } from './constants.ts'
import { liveOf } from './fingerprint.ts'
import { dropboxPathOf } from './paths.ts'
import { deleteResolved } from './unlink.ts'

/**
 * Delete a folder file by file, each only if it is still as measured: a file
 * the agent read is held to that version, any other to the content_hash its
 * listing row shows, and goes out with its rev as `parent_rev`. A file that
 * changed stays, with the folders above it, and lands in `lost` with the
 * version it was measured on. delete_v2 takes a folder whole, so a folder goes
 * only once a listing shows it empty; a file another writer creates in it
 * between that listing and the delete goes with it. Returns whether the folder
 * itself was deleted.
 */
async function deleteTree(
  accessor: DropboxAccessor,
  path: PathSpec,
  lost: [PathSpec, string | null][],
): Promise<boolean> {
  const tm = accessor.tokenManager
  const apiPath = dropboxPathOf(accessor, path)
  const entries = await listFolder(tm, apiPath)
  const walk = entries.map((entry) => [entry, childSpec(path, entry.name)] as const)
  const held = await heldVersions(walk.map(([, spec]) => spec))
  let emptied = true
  for (const [i, [entry, spec]] of walk.entries()) {
    if (entry['.tag'] === 'folder') {
      emptied = (await deleteTree(accessor, spec, lost)) && emptied
      continue
    }
    const live = liveOf(entry)
    const want = held[i] ?? live?.content ?? null
    if (want !== live?.content) {
      lost.push([spec, want])
      emptied = false
      continue
    }
    try {
      await deletePath(tm, dropboxPathOf(accessor, spec), want !== null ? live.native : null)
    } catch (err) {
      if (!(err instanceof DropboxApiError)) throw err
      if (GONE_SUMMARIES.some((s) => err.summary.startsWith(s))) {
        console.debug(`${spec.virtual} already gone: ${String(err)}`)
        continue
      }
      if (!LOST_SUMMARIES.some((s) => err.summary.startsWith(s))) throw err
      lost.push([spec, want])
      emptied = false
    }
  }
  if (!emptied) return false
  if ((await listFolder(tm, apiPath, { limit: 1 })).length > 0) throw enotempty(path)
  await deletePath(tm, apiPath)
  return true
}

/** Delete a looked-up entry: a file alone, a folder walked. Mirrors Python's `_remove`. */
async function remove(
  accessor: DropboxAccessor,
  path: PathSpec,
  entry: DropboxEntry,
  lost: [PathSpec, string | null][],
): Promise<boolean> {
  if (entry['.tag'] === 'folder') await deleteTree(accessor, path, lost)
  else await deleteResolved(accessor, path, entry)
  return true
}

/**
 * Remove a file or a folder and everything under it. On a `write:
 * conditional` mount a folder is walked file by file, as `rm -r` walks an
 * object store: the files that changed since they were measured stay, and the
 * first is named. Otherwise delete_v2 removes a folder recursively, so rm -r
 * maps to one call. Mirrors Python's `rm_r`.
 */
export async function rmR(accessor: DropboxAccessor, path: PathSpec): Promise<void> {
  const apiPath = dropboxPathOf(accessor, path)
  const timer = startOp()
  if (!conditioned(path, 'delete')) {
    try {
      await deletePath(accessor.tokenManager, apiPath)
    } catch (err) {
      if (err instanceof DropboxApiError && err.status === 409) throw enoent(path.virtual)
      throw err
    }
    record('rm_r', path.virtual, 'dropbox', 0, timer)
    await invalidateSubtree(path)
    await invalidateAncestors(path)
    return
  }
  const entry = await lookup(accessor.tokenManager, apiPath)
  if (entry === null) throw enoent(path.virtual)
  const upto = lostCount()
  const lost: [PathSpec, string | null][] = []
  await evictAfter(
    () => remove(accessor, path, entry, lost),
    async (done) => {
      record('rm_r', path.virtual, 'dropbox', 0, timer)
      await invalidateSubtree(path)
      await invalidateAncestors(path)
      const refusal = await keepRefused(lost)
      if (done === true && refusal !== null) throw refusal
    },
  )
  liftLost(path, upto, true)
}
