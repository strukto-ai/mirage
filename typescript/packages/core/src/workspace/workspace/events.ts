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
import type { EventRuntime } from '../../events/base.ts'
import { EventHub } from '../../events/hub.ts'
import type { MountRegistry } from '../mount/registry.ts'

/**
 * The workspace's event surface: which runtime serves `events`/`notify`
 * and when it attaches. The default runtime attaches lazily on first
 * use; `attach` beforehand only to customize it. Mirrors the Python
 * `EventManager` in `workspace/workspace/events.py`.
 */
export class EventManager {
  private readonly registry: MountRegistry
  private attached: EventRuntime | null = null

  constructor(registry: MountRegistry) {
    this.registry = registry
  }

  get runtime(): EventRuntime | null {
    return this.attached
  }

  attach(runtime: EventRuntime): void {
    if (this.attached !== null) {
      throw new Error(
        'event runtime already attached: detachEventRuntime first, or attach before the first events()/notify()',
      )
    }
    this.attached = runtime
  }

  /**
   * Close and drop the attached runtime, if any. Active `events`
   * iterators finish cleanly; the next `events`/`notify` lazily
   * attaches a fresh default runtime.
   */
  async detach(): Promise<void> {
    if (this.attached === null) return
    await this.attached.close()
    this.attached = null
  }

  delegate(): EventRuntime {
    this.attached ??= new EventHub(this.registry)
    return this.attached
  }

  events(path: string | PathSpec | readonly (string | PathSpec)[]): AsyncIterable<FileEvent> {
    const raw = typeof path === 'string' || path instanceof PathSpec ? [path] : [...path]
    const specs = raw.map((item) => (item instanceof PathSpec ? item : PathSpec.fromStrPath(item)))
    return this.delegate().events(specs)
  }

  async notify(change: FileEvent): Promise<void> {
    await this.delegate().notify(change)
  }
}
