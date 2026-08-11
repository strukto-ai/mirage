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
  invalidateAfterUnlink(path: PathSpec): Promise<void>
}

export interface WatchMount {
  readonly prefix: string
  readonly cacheManager: CacheInvalidator | null
}

export interface WatchRegistry {
  mountFor(path: string): WatchMount | null
}

export interface DeltaHook {
  pull(root: PathSpec, checkpoint: string | null): Promise<Delta>
}

export interface SupportsChanges {
  deltaHook(): DeltaHook
}

export interface WatchOptions {
  queue?: WatchQueue
}

export interface WatchRuntime {
  watch(path: PathSpec | readonly PathSpec[], options?: WatchOptions): AsyncIterable<FileEvent>
  notify(change: FileEvent): Promise<void>
  close(): Promise<void>
}
