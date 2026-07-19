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

import type { DropboxAccessor } from '../../../accessor/dropbox.ts'
import { copy as dropboxCopy } from '../../../core/dropbox/copy.ts'
import { create as dropboxCreate } from '../../../core/dropbox/create.ts'
import { du as dropboxDu, duAll as dropboxDuAll } from '../../../core/dropbox/du.ts'
import { exists as dropboxExists } from '../../../core/dropbox/exists.ts'
import { find as dropboxFind } from '../../../core/dropbox/find.ts'
import { mkdir as dropboxMkdir } from '../../../core/dropbox/mkdir.ts'
import { read as dropboxRead, stream as dropboxStream } from '../../../core/dropbox/read.ts'
import { isDirName, readdir as dropboxReaddir } from '../../../core/dropbox/readdir.ts'
import { rename as dropboxRename } from '../../../core/dropbox/rename.ts'
import { rmR as dropboxRmR } from '../../../core/dropbox/rm.ts'
import { rmdir as dropboxRmdir } from '../../../core/dropbox/rmdir.ts'
import { stat as dropboxStat } from '../../../core/dropbox/stat.ts'
import { unlink as dropboxUnlink } from '../../../core/dropbox/unlink.ts'
import { write as dropboxWrite } from '../../../core/dropbox/write.ts'
import type { CommandIO } from '../generic_bind/index.ts'

export const DROPBOX_IO: CommandIO<DropboxAccessor> = {
  readdir: dropboxReaddir,
  readBytes: dropboxRead,
  readStream: dropboxStream,
  stat: dropboxStat,
  isMounted: () => true,
  isDirName: (_accessor, child) => isDirName(child),
  local: false,
  duTotal: dropboxDu,
  duAll: dropboxDuAll,
  write: dropboxWrite,
  exists: dropboxExists,
  mkdir: (accessor, path, parents) => dropboxMkdir(accessor, path, parents),
  unlink: dropboxUnlink,
  rmdir: dropboxRmdir,
  rmR: dropboxRmR,
  rename: dropboxRename,
  // No dirCopy: cp -r must MERGE into an existing destination dir, so
  // the builder plans file-by-file copies (copy_v2 on a whole folder
  // rejects an existing destination).
  copy: dropboxCopy,
  create: dropboxCreate,
  find: dropboxFind,
}
