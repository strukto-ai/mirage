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
import { conditionVersion, nativeCondition, stale, writeCondition } from '../../cache/context.ts'
import type { WriteCondition } from '../../cache/types.ts'
import { liftLost, lostCount, record, startOp } from '../../observe/context.ts'
import type { PathSpec } from '../../types.ts'
import { enoent, enotempty } from '../../errors/fs.ts'
import type { StaleWriteError } from '../../errors/types.ts'
import { DropboxApiError, type DropboxTokenManager } from './client.ts'
import {
  copyPath,
  deletePath,
  getMetadata,
  listFolder,
  lookup,
  movePath,
  refused,
  type DropboxEntry,
} from './api.ts'
import { MISSING_SOURCE, TAKEN, TAKEN_BY_FOLDER } from './constants.ts'
import { liveOf } from './fingerprint.ts'
import { checkPath, dropboxPathOf } from './paths.ts'

/**
 * The refusal for a copy or move whose cleared destination came back. The
 * condition the op sent stays held, whatever took the name. Mirrors Python's
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
  const held = conditionVersion(cond)
  return stale(dst, { version: held === '' ? null : held })
}

/**
 * Delete what holds the destination name, once the op landed beside it. A
 * folder is asked for a child again first, so one written while the op landed
 * is not deleted with it: mv's "Directory not empty". Mirrors Python's
 * `_clear`.
 */
async function clear(
  tm: DropboxTokenManager,
  dst: PathSpec,
  to: string,
  rev: string | null,
  existing: DropboxEntry | null,
): Promise<void> {
  if (existing?.['.tag'] === 'folder' && (await listFolder(tm, to, { limit: 1 })).length > 0) {
    throw enotempty(dst.virtual)
  }
  await deletePath(tm, to, rev)
}

/**
 * Run a copy or move, replacing a file that holds the destination name. The op
 * goes first, since Dropbox answers a missing source before a taken name. A
 * held destination is measured before the op, cleared with its rev on a taken
 * name, and refused as gone when a folder took it. On a taken name the op
 * lands under a staged name beside the destination, what holds the name goes
 * next, and the landed entry takes the name last: a refused op leaves the
 * destination as it was, and a refused delete hands the landed entry to
 * `undo`. `emptyFolder` lets an empty folder there give way too. Returns the
 * op's reply and the destination it replaced when that was looked up. Mirrors
 * Python's `replace_onto`.
 */
export async function replaceOnto<T>(
  tm: DropboxTokenManager,
  src: PathSpec,
  dst: PathSpec,
  to: string,
  op: (to: string) => Promise<T>,
  undo: (staged: string) => Promise<unknown>,
  emptyFolder: boolean,
): Promise<[T, DropboxEntry | null]> {
  const cond = await writeCondition(dst, 'copy')
  let rev: string | null = null
  if (cond?.kind === 'match' && cond.version !== '') {
    rev = await nativeCondition(dst, cond, liveOf(await lookup(tm, to)), 'copy')
  }
  let existing: DropboxEntry | null = null
  try {
    return [await op(to), null]
  } catch (err) {
    if (!(err instanceof DropboxApiError)) throw err
    if (err.summary.startsWith(MISSING_SOURCE)) throw enoent(src.virtual)
    if (!err.summary.startsWith(TAKEN)) throw err
    if (rev === null) {
      existing = await getMetadata(tm, to)
      const blocks =
        existing['.tag'] === 'folder' &&
        !(emptyFolder && (await listFolder(tm, to, { limit: 1 })).length === 0)
      if (blocks) throw err
    } else if (err.summary.startsWith(TAKEN_BY_FOLDER)) {
      throw await stale(dst)
    }
  }
  const staged = `${to}.mirage-${crypto.randomUUID().replaceAll('-', '')}`
  let landed: T
  try {
    landed = await op(staged)
  } catch (again) {
    if (again instanceof DropboxApiError && again.summary.startsWith(MISSING_SOURCE)) {
      throw enoent(src.virtual)
    }
    throw again
  }
  try {
    await clear(tm, dst, to, rev, existing)
  } catch (cleared) {
    await takeBack(undo, staged)
    if (cleared instanceof DropboxApiError) {
      throw (await refused(dst, cleared, cond, rev)) ?? cleared
    }
    throw cleared
  }
  try {
    await movePath(tm, staged, to)
  } catch (again) {
    await takeBack(undo, staged)
    throw (await retaken(again, cond, dst)) ?? again
  }
  return [landed, existing]
}

/**
 * Hand an entry the op landed to `undo`; a refusal is logged, so the error
 * that called for it stays the one raised. Mirrors Python's `_take_back`.
 */
async function takeBack(undo: (staged: string) => Promise<unknown>, staged: string): Promise<void> {
  try {
    await undo(staged)
  } catch (back) {
    console.debug(`could not take back ${staged}: ${String(back)}`)
  }
}

/**
 * copy_v2 copies files and folder subtrees server-side; an existing
 * destination FILE is replaced, as cp does (see `replaceOnto`).
 */
export async function copy(accessor: DropboxAccessor, src: PathSpec, dst: PathSpec): Promise<void> {
  await checkPath(accessor, src)
  await checkPath(accessor, dst)
  const from = dropboxPathOf(accessor, src)
  const to = dropboxPathOf(accessor, dst)
  const tm = accessor.tokenManager
  const upto = lostCount()
  const timer = startOp()
  await replaceOnto(
    tm,
    src,
    dst,
    to,
    (at) => copyPath(tm, from, at),
    (staged) => deletePath(tm, staged),
    false,
  )
  record('copy', dst.virtual, 'dropbox', 0, timer)
  liftLost(dst, upto)
}

/**
 * Copy a folder tree onto a fresh name in one copy_v2. `cp -r` asks this
 * only when nothing holds `dst`, so a taken name is Dropbox's conflict,
 * never a merge.
 */
export async function dirCopy(
  accessor: DropboxAccessor,
  src: PathSpec,
  dst: PathSpec,
): Promise<void> {
  await checkPath(accessor, src)
  await checkPath(accessor, dst)
  const tm = accessor.tokenManager
  const upto = lostCount()
  const timer = startOp()
  try {
    await copyPath(tm, dropboxPathOf(accessor, src), dropboxPathOf(accessor, dst))
  } catch (err) {
    if (err instanceof DropboxApiError && err.summary.startsWith(MISSING_SOURCE)) {
      throw enoent(src.virtual)
    }
    throw err
  }
  record('copy_prefix', dst.virtual, 'dropbox', 0, timer)
  liftLost(dst, upto, true)
}
