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
import { invalidateAfterWrite } from '../../cache/context.ts'
import type { PathSpec } from '../../types.ts'
import { eacces, eisdir } from '../../utils/errors.ts'
import { updateFileContent, uploadFile } from '../google/drive.ts'
import { eaccesOnDenied, isFolder, isNative, resolveKey, resolveParent } from './resolve.ts'

async function writeImpl(
  accessor: GDriveAccessor,
  path: PathSpec,
  data: Uint8Array,
): Promise<void> {
  const key = path.resourcePath
  if (key === '') throw eisdir(path)
  const tm = accessor.tokenManager
  const node = await resolveKey(accessor, key)
  if (node !== null && isFolder(node)) throw eisdir(path)
  // Google-native files are written through the gws commands, not raw bytes.
  if (node !== null && isNative(node)) throw eacces(path)
  if (node !== null) {
    await updateFileContent(tm, node.id, data)
  } else {
    const [parentId] = await resolveParent(accessor, path)
    const basename = key.includes('/') ? key.slice(key.lastIndexOf('/') + 1) : key
    await uploadFile(tm, basename, parentId, data)
  }
  await invalidateAfterWrite(path)
}

export const write = eaccesOnDenied(writeImpl)
