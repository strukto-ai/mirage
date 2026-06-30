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

import type { CommandIO } from '@struktoai/mirage-core'
import type { DiskAccessor } from '../../../accessor/disk.ts'
import { SCOPE_ERROR } from '../../../core/disk/constants.ts'
import { copy as diskCopy } from '../../../core/disk/copy.ts'
import { du as diskDu, duAll as diskDuAll } from '../../../core/disk/du.ts'
import { exists as diskExists } from '../../../core/disk/exists.ts'
import { find as diskFind } from '../../../core/disk/find.ts'
import { mkdir as diskMkdir } from '../../../core/disk/mkdir.ts'
import { read as diskRead } from '../../../core/disk/read.ts'
import { readdir as diskReaddir } from '../../../core/disk/readdir.ts'
import { rename as diskRename } from '../../../core/disk/rename.ts'
import { rmR as diskRmR } from '../../../core/disk/rm.ts'
import { rmdir as diskRmdir } from '../../../core/disk/rmdir.ts'
import { stat as diskStat } from '../../../core/disk/stat.ts'
import { stream as diskStream } from '../../../core/disk/stream.ts'
import { unlink as diskUnlink } from '../../../core/disk/unlink.ts'
import { writeBytes as diskWrite } from '../../../core/disk/write.ts'

export const DISK_CMD_OPS: CommandIO<DiskAccessor> = {
  readdir: diskReaddir,
  readBytes: diskRead,
  readStream: diskStream,
  stat: diskStat,
  isMounted: (a) => a.root !== '',
  local: true,
  maxGlobMatches: SCOPE_ERROR,
  write: diskWrite,
  exists: diskExists,
  mkdir: diskMkdir,
  unlink: diskUnlink,
  rmdir: diskRmdir,
  rmR: diskRmR,
  rename: diskRename,
  copy: diskCopy,
  find: diskFind,
  duTotal: diskDu,
  duAll: diskDuAll,
}
