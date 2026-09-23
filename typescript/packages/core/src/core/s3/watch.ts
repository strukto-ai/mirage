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

import type { S3Accessor } from '../../accessor/s3.ts'
import type { DeltaHook } from '../../watch/base.ts'
import { ListingDeltaHook } from '../../watch/delta.ts'
import { statFingerprint } from '../../watch/fingerprint.ts'
import { synthDirs } from '../../watch/walk.ts'
import type { PathSpec, WalkEntry } from '../../types.ts'
import { mountPrefixOf } from '../../utils/key_prefix.ts'
import { rstripSlash, stripSlash } from '../../utils/slash.ts'
import { loadS3Module, rawPathOf, s3Key, stripKeyPrefix, withClient } from './client.ts'

interface ListedObject {
  Key?: string
  Size?: number
  LastModified?: Date | string
  ETag?: string
}

function isoOf(value: Date | string | undefined): string | null {
  if (value === undefined) return null
  // Checkpoints persist this spelling as part of the fallback fingerprint.
  return value instanceof Date ? value.toISOString() : value
}

/**
 * Recursive `ListObjectsV2` feeding the generic listing differ.
 *
 * One paginated LIST with no Delimiter covers the whole subtree, so a pull
 * costs one request per 1000 keys rather than one per directory. Reads the
 * bucket directly, never through mirage's caches, as the DeltaHook contract
 * requires.
 *
 * Fingerprints on the object's ETag, which for a single-part upload is the MD5
 * of the content, so an overwrite with identical bytes is correctly reported
 * as no change. Multipart ETags are a digest of the part digests, which still
 * changes with the content.
 */
export class S3Walk {
  private readonly accessor: S3Accessor

  constructor(accessor: S3Accessor) {
    this.accessor = accessor
  }

  async *walk(root: PathSpec): AsyncGenerator<WalkEntry> {
    const config = this.accessor.config
    const prefix = mountPrefixOf(root.virtual, root.vfsPath)
    const stem = rstripSlash(s3Key(rawPathOf(root), config))
    const base = stem !== '' ? `${stem}/` : ''
    const files: string[] = []
    const markers: string[] = []
    const rows: WalkEntry[] = []
    const { ListObjectsV2Command } = await loadS3Module(config)
    await withClient(config, async (client) => {
      let continuationToken: string | undefined
      do {
        const input: Record<string, unknown> = { Bucket: config.bucket, Prefix: stem }
        if (continuationToken !== undefined) input.ContinuationToken = continuationToken
        const resp = (await client.send(new ListObjectsV2Command(input))) as {
          Contents?: ListedObject[]
          IsTruncated?: boolean
          NextContinuationToken?: string
        }
        for (const obj of resp.Contents ?? []) {
          const key = obj.Key
          if (key === undefined) continue
          if (!(key === stem || key.startsWith(base))) continue
          const relative = stripSlash(stripKeyPrefix(key, config))
          const virtual = prefix !== '' ? `${prefix}/${relative}` : `/${relative}`
          if (key.endsWith('/')) {
            // A directory marker: mirage's own mkdir writes one. It
            // carries an ETag and a size, but it is not a file, so
            // synthDirs reports it instead.
            markers.push(rstripSlash(virtual))
            continue
          }
          files.push(virtual)
          const modified = isoOf(obj.LastModified)
          const size = obj.Size ?? null
          const etag = (obj.ETag ?? '').replace(/^"|"$/g, '') || null
          rows.push({
            virtual,
            isDir: false,
            fingerprint: statFingerprint(etag, modified, size),
            size,
            modified,
          })
        }
        continuationToken = resp.IsTruncated === true ? resp.NextContinuationToken : undefined
      } while (continuationToken !== undefined)
    })
    yield* rows
    yield* synthDirs(root.virtual, files, markers)
  }
}

// Build the delta hook shared by S3 and every S3-compatible alias.
export function buildDeltaHook(accessor: S3Accessor): DeltaHook {
  const walk = new S3Walk(accessor)
  return new ListingDeltaHook(walk.walk.bind(walk))
}
