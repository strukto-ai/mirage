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

import {
  FileChangeKind,
  FileEvent,
  OverflowPolicy,
  PathSpec,
  type FileEventInit,
} from '../../types.ts'
import { DEFAULT_MAX_PENDING } from '../constants.ts'
import { QueueClosed, QueueOverflowError } from '../errors.ts'
import type { WatchQueue } from './base.ts'

interface Signal {
  promise: Promise<void>
  wake: () => void
}

export interface RAMWatchQueueOptions {
  maxPending?: number
  onOverflow?: OverflowPolicy
}

function signal(): Signal {
  let wake = (): void => undefined
  const promise = new Promise<void>((resolve) => {
    wake = resolve
  })
  return { promise, wake }
}

function replacement(init: FileEventInit): FileEvent {
  return new FileEvent(init)
}

export class RAMWatchQueue implements WatchQueue {
  private readonly roots: readonly PathSpec[]
  private readonly label: string
  private readonly maxPending: number
  private readonly onOverflow: OverflowPolicy
  private readonly changes = new Map<string, FileEvent>()
  private overflowed = false
  private closed = false
  private ready = signal()

  constructor(roots: PathSpec | readonly PathSpec[], options: RAMWatchQueueOptions = {}) {
    this.roots = roots instanceof PathSpec ? [roots] : [...roots]
    this.label = this.roots.map((root) => root.virtual).join(', ')
    this.maxPending = options.maxPending ?? DEFAULT_MAX_PENDING
    this.onOverflow = options.onOverflow ?? OverflowPolicy.COLLAPSE
  }

  private merge(old: FileEvent | undefined, change: FileEvent): FileEvent | null {
    if (old === undefined) return change
    if (old.kind === FileChangeKind.UNKNOWN) return old
    if (old.kind === FileChangeKind.CREATE) {
      if (change.kind === FileChangeKind.DELETE) return null
      return replacement({
        kind: FileChangeKind.CREATE,
        path: change.path,
        timestamp: change.timestamp,
        previousPath: change.previousPath,
        metadata: change.metadata,
      })
    }
    if (old.kind === FileChangeKind.MOVE && change.kind !== FileChangeKind.DELETE) {
      return replacement({
        kind: FileChangeKind.MOVE,
        path: change.path,
        timestamp: change.timestamp,
        previousPath: old.previousPath,
        metadata: change.metadata,
      })
    }
    if (old.kind === FileChangeKind.DELETE && change.kind === FileChangeKind.CREATE) {
      return replacement({
        kind: FileChangeKind.UPDATE,
        path: change.path,
        timestamp: change.timestamp,
        previousPath: change.previousPath,
        metadata: change.metadata,
      })
    }
    return change
  }

  private absorbSource(change: FileEvent): FileEvent {
    if (change.kind !== FileChangeKind.MOVE || change.previousPath === null) return change
    const source = this.changes.get(change.previousPath.virtual)
    if (source === undefined || source.kind === FileChangeKind.UNKNOWN) return change
    this.changes.delete(change.previousPath.virtual)
    if (source.kind === FileChangeKind.CREATE) {
      return replacement({
        kind: FileChangeKind.CREATE,
        path: change.path,
        timestamp: change.timestamp,
        metadata: change.metadata,
      })
    }
    if (source.kind === FileChangeKind.MOVE && source.previousPath !== null) {
      return replacement({
        kind: FileChangeKind.MOVE,
        path: change.path,
        timestamp: change.timestamp,
        previousPath: source.previousPath,
        metadata: change.metadata,
      })
    }
    return change
  }

  push(change: FileEvent): Promise<void> {
    if (this.closed) return Promise.resolve()
    const event = this.absorbSource(change)
    const key = event.path.virtual
    const old = this.changes.get(key)
    this.changes.delete(key)
    if (
      old?.kind === FileChangeKind.MOVE &&
      old.previousPath !== null &&
      event.kind === FileChangeKind.DELETE
    ) {
      const source = old.previousPath.virtual
      if (!this.changes.has(source)) {
        this.changes.set(
          source,
          replacement({
            kind: FileChangeKind.DELETE,
            path: old.previousPath,
            timestamp: event.timestamp,
          }),
        )
      }
    } else {
      const merged = this.merge(old, event)
      if (merged !== null) this.changes.set(key, merged)
    }
    if (this.changes.size > this.maxPending) this.applyOverflow()
    if (this.changes.size > 0 || this.overflowed) this.ready.wake()
    return Promise.resolve()
  }

  private applyOverflow(): void {
    if (this.onOverflow === OverflowPolicy.DROP_OLDEST) {
      const oldest = this.changes.keys().next().value
      if (oldest !== undefined) this.changes.delete(oldest)
      return
    }
    this.changes.clear()
    if (this.onOverflow === OverflowPolicy.ERROR) {
      this.overflowed = true
      return
    }
    const timestamp = new Date()
    for (const root of this.roots) {
      this.changes.set(
        root.virtual,
        new FileEvent({ kind: FileChangeKind.UNKNOWN, path: root, timestamp }),
      )
    }
  }

  async pop(): Promise<FileEvent> {
    for (;;) {
      if (this.closed) throw new QueueClosed(this.label)
      if (this.overflowed) {
        this.overflowed = false
        if (this.changes.size === 0) this.ready = signal()
        throw new QueueOverflowError(
          `watch queue for ${this.label} exceeded ${String(this.maxPending)} pending changes`,
        )
      }
      const first = this.changes.entries().next().value
      if (first !== undefined) {
        this.changes.delete(first[0])
        if (this.changes.size === 0) this.ready = signal()
        return first[1]
      }
      this.ready = signal()
      await this.ready.promise
    }
  }

  pending(): Promise<number> {
    return Promise.resolve(this.changes.size)
  }

  clear(): Promise<void> {
    this.changes.clear()
    this.overflowed = false
    return Promise.resolve()
  }

  close(): Promise<void> {
    this.closed = true
    this.changes.clear()
    this.overflowed = false
    this.ready.wake()
    return Promise.resolve()
  }
}
