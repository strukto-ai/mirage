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

import { invalidateAfterWrite, invalidateAncestors } from '../../cache/context.ts'
import type { PathSpec } from '../../types.ts'
import type { S3Accessor } from '../../accessor/s3.ts'
import { loadS3Module, rawPathOf, s3Prefix, withClient } from './_client.ts'

export async function mkdir(accessor: S3Accessor, path: PathSpec, parents = false): Promise<void> {
  const { PutObjectCommand } = await loadS3Module(accessor.config)
  const raw = rawPathOf(path)
  const pfx = s3Prefix(raw, accessor.config)
  if (pfx === '') return
  await withClient(accessor.config, async (client) => {
    await client.send(
      new PutObjectCommand({
        Bucket: accessor.config.bucket,
        Key: pfx,
        Body: new Uint8Array(),
      }),
    )
  })
  await invalidateAfterWrite(path)
  if (parents) await invalidateAncestors(path)
}
