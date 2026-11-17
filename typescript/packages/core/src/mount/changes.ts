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

import { asyncContextIsolatesTasks, createAsyncContext } from '../utils/async_context.ts'
import { abortable, makeAbortError } from '../utils/abort.ts'
import type { Clock } from '../utils/clock.ts'
import { rstripSlash } from '../utils/slash.ts'

/**
 * The machine whose served mount makes the file ops running now, unbound for
 * any other caller: that machine's kernel already holds what its own requests
 * changed. Mirrors Python's `SERVED_BY`.
 */
export const SERVED_BY = createAsyncContext<string>()

/**
 * Whether a change at `path` reaches what is under `prefix`: it is the prefix,
 * under it, or above it.
 */
function overlaps(path: string, prefix: string): boolean {
  const a = rstripSlash(path)
  const b = rstripSlash(prefix)
  return a === b || b.startsWith(`${a}/`) || a.startsWith(`${b}/`)
}

/**
 * The file changes of the last `window` seconds, each with the machine whose
 * served mount made it, so a machine whose kernel keeps what its mounts
 * answered that long starts a program only once nothing another made there
 * may still be held. Mirrors Python's `RecentChanges`.
 */
export class RecentChanges {
  // Oldest first; those before `head` are past the window, dropped in one
  // slice once they make up half the list, so a write never shifts the rest.
  private changes: [number, string | null, string][] = []
  private head = 0

  /**
   * @param clock the workspace's clock.
   * @param window how long a machine's kernel keeps an answer.
   */
  constructor(
    private readonly clock: Clock,
    private readonly window: number,
  ) {}

  /**
   * Record a change at `path`, made by `SERVED_BY`'s machine. Without task
   * isolation another task's binding can show here, so the change counts as
   * everyone's.
   *
   * @param path the virtual path changed; `/` for every mount.
   */
  note(path: string): void {
    const now = this.clock.monotonic()
    this.forget(now)
    const by = asyncContextIsolatesTasks ? (SERVED_BY.getStore() ?? null) : null
    this.changes.push([now, by, path])
  }

  /** The workspace clock's monotonic reading, which `waitOut` compares the start of a mount's caching with. */
  now(): number {
    return this.clock.monotonic()
  }

  /**
   * Wait until no change another made under a served prefix since its mount
   * began keeping answers is younger than the window, so `machine`'s kernel
   * holds none.
   *
   * @param served each prefix served into the machine, with when its mount
   *   began (`now`).
   * @param machine the machine, whose own changes do not count.
   * @param signal the line's, which ends the wait.
   */
  async waitOut(
    served: ReadonlyMap<string, number>,
    machine: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const now = this.clock.monotonic()
    this.forget(now)
    let last: number | null = null
    for (const [at, by, path] of this.changes.slice(this.head)) {
      if (by === machine) continue
      for (const [prefix, since] of served) {
        if (at >= since && overlaps(path, prefix)) {
          last = last === null ? at : Math.max(last, at)
          break
        }
      }
    }
    if (last === null) return
    if (signal?.aborted === true) throw makeAbortError(signal)
    await abortable(this.clock.sleep(last + this.window - now), signal)
  }

  private forget(now: number): void {
    while ((this.changes[this.head]?.[0] ?? Infinity) <= now - this.window) this.head += 1
    if (this.head * 2 < this.changes.length) return
    this.changes = this.changes.slice(this.head)
    this.head = 0
  }
}
