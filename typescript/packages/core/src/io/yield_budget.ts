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
export const YIELD_INTERVAL = 10

/**
 * A per-consumer time budget between opportunities for timers and
 * cancellation. `check` runs beside the signal, for a deadline it does not
 * carry. Python's twin keeps a shorter interval: its awaits each wait for a
 * loop turn where these settle as microtasks within one, and its yield costs
 * microseconds where `setTimeout` waits at least a millisecond.
 */
export class YieldBudget {
  private nextYield = performance.now() + YIELD_INTERVAL

  constructor(
    private readonly signal?: AbortSignal,
    private readonly check?: () => void,
  ) {}

  run(): Promise<void> | undefined {
    this.signal?.throwIfAborted()
    this.check?.()
    if (performance.now() < this.nextYield) return
    return this.yield()
  }

  private async yield(): Promise<void> {
    // A task-queue turn, not Promise.resolve()'s microtask continuation.
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    this.nextYield = performance.now() + YIELD_INTERVAL
    this.signal?.throwIfAborted()
    this.check?.()
  }
}
