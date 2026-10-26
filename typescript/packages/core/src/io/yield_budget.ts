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
export const YIELD_INTERVAL = 2
export const YIELD_CALLS = 4096

/**
 * A per-consumer time budget between opportunities for timers and
 * cancellation. `check` runs beside the signal, for a deadline it does not
 * carry. A busy consumer yields every `YIELD_INTERVAL` ms, the turn Python's
 * twin takes under the daemon's 1 ms GIL switch interval: the twin yields every
 * two switch intervals, as a loop that yields more often keeps its other
 * threads from the GIL, while this one runs every workspace on one thread. A
 * budget also yields after `YIELD_CALLS` runs, whichever comes first, and
 * starts at its first `run`, as the twin does.
 * The interval is read on `performance.now()`, the clock fake timers replace
 * along with the timer its yield waits on; where that clock stands still while
 * a task computes, the call bound is what lets a busy line be cancelled.
 */
export class YieldBudget {
  private nextYield: number | null = null
  private calls = 0

  constructor(
    private readonly signal?: AbortSignal,
    private readonly check?: () => void,
  ) {}

  run(): Promise<void> | undefined {
    this.signal?.throwIfAborted()
    this.check?.()
    this.calls += 1
    if (this.nextYield === null) {
      this.nextYield = performance.now() + YIELD_INTERVAL
      return
    }
    if (performance.now() < this.nextYield && this.calls < YIELD_CALLS) return
    return this.yield()
  }

  private async yield(): Promise<void> {
    // A turn of the loop, not Promise.resolve()'s microtask continuation, so
    // timers and I/O due by now run first. A nested setTimeout(0) idles 1 ms in
    // Node and 4 ms in a page at every yield; an immediate (Node, Bun) or a
    // message a page posts itself goes on without that wait.
    await new Promise<void>((resolve) => {
      const { setImmediate: immediate } = globalThis as {
        setImmediate?: (callback: () => void) => unknown
      }
      if (immediate !== undefined) {
        immediate(resolve)
        return
      }
      const channel = new MessageChannel()
      channel.port1.onmessage = () => {
        channel.port1.close()
        resolve()
      }
      channel.port2.postMessage(null)
    })
    this.calls = 0
    this.nextYield = performance.now() + YIELD_INTERVAL
    this.signal?.throwIfAborted()
    this.check?.()
  }
}
