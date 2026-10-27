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
import { record, revisionFor, startOp } from '../../observe/context.ts'
import { VFSName, type PathSpec } from '../../types.ts'
import type { S3Accessor } from '../../accessor/s3.ts'
import { createS3Client, isDenied, isNotFound, loadS3Module, s3Key } from './client.ts'
import { eacces, enoent } from '../../errors/fs.ts'
import { fpRevFromS3Response } from './read.ts'

// An MD5 as an ETag spells it: 32 lowercase hex digits, no part count.
const MD5_ETAG = /^[0-9a-f]{32}$/

/**
 * An object's MD5, read off its ETag when the ETag is one.
 *
 * A store names an object's MD5 as its ETag only for a single-part upload
 * kept unencrypted, or on AWS under SSE-S3: a multipart ETag ends in `-N`, and
 * an object under SSE-KMS or SSE-C carries some other 32 hex digits, which no
 * look at the ETag tells apart, so the head's encryption decides. `aws` says
 * the store is AWS itself, where SSE-S3 keeps the MD5. Every other algorithm
 * is null. A digest answered is recorded as the read it stands in for, with
 * the ETag and version the head saw, so a snapshot pins them and a
 * conditional write later in the line is conditioned on them. Mirrors
 * Python's core/s3/checksum.py.
 */
export async function checksum(
  accessor: S3Accessor,
  path: PathSpec,
  algorithm: string,
  aws: boolean,
): Promise<string | null> {
  if (algorithm !== 'md5') return null
  const { config } = accessor
  const { HeadObjectCommand } = await loadS3Module(config)
  const client = await createS3Client(config)
  const input: Record<string, unknown> = {
    Bucket: config.bucket,
    Key: s3Key(rawPathOf(path), config),
  }
  const pinned = revisionFor(path.virtual)
  if (pinned !== null) input.VersionId = pinned
  let resp: {
    ETag?: string
    VersionId?: string
    ServerSideEncryption?: string
    SSECustomerAlgorithm?: string
  }
  const timer = startOp()
  try {
    resp = await (client as unknown as { send: (cmd: unknown) => Promise<typeof resp> }).send(
      new HeadObjectCommand(input),
    )
  } catch (err) {
    if (isNotFound(err)) throw enoent(path)
    if (isDenied(err)) throw eacces(path)
    throw err
  } finally {
    ;(client as unknown as { destroy?: () => void }).destroy?.()
  }
  const sse = resp.ServerSideEncryption ?? null
  if ((resp.SSECustomerAlgorithm ?? null) !== null) return null
  if (sse !== null && !(aws && sse === 'AES256')) return null
  const etag = (resp.ETag ?? '').replace(/^"|"$/g, '')
  if (!MD5_ETAG.test(etag)) return null
  record('read', path.virtual, VFSName.S3, 0, timer, fpRevFromS3Response(resp))
  return etag
}
