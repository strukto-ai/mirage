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

import type { Delta, FileEvent, PathSpec } from '../types.ts'
import type { WatchQueue } from './queue/base.ts'

export interface CacheInvalidator {
  invalidateAfterWrite(path: PathSpec): Promise<void>
  invalidateAfterRemove(path: PathSpec): Promise<void>
  invalidateSubtree(path: PathSpec): Promise<void>
  invalidateAncestors(path: PathSpec): Promise<void>
}

export interface WatchMount {
  readonly prefix: string
  readonly cacheManager: CacheInvalidator | null
}

// The raising lookup: a watch path or change event outside every mount
// is a caller error, so the miss propagates (mirrors the Python
// watcher calling the registry's raising mount_for directly).
export interface WatchRegistry {
  mountFor(path: string): WatchMount
}

export interface DeltaHook {
  pull(root: PathSpec, checkpoint: string | null): Promise<Delta>
}

/**
 * Translation of one service notification into mount paths.
 *
 * The push counterpart of `DeltaHook`: where a hook pulls and diffs, this
 * maps a notification the service already delivered. Mirage owns no transport
 * either way, so the consumer runs the socket, the webhook receiver or the
 * change stream and passes what arrived here; only the path arithmetic lives
 * beside the backend, because the naming rules are the backend's and a
 * consumer reimplementing them drifts.
 *
 * A notification that names only a scope maps to `UNKNOWN` on that directory,
 * which the watcher reads as "re-inventory everything below". That is the
 * honest answer when the service cannot say more, so a hook never has to
 * invent a path it was not told about.
 *
 */

export interface WatchOptions {
  queue?: WatchQueue
}

export interface WatchRuntime {
  watch(path: PathSpec | readonly PathSpec[], options?: WatchOptions): AsyncIterable<FileEvent>
  notify(change: FileEvent): Promise<void>
  close(): Promise<void>
}
