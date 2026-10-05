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

import type { BoxAccessor } from '../../../accessor/box.ts'
import { makeWalkedDu } from '../../../core/generic/du.ts'
import { narrowPaths as boxNarrowPaths } from '../../../core/box/search.ts'
import { read as boxRead, readStream as boxStream } from '../../../core/box/read.ts'
import { readdir as boxReaddir } from '../../../core/box/readdir.ts'
import { stat as boxStat } from '../../../core/box/stat.ts'
import { copy as boxCopy } from '../../../core/box/copy.ts'
import { create as boxCreate } from '../../../core/box/create.ts'
import { exists as boxExists } from '../../../core/box/exists.ts'
import { mkdir as boxMkdir } from '../../../core/box/mkdir.ts'
import { rename as boxRename } from '../../../core/box/rename.ts'
import { rmR as boxRmR, rmdir as boxRmdir } from '../../../core/box/rmdir.ts'
import { truncate as boxTruncate } from '../../../core/box/truncate.ts'
import { unlink as boxUnlink } from '../../../core/box/unlink.ts'
import { write as boxWrite } from '../../../core/box/write.ts'
import { type CommandIO, rangeOf } from '../generic_bind/index.ts'

export const IO: CommandIO<BoxAccessor> = new VFSAdapter<BoxAccessor>({
  read: { readdir: boxReaddir, readBytes: boxRead, stat: boxStat },
  native: {
    readRange: rangeOf(boxRead),
    readStream: boxStream,
    du: makeWalkedDu(boxStat, boxReaddir),
    exists: boxExists,
  },
  writes: {
    write: boxWrite,
    mkdir: boxMkdir,
    unlink: boxUnlink,
    rmdir: boxRmdir,
    rmR: boxRmR,
    rename: boxRename,
    copy: boxCopy,
    dirCopy: boxCopy,
    create: boxCreate,
    truncate: boxTruncate,
  },
  contentSearch: { narrowPaths: boxNarrowPaths, enabled: (accessor) => accessor.contentSearch },
  isMounted: () => true,
  local: false,
}).toCommandIO()
