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

export class KeyLock {
  private readonly queues = new Map<string, Set<Waiter>>()

  async withLock<T>(key: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (hasAborted(signal)) throw makeAbortError(signal)
    let queue = this.queues.get(key)
    if (queue === undefined) {
      queue = new Set<Waiter>()
      this.queues.set(key, queue)
    } else {
      const waiting = queue
      await new Promise<void>((resolve, reject) => {
        const waiter: Waiter = {
          enter: () => {
            signal?.removeEventListener('abort', onAbort)
            resolve()
          },
        }
        const onAbort = (): void => {
          waiting.delete(waiter)
          reject(makeAbortError(signal))
        }
        waiting.add(waiter)
        signal?.addEventListener('abort', onAbort, { once: true })
      })
    }
    try {
      // Admission may have transferred immediately before cancellation.
      if (hasAborted(signal)) throw makeAbortError(signal)
      return await fn()
    } finally {
      const next = queue.values().next().value
      if (next !== undefined) {
        queue.delete(next)
        next.enter()
      } else if (this.queues.get(key) === queue) {
        this.queues.delete(key)
      }
    }
  }

  discard(key: string): void {
    this.queues.delete(key)
  }

  clear(): void {
    this.queues.clear()
  }
}
