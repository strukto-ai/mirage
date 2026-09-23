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

import type { Reply } from '../../kit/typescript/index.ts'
import type { GwsState } from '../store/state.ts'
import type { DriveItem } from '../store/types.ts'
import { FOLDER_MIME } from '../wire/mime.ts'
import { driveError, fileNotFound } from '../wire/reply.ts'

// My Drive's root under the alias every client spells. The fake keeps the
// alias itself as the parent id instead of minting a root folder.
export const ROOT = 'root'

// Every route that names a parent -- files.create, the multipart upload,
// files.copy and files.update's addParents -- judges it here, so a parent is
// refused one way wherever it was named. Probed against live Drive on
// 2026-09-21: a missing id is a 404 and a file is a 403 (both reported before
// the count), an item has exactly one parent, and a trashed folder is still a
// parent. Nothing is applied when any id fails.
export function refuseParents(st: GwsState, ids: readonly string[]): Reply | null {
  for (const id of ids) {
    if (id === ROOT) continue
    const parent = st.files.get(id)
    if (parent === undefined) return fileNotFound(id)
    if (parent.mimeType !== FOLDER_MIME) {
      return driveError(403, 'The specified parent is not a folder.', 'parentNotAFolder')
    }
  }
  if (new Set(ids).size > 1) {
    return driveError(403, 'Increasing the number of parents is not allowed', 'cannotAddParent')
  }
  return null
}

// Whether `id` is `folder` itself or sits anywhere below it.
function within(st: GwsState, id: string, folder: string): boolean {
  const seen = new Set<string>()
  for (let at: string | undefined = id; at !== undefined && !seen.has(at); ) {
    if (at === folder) return true
    seen.add(at)
    at = st.files.get(at)?.parents[0]
  }
  return false
}

// The parents files.update leaves an item with. An added parent REPLACES the
// old one whether or not the caller removed it, because the item keeps one
// parent; adding the parent it is also removing cancels out; removing the
// only parent lands it in the root; removing a parent it lacks is a no-op.
// A folder cannot move under itself, nor from My Drive into a shared drive
// (Drive documents that refusal). A shared drive's top-level folder has no
// parent to change; its refusal is Drive's documented permission error, not
// probed, because a consumer account cannot create a shared drive.
export function movedParents(
  st: GwsState,
  item: DriveItem,
  add: readonly string[],
  remove: readonly string[],
): string[] | Reply {
  if (add.length === 0 && remove.length === 0) return item.parents
  const refused = refuseParents(st, add)
  if (refused !== null) return refused
  if (st.drives.has(item.id)) {
    return driveError(
      403,
      `The user does not have sufficient permissions for file ${item.id}.`,
      'insufficientFilePermissions',
    )
  }
  const target = add.find((id) => !remove.includes(id))
  if (target === undefined) {
    const kept = item.parents.filter((p) => !remove.includes(p))
    return kept.length > 0 ? kept : [ROOT]
  }
  if (item.mimeType === FOLDER_MIME && within(st, target, item.id)) {
    return driveError(400, 'Bad Request', 'badRequest')
  }
  const intoDrive = st.files.get(target)?.driveId !== undefined
  if (item.mimeType === FOLDER_MIME && item.driveId === undefined && intoDrive) {
    return driveError(
      403,
      'Moving folders into shared drives is not supported.',
      'teamDrivesFolderMoveInNotSupported',
    )
  }
  return [target]
}

// An item lives in its parent's drive, so a move across drives carries the
// item and everything under it. My Drive has no drive id.
export function followParentDrive(st: GwsState, item: DriveItem): void {
  const driveId = st.files.get(item.parents[0] ?? '')?.driveId
  const moving = [item]
  for (let current = moving.pop(); current !== undefined; current = moving.pop()) {
    if (driveId === undefined) delete current.driveId
    else current.driveId = driveId
    for (const child of st.files.values()) {
      if (child.parents.includes(current.id)) moving.push(child)
    }
  }
}
