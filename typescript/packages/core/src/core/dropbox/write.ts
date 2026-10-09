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
import {
  evictAfter,
  invalidateAfterWrite,
  invalidateAncestors,
  nativeCondition,
  writeCondition,
} from '../../cache/context.ts'
import { record, startOp } from '../../observe/context.ts'
import type { PathSpec } from '../../types.ts'
import { uploadToken } from '../../utils/upload.ts'
import { lookup, refused, type DropboxEntry } from './api.ts'
import { liveOf } from './fingerprint.ts'
import { dropboxUpload } from './client.ts'
import { dropboxPathOf } from './paths.ts'
import { statFromEntry } from './stat.ts'

// Single-call upload; Dropbox caps it at ~150 MB (larger files need
// upload sessions, not supported here). A failed upload still evicts the
// path: Dropbox may have stored the bytes before its reply broke off. On a
// `write: conditional` mount a held version is checked against the file's
// live content_hash, which costs one get_metadata, and its rev goes out in
// `update` mode, so a file changed since it was read is refused.
export async function write(
  accessor: DropboxAccessor,
  path: PathSpec,
  data: Uint8Array,
): Promise<void> {
  const tm = accessor.tokenManager
  const apiPath = dropboxPathOf(accessor, path)
  const cond = await writeCondition(path, 'put')
  let rev: string | null = null
  if (cond?.ifMatch !== undefined && cond.ifMatch !== '') {
    rev = await nativeCondition(path, cond, liveOf(await lookup(tm, apiPath)), 'put')
  }
  const timer = startOp()
  try {
    await evictAfter(
      async () => {
        const entry = await dropboxUpload(tm, apiPath, data, rev)
        const token = uploadToken(entry as DropboxEntry | null, statFromEntry, path.virtual)
        record('write', path.virtual, 'dropbox', data.byteLength, timer, { fingerprint: token })
      },
      async () => {
        await invalidateAfterWrite(path)
        await invalidateAncestors(path)
      },
    )
  } catch (err) {
    const lost = await refused(path, err, cond, rev)
    if (lost !== null) throw lost
    throw err
  }
}
