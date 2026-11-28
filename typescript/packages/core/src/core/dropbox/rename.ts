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

import { liftLost, lostCount, record, startOp } from '../../observe/context.ts'
import type { PathSpec } from '../../types.ts'
import { lookup, movePath, type DropboxEntry } from './api.ts'
import type { DropboxTokenManager } from './client.ts'
import { replaceOnto } from './copy.ts'
import { checkPath, dropboxPathOf } from './paths.ts'

/**
 * Move what landed at `landed` back to `back` while it is still what landed:
 * the entry by id, a file at the rev its move answered. Dropbox moves on no
 * condition, so one another writer changed since is left where it is. Mirrors
 * Python's `_move_back`.
 */
async function moveBack(
  tm: DropboxTokenManager,
  landed: string,
  back: string,
  made: Partial<DropboxEntry>,
): Promise<void> {
  const there = await lookup(tm, landed)
  if (there === null || there.id !== made.id || there.rev !== made.rev) {
    console.debug(`${landed} changed since it landed; it stays`)
    return
  }
  await movePath(tm, landed, back)
}

// move_v2 rejects an existing destination, but rename(2) replaces one:
// a file outright, and a directory when it is empty. So on a conflict the
// target moves aside, the source takes its name, and the target is deleted
// last, except for a folder that still lists a child, where the original
// error propagates and the generic mv reports "Directory not empty"
// (mirrors msgraph's renameReplace). The source moves whole, so only a
// destination it replaces is held to its version (`replaceOnto`); a move
// taken back is left where it landed once another writer changed it
// (`moveBack`).
export async function rename(
  accessor: DropboxAccessor,
  src: PathSpec,
  dst: PathSpec,
): Promise<void> {
  await checkPath(accessor, src)
  await checkPath(accessor, dst)
  const from = dropboxPathOf(accessor, src)
  const to = dropboxPathOf(accessor, dst)
  const tm = accessor.tokenManager
  const timer = startOp()
  const upto = lostCount()
  const [moved] = await replaceOnto(
    tm,
    src,
    dst,
    from,
    to,
    (at) => movePath(tm, from, at),
    (landed, made) => moveBack(tm, landed, from, made),
    true,
    true,
  )
  const folder = moved['.tag'] !== 'file'
  const op = folder ? 'rename_prefix' : 'rename'
  record(op, src.virtual, 'dropbox', 0, timer)
  record(op, dst.virtual, 'dropbox', 0, timer)
  liftLost(src, upto, folder)
  liftLost(dst, upto, folder)
}
