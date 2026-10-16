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
import { FileChangeKind, type FileEvent, type JsonValue, type PathSpec } from '../../types.ts'
import { normalize } from '../../utils/key_prefix.ts'
import { rstripSlash } from '../../utils/slash.ts'
import { eventAt, field, textField } from '../../events/payload.ts'

// The eventName families a record carries: a write (Put, Post, Copy,
// CompleteMultipartUpload) or a removal (Delete, DeleteMarkerCreated,
// lifecycle expiry).
const WRITTEN = 'ObjectCreated:'
const REMOVED = ['ObjectRemoved:', 'LifecycleExpiration:']

/**
 * Map one S3 event notification record onto mount paths.
 *
 * The consumer owns the transport (S3 Event Notifications delivered to an SQS
 * queue, an SNS topic or EventBridge) and passes each record of a
 * notification's `Records` with its `eventName`. Nothing here runs a loop. A
 * record names the bucket and the object key, URL-encoded with `+` for a
 * space, and says whether the object was written or removed.
 *
 * S3 does not say whether a write made the object or replaced it, so a key the
 * hook has mapped before is an UPDATE and any other is a CREATE, as the Box
 * hook splits an upload. A key ending in `/` is a directory marker: writing
 * one makes the directory, and removing one leaves whatever is below it, so
 * that directory is UNKNOWN. In a versioned bucket a `Delete` names the one
 * version it removed, and an older one may now be the object, so the key is
 * UNKNOWN; a delete marker hides the object, which is a DELETE. A record for
 * another bucket, or for a key outside the mount's `keyPrefix`, maps to
 * nothing.
 *
 * Mirrors Python `S3EventHook` (`core/s3/events.py`).
 */
export class S3EventHook {
  private readonly accessor: S3Accessor
  private readonly seen = new Set<string>()

  constructor(accessor: S3Accessor) {
    this.accessor = accessor
  }

  toEvents(root: PathSpec, eventName: string, payload: JsonValue): Promise<readonly FileEvent[]> {
    return Promise.resolve(this.map(root, eventName, payload))
  }

  private map(root: PathSpec, eventName: string, payload: JsonValue): readonly FileEvent[] {
    const config = this.accessor.config
    const s3 = field(payload, 's3')
    const raw = textField(field(s3, 'object'), 'key')
    if (textField(field(s3, 'bucket'), 'name') !== config.bucket || !raw) return []
    const key = decodeURIComponent(raw.replace(/\+/g, ' '))
    const prefix = normalize(config.keyPrefix)
    if (prefix !== '' && !key.startsWith(prefix)) return []
    const relative = key.slice(prefix.length)
    if (relative.endsWith('/')) {
      const place = rstripSlash(relative)
      if (place === '') return []
      const kind = eventName.startsWith(WRITTEN) ? FileChangeKind.CREATE : FileChangeKind.UNKNOWN
      return [eventAt(root, place, kind)]
    }
    if (REMOVED.some((family) => eventName.startsWith(family))) {
      const version = textField(field(s3, 'object'), 'versionId')
      if (eventName.endsWith(':Delete') && version !== null) {
        return [eventAt(root, relative, FileChangeKind.UNKNOWN)]
      }
      this.seen.delete(relative)
      return [eventAt(root, relative, FileChangeKind.DELETE)]
    }
    if (!eventName.startsWith(WRITTEN)) return []
    const kind = this.seen.has(relative) ? FileChangeKind.UPDATE : FileChangeKind.CREATE
    this.seen.add(relative)
    return [eventAt(root, relative, kind)]
  }
}
