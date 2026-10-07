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

import type { GDriveAccessor } from '../../accessor/gdrive.ts'
import { evictAfter, invalidateAfterWrite } from '../../cache/context.ts'
import { record, startOp } from '../../observe/context.ts'
import type { PathSpec } from '../../types.ts'
import { eacces, eisdir } from '../../errors/fs.ts'
import { uploadToken } from '../../utils/upload.ts'
import { type DriveFile, updateFileContent, uploadFile } from '../google/drive.ts'
import { statFromItem } from './stat.ts'
import { eaccesOnDenied, isFolder, isNative, resolveKey, resolveParent } from './resolve.ts'

/**
 * Upload a new file, or new content for an existing one. A failed upload
 * still evicts the path: Drive may have stored the bytes before its reply
 * broke off.
 */
async function writeImpl(
  accessor: GDriveAccessor,
  path: PathSpec,
  data: Uint8Array,
): Promise<void> {
  const key = path.vfsPath
  if (key === '') throw eisdir(path)
  const timer = startOp()
  const tm = accessor.tokenManager
  const node = await resolveKey(accessor, key)
  if (node !== null && isFolder(node)) throw eisdir(path)
  // Google-native files are written through the gws commands, not raw bytes.
  if (node !== null && isNative(node)) throw eacces(path)
  let upload: () => Promise<DriveFile>
  if (node !== null) {
    upload = () => updateFileContent(tm, node.id, data)
  } else {
    const [parentId] = await resolveParent(accessor, path)
    const basename = key.includes('/') ? key.slice(key.lastIndexOf('/') + 1) : key
    upload = () => uploadFile(tm, basename, parentId, data)
  }
  await evictAfter(
    async () => {
      const token = uploadToken(await upload(), statFromItem, path.virtual)
      record('write', path.virtual, 'gdrive', data.length, timer, { fingerprint: token })
    },
    () => invalidateAfterWrite(path),
  )
}

export const write = eaccesOnDenied(writeImpl)
