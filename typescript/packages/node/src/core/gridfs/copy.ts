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

import { enoent, invalidateAfterWrite, type PathSpec } from '@struktoai/mirage-core'
import type { GridFSAccessor } from '../../accessor/gridfs.ts'
import { bucket, gridfsKey, latestFile, rawPathOf } from './_client.ts'

export async function copy(accessor: GridFSAccessor, src: PathSpec, dst: PathSpec): Promise<void> {
  // Copies the latest revision only (mirrors S3 CopyObject), streamed
  // chunk-by-chunk so large files never buffer fully in memory.
  const srcKey = gridfsKey(rawPathOf(src), accessor.config)
  const dstKey = gridfsKey(rawPathOf(dst), accessor.config)
  const doc = await latestFile(accessor, srcKey)
  if (doc === null) throw enoent(src)
  const b = await bucket(accessor)
  const readable = b.openDownloadStream(doc._id)
  const upload = b.openUploadStream(dstKey)
  await new Promise<void>((resolve, reject) => {
    upload.on('error', reject)
    readable.on('error', reject)
    upload.on('finish', () => {
      resolve()
    })
    readable.pipe(upload)
  })
  await invalidateAfterWrite(dst)
}
