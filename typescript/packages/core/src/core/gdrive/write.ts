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
import { record, startOp } from '../../observe/context.ts'
import { type FileStat, FileType, type PathSpec } from '../../types.ts'
import type { Handed } from '../../vfs/types.ts'
import { eacces, eisdir } from '../../errors/fs.ts'
import { uploadToken } from '../../utils/upload.ts'
import { updateFileContent, uploadFile } from '../google/drive.ts'
import { NATIVE_RESOURCE_TYPES } from './fingerprint.ts'
import { liveRow, statFromItem } from './readdir.ts'
import { eaccesOnDenied, parentFolder } from './resolve.ts'

/**
 * Upload a new file, or new content for an existing one, handed what is at
 * `path` and at its parent. Answers the stored file's stat, null for a reply
 * that names none. Mirrors Python's `write`.
 */
async function writeImpl(
  accessor: GDriveAccessor,
  path: PathSpec,
  data: Uint8Array,
  handed: Handed = {},
): Promise<FileStat | null> {
  const key = path.vfsPath
  if (key === '') throw eisdir(path)
  const timer = startOp()
  const tm = accessor.tokenManager
  const entry = await liveRow(accessor, path, handed.entry)
  if (entry !== null && entry.type === FileType.DIRECTORY) throw eisdir(path)
  // Google-native files are written through the gws commands, not raw bytes.
  if (entry !== null && NATIVE_RESOURCE_TYPES.has(entry.extra.resource_type as string)) {
    throw eacces(path)
  }
  let reply
  if (entry !== null) {
    reply = await updateFileContent(tm, entry.extra.file_id as string, data)
  } else {
    const [parentId] = await parentFolder(accessor, path, handed.parent)
    const basename = key.includes('/') ? key.slice(key.lastIndexOf('/') + 1) : key
    reply = await uploadFile(tm, basename, parentId, data)
  }
  const token = uploadToken(reply, statFromItem, path.virtual)
  record('write', path.virtual, 'gdrive', data.length, timer, { fingerprint: token })
  const item: unknown = reply
  return typeof item === 'object' && item !== null ? statFromItem(reply) : null
}

export const write = eaccesOnDenied(writeImpl)
