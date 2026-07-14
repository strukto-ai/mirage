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

import type { DatabricksVolumeAccessor } from '../../../accessor/databricks_volume.ts'
import { copy as dbxCopy } from '../../../core/databricks_volume/copy.ts'
import { create as dbxCreate } from '../../../core/databricks_volume/create.ts'
import { exists as dbxExists } from '../../../core/databricks_volume/exists.ts'
import { mkdir as dbxMkdir } from '../../../core/databricks_volume/mkdir.ts'
import { readBytes as dbxRead } from '../../../core/databricks_volume/read.ts'
import { readdir as dbxReaddir } from '../../../core/databricks_volume/readdir.ts'
import { rename as dbxRename } from '../../../core/databricks_volume/rename.ts'
import { rmRecursive as dbxRmR } from '../../../core/databricks_volume/rm.ts'
import { rmdir as dbxRmdir } from '../../../core/databricks_volume/rmdir.ts'
import { stat as dbxStat } from '../../../core/databricks_volume/stat.ts'
import { readStream as dbxStream } from '../../../core/databricks_volume/stream.ts'
import { unlink as dbxUnlink } from '../../../core/databricks_volume/unlink.ts'
import { writeBytes as dbxWrite } from '../../../core/databricks_volume/write.ts'
import type { CommandIO } from '../generic_bind/index.ts'

export const DATABRICKS_VOLUME_CMD_OPS: CommandIO<DatabricksVolumeAccessor> = {
  readdir: dbxReaddir,
  readBytes: dbxRead,
  readStream: dbxStream,
  stat: dbxStat,
  isMounted: () => true,
  local: false,
  write: dbxWrite,
  exists: dbxExists,
  mkdir: (accessor, path, parents) => dbxMkdir(accessor, path, undefined, parents === true),
  unlink: dbxUnlink,
  rmdir: dbxRmdir,
  rmR: async (accessor, path) => {
    await dbxRmR(accessor, path)
  },
  rename: dbxRename,
  copy: dbxCopy,
  create: dbxCreate,
}
