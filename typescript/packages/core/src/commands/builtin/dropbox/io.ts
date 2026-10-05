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

import { VFSAdapter } from '../../../vfs/adapter.ts'

import type { DropboxAccessor } from '../../../accessor/dropbox.ts'
import { copy as dropboxCopy } from '../../../core/dropbox/copy.ts'
import { create as dropboxCreate } from '../../../core/dropbox/create.ts'
import { makeWalkedDu } from '../../../core/generic/du.ts'
import { narrowPaths as dropboxNarrowPaths } from '../../../core/dropbox/search.ts'
import { exists as dropboxExists } from '../../../core/dropbox/exists.ts'
import { mkdir as dropboxMkdir } from '../../../core/dropbox/mkdir.ts'
import { read as dropboxRead, readStream as dropboxStream } from '../../../core/dropbox/read.ts'
import { readdir as dropboxReaddir } from '../../../core/dropbox/readdir.ts'
import { rename as dropboxRename } from '../../../core/dropbox/rename.ts'
import { rmR as dropboxRmR } from '../../../core/dropbox/rm.ts'
import { rmdir as dropboxRmdir } from '../../../core/dropbox/rmdir.ts'
import { stat as dropboxStat } from '../../../core/dropbox/stat.ts'
import { unlink as dropboxUnlink } from '../../../core/dropbox/unlink.ts'
import { write as dropboxWrite } from '../../../core/dropbox/write.ts'
import { type CommandIO, rangeOf } from '../generic_bind/index.ts'

export const IO: CommandIO<DropboxAccessor> = new VFSAdapter<DropboxAccessor>({
  read: { readdir: dropboxReaddir, readBytes: dropboxRead, stat: dropboxStat },
  native: {
    readRange: rangeOf(dropboxRead),
    readStream: dropboxStream,
    du: makeWalkedDu(dropboxStat, dropboxReaddir),
    exists: dropboxExists,
  },
  writes: {
    write: dropboxWrite,
    mkdir: (accessor, path, parents) => dropboxMkdir(accessor, path, parents),
    unlink: dropboxUnlink,
    rmdir: dropboxRmdir,
    rmR: dropboxRmR,
    rename: dropboxRename,
    copy: dropboxCopy,
    create: dropboxCreate,
  },
  contentSearch: { narrowPaths: dropboxNarrowPaths, enabled: (accessor) => accessor.contentSearch },
  isMounted: () => true,
  local: false,
}).toCommandIO()
