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

/** How often a run's memory is read while it is in flight. */
export const WATCH_INTERVAL_MS = 50

/**
 * Watch a worker's memory while one run is in flight, and call `exceeded`
 * once it passes `limit`.
 *
 * Pyodide sets no cap of its own: its heap grows until wasm's 4 GiB
 * ceiling, and a guest stuck in a loop never yields to a check of its
 * own. The worker answers a memory read even while its guest is busy, so
 * the watch runs outside it and the caller stops the worker, which is the
 * only way to stop such a guest. The heap never shrinks, so a run that
 * leaves it near the cap leaves the next run less room, as the same
 * process would.
 *
 * Args:
 *   memory: reads the worker's memory in bytes.
 *   limit: the cap, in bytes.
 *   exceeded: called once, with the bytes read, when the cap is passed.
 *
 * Returns:
 *   A function that stops the watch.
 */
export function watchMemory(
  memory: () => Promise<number>,
  limit: number,
  exceeded: (used: number) => void,
): () => void {
  // An object, not a let: the watch is stopped from outside while a read
  // is in flight, which a narrowed local would not see.
  const watch = { stopped: false }
  const check = async (): Promise<void> => {
    let used: number
    try {
      used = await memory()
    } catch (err) {
      // The worker is gone or going; whatever stopped it reports why.
      console.debug(`pyodide memory read failed: ${String(err)}`)
      return
    }
    if (watch.stopped || used <= limit) return
    watch.stopped = true
    clearInterval(timer)
    exceeded(used)
  }
  const timer = setInterval(() => {
    void check()
  }, WATCH_INTERVAL_MS)
  return () => {
    watch.stopped = true
    clearInterval(timer)
  }
}
