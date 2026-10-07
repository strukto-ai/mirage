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

import type { DropboxAccessor } from '../../accessor/dropbox.ts'
import { evictAfter, invalidateAfterWrite, invalidateAncestors } from '../../cache/context.ts'
import { record, startOp } from '../../observe/context.ts'
import type { PathSpec } from '../../types.ts'
import { uploadToken } from '../../utils/upload.ts'
import type { DropboxEntry } from './api.ts'
import { dropboxUpload } from './client.ts'
import { dropboxPathOf } from './paths.ts'
import { statFromEntry } from './stat.ts'

// Single-call upload; Dropbox caps it at ~150 MB (larger files need
// upload sessions, not supported here). A failed upload still evicts the
// path: Dropbox may have stored the bytes before its reply broke off.
export async function write(
  accessor: DropboxAccessor,
  path: PathSpec,
  data: Uint8Array,
): Promise<void> {
  const timer = startOp()
  await evictAfter(
    () => dropboxUpload(accessor.tokenManager, dropboxPathOf(accessor, path), data),
    async (entry) => {
      if (entry !== undefined) {
        const token = uploadToken(entry as DropboxEntry | null, statFromEntry, path.virtual)
        record('write', path.virtual, 'dropbox', data.byteLength, timer, { fingerprint: token })
      }
      await invalidateAfterWrite(path)
      await invalidateAncestors(path)
    },
  )
}
