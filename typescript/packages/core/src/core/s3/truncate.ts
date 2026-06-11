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

import { invalidateAfterWrite } from '../../cache/context.ts'
import type { PathSpec } from '../../types.ts'
import type { S3Accessor } from '../../accessor/s3.ts'
import {
  isNotFoundError,
  loadS3Module,
  rawPathOf,
  s3Key,
  streamToBuffer,
  withClient,
} from './_client.ts'

export async function truncate(
  accessor: S3Accessor,
  path: PathSpec,
  length: number,
): Promise<void> {
  const { GetObjectCommand, PutObjectCommand } = await loadS3Module(accessor.config)
  const raw = rawPathOf(path)
  const key = s3Key(raw, accessor.config)
  await withClient(accessor.config, async (client) => {
    let existing: Uint8Array = new Uint8Array()
    try {
      const resp = (await client.send(
        new GetObjectCommand({ Bucket: accessor.config.bucket, Key: key }),
      )) as { Body?: unknown }
      existing = await streamToBuffer(resp.Body)
    } catch (err) {
      if (!isNotFoundError(err)) throw err
    }
    const out = new Uint8Array(length)
    out.set(existing.subarray(0, Math.min(existing.byteLength, length)), 0)
    // Remaining bytes are already zero-filled (Uint8Array default).
    await client.send(new PutObjectCommand({ Bucket: accessor.config.bucket, Key: key, Body: out }))
  })
  await invalidateAfterWrite(path)
}
