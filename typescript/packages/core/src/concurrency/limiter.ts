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
 * Limit concurrent async operations within one process.
 *
 * Twin of python's `concurrency/limiter.py`, which wraps
 * `asyncio.Semaphore`. Node has no built-in semaphore, so the queue is
 * explicit -- but the two contracts match: a permit count below one is
 * rejected rather than clamped, and a release hands its permit straight
 * to the longest-waiting caller instead of returning it to the pool.
 * Handing off matters: returning it first would let a caller arriving in
 * the same tick barge ahead of the queue and drive the count negative.
 */
export class ConcurrencyLimiter {
  private available: number
  private readonly waiters: (() => void)[] = []

  constructor(maxConcurrency: number) {
    if (maxConcurrency < 1) throw new Error('maxConcurrency must be at least 1')
    this.available = maxConcurrency
  }

  /**
   * Take one permit, waiting for a free one, and return its release.
   *
   * The release is idempotent so a caller that unwinds twice (a `finally`
   * plus an explicit call) cannot inflate the permit count -- python gets
   * that from `async with` and the shape here has to supply it.
   */
  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available -= 1
    } else {
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve)
      })
    }
    let released = false
    return () => {
      if (released) return
      released = true
      this.release()
    }
  }

  private release(): void {
    const next = this.waiters.shift()
    if (next !== undefined) {
      next()
      return
    }
    this.available += 1
  }
}

/** Map in order with bounded workers; a failure stops admission and joins active work. */
export async function boundedMap<T, R>(
  items: readonly T[],
  fn: (item: T) => Promise<R>,
  workers: number,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  const remaining = items.entries()
  let failure: { reason: unknown } | undefined
  const worker = async (): Promise<void> => {
    for (const [index, item] of remaining) {
      if (failure !== undefined) return
      try {
        results[index] = await fn(item)
      } catch (reason) {
        failure ??= { reason }
        return
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, workers), items.length) }, worker))
  if (failure !== undefined) throw failure.reason
  return results
}

/**
 * The one error an aborted invocation rejects with. A signal's own reason
 * rides along as `cause` (a caller's `abort(x)`, a timeout's TimeoutError)
 * so every gate keys on one name and the caller still sees why.
 */
export function makeAbortError(signal?: AbortSignal): DOMException {
  const reason: unknown = signal?.aborted === true ? signal.reason : undefined
  // Always a fresh wrapper, even when the reason is itself an AbortError
  // (a plain `abort()`): the contract is one name and the reason under
  // `cause`, and a caller reading `cause` must find it on every path.
  const error = new DOMException('execute aborted', 'AbortError')
  if (reason !== undefined) {
    Object.defineProperty(error, 'cause', { value: reason, configurable: true, writable: true })
  }
  return error
}

/** Settle with `promise`, or reject as an abort as soon as `signal` fires. */
export function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise
  if (signal.aborted) {
    // The promise is still ours to settle; a later rejection with no
    // listener would surface as an unhandled error.
    void promise.catch(() => undefined)
    return Promise.reject(makeAbortError(signal))
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(makeAbortError(signal))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort)
    })
  })
}
