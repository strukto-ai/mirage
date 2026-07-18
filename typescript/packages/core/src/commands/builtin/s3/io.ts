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

import type { S3Accessor } from '../../../accessor/s3.ts'
import { SCOPE_ERROR } from '../../../core/s3/constants.ts'
import { copy as s3Copy } from '../../../core/s3/copy.ts'
import { create as s3Create } from '../../../core/s3/create.ts'
import { du as s3Du, duAll as s3DuAll } from '../../../core/s3/du.ts'
import { exists as s3Exists } from '../../../core/s3/exists.ts'
import { find as s3Find } from '../../../core/s3/find.ts'
import { mkdir as s3Mkdir } from '../../../core/s3/mkdir.ts'
import { read as s3Read } from '../../../core/s3/read.ts'
import { readdir as s3Readdir } from '../../../core/s3/readdir.ts'
import { rename as s3Rename } from '../../../core/s3/rename.ts'
import { rmR as s3RmR } from '../../../core/s3/rm.ts'
import { rmdir as s3Rmdir } from '../../../core/s3/rmdir.ts'
import { stat as s3Stat } from '../../../core/s3/stat.ts'
import { stream as s3Stream } from '../../../core/s3/stream.ts'
import { truncate as s3Truncate } from '../../../core/s3/truncate.ts'
import { unlink as s3Unlink } from '../../../core/s3/unlink.ts'
import { write as s3Write } from '../../../core/s3/write.ts'
import type { CommandIO } from '../generic_bind/index.ts'

export const S3_IO: CommandIO<S3Accessor> = {
  readdir: s3Readdir,
  readBytes: s3Read,
  readStream: s3Stream,
  stat: s3Stat,
  isMounted: () => true,
  local: false,
  maxGlobMatches: SCOPE_ERROR,
  write: s3Write,
  exists: s3Exists,
  mkdir: s3Mkdir,
  unlink: s3Unlink,
  rmdir: s3Rmdir,
  rmR: s3RmR,
  rename: s3Rename,
  copy: s3Copy,
  create: s3Create,
  truncate: s3Truncate,
  find: s3Find,
  duTotal: s3Du,
  duAll: s3DuAll,
}
