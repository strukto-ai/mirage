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

import { abortable, makeAbortError, mergeSignals } from '../utils/abort.ts'

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
   * that from `async with` and the shape here has to supply it. An abort
   * leaves the queue without a permit, as a cancelled `acquire` does in
   * python.
   *
   * Args:
   *   signal: abandons the wait when it fires.
   */
  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted === true) throw makeAbortError(signal)
    if (this.available > 0) {
      this.available -= 1
    } else {
      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => {
          this.waiters.splice(this.waiters.indexOf(admit), 1)
          reject(makeAbortError(signal))
        }
        const admit = (): void => {
          signal?.removeEventListener('abort', onAbort)
          resolve()
        }
        this.waiters.push(admit)
        signal?.addEventListener('abort', onAbort, { once: true })
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

/** Map a stream in input order, owning all admitted work through cancellation. */
export async function* boundedMapStream<T, R>(
  items: (signal: AbortSignal) => AsyncIterable<T>,
  fn: (item: T, signal: AbortSignal) => Promise<R>,
  workers: number,
  parent?: AbortSignal,
): AsyncGenerator<R> {
  const controller = new AbortController()
  const signal = mergeSignals(parent, controller.signal) ?? controller.signal
  const permits = workers > 0 ? new ConcurrencyLimiter(workers) : null
  type Result = { value: R } | { error: unknown }
  const ready: { result: Promise<Result>; release: () => void }[] = []
  let done = false
  let failure: { error: unknown } | undefined
  let wake: (() => void) | undefined
  const isDone = (): boolean => done
  const iterator = items(signal)[Symbol.asyncIterator]()
  const producer = (async (): Promise<void> => {
    try {
      for (;;) {
        const release = permits === null ? (): void => undefined : await permits.acquire(signal)
        const next = await abortable(iterator.next(), signal)
        if (next.done === true) {
          release()
          return
        }
        const result = fn(next.value, signal).then(
          (value): Result => ({ value }),
          (error: unknown): Result => ({ error }),
        )
        ready.push({ result, release })
        wake?.()
      }
    } catch (error) {
      failure = { error }
    } finally {
      done = true
      wake?.()
    }
  })()
  try {
    for (;;) {
      const entry = ready[0]
      if (entry === undefined) {
        if (isDone()) break
        await abortable(
          new Promise<void>((resolve) => {
            wake = resolve
          }),
          signal,
        )
        wake = undefined
        continue
      }
      const result = await abortable(entry.result, signal)
      if ('error' in result) throw result.error
      yield result.value
      ready.shift()
      entry.release()
    }
    if (failure !== undefined) throw failure.error
  } finally {
    controller.abort()
    await producer
    await Promise.all(ready.map((entry) => entry.result))
    await iterator.return?.()
  }
}
