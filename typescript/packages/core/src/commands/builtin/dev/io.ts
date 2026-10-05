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

import type { RAMAccessor } from '../../../accessor/ram.ts'
import type { IndexCacheStore } from '../../../cache/index/store.ts'
import { read, readRange, stat, readStream } from '../../../core/dev/index.ts'
import { appendBytes as ramAppend } from '../../../core/ram/append.ts'
import { copy as ramCopy } from '../../../core/ram/copy.ts'
import { create as ramCreate } from '../../../core/ram/create.ts'
import { SCOPE_ERROR } from '../../../core/ram/constants.ts'
import { size as ramDu, entries as ramDuAll } from '../../../core/ram/du/index.ts'
import { exists as ramExists } from '../../../core/ram/exists.ts'
import { find as ramFind } from '../../../core/ram/find.ts'
import { mkdir as ramMkdir } from '../../../core/ram/mkdir.ts'
import { pwrite as ramPwrite } from '../../../core/ram/pwrite.ts'
import { readdir as ramReaddir } from '../../../core/ram/readdir.ts'
import { rename as ramRename } from '../../../core/ram/rename.ts'
import { rmR as ramRmR } from '../../../core/ram/rm.ts'
import { rmdir as ramRmdir } from '../../../core/ram/rmdir.ts'
import { setAttrs as ramSetAttrs } from '../../../core/ram/set_attrs.ts'
import { truncate as ramTruncate } from '../../../core/ram/truncate.ts'
import { unlink as ramUnlink } from '../../../core/ram/unlink.ts'
import { write as ramWrite } from '../../../core/ram/write.ts'
import type { PathSpec } from '../../../types.ts'
import type { CommandIO } from '../generic_bind/index.ts'

async function* finiteStream(
  accessor: RAMAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): AsyncIterable<Uint8Array> {
  const data = await read(accessor, path, index)
  if (data.byteLength > 0) yield data
}

export const IO: CommandIO<RAMAccessor> = new VFSAdapter<RAMAccessor>({
  read: { readdir: ramReaddir, readBytes: read, stat },
  native: {
    readRange,
    readStream: finiteStream,
    exists: ramExists,
    find: ramFind,
    du: { size: ramDu, entries: ramDuAll },
  },
  writes: {
    write: ramWrite,
    mkdir: ramMkdir,
    unlink: ramUnlink,
    rmdir: ramRmdir,
    rmR: ramRmR,
    rename: ramRename,
    copy: ramCopy,
    create: ramCreate,
    truncate: ramTruncate,
    append: ramAppend,
    pwrite: ramPwrite,
    setAttrs: ramSetAttrs,
  },
  isMounted: () => true,
  local: true,
  maxGlobMatches: SCOPE_ERROR,
}).toCommandIO()

export const DEV_STREAMING: CommandIO<RAMAccessor> = {
  ...IO,
  readStream,
}
