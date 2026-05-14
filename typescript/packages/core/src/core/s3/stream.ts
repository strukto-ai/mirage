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

import { recordStream, revisionFor } from '../../observe/context.ts'
import { ResourceName, type PathSpec } from '../../types.ts'
import type { S3Accessor } from '../../accessor/s3.ts'
import { createS3Client, isNotFoundError, loadS3Module, s3Key } from './_client.ts'
import { fpRevFromS3Response } from './read.ts'

const DEFAULT_CHUNK_SIZE = 64 * 1024

export async function* stream(accessor: S3Accessor, path: PathSpec): AsyncIterable<Uint8Array> {
  const virtual = path.original
  const prefix = path.prefix
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
  const input: Record<string, unknown> = { Bucket: config.bucket, Key: s3Key(rawPath) }
  if (pinnedRevision !== null) input.VersionId = pinnedRevision

  // Use virtual (mount-prefixed) path so the record stays correct even
  // when the stream body executes after setVirtualPrefix has been reset.
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
      for await (const chunk of body) {
        if (rec !== null) rec.bytes += chunk.byteLength
        yield chunk
      }
    }
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

export async function rangeRead(
  accessor: S3Accessor,
  path: PathSpec,
  offset: number,
  size: number,
): Promise<Uint8Array> {
  // Delegate to read() with explicit range parameters.
  const { read } = await import('./read.ts')
  return read(accessor, path, undefined, { offset, size })
}

export { DEFAULT_CHUNK_SIZE }
