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
import type { PathSpec } from '../../types.ts'
import { eisdir } from '../../utils/errors.ts'
import { downloadFile } from '../google/drive.ts'
import { eaccesOnDenied, isFolder, isNative, resolveKey } from './resolve.ts'
import { write } from './write.ts'

async function truncateImpl(
  accessor: GDriveAccessor,
  path: PathSpec,
  length: number,
): Promise<void> {
  const node = await resolveKey(accessor, path.resourcePath)
  if (node !== null && isFolder(node)) throw eisdir(path)
  let data: Uint8Array
  if (node === null || isNative(node)) {
    data = new Uint8Array(0)
  } else {
    data = await downloadFile(accessor.tokenManager, node.id)
  }
  let out: Uint8Array
  if (length <= data.length) {
    out = data.slice(0, length)
  } else {
    out = new Uint8Array(length)
    out.set(data, 0)
  }
  await write(accessor, path, out)
}

export const truncate = eaccesOnDenied(truncateImpl)
