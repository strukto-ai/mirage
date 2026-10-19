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
import type { PathSpec } from '../../types.ts'
import type { Handed } from '../../vfs/types.ts'
import { enoent } from '../../errors/fs.ts'
import { liveRow } from './readdir.ts'
import { eaccesOnDenied } from './resolve.ts'

// A Drive folder delete removes its subtree in one call.
async function rmRImpl(
  accessor: GDriveAccessor,
  path: PathSpec,
  handed: Handed = {},
): Promise<void> {
  if (path.vfsPath === '') return
  const entry = await liveRow(accessor, path, handed.entry)
  if (entry === null) throw enoent(path)
  await accessor.drive.deleteFile(entry.extra.file_id as string)
}

export const rmR = eaccesOnDenied(rmRImpl)
