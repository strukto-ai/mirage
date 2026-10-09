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
import { invalidateAfterMove, invalidateAncestors } from '../../cache/context.ts'
import { liftLost, lostCount, record, startOp } from '../../observe/context.ts'
import type { PathSpec } from '../../types.ts'
import { movePath } from './api.ts'
import { replaceOnto } from './copy.ts'
import { dropboxPathOf } from './paths.ts'

// move_v2 rejects an existing destination, but rename(2) replaces one:
// a file outright, and a directory when it is empty. So a conflict
// deletes the target and retries, except for a folder that still lists a
// child, where the original error propagates and the generic mv reports
// "Directory not empty" (mirrors msgraph's renameReplace). The source moves
// whole, so only a destination it replaces is held to its version.
export async function rename(
  accessor: DropboxAccessor,
  src: PathSpec,
  dst: PathSpec,
): Promise<void> {
  const from = dropboxPathOf(accessor, src)
  const to = dropboxPathOf(accessor, dst)
  const tm = accessor.tokenManager
  const timer = startOp()
  const upto = lostCount()
  const [moved, replaced] = await replaceOnto(tm, src, dst, to, () => movePath(tm, from, to), true)
  const replacedNonFile = replaced !== null && replaced['.tag'] !== 'file'
  // A folder carries a subtree under both names. dst also loses one when
  // the move replaced anything there but a file (an empty folder, or an
  // entry of no known kind), whose name may still have cached children.
  // Only a file tag narrows; a reply that names no type keeps the
  // subtree.
  const folder = moved['.tag'] !== 'file'
  const op = folder ? 'rename_prefix' : 'rename'
  record(op, src.virtual, 'dropbox', 0, timer)
  record(op, dst.virtual, 'dropbox', 0, timer)
  await invalidateAfterMove(src, folder)
  await invalidateAncestors(src)
  await invalidateAfterMove(dst, folder || replacedNonFile)
  await invalidateAncestors(dst)
  liftLost(src, upto, folder)
  liftLost(dst, upto, folder)
}
