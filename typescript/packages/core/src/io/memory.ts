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

import { createAsyncContext } from '../utils/async_context.ts'
import { MemoryExhausted } from './errors.ts'

/**
 * The max_memory a workspace runs under when it names none: with the 32 MB
 * read cache, 64 MB a workspace, 32 of them on a 2 GiB machine. Mirrors
 * Python's MAX_MEMORY.
 */
export const MAX_MEMORY = 32 * 1024 * 1024

/**
 * A workspace's `max_memory` and the bytes its stores hold.
 *
 * What the workspace stores is counted exactly, by the stores themselves,
 * and `held` sums it when asked, so nothing is charged or released here and
 * the count cannot drift. An object a command builds while it runs must fit
 * in what is left (`room`). Mirrors Python's `MemoryBudget`.
 */
export class MemoryBudget {
  constructor(
    readonly limit: number,
    readonly held: () => number,
  ) {}

  /** The bytes left under the limit, never below 0. */
  room(): number {
    return Math.max(this.limit - this.held(), 0)
  }
}

// The budget of the workspace a line or an op runs in, null for no cap.
const budget = createAsyncContext<MemoryBudget | null>()

/**
 * `fn` run under a workspace's memory budget, which what it stores and every
 * object it builds are checked against. Mirrors Python's `run_with_memory`.
 */
export function runWithMemory<T>(memory: MemoryBudget | null, fn: () => Promise<T>): Promise<T> {
  return Promise.resolve(budget.run(memory, fn))
}

/**
 * The bytes left in the running workspace's budget, null for no cap. A
 * browser cannot tell one task's binding from another's, so there it is the
 * least any live budget has left. Mirrors Python's `memory_room`.
 */
export function memoryRoom(): number | null {
  let room: number | null = null
  for (const live of budget.liveStores()) {
    if (live !== null) room = Math.min(room ?? Infinity, live.room())
  }
  return room
}

/**
 * Refuse an object that grew to `size` bytes past what the running
 * workspace's budget has left. Mirrors Python's `check_memory`.
 */
export function checkMemory(size: number): void {
  const room = memoryRoom()
  if (room !== null && size > room) throw new MemoryExhausted()
}
