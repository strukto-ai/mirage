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
  invalidateAfterWrite,
  invalidateAncestors,
  nativeCondition,
  stale,
  writeCondition,
} from '../../cache/context.ts'
import type { WriteCondition } from '../../cache/types.ts'
import { liftLost, lostCount, record, startOp } from '../../observe/context.ts'
import type { PathSpec } from '../../types.ts'
import { enoent } from '../../errors/fs.ts'
import type { StaleWriteError } from '../../errors/types.ts'
import { DropboxApiError, type DropboxTokenManager } from './client.ts'
import {
  copyPath,
  deletePath,
  getMetadata,
  listFolder,
  lookup,
  refused,
  type DropboxEntry,
} from './api.ts'
import { MISSING_SOURCE, TAKEN, TAKEN_BY_FOLDER } from './constants.ts'
import { liveOf } from './fingerprint.ts'
import { dropboxPathOf } from './paths.ts'

/**
 * The refusal for a copy or move whose cleared destination came back. The held
 * version stays held; a folder there keeps none. Mirrors Python's `_retaken`.
 */
async function retaken(
  err: unknown,
  cond: WriteCondition | null,
  dst: PathSpec,
): Promise<StaleWriteError | null> {
  if (cond === null || !(err instanceof DropboxApiError) || !err.summary.startsWith(TAKEN)) {
    return null
  }
  if (
    cond.ifMatch !== undefined &&
    cond.ifMatch !== '' &&
    !err.summary.startsWith(TAKEN_BY_FOLDER)
  ) {
    return stale(dst, { version: cond.ifMatch })
  }
  return stale(dst, { gone: true })
}

/**
 * Run a copy or move, replacing a file that holds the destination name. The op
 * goes first, since Dropbox answers a missing source before a taken name. A
 * held destination is measured before the op, cleared with its rev on a taken
 * name, and refused as gone when a folder took it. `emptyFolder` lets an empty
 * folder there give way too. Returns the op's reply and the destination it
 * replaced when that was looked up. Mirrors Python's `replace_onto`.
 */
export async function replaceOnto<T>(
  tm: DropboxTokenManager,
  src: PathSpec,
  dst: PathSpec,
  to: string,
  op: () => Promise<T>,
  emptyFolder: boolean,
): Promise<[T, DropboxEntry | null]> {
  const cond = await writeCondition(dst, 'copy')
  let rev: string | null = null
  if (cond?.ifMatch !== undefined && cond.ifMatch !== '') {
    rev = await nativeCondition(dst, cond, liveOf(await lookup(tm, to)), 'copy')
  }
  try {
    return [await op(), null]
  } catch (err) {
    if (!(err instanceof DropboxApiError)) throw err
    if (err.summary.startsWith(MISSING_SOURCE)) throw enoent(src.virtual)
    if (!err.summary.startsWith(TAKEN)) throw err
    let existing: DropboxEntry | null = null
    if (rev === null) {
      existing = await getMetadata(tm, to)
      const blocks =
        existing['.tag'] === 'folder' &&
        !(emptyFolder && (await listFolder(tm, to, { limit: 1 })).length === 0)
      if (blocks) throw err
    } else if (err.summary.startsWith(TAKEN_BY_FOLDER)) {
      throw await stale(dst, { gone: true })
    }
    try {
      await deletePath(tm, to, rev)
    } catch (cleared) {
      throw (await refused(dst, cleared, cond, rev)) ?? cleared
    }
    try {
      return [await op(), existing]
    } catch (again) {
      if (again instanceof DropboxApiError && again.summary.startsWith(MISSING_SOURCE)) {
        throw enoent(src.virtual)
      }
      throw (await retaken(again, cond, dst)) ?? again
    }
  }
}

/**
 * copy_v2 copies files and folder subtrees server-side; an existing
 * destination FILE is replaced, as cp does (see `replaceOnto`).
 */
export async function copy(accessor: DropboxAccessor, src: PathSpec, dst: PathSpec): Promise<void> {
  const from = dropboxPathOf(accessor, src)
  const to = dropboxPathOf(accessor, dst)
  const tm = accessor.tokenManager
  const upto = lostCount()
  const timer = startOp()
  await replaceOnto(tm, src, dst, to, () => copyPath(tm, from, to), false)
  record('copy', dst.virtual, 'dropbox', 0, timer)
  liftLost(dst, upto)
  await invalidateAfterWrite(dst)
  await invalidateAncestors(dst)
}
