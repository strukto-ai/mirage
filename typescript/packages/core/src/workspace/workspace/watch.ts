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

import type { FileEvent } from '../../types.ts'
import { PathSpec } from '../../types.ts'
import type { WatchRuntime } from '../../watch/base.ts'
import { Watcher } from '../../watch/watcher.ts'
import type { MountRegistry } from '../mount/registry.ts'

/**
 * The workspace's watch surface: which runtime serves `watch`/`notify`
 * and when it attaches. The default runtime attaches lazily on first
 * use; `attach` beforehand only to customize it. Mirrors the Python
 * `WatchManager` in `workspace/watch.py`.
 */
export class WatchManager {
  private readonly registry: MountRegistry
  private attached: WatchRuntime | null = null

  constructor(registry: MountRegistry) {
    this.registry = registry
  }

  get runtime(): WatchRuntime | null {
    return this.attached
  }

  attach(runtime: WatchRuntime): void {
    if (this.attached !== null) {
      throw new Error(
        'watch runtime already attached: detachWatchRuntime first, or attach before the first watch()/notify()',
      )
    }
    this.attached = runtime
  }

  /**
   * Close and drop the attached runtime, if any. Active `watch`
   * iterators finish cleanly; the next `watch`/`notify` lazily
   * attaches a fresh default runtime.
   */
  async detach(): Promise<void> {
    if (this.attached === null) return
    await this.attached.close()
    this.attached = null
  }

  delegate(): WatchRuntime {
    this.attached ??= new Watcher(this.registry)
    return this.attached
  }

  watch(path: string | PathSpec | readonly (string | PathSpec)[]): AsyncIterable<FileEvent> {
    const raw = typeof path === 'string' || path instanceof PathSpec ? [path] : [...path]
    const specs = raw.map((item) => (item instanceof PathSpec ? item : PathSpec.fromStrPath(item)))
    return this.delegate().watch(specs)
  }

  async notify(change: FileEvent): Promise<void> {
    await this.delegate().notify(change)
  }
}
