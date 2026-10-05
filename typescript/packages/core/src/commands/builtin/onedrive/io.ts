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
import type { OneDriveAccessor } from '../../../accessor/onedrive.ts'
import { makeWalkedDu } from '../../../core/generic/du.ts'
import { copy } from '../../../core/onedrive/copy.ts'
import { create } from '../../../core/onedrive/create.ts'
import { exists } from '../../../core/onedrive/exists.ts'
import { find } from '../../../core/onedrive/find.ts'
import { mkdir } from '../../../core/onedrive/mkdir.ts'
import { read } from '../../../core/onedrive/read.ts'
import { readdir } from '../../../core/onedrive/readdir.ts'
import { rename } from '../../../core/onedrive/rename.ts'
import { rmR } from '../../../core/onedrive/rm.ts'
import { rmdir } from '../../../core/onedrive/rmdir.ts'
import { stat } from '../../../core/onedrive/stat.ts'
import { readStream } from '../../../core/onedrive/stream.ts'
import { truncate } from '../../../core/onedrive/truncate.ts'
import { unlink } from '../../../core/onedrive/unlink.ts'
import { write } from '../../../core/onedrive/write.ts'
import { type CommandIO, rangeOf } from '../generic_bind/index.ts'

export const IO: CommandIO<OneDriveAccessor> = new VFSAdapter<OneDriveAccessor>({
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
