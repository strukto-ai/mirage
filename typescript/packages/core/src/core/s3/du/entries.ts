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

import type { IndexCacheStore } from '../../../cache/index/store.ts'
import type { PathSpec } from '../../../types.ts'
import type { S3Accessor } from '../../../accessor/s3.ts'
import { rstripSlash } from '../../../utils/slash.ts'
import { loadS3Module, rawPathOf, s3Key, stripKeyPrefix, withClient } from '../_client.ts'

/**
 * Return `[path, size]` pairs for every object under the prefix plus a trailing
 * mount-relative path, plus their total. Mirrors Python's `du.entries`.
 */
export async function entries(
  accessor: S3Accessor,
  path: PathSpec,
  _index?: IndexCacheStore,
): Promise<[[string, number][], number]> {
  const { ListObjectsV2Command } = await loadS3Module(accessor.config)
  const raw = rawPathOf(path)
  const stem = rstripSlash(s3Key(raw, accessor.config))
  const base = stem !== '' ? `${stem}/` : ''
  const entries: [string, number][] = []
  let total = 0
  await withClient(accessor.config, async (client) => {
    let continuationToken: string | undefined
    do {
      const input: Record<string, unknown> = {
        Bucket: accessor.config.bucket,
        Prefix: stem,
      }
      if (continuationToken !== undefined) input.ContinuationToken = continuationToken
      const resp = (await client.send(new ListObjectsV2Command(input))) as {
        Contents?: { Key?: string; Size?: number }[]
        IsTruncated?: boolean
        NextContinuationToken?: string
      }
      for (const obj of resp.Contents ?? []) {
        const key = obj.Key
        if (key === undefined) continue
        if (!(key === stem || key.startsWith(base))) continue
        const size = obj.Size ?? 0
        const entry = '/' + stripKeyPrefix(key, accessor.config)
        entries.push([entry, size])
        total += size
      }
      continuationToken = resp.IsTruncated === true ? resp.NextContinuationToken : undefined
    } while (continuationToken !== undefined)
  })
  return [entries, total]
}
