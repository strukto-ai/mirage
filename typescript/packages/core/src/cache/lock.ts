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

import { hasAborted, makeAbortError } from '../utils/abort.ts'

interface Waiter {
  enter: () => void
}

/** One caller's hold on a `KeyLock` key. Mirrors Python's KeyHold. */
export interface KeyHold {
  /** Let the key go while `fn` runs, then wait for it again. */
  released<T>(fn: () => Promise<T>): Promise<T>
}

export class KeyLock {
  private readonly queues = new Map<string, Set<Waiter>>()

  async withLock<T>(
    key: string,
    fn: (hold: KeyHold) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (hasAborted(signal)) throw makeAbortError(signal)
    const entered = this.enter(key, signal)
    let queue = entered instanceof Set ? entered : await entered
    try {
      // Admission may have transferred immediately before cancellation.
      if (hasAborted(signal)) throw makeAbortError(signal)
      return await fn({
        released: async <R>(body: () => Promise<R>): Promise<R> => {
          this.leave(key, queue)
          try {
            return await body()
          } finally {
            const back = this.enter(key)
            queue = back instanceof Set ? back : await back
          }
        },
      })
    } finally {
      this.leave(key, queue)
    }
  }

  /** Whether someone holds the key now. */
  held(key: string): boolean {
    return this.queues.has(key)
  }

  discard(key: string): void {
    this.queues.delete(key)
  }

  clear(): void {
    this.queues.clear()
  }

  /** The key's queue: taken at once when the key is free, else once its
   * holder hands it over. */
  private enter(key: string, signal?: AbortSignal): Set<Waiter> | Promise<Set<Waiter>> {
    const queue = this.queues.get(key)
    if (queue === undefined) {
      const held = new Set<Waiter>()
      this.queues.set(key, held)
      return held
    }
    return new Promise<Set<Waiter>>((resolve, reject) => {
      const waiter: Waiter = {
        enter: () => {
          signal?.removeEventListener('abort', onAbort)
          resolve(queue)
        },
      }
      const onAbort = (): void => {
        queue.delete(waiter)
        reject(makeAbortError(signal))
      }
      queue.add(waiter)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  private leave(key: string, queue: Set<Waiter>): void {
    const next = queue.values().next().value
    if (next !== undefined) {
      queue.delete(next)
      next.enter()
    } else if (this.queues.get(key) === queue) {
      this.queues.delete(key)
    }
  }
}
