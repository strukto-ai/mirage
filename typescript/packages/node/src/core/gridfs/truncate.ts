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

import { invalidateAfterWrite, type PathSpec } from '@struktoai/mirage-core'
import type { GridFSAccessor } from '../../accessor/gridfs.ts'
import { gridfsKey, latestFile, rawPathOf } from './_client.ts'
import { downloadBytes } from './read.ts'
import { uploadBytes } from './write.ts'

export async function truncate(
  accessor: GridFSAccessor,
  path: PathSpec,
  length: number,
): Promise<void> {
  const raw = rawPathOf(path)
  const key = gridfsKey(raw, accessor.config)
  const doc = await latestFile(accessor, key)
  let data = doc === null ? new Uint8Array(0) : await downloadBytes(accessor, path, doc._id)
  if (data.byteLength > length) {
    data = data.slice(0, length)
  } else if (data.byteLength < length) {
    const padded = new Uint8Array(length)
    padded.set(data, 0)
    data = padded
  }
  await uploadBytes(accessor, key, data)
  await invalidateAfterWrite(path)
}
