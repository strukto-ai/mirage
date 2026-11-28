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
import { asideName, landThenRetire, setAside } from '../api/replace.ts'
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
import { liveOf, tokenOf } from './fingerprint.ts'
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
 * Move what holds the destination aside, refusing one that changed, answering
 * what moved as the move answered it. Dropbox moves on no condition, so what
 * moved is checked after: a file must still carry the content read, a folder
 * must still be one. A refusal here comes after the move, so `setAside` moves
 * it back. Mirrors Python's `_move_aside`.
 */
async function moveAside(
  tm: DropboxTokenManager,
  dst: PathSpec,
  to: string,
  aside: string,
  folder: boolean,
  content: string | null,
): Promise<Partial<DropboxEntry>> {
  const moved = await movePath(tm, to, aside)
  const kept = folder
    ? moved['.tag'] === 'folder'
    : moved['.tag'] === 'file' && (content === null || tokenOf(moved.content_hash) === content)
  if (!kept) throw await stale(dst)
  return moved
}

/**
 * Delete what was set aside: a file held to the rev its move answered, a
 * folder only while it lists no child, so one written while the op landed is
 * not deleted with it: mv's "Directory not empty". Mirrors Python's `_retire`.
 */
async function retire(
  tm: DropboxTokenManager,
  dst: PathSpec,
  aside: string,
  moved: Partial<DropboxEntry>,
  cond: WriteCondition | null,
): Promise<void> {
  if (moved['.tag'] === 'folder') {
    if ((await listFolder(tm, aside, { limit: 1 })).length > 0) throw enotempty(dst.virtual)
    await deletePath(tm, aside)
    return
  }
  const rev = tokenOf(moved.rev)
  try {
    await deletePath(tm, aside, rev)
  } catch (err) {
    if (err instanceof DropboxApiError) throw (await refused(dst, err, cond, rev)) ?? err
    throw err
  }
}

/**
 * Run a copy or move, replacing what holds the destination name. The op goes
 * first, since Dropbox answers a missing source before a taken name. On a
 * taken name, what holds it (a file, or an empty folder where `emptyFolder`)
 * moves aside under a staged name, the op lands on the name, and what moved
 * aside is deleted last. A held destination is measured before the op and
 * refused as gone when a folder took it. A refused or lost step puts both back
 * (`landThenRetire`), handing a landing and the op's reply to `undo`. Returns
 * the op's reply and the destination it replaced when that was looked up.
 * Mirrors Python's `replace_onto`.
 */
export async function replaceOnto<T>(
  tm: DropboxTokenManager,
  src: PathSpec,
  dst: PathSpec,
  to: string,
  op: (to: string) => Promise<T>,
  undo: (landed: string, reply: T) => Promise<unknown>,
  emptyFolder: boolean,
): Promise<[T, DropboxEntry | null]> {
  const cond = await writeCondition(dst, 'copy')
  let rev: string | null = null
  let live: ReturnType<typeof liveOf> = null
  if (cond?.kind === 'match' && cond.version !== '') {
    live = liveOf(await lookup(tm, to))
    rev = await nativeCondition(dst, cond, live, 'copy')
  }
  let existing: DropboxEntry
  try {
    return [await op(to), null]
  } catch (err) {
    if (!(err instanceof DropboxApiError)) throw err
    if (err.summary.startsWith(MISSING_SOURCE)) throw enoent(src.virtual)
    if (!err.summary.startsWith(TAKEN)) throw err
    if (rev !== null && err.summary.startsWith(TAKEN_BY_FOLDER)) throw await stale(dst)
    existing = await getMetadata(tm, to)
    const blocks =
      existing['.tag'] === 'folder' &&
      !(emptyFolder && (await listFolder(tm, to, { limit: 1 })).length === 0)
    if (blocks) throw err
  }
  const folder = existing['.tag'] === 'folder'
  const content = live !== null ? live.content : tokenOf(existing.content_hash)
  const aside = asideName(to)
  let landed: T
  try {
    const moved = await setAside(
      () => moveAside(tm, dst, to, aside, folder, content),
      () => movePath(tm, aside, to),
    )
    landed = await landThenRetire(
      () => op(to),
      (reply) => undo(to, reply),
      () => retire(tm, dst, aside, moved, cond),
      () => absent(tm, aside),
      () => movePath(tm, aside, to),
    )
  } catch (err) {
    if (err instanceof DropboxApiError && err.summary.startsWith(MISSING_SOURCE)) {
      throw enoent(src.virtual)
    }
    throw (await retaken(err, cond, dst)) ?? err
  }
  return [landed, existing]
}

// Whether nothing is at `path` any more. Mirrors Python's `_absent`.
async function absent(tm: DropboxTokenManager, path: string): Promise<boolean> {
  return (await lookup(tm, path)) === null
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
    (landed, made) => deletePath(tm, landed, tokenOf(made.rev)),
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
