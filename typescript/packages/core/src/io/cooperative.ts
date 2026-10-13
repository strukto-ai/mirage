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
import { concat } from '../utils/bytes.ts'
import { abortable } from '../utils/abort.ts'
import { YieldBudget } from './yield_budget.ts'

export const CHUNK_SIZE = 16 * 1024

/**
 * Split even a single RAM/cache blob; an abort closes the producer and wins
 * over a stalled pull. Unless `split`, each pull passes through whole, as its
 * producer wrote it.
 */
export async function* chunks(
  source: Uint8Array | AsyncIterable<Uint8Array>,
  signal?: AbortSignal,
  split = true,
): AsyncIterableIterator<Uint8Array> {
  const budget = new YieldBudget(signal)
  const piece = split ? CHUNK_SIZE : Number.POSITIVE_INFINITY
  if (source instanceof Uint8Array) {
    for (let offset = 0; offset < source.byteLength; offset += piece) {
      const pending = budget.run()
      if (pending !== undefined) await pending
      yield source.subarray(offset, offset + piece)
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
      for (let offset = 0; offset < data.byteLength; offset += piece) {
        const pending = budget.run()
        if (pending !== undefined) await pending
        yield data.subarray(offset, offset + piece)
      }
    }
  } finally {
    // What for-await did implicitly: close a producer left mid-stream,
    // whether the consumer stopped early or an abort landed. A return
    // queued behind a pull that never settles would hang, so that one
    // is not awaited.
    if (!finished) {
      const closing = iterator.return?.()
      if (closing !== undefined) {
        if (pulling) void closing.catch(() => undefined)
        else await closing
      }
    }
  }
}

/** Read at most count bytes, closing the source when the limit is reached. */
export async function readPrefix(
  source: Uint8Array | AsyncIterable<Uint8Array>,
  count: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (count <= 0) return new Uint8Array()
  const parts: Uint8Array[] = []
  for await (const part of chunks(source, signal)) {
    parts.push(part.subarray(0, count))
    count -= part.length
    if (count <= 0) break
  }
  return concat(parts)
}
