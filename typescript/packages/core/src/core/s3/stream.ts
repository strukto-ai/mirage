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

import { mountPrefixOf } from '../../utils/key_prefix.ts'
import { recordStream, revisionFor } from '../../observe/context.ts'
import { ResourceName, type PathSpec } from '../../types.ts'
import type { S3Accessor } from '../../accessor/s3.ts'
import { createS3Client, isNotFoundError, loadS3Module, s3Key } from './_client.ts'
import { fpRevFromS3Response, read } from './read.ts'
import { enoent } from '../../utils/errors.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'

const DEFAULT_CHUNK_SIZE = 8192

function concatChunks(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength)
  out.set(a, 0)
  out.set(b, a.byteLength)
  return out
}

export async function* stream(accessor: S3Accessor, path: PathSpec): AsyncIterable<Uint8Array> {
  const virtual = path.virtual
  const prefix = mountPrefixOf(path.virtual, path.resourcePath)
  const rawPath =
    prefix !== '' && virtual.startsWith(prefix) ? virtual.slice(prefix.length) || '/' : virtual

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

  // Naming the virtual path keeps the record exact without consulting the
  // active mount prefix; record() leaves an already-prefixed path alone.
  const rec = recordStream('read', virtual, ResourceName.S3)

  try {
    const resp = (await send(new GetObjectCommand(input))) as {
      Body?: unknown
      ETag?: string
      VersionId?: string
    }
    if (rec !== null) {
      const { fingerprint, revision } = fpRevFromS3Response(resp)
      rec.fingerprint = fingerprint
      rec.revision = revision
    }
    const body = resp.Body as
      | (AsyncIterable<Uint8Array> & { [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array> })
      | undefined
    if (body === undefined) return
    if (typeof body[Symbol.asyncIterator] === 'function') {
      let pending: Uint8Array = new Uint8Array(0)
      for await (const chunk of body) {
        pending = concatChunks(pending, chunk)
        while (pending.byteLength >= DEFAULT_CHUNK_SIZE) {
          const piece = pending.slice(0, DEFAULT_CHUNK_SIZE)
          if (rec !== null) rec.bytes += piece.byteLength
          yield piece
          pending = pending.slice(DEFAULT_CHUNK_SIZE)
        }
      }
      if (pending.byteLength > 0) {
        if (rec !== null) rec.bytes += pending.byteLength
        yield pending
      }
    }
  } catch (err) {
    if (isNotFoundError(err)) {
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
 * @param index the index cache store, forwarded to the SDK read
 * @param offset first byte to read
 * @param size how many bytes, or null for the rest of the object
 */
export async function readRange(
  accessor: S3Accessor,
  path: PathSpec,
  index: IndexCacheStore | undefined,
  offset: number,
  size: number | null,
): Promise<Uint8Array> {
  if (accessor.config.presignedUrlProvider === undefined) {
    return read(accessor, path, index, size === null ? { offset } : { offset, size })
  }
  return windowFromStream(accessor, path, offset, size)
}

async function windowFromStream(
  accessor: S3Accessor,
  path: PathSpec,
  offset: number,
  size: number | null,
): Promise<Uint8Array> {
  const end = size === null ? Number.POSITIVE_INFINITY : offset + size
  const pieces: Uint8Array[] = []
  let seen = 0
  let total = 0
  for await (const chunk of stream(accessor, path)) {
    const chunkEnd = seen + chunk.byteLength
    if (chunkEnd > offset) {
      const piece = chunk.subarray(
        Math.max(0, offset - seen),
        Math.min(chunk.byteLength, end - seen),
      )
      pieces.push(piece)
      total += piece.byteLength
    }
    seen = chunkEnd
    // Breaking here returns the generator, which cancels the body reader.
    if (seen >= end) break
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const piece of pieces) {
    out.set(piece, at)
    at += piece.byteLength
  }
  return out
}

/**
 * The resource-level `range_read(path, start, end)`, end exclusive.
 *
 * Every other backend's `rangeRead` and all of python's spell the window this
 * way; s3 read its fourth argument as a length, so `range_read(p, 10, 20)`
 * returned twenty bytes from offset ten where python returned ten.
 *
 * @param accessor the S3 accessor
 * @param path the object path
 * @param start first byte to read
 * @param end one past the last byte to read
 */
export function rangeRead(
  accessor: S3Accessor,
  path: PathSpec,
  start: number,
  end: number,
): Promise<Uint8Array> {
  return readRange(accessor, path, undefined, start, end - start)
}
