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

import { rawPathOf } from '../../utils/key_prefix.ts'
import { rechunk, sliceStream } from '../../io/stream.ts'
import { materialize } from '../../io/types.ts'
import { recordStream, revisionFor } from '../../observe/context.ts'
import { VFSName, type PathSpec } from '../../types.ts'
import type { S3Accessor } from '../../accessor/s3.ts'
import { createS3Client, isNotFound, loadS3Module, s3Key } from './client.ts'
import { fpRevFromS3Response, read } from './read.ts'
import { enoent } from '../../errors/fs.ts'

const DEFAULT_CHUNK_SIZE = 8192

export async function* readStream(
  accessor: S3Accessor,
  path: PathSpec,
  onVersion?: (version: string | null) => void,
): AsyncIterable<Uint8Array> {
  const virtual = path.virtual
  const rawPath = rawPathOf(path)

  const { config } = accessor
  const { GetObjectCommand } = await loadS3Module(config)
  const client = await createS3Client(config)
  const send = (
    client as unknown as {
      send: (cmd: unknown) => Promise<{ Body?: unknown; ETag?: string; VersionId?: string }>
    }
  ).send.bind(client)

  const pinnedRevision = revisionFor(virtual)
  const input: Record<string, unknown> = { Bucket: config.bucket, Key: s3Key(rawPath, config) }
  if (pinnedRevision !== null) input.VersionId = pinnedRevision

  try {
    const resp = (await send(new GetObjectCommand(input))) as {
      Body?: unknown
      ETag?: string
      VersionId?: string
    }
    const rec = recordStream('read', virtual, VFSName.S3)
    const { fingerprint, revision } = fpRevFromS3Response(resp)
    onVersion?.(fingerprint)
    if (rec !== null) {
      rec.fingerprint = fingerprint
      rec.revision = revision
    }
    const body = resp.Body as
      | (AsyncIterable<Uint8Array> & { [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array> })
      | undefined
    if (body === undefined) return
    if (typeof body[Symbol.asyncIterator] === 'function') {
      for await (const piece of rechunk(body, DEFAULT_CHUNK_SIZE)) {
        if (rec !== null) rec.bytes += piece.byteLength
        yield piece
      }
    }
  } catch (err) {
    if (isNotFound(err)) {
      throw enoent(path)
    }
    throw err
  } finally {
    ;(client as unknown as { destroy?: () => void }).destroy?.()
  }
}

/**
 * A byte window, taken the cheapest way the configured client allows.
 *
 * The SDK path asks for one ranged GET, which is the whole point on an object
 * store. The browser path cannot: `createBrowserS3Client` fetches a presigned
 * URL, and a presigned GET carries no `Range` — adding the header would make
 * the request non-simple and trip a CORS preflight that presigned deployments
 * generally do not allow. Its shim therefore refuses a `Range` input outright,
 * so asking for one there would fail rather than quietly return the whole
 * object as if it were the window.
 *
 * Streaming is the honest substitute: `bodyFromResponse` hands back a reader
 * over the live body, so stopping at `offset + size` cancels the download
 * instead of buffering the rest of the object and throwing it away.
 *
 * @param accessor the S3 accessor
 * @param path the object path
 * @param offset first byte to read
 * @param size how many bytes, or null for the rest of the object
 */
export async function readRange(
  accessor: S3Accessor,
  path: PathSpec,
  offset: number,
  size: number | null,
): Promise<Uint8Array> {
  if (accessor.config.presignedUrlProvider === undefined) {
    return read(accessor, path, size === null ? { offset } : { offset, size })
  }
  return materialize(sliceStream(readStream(accessor, path), offset, size))
}
