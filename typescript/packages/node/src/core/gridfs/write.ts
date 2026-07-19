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

import { ResourceName, invalidateAfterWrite, record, type PathSpec } from '@struktoai/mirage-core'
import type { GridFSAccessor } from '../../accessor/gridfs.ts'
import { bucket, gridfsKey, rawPathOf } from './_client.ts'

export async function uploadBytes(
  accessor: GridFSAccessor,
  key: string,
  data: Uint8Array,
): Promise<void> {
  const b = await bucket(accessor)
  const upload = b.openUploadStream(key)
  await new Promise<void>((resolve, reject) => {
    upload.on('error', reject)
    upload.on('finish', () => {
      resolve()
    })
    upload.end(data)
  })
}

export async function write(
  accessor: GridFSAccessor,
  path: PathSpec,
  data: Uint8Array,
): Promise<void> {
  // Uploads a new revision; older revisions stay in fs.files, so reads
  // pinned to an old revision _id keep working (GridFS-native versioning).
  const raw = rawPathOf(path)
  const key = gridfsKey(raw, accessor.config)
  const startMs = performance.now()
  await uploadBytes(accessor, key, data)
  record('write', path.virtual, ResourceName.GRIDFS, data.byteLength, startMs)
  await invalidateAfterWrite(path)
}
