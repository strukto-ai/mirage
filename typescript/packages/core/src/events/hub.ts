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
import { mountKey, underPath } from '../utils/key_prefix.ts'
import { rstripSlash, stripSlash } from '../utils/slash.ts'
import type { EventMount, EventRegistry, EventRuntime } from './base.ts'
import { QueueClosed } from './errors.ts'
import type { QueueFactory } from './queue/base.ts'
import { RAMEventQueue } from './queue/ram.ts'
import type { Subscriber } from './source.ts'

function defaultQueueFactory(roots: readonly PathSpec[]): RAMEventQueue {
  return new RAMEventQueue(roots)
}

export class EventHub implements EventRuntime {
  private readonly registry: EventRegistry
  private readonly queueFactory: QueueFactory
  private readonly subscribers: Subscriber[] = []
  private closed = false

  constructor(registry: EventRegistry, queueFactory: QueueFactory = defaultQueueFactory) {
    this.registry = registry
    this.queueFactory = queueFactory
  }

  private frame(mount: EventMount, virtual: string): PathSpec {
    const normalized = `/${stripSlash(virtual)}`
    return PathSpec.fromStrPath(normalized, mountKey(normalized, rstripSlash(mount.prefix)))
  }

  private inScope(root: string, virtual: string): boolean {
    if (hasGlob(root)) {
      const pattern = rstripSlash(root)
      if (!globPrefixMatch(virtual, pattern)) return false
      const pathDepth = stripSlash(virtual).split('/').length
      const patternDepth = stripSlash(pattern).split('/').length
      return root.endsWith('/') ? pathDepth > patternDepth : pathDepth === patternDepth
    }
    return underPath(virtual, root)
  }

  private matches(subscriber: Subscriber, change: FileEvent): boolean {
    return subscriber.roots.some((root) => this.inScope(root, change.path.virtual))
  }

  /**
   * Invalidate a changed path before its event is delivered.
   *
   * An external change is often the only signal mirage gets, so its mount's
   * cache takes it as a write is taken (`CacheManager.invalidate`): the kind
   * decides how far down it reaches, UNKNOWN taking the subtree a push that
   * names only a scope reports (IMAP IDLE says a mailbox changed, not which
   * message), and every ancestor's entry goes too, since a nested create or
   * delete implies levels appeared or vanished with it.
   */
  private async evict(mount: EventMount, path: PathSpec, kind: FileChangeKind): Promise<void> {
    await mount.cacheManager?.invalidate(path, kind)
  }

  private async invalidate(mount: EventMount, change: FileEvent): Promise<void> {
    await this.evict(mount, change.path, change.kind)
    if (change.kind === FileChangeKind.MOVE && change.previousPath !== null) {
      const previousMount = this.registry.mountFor(change.previousPath.virtual)
      await this.evict(
        previousMount,
        this.frame(previousMount, change.previousPath.virtual),
        FileChangeKind.DELETE,
      )
    }
  }

  async notify(change: FileEvent): Promise<void> {
    if (this.closed) return
    const mount = this.registry.mountFor(change.path.virtual)
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

  async *events(path: PathSpec | readonly PathSpec[]): AsyncGenerator<FileEvent> {
    if (this.closed) throw new Error('event hub is closed')
    const paths = path instanceof PathSpec ? [path] : [...path]
    if (paths.length === 0) throw new Error('events requires at least one path')
    const roots = paths.map((item) =>
      this.frame(this.registry.mountFor(item.virtual), item.virtual),
    )
    const scopes = paths.map((item) => {
      const stripped = stripSlash(item.virtual)
      const trailing = item.virtual.endsWith('/') && stripped !== '' ? '/' : ''
      return `/${stripped}${trailing}`
    })
    const subscriber: Subscriber = { queue: this.queueFactory(roots), roots: scopes }
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
