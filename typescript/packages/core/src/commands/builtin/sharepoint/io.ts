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
import type { SharePointAccessor } from '../../../accessor/sharepoint.ts'
import { makeWalkedDu } from '../../../core/generic/du.ts'
import { copy } from '../../../core/sharepoint/copy.ts'
import { create } from '../../../core/sharepoint/create.ts'
import { exists } from '../../../core/sharepoint/exists.ts'
import { find } from '../../../core/sharepoint/find.ts'
import { mkdir } from '../../../core/sharepoint/mkdir.ts'
import { read } from '../../../core/sharepoint/read.ts'
import { readdir } from '../../../core/sharepoint/readdir.ts'
import { rename } from '../../../core/sharepoint/rename.ts'
import { rmR } from '../../../core/sharepoint/rm.ts'
import { rmdir } from '../../../core/sharepoint/rmdir.ts'
import { stat } from '../../../core/sharepoint/stat.ts'
import { readStream } from '../../../core/sharepoint/stream.ts'
import { truncate } from '../../../core/sharepoint/truncate.ts'
import { unlink } from '../../../core/sharepoint/unlink.ts'
import { write } from '../../../core/sharepoint/write.ts'
import { type CommandIO, rangeOf } from '../generic_bind/index.ts'

export const IO: CommandIO<SharePointAccessor> = new VFSAdapter<SharePointAccessor>({
  read: { readdir, readBytes: read, stat },
  native: {
    readRange: rangeOf(read),
    readStream,
    exists,
    find,
    du: makeWalkedDu(stat, readdir),
  },
  writes: {
    write,
    mkdir,
    unlink,
    rmdir,
    rmR,
    rename,
    copy,
    dirCopy: copy,
    create,
    truncate,
  },
  isMounted: () => true,
  local: false,
}).toCommandIO()
