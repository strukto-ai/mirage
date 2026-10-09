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
import { record, startOp } from '../../observe/context.ts'
import type { PathSpec } from '../../types.ts'
import { enoent } from '../../errors/fs.ts'
import type { StaleWriteError } from '../../errors/types.ts'
import { DropboxApiError, type DropboxTokenManager } from './client.ts'
import { copyPath, deletePath, getMetadata, lookup, refused, type DropboxEntry } from './api.ts'
import { MISSING_SOURCE, TAKEN, TAKEN_BY_FOLDER } from './constants.ts'
import { liveOf } from './fingerprint.ts'
import { dropboxPathOf } from './paths.ts'

/**
 * The condition a copy or move onto `dst` carries, and its rev. A destination
 * mirage holds a version of is checked before anything moves: one changed or
 * gone since it was read is refused here. The rev is what clearing it sends as
 * `parent_rev`. Mirrors Python's `_measure_destination`.
 *
 * @throws a stale-write error when the destination changed or went since it was read
 */
async function measureDestination(
  tm: DropboxTokenManager,
  dst: PathSpec,
  to: string,
): Promise<[WriteCondition | null, string | null]> {
  const cond = await writeCondition(dst, 'copy')
  if (cond?.ifMatch === undefined || cond.ifMatch === '') return [cond, null]
  return [cond, await nativeCondition(dst, cond, liveOf(await lookup(tm, to)), 'copy')]
}

/**
 * Delete the file a copy or move lands on, with its rev when measured.
 * Mirrors Python's `_clear_destination`.
 *
 * @throws a stale-write error when the destination changed since it was measured
 */
async function clearDestination(
  tm: DropboxTokenManager,
  dst: PathSpec,
  to: string,
  cond: WriteCondition | null,
  rev: string | null,
): Promise<void> {
  try {
    await deletePath(tm, to, rev)
  } catch (err) {
    const lost = await refused(dst, err, cond, rev)
    if (lost !== null) throw lost
    throw err
  }
}

/**
 * The refusal for a copy or move whose cleared destination came back: another
 * writer took the name between the clear and the retry. Its file is not
 * deleted a second time, and the version held stays held, so a retry without a
 * read is refused again; a folder there holds no file version, so it keeps
 * none. Null for any other failure. Mirrors Python's
 * `_retaken`.
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
 * Run a copy or move, replacing a destination that takes the name. The op
 * goes first, so a source that is gone costs the destination nothing: Dropbox
 * answers a missing source before a taken destination (measured 2026-10-08).
 * On a taken name a destination mirage holds a version of is cleared with its
 * rev, unless a folder has taken it: that is refused as gone, with nothing
 * deleted. A destination it holds no version of is looked up and cleared
 * plain if `mayClear` allows it.
 * Then the op runs once more. Returns the op's reply and the destination it
 * replaced when that was looked up. Mirrors Python's `replace_onto`.
 *
 * @throws a stale-write error when the destination changed, went or was retaken
 */
export async function replaceOnto<T>(
  tm: DropboxTokenManager,
  src: PathSpec,
  dst: PathSpec,
  to: string,
  op: () => Promise<T>,
  mayClear: (existing: DropboxEntry) => Promise<boolean>,
): Promise<[T, DropboxEntry | null]> {
  const [cond, rev] = await measureDestination(tm, dst, to)
  try {
    return [await op(), null]
  } catch (err) {
    if (!(err instanceof DropboxApiError)) throw err
    if (err.summary.startsWith(MISSING_SOURCE)) throw enoent(src.virtual)
    if (!err.summary.startsWith(TAKEN)) throw err
    let existing: DropboxEntry | null = null
    if (rev === null) {
      existing = await getMetadata(tm, to)
      if (!(await mayClear(existing))) throw err
    } else if (err.summary.startsWith(TAKEN_BY_FOLDER)) {
      throw await stale(dst, { gone: true })
    }
    await clearDestination(tm, dst, to, cond, rev)
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

/** Whether a looked-up destination is anything but a folder. Mirrors Python's `not_a_folder`. */
export function notAFolder(existing: DropboxEntry): Promise<boolean> {
  return Promise.resolve(existing['.tag'] !== 'folder')
}

/**
 * copy_v2 copies files and folder subtrees server-side; an existing
 * destination FILE is replaced like GNU cp (see `replaceOnto`).
 */
export async function copy(accessor: DropboxAccessor, src: PathSpec, dst: PathSpec): Promise<void> {
  const from = dropboxPathOf(accessor, src)
  const to = dropboxPathOf(accessor, dst)
  const tm = accessor.tokenManager
  const timer = startOp()
  await replaceOnto(tm, src, dst, to, () => copyPath(tm, from, to), notAFolder)
  record('copy', dst.virtual, 'dropbox', 0, timer)
  await invalidateAfterWrite(dst)
  await invalidateAncestors(dst)
}
