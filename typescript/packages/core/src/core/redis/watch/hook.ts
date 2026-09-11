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

import { FileChangeKind, type FileEvent, type JsonValue, type PathSpec } from '../../../types.ts'
import { eventAt } from '../../../watch/index.ts'
import type { RedisAccessor } from '../../../accessor/redis.ts'
import { DIR_SEGMENT, DIR_SET_VERBS, FILE_SEGMENT, REDIS_KINDS } from './constants.ts'

/**
 * Map one redis keyspace notification onto mount paths.
 *
 * The consumer subscribes to `__keyevent@<db>__:*` (which requires
 * `notify-keyspace-events` to be configured; it is empty by default) and
 * forwards the event verb with the key the message carried.
 *
 * Two limits are the protocol's, not this hook's, and both are reported
 * honestly rather than guessed around:
 *
 * A `set` on a key that did not exist and one that did produce the same
 * notification, so a create is reported as an UPDATE. Nothing is lost for a
 * reader, because the watcher evicts the parent listing for either, but a
 * consumer that needs the distinction has to pull.
 *
 * A rename arrives as two independent messages (`rename_from` with the old
 * key, `rename_to` with the new), so reconstructing a MOVE would need state
 * this hook does not keep. They map to a DELETE and an UPDATE, which is what a
 * poll-diff source reports for a rename too.
 *
 * Directories are the third limit, and the coarsest. Every directory on the
 * mount is one member of a single `<prefix>dir` set, and a keyspace message
 * carries the key, never the member, so an external `mkdir` or `rmdir` says
 * only that some directory changed. An empty directory has no `file:` key at
 * all, so nothing else reports it. That maps to UNKNOWN at the mount root,
 * which re-inventories the whole mount: expensive, but it is exactly what
 * UNKNOWN means and the protocol offers nothing narrower.
 *
 * Keys outside those two (the `modified:` and `attrs:` side keys) name nothing
 * this mount serves and map to nothing.
 *
 * Mirrors Python `RedisEventHook` (`core/redis/watch/hook.py`).
 */
export class RedisEventHook {
  private readonly accessor: RedisAccessor

  constructor(accessor: RedisAccessor) {
    this.accessor = accessor
  }

  /** Mount-relative path for a redis key, or null if it names no file. */
  private relative(key: string): string | null {
    const head = `${this.accessor.store.keyPrefix}${FILE_SEGMENT}`
    if (!key.startsWith(head)) return null
    return key.slice(head.length)
  }

  toEvents(root: PathSpec, eventType: string, payload: JsonValue): Promise<readonly FileEvent[]> {
    if (typeof payload !== 'string') return Promise.resolve([])
    if (payload === `${this.accessor.store.keyPrefix}${DIR_SEGMENT}`) {
      if (!DIR_SET_VERBS.has(eventType)) return Promise.resolve([])
      return Promise.resolve([eventAt(root, '/', FileChangeKind.UNKNOWN)])
    }
    const relative = this.relative(payload)
    if (relative === null) return Promise.resolve([])
    const kind = REDIS_KINDS[eventType]
    if (kind === undefined) return Promise.resolve([])
    return Promise.resolve([eventAt(root, relative, kind)])
  }
}
