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

import { FileChangeKind, FileEvent, PathSpec } from '../types.ts'
import { hasGlob } from '../utils/glob_walk.ts'
import { globPrefixMatch } from '../utils/path.ts'
import { rstripSlash, stripSlash } from '../utils/slash.ts'
import type { WatchMount, WatchOptions, WatchRegistry, WatchRuntime } from './base.ts'
import { QueueClosed } from './errors.ts'
import type { QueueFactory } from './queue/base.ts'
import { RAMWatchQueue } from './queue/ram.ts'
import type { Subscriber } from './source.ts'

function defaultQueueFactory(roots: readonly PathSpec[]): RAMWatchQueue {
  return new RAMWatchQueue(roots)
}

export class Watcher implements WatchRuntime {
  private readonly registry: WatchRegistry
  private readonly queueFactory: QueueFactory
  private readonly subscribers: Subscriber[] = []
  private closed = false

  constructor(registry: WatchRegistry, queueFactory: QueueFactory = defaultQueueFactory) {
    this.registry = registry
    this.queueFactory = queueFactory
  }

  private mountFor(path: string): WatchMount {
    const mount = this.registry.mountFor(path)
    if (mount === null) throw new Error(`no mount matches path: ${path}`)
    return mount
  }

  private frame(mount: WatchMount, virtual: string): PathSpec {
    const normalized = `/${stripSlash(virtual)}`
    const resourcePath = normalized.startsWith(mount.prefix)
      ? normalized.slice(mount.prefix.length)
      : ''
    return PathSpec.fromStrPath(normalized, resourcePath)
  }

  private inScope(root: string, virtual: string): boolean {
    if (hasGlob(root)) {
      const pattern = rstripSlash(root)
      if (!globPrefixMatch(virtual, pattern)) return false
      const pathDepth = stripSlash(virtual).split('/').length
      const patternDepth = stripSlash(pattern).split('/').length
      return root.endsWith('/') ? pathDepth > patternDepth : pathDepth === patternDepth
    }
    const literal = rstripSlash(root)
    return virtual === literal || virtual.startsWith(`${literal}/`)
  }

  private matches(subscriber: Subscriber, change: FileEvent): boolean {
    return subscriber.roots.some((root) => this.inScope(root, change.path.virtual))
  }

  private ancestors(mount: WatchMount, virtual: string): PathSpec[] {
    const prefix = rstripSlash(mount.prefix)
    const ancestors: PathSpec[] = []
    let current = rstripSlash(virtual)
    for (;;) {
      current = current.slice(0, current.lastIndexOf('/'))
      if (current.length <= prefix.length) return ancestors
      ancestors.push(this.frame(mount, current))
    }
  }

  private async evict(mount: WatchMount, path: PathSpec, unlink: boolean): Promise<void> {
    const manager = mount.cacheManager
    if (manager === null) return
    if (unlink) await manager.invalidateAfterUnlink(path)
    else await manager.invalidateAfterWrite(path)
    for (const ancestor of this.ancestors(mount, path.virtual)) {
      await manager.invalidateAfterWrite(ancestor)
    }
  }

  private async invalidate(mount: WatchMount, change: FileEvent): Promise<void> {
    await this.evict(mount, change.path, change.kind === FileChangeKind.DELETE)
    if (change.kind === FileChangeKind.MOVE && change.previousPath !== null) {
      const previousMount = this.mountFor(change.previousPath.virtual)
      await this.evict(previousMount, this.frame(previousMount, change.previousPath.virtual), true)
    }
  }

  async notify(change: FileEvent): Promise<void> {
    if (this.closed) return
    const mount = this.mountFor(change.path.virtual)
    const framed = new FileEvent({
      kind: change.kind,
      path: this.frame(mount, change.path.virtual),
      timestamp: change.timestamp,
      previousPath: change.previousPath,
      metadata: change.metadata,
    })
    await this.invalidate(mount, framed)
    for (const subscriber of this.subscribers) {
      if (this.matches(subscriber, framed)) await subscriber.queue.push(framed)
    }
  }

  async *watch(
    path: PathSpec | readonly PathSpec[],
    options: WatchOptions = {},
  ): AsyncGenerator<FileEvent> {
    if (this.closed) throw new Error('watcher is closed')
    const paths = path instanceof PathSpec ? [path] : [...path]
    if (paths.length === 0) throw new Error('watch requires at least one path')
    const roots = paths.map((item) => this.frame(this.mountFor(item.virtual), item.virtual))
    const scopes = paths.map((item) => {
      const stripped = stripSlash(item.virtual)
      const trailing = item.virtual.endsWith('/') && stripped !== '' ? '/' : ''
      return `/${stripped}${trailing}`
    })
    const subscriber: Subscriber = {
      queue: options.queue ?? this.queueFactory(roots),
      roots: scopes,
    }
    this.subscribers.push(subscriber)
    try {
      for (;;) {
        try {
          yield await subscriber.queue.pop()
        } catch (error) {
          if (error instanceof QueueClosed) return
          throw error
        }
      }
    } finally {
      const index = this.subscribers.indexOf(subscriber)
      if (index >= 0) this.subscribers.splice(index, 1)
      await subscriber.queue.close()
    }
  }

  async close(): Promise<void> {
    this.closed = true
    for (const subscriber of [...this.subscribers]) await subscriber.queue.close()
  }
}
