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

import { VFSAdapter } from '@struktoai/mirage-core/vfs/adapter'

import { type CommandIO, rangeOf } from '@struktoai/mirage-core/commands/builtin/generic_bind/index'
import type { OPFSAccessor } from '../../../accessor/opfs.ts'
import { appendBytes as opfsAppend } from '../../../core/opfs/append.ts'
import { SCOPE_ERROR } from '../../../core/opfs/constants.ts'
import { copy as opfsCopy } from '../../../core/opfs/copy.ts'
import { create as opfsCreate } from '../../../core/opfs/create.ts'
import { size as opfsDu, entries as opfsDuAll } from '../../../core/opfs/du/index.ts'
import { exists as opfsExists } from '../../../core/opfs/exists.ts'
import { find as opfsFind } from '../../../core/opfs/find.ts'
import { mkdir as opfsMkdir } from '../../../core/opfs/mkdir.ts'
import { read as opfsRead } from '../../../core/opfs/read.ts'
import { readdir as opfsReaddir } from '../../../core/opfs/readdir.ts'
import { rename as opfsRename } from '../../../core/opfs/rename.ts'
import { rmR as opfsRmR } from '../../../core/opfs/rm.ts'
import { rmdir as opfsRmdir } from '../../../core/opfs/rmdir.ts'
import { stat as opfsStat } from '../../../core/opfs/stat.ts'
import { readStream as opfsStream } from '../../../core/opfs/stream.ts'
import { truncate as opfsTruncate } from '../../../core/opfs/truncate.ts'
import { unlink as opfsUnlink } from '../../../core/opfs/unlink.ts'
import { write as opfsWrite } from '../../../core/opfs/write.ts'

export const IO: CommandIO<OPFSAccessor> = new VFSAdapter<OPFSAccessor>({
  read: { readdir: opfsReaddir, readBytes: opfsRead, stat: opfsStat },
  native: {
    readRange: rangeOf(opfsRead),
    readStream: opfsStream,
    exists: opfsExists,
    find: opfsFind,
    du: { size: opfsDu, entries: opfsDuAll },
  },
  writes: {
    write: opfsWrite,
    mkdir: opfsMkdir,
    unlink: opfsUnlink,
    rmdir: opfsRmdir,
    rmR: opfsRmR,
    rename: opfsRename,
    copy: opfsCopy,
    create: opfsCreate,
    truncate: opfsTruncate,
    append: opfsAppend,
  },
  isMounted: () => true,
  local: true,
  maxGlobMatches: SCOPE_ERROR,
}).toCommandIO()
