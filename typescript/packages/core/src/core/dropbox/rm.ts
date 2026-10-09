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
  evictKeepingVersion,
  heldVersions,
  invalidateAfterUnlink,
  invalidateAncestors,
  invalidateSubtree,
  keepRefused,
} from '../../cache/context.ts'
import { liftLost, lostCount, record, startOp, type OpTimer } from '../../observe/context.ts'
import type { PathSpec } from '../../types.ts'
import { enoent, enotempty } from '../../errors/fs.ts'
import { childSpec, outermost } from '../../utils/key_prefix.ts'
import { DropboxApiError } from './client.ts'
import { deletePath, listFolder, lookup, type DropboxEntry } from './api.ts'
import { GONE_SUMMARIES, LOST_SUMMARIES } from './constants.ts'
import { liveOf } from './fingerprint.ts'
import { dropboxPathOf } from './paths.ts'
import { deleteResolved } from './unlink.ts'

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
  record(op, path.virtual, 'dropbox', 0, timer)
  liftLost(path, upto, op === 'rm_r')
  await invalidateAfterUnlink(path)
}

/**
 * Delete a folder file by file, each held to the version read or listed. A file
 * that changed stays, with the folders above it; a folder goes once a listing
 * shows it empty. Each file and folder is recorded as its delete lands. Returns
 * whether the folder itself was deleted.
 */
async function deleteTree(
  accessor: DropboxAccessor,
  path: PathSpec,
  lost: [PathSpec, string | null][],
  swept: PathSpec[],
): Promise<boolean> {
  const tm = accessor.tokenManager
  const apiPath = dropboxPathOf(accessor, path)
  const entries = await listFolder(tm, apiPath)
  const walk = entries.map((entry) => [entry, childSpec(path, entry.name)] as const)
  const held = await heldVersions(walk.map(([, spec]) => spec))
  let emptied = true
  for (const [i, [entry, spec]] of walk.entries()) {
    if (entry['.tag'] === 'folder') {
      emptied = (await deleteTree(accessor, spec, lost, swept)) && emptied
      continue
    }
    const live = liveOf(entry)
    const want = held[i] ?? live?.content ?? null
    if (want !== live?.content) {
      lost.push([spec, want])
      emptied = false
      continue
    }
    const upto = lostCount()
    const timer = startOp()
    try {
      await deletePath(tm, dropboxPathOf(accessor, spec), want !== null ? live.native : null)
    } catch (err) {
      if (!(err instanceof DropboxApiError)) {
        await evictKeepingVersion(spec)
        throw err
      }
      if (!GONE_SUMMARIES.some((s) => err.summary.startsWith(s))) {
        if (!LOST_SUMMARIES.some((s) => err.summary.startsWith(s))) {
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
  if ((await listFolder(tm, apiPath, { limit: 1 })).length > 0) throw enotempty(path)
  const upto = lostCount()
  const timer = startOp()
  swept.push(path)
  await deletePath(tm, apiPath)
  await removed(path, 'rm_r', upto, timer)
  return true
}

/** Delete a looked-up entry: a file alone, a folder walked. Mirrors Python's `_remove`. */
async function remove(
  accessor: DropboxAccessor,
  path: PathSpec,
  entry: DropboxEntry,
  lost: [PathSpec, string | null][],
  swept: PathSpec[],
): Promise<boolean> {
  if (entry['.tag'] === 'folder') await deleteTree(accessor, path, lost, swept)
  else await deleteResolved(accessor, path, entry)
  return true
}

/**
 * Remove a file or folder; a conditional mount walks it file by file. A walk
 * records each file and folder (the operand among them) as its delete lands,
 * never the operand's subtree up front or at the end, so a file it never reached
 * keeps its version, and a read another stage makes after a removal outranks it. Anything else is recorded once, for
 * the operand's whole subtree. Mirrors Python's `rm_r`.
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
  const walked = entry['.tag'] === 'folder'
  const lost: [PathSpec, string | null][] = []
  const swept: PathSpec[] = []
  await evictAfter(
    () => remove(accessor, path, entry, lost, swept),
    async (done) => {
      if (!walked) {
        record('rm_r', path.virtual, 'dropbox', 0, timer)
        await invalidateSubtree(path)
      }
      for (const folder of outermost(swept)) await invalidateSubtree(folder)
      await invalidateAncestors(path)
      const refusal = await keepRefused(lost)
      if (done === true && refusal !== null) throw refusal
    },
  )
  if (!walked) liftLost(path, upto, true)
}
