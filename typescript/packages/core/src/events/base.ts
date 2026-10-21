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

import type { CacheManager } from '../cache/manager.ts'
import type { Delta, FileEvent, PathSpec } from '../types.ts'

export interface EventMount {
  readonly prefix: string
  readonly cacheManager: Pick<CacheManager, 'invalidate'> | null
}

// The raising lookup: a subscribed path or change event outside every mount
// is a caller error, so the miss propagates (mirrors the Python
// hub calling the registry's raising mount_for directly).
export interface EventRegistry {
  mountFor(path: string): EventMount
}

export interface DeltaHook {
  pull(root: PathSpec, checkpoint: string | null): Promise<Delta>
}

export interface EventRuntime {
  events(path: PathSpec | readonly PathSpec[]): AsyncIterable<FileEvent>
  notify(change: FileEvent): Promise<void>
  close(): Promise<void>
}
