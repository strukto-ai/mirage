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
import type { GridFSAccessor } from '../../../accessor/gridfs.ts'
import { SCOPE_ERROR } from '../../../core/gridfs/constants.ts'
import { copy as gridfsCopy } from '../../../core/gridfs/copy.ts'
import { create as gridfsCreate } from '../../../core/gridfs/create.ts'
import { du as gridfsDu, duAll as gridfsDuAll } from '../../../core/gridfs/du.ts'
import { exists as gridfsExists } from '../../../core/gridfs/exists.ts'
import { find as gridfsFind } from '../../../core/gridfs/find.ts'
import { mkdir as gridfsMkdir } from '../../../core/gridfs/mkdir.ts'
import { read as gridfsRead } from '../../../core/gridfs/read.ts'
import { readdir as gridfsReaddir } from '../../../core/gridfs/readdir.ts'
import { rename as gridfsRename } from '../../../core/gridfs/rename.ts'
import { rmR as gridfsRmR } from '../../../core/gridfs/rm.ts'
import { rmdir as gridfsRmdir } from '../../../core/gridfs/rmdir.ts'
import { stat as gridfsStat } from '../../../core/gridfs/stat.ts'
import { stream as gridfsStream } from '../../../core/gridfs/stream.ts'
import { truncate as gridfsTruncate } from '../../../core/gridfs/truncate.ts'
import { unlink as gridfsUnlink } from '../../../core/gridfs/unlink.ts'
import { write as gridfsWrite } from '../../../core/gridfs/write.ts'

export const GRIDFS_IO: CommandIO<GridFSAccessor> = {
  readdir: gridfsReaddir,
  readBytes: gridfsRead,
  readStream: gridfsStream,
  stat: gridfsStat,
  isMounted: () => true,
  local: false,
  maxGlobMatches: SCOPE_ERROR,
  write: gridfsWrite,
  exists: gridfsExists,
  mkdir: gridfsMkdir,
  unlink: gridfsUnlink,
  rmdir: gridfsRmdir,
  rmR: gridfsRmR,
  rename: gridfsRename,
  copy: gridfsCopy,
  create: gridfsCreate,
  truncate: gridfsTruncate,
  find: gridfsFind,
  duTotal: gridfsDu,
  duAll: gridfsDuAll,
}
