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

/**
 * Open handles by integer id.
 *
 * The table every encoder used to hand-roll beside its handle type:
 * ids are dense from `firstId` upward and never reused within a run.
 * Generic because the entries differ (a FUSE core holds its
 * kernel-dialect handle beside prefetched data), while the bookkeeping
 * never does. Mirrors Python's `FileTable`.
 */
export class FileTable<T> {
  private nextId: number
  private readonly entries = new Map<number, T>()

  constructor(firstId = 1) {
    this.nextId = firstId
  }

  /** Track an entry under a fresh id and return the id. */
  add(entry: T): number {
    const fd = this.nextId++
    this.entries.set(fd, entry)
    return fd
  }

  /** The entry under `fd`, or undefined. */
  get(fd: number): T | undefined {
    return this.entries.get(fd)
  }

  /** Remove and return the entry under `fd`, or undefined. */
  pop(fd: number): T | undefined {
    const entry = this.entries.get(fd)
    this.entries.delete(fd)
    return entry
  }

  /** Place an entry under an explicit id. */
  set(fd: number, entry: T): void {
    this.entries.set(fd, entry)
  }

  /** Every tracked entry. */
  values(): IterableIterator<T> {
    return this.entries.values()
  }

  /** Whether an entry sits under `fd`. */
  has(fd: number): boolean {
    return this.entries.has(fd)
  }
}
