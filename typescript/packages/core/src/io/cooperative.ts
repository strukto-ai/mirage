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
import { abortable } from '../workspace/abort.ts'
import { CachableAsyncIterator } from './cachable_iterator.ts'
import { YieldBudget } from './yield_budget.ts'

export const CHUNK_SIZE = 16 * 1024

/** Split even a single RAM/cache blob; an abort closes the producer and wins over a stalled pull. */
export async function* chunks(
  source: Uint8Array | AsyncIterable<Uint8Array>,
  signal?: AbortSignal,
): AsyncIterableIterator<Uint8Array> {
  const budget = new YieldBudget(signal)
  if (source instanceof Uint8Array) {
    for (let offset = 0; offset < source.byteLength; offset += CHUNK_SIZE) {
      const pending = budget.run()
      if (pending !== undefined) await pending
      yield source.subarray(offset, offset + CHUNK_SIZE)
    }
    return
  }
  // Pulled by hand rather than for-await: a pull that stays pending (a
  // stalled body) has to lose the race to the abort, which for-await
  // cannot express.
  const iterator = source[Symbol.asyncIterator]()
  let finished = false
  let pulling = false
  try {
    for (;;) {
      pulling = true
      const result = await abortable(iterator.next(), signal)
      pulling = false
      if (result.done === true) {
        finished = true
        break
      }
      const data = result.value
      // Once per pull as well as per chunk: a run of empty chunks that
      // resolve at once would otherwise never reach a yield, and a
      // microtask chain with no yield starves the timer an abort rides.
      const pulled = budget.run()
      if (pulled !== undefined) await pulled
      for (let offset = 0; offset < data.byteLength; offset += CHUNK_SIZE) {
        const pending = budget.run()
        if (pending !== undefined) await pending
        yield data.subarray(offset, offset + CHUNK_SIZE)
      }
    }
  } catch (error) {
    // The discard closes the producer as well, and behind a pull that
    // never settles that close would hang the abort; it is not awaited
    // then. `discard` never rejects.
    if (source instanceof CachableAsyncIterator) {
      const discarding = source.discard()
      if (pulling) void discarding
      else await discarding
    }
    throw error
  } finally {
    // What for-await did implicitly: close a producer left mid-stream,
    // whether the consumer stopped early or an abort landed. A return
    // queued behind a pull that never settles would hang, so that one
    // is not awaited.
    if (!finished && !(source instanceof CachableAsyncIterator)) {
      const closing = iterator.return?.()
      if (closing !== undefined) {
        if (pulling) void closing.catch(() => undefined)
        else await closing
      }
    }
  }
}
