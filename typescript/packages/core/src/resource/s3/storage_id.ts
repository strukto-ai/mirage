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

import { stripSlash } from '../../utils/slash.ts'
import type { S3Config } from './config.ts'

/**
 * The storage identity of one S3-compatible mount.
 *
 * `cp` and `mv` compare two operands to decide whether they name the same
 * file. Within one mount the mount-relative path answers that; across mounts
 * it does not, since two prefixes can address one store and a move there would
 * copy an object over itself and then unlink the source.
 *
 * Endpoint, bucket and key prefix pin the object namespace. The endpoint
 * matters because the same bucket name on two providers (AWS vs MinIO vs R2)
 * is two different stores. The prefix joins path-like so two mounts whose
 * prefixes nest still resolve to one key once the mount-relative path is
 * appended.
 *
 * Both runtimes call this rather than each writing it out: the node resource
 * had it and the browser one did not, so the same two buckets compared equal
 * under node and distinct under the browser.
 *
 * @param kind the resource kind, which distinguishes the S3-compatible clones
 * @param config the mount's S3 config
 */
export function s3StorageId(kind: string, config: S3Config): string {
  const prefix = stripSlash(config.keyPrefix ?? '')
  const base = `${kind}:${config.endpoint ?? 'aws'}:${config.bucket}`
  return prefix === '' ? base : `${base}/${prefix}`
}
