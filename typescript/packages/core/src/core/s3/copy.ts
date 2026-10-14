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
import { writesConditioned } from '../../cache/context.ts'
import { enoent, exdev } from '../../errors/fs.ts'
import type { PathSpec } from '../../types.ts'
import { rawPathOf } from '../../utils/key_prefix.ts'
import type { S3Config } from '../../vfs/s3/config.ts'
import { makeCopy } from '../object_store/copy.ts'
import { createS3Client, isNotFoundError, loadS3Module, s3Key } from './client.ts'
import { DRIVER } from './driver.ts'
import { exists } from './exists.ts'

export const copy = makeCopy(DRIVER, exists)

/** Where a mount's requests go and who sends them. Mirrors Python's `_service`. */
function service(config: S3Config): readonly unknown[] {
  return [
    config.endpoint,
    config.region,
    config.profile,
    config.accessKeyId,
    config.secretAccessKey,
    config.sessionToken,
  ]
}

/**
 * Copy an object from another S3 mount's bucket into this one's, in S3.
 *
 * One CopyObject, sent with this mount's client. S3 copies across buckets
 * when one set of credentials reaches both, so it is tried only when both
 * mounts send their requests to the same endpoint with the same credentials;
 * otherwise, or when S3 refuses it, it is EXDEV, and the caller moves the
 * bytes. A conditional mount's write carries its condition, which the move's
 * write does, and a presigned mount signs only what its provider allows, so
 * it is EXDEV there too. A missing source is ENOENT. Mirrors Python's
 * `copy_from`.
 */
export async function copyFrom(
  accessor: S3Accessor,
  source: S3Accessor,
  src: PathSpec,
  dst: PathSpec,
): Promise<void> {
  const { config } = accessor
  const theirs = service(source.config)
  if (
    writesConditioned(dst) ||
    config.presignedUrlProvider !== undefined ||
    service(config).some((value, i) => value !== theirs[i])
  ) {
    throw exdev(dst)
  }
  const { CopyObjectCommand } = await loadS3Module(config)
  const client = await createS3Client(config)
  try {
    await (client as unknown as { send: (cmd: unknown) => Promise<unknown> }).send(
      new CopyObjectCommand({
        Bucket: config.bucket,
        Key: s3Key(rawPathOf(dst), config),
        CopySource: `${source.config.bucket}/${s3Key(rawPathOf(src), source.config)}`,
      }),
    )
  } catch (err) {
    if (isNotFoundError(err)) throw enoent(src)
    if ((err as { $metadata?: unknown }).$metadata !== undefined) throw exdev(dst)
    throw err
  } finally {
    ;(client as unknown as { destroy?: () => void }).destroy?.()
  }
}
