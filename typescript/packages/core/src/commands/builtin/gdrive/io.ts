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

import type { GDriveAccessor } from '../../../accessor/gdrive.ts'
import { copy as gdriveCopy } from '../../../core/gdrive/copy.ts'
import { create as gdriveCreate } from '../../../core/gdrive/create.ts'
import { du as gdriveDu, duAll as gdriveDuAll } from '../../../core/gdrive/du.ts'
import { find as gdriveFind } from '../../../core/gdrive/find.ts'
import { exists as gdriveExists } from '../../../core/gdrive/exists.ts'
import { mkdir as gdriveMkdir } from '../../../core/gdrive/mkdir.ts'
import { read as gdriveRead, stream as gdriveStream } from '../../../core/gdrive/read.ts'
import { isDirName, readdir as gdriveReaddir } from '../../../core/gdrive/readdir.ts'
import { rename as gdriveRename } from '../../../core/gdrive/rename.ts'
import { rmR as gdriveRmR } from '../../../core/gdrive/rm.ts'
import { rmdir as gdriveRmdir } from '../../../core/gdrive/rmdir.ts'
import { stat as gdriveStat } from '../../../core/gdrive/stat.ts'
import { truncate as gdriveTruncate } from '../../../core/gdrive/truncate.ts'
import { unlink as gdriveUnlink } from '../../../core/gdrive/unlink.ts'
import { write as gdriveWrite } from '../../../core/gdrive/write.ts'
import type { CommandIO } from '../generic_bind/index.ts'

export const GDRIVE_IO: CommandIO<GDriveAccessor> = {
  readdir: gdriveReaddir,
  readBytes: gdriveRead,
  readStream: gdriveStream,
  stat: gdriveStat,
  isMounted: () => true,
  isDirName: (_accessor, child) => isDirName(child),
  local: false,
  write: gdriveWrite,
  exists: gdriveExists,
  mkdir: gdriveMkdir,
  unlink: gdriveUnlink,
  rmdir: gdriveRmdir,
  rmR: gdriveRmR,
  rename: gdriveRename,
  copy: gdriveCopy,
  dirCopy: gdriveCopy,
  create: gdriveCreate,
  truncate: gdriveTruncate,
  find: gdriveFind,
  duTotal: gdriveDu,
  duAll: gdriveDuAll,
}
