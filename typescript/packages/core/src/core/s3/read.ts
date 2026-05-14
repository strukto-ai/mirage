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

import type { IndexCacheStore } from '../../cache/index/store.ts'
import { record, revisionFor } from '../../observe/context.ts'
import { ResourceName, type PathSpec } from '../../types.ts'
import type { S3Accessor } from '../../accessor/s3.ts'
import { createS3Client, isNotFoundError, loadS3Module, s3Key, streamToBuffer } from './_client.ts'

export interface S3ReadOptions {
  offset?: number
  size?: number
}

/**
 * Extract `(fingerprint, revision)` from a GetObject / HeadObject response.
 *
 * VersionId is null on non-versioned buckets; the SDK can also return the
 * literal string "null" there, which we normalize.
 */
export function fpRevFromS3Response(resp: { ETag?: string | null; VersionId?: string | null }): {
  fingerprint: string | null
  revision: string | null
} {
  const rawEtag = resp.ETag ?? ''
  const fingerprint = rawEtag.replace(/^"|"$/g, '') || null
  let vid = resp.VersionId ?? null
  if (vid === 'null') vid = null
  return { fingerprint, revision: vid }
}

export async function read(
  accessor: S3Accessor,
  path: PathSpec,
  _index?: IndexCacheStore,
  options: S3ReadOptions = {},
): Promise<Uint8Array> {
  const virtual = path.original
  const prefix = path.prefix
  const rawPath =
    prefix !== '' && virtual.startsWith(prefix) ? virtual.slice(prefix.length) || '/' : virtual
  // `virtual` retains the mount prefix (e.g. /s3/foo) for snapshot records;
  // `rawPath` is the backend-relative key used for the actual S3 call.
  const key = s3Key(rawPath)
  const { config } = accessor
  const { GetObjectCommand } = await loadS3Module(config)
  const client = await createS3Client(config)
  const input: Record<string, unknown> = { Bucket: config.bucket, Key: key }
  const pinnedRevision = revisionFor(virtual)
  if (pinnedRevision !== null) {
    input.VersionId = pinnedRevision
  }
  if (options.offset !== undefined || options.size !== undefined) {
    const start = options.offset ?? 0
    const end = options.size !== undefined ? start + options.size - 1 : ''
    input.Range = `bytes=${String(start)}-${String(end)}`
  }
  const startMs = performance.now()
  try {
    const resp = (await (
      client as unknown as {
        send: (cmd: unknown) => Promise<{ Body?: unknown; ETag?: string; VersionId?: string }>
      }
    ).send(new GetObjectCommand(input))) as {
      Body?: unknown
      ETag?: string
      VersionId?: string
    }
    const bytes = await streamToBuffer(resp.Body)
    const { fingerprint, revision } = fpRevFromS3Response(resp)
    // Use the virtual (mount-prefixed) path here rather than rawPath +
    // an applyPrefix lookup, because lazy stream consumption can outlive
    // the mount's setVirtualPrefix scope. Passing virtual makes record's
    // path independent of the active recording context state.
    record('read', virtual, ResourceName.S3, bytes.byteLength, startMs, {
      fingerprint,
      revision,
    })
    return bytes
  } catch (err) {
    if (isNotFoundError(err)) {
      const e = new Error(`S3 object not found: ${rawPath}`) as Error & { code: string }
      e.code = 'ENOENT'
      throw e
    }
    throw err
  } finally {
    ;(client as unknown as { destroy?: () => void }).destroy?.()
  }
}
