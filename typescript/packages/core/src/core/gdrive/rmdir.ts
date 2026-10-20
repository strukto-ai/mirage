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

import type { GDriveAccessor } from '../../accessor/gdrive.ts'

import { FileType, type PathSpec } from '../../types.ts'
import type { Handed } from '../../vfs/types.ts'
import { enoent, enotdir, enotempty } from '../../errors/fs.ts'
import { liveRow } from './readdir.ts'
import { eaccesOnDenied } from './resolve.ts'

/**
 * Remove an empty folder.
 *
 * A Drive `files.delete` on a folder removes every descendant with it, so
 * this is the same request `rmR` sends and the emptiness check is the only
 * thing separating them. Without it `rmdir` destroyed the whole subtree for
 * every caller that does not pre-check emptiness itself, and the command
 * builders are the only callers that do: FUSE, `ws.vfs` and the sandbox
 * runtimes all reach the op directly. The probe is the one `rename` already
 * makes before it overwrites a directory, bounded to a single entry.
 */
async function rmdirImpl(
  accessor: GDriveAccessor,
  path: PathSpec,
  handed: Handed = {},
): Promise<void> {
  if (path.vfsPath === '') return
  const entry = await liveRow(accessor, path, handed.entry)
  if (entry === null) throw enoent(path)
  if (entry.type !== FileType.DIRECTORY) throw enotdir(path)
  const driveId = entry.extra.drive_id
  const drive = accessor.drive
  const children = await drive.listFiles({
    folderId: entry.extra.file_id as string,
    driveId: typeof driveId === 'string' ? driveId : null,
    limit: 1,
  })
  if (children.length > 0) throw enotempty(path)
  await drive.deleteFile(entry.extra.file_id as string)
}

export const rmdir = eaccesOnDenied(rmdirImpl)
