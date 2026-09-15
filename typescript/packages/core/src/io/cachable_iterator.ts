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

import { YieldBudget } from './yield_budget.ts'

export class CachableAsyncIterator implements AsyncIterableIterator<Uint8Array> {
  private source: AsyncIterator<Uint8Array>
  private readonly buffer: Uint8Array[] = []
  private exhaustedFlag = false
  private discardedFlag = false
  // Set while a pull on the source is outstanding. A pull the consumer
  // abandoned (raced against a signal) stays outstanding, and a return
  // queued behind it would never settle.
  private pulling = false
  private readonly budget = new YieldBudget()

  constructor(source: AsyncIterable<Uint8Array>) {
    this.source = source[Symbol.asyncIterator]()
  }

  // Re-wrap the underlying source in place, keeping whatever is already
  // buffered. The mount seam uses this to restore its recording context
  // around each pull without replacing the object commands hold on to.
  // Mirrors python's CachableAsyncIterator.replace_source.
  wrapSource(fn: (src: AsyncIterable<Uint8Array>) => AsyncIterable<Uint8Array>): void {
    const inner = this.source
    this.source = fn({ [Symbol.asyncIterator]: () => inner })[Symbol.asyncIterator]()
  }

  get discarded(): boolean {
    return this.discardedFlag
  }

  get exhausted(): boolean {
    return this.exhaustedFlag
  }

  get bufferedChunks(): readonly Uint8Array[] {
    return this.buffer
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<Uint8Array> {
    return this
  }

  async next(): Promise<IteratorResult<Uint8Array>> {
    if (this.exhaustedFlag) return { done: true, value: undefined }
    try {
      const pending = this.budget.run()
      if (pending !== undefined) await pending
      const result = await this.pull()
      if (result.done === true) {
        this.exhaustedFlag = true
        return { done: true, value: undefined }
      }
      this.buffer.push(result.value)
      return { done: false, value: result.value }
    } catch (err) {
      await this.discard()
      throw err
    }
  }

  async drain(): Promise<Uint8Array> {
    if (this.exhaustedFlag) return concat(this.buffer)
    try {
      for (;;) {
        const pending = this.budget.run()
        if (pending !== undefined) await pending
        const result = await this.pull()
        if (result.done === true) break
        this.buffer.push(result.value)
      }
    } catch (error) {
      await this.discard()
      throw error
    } finally {
      this.exhaustedFlag = true
    }
    return concat(this.buffer)
  }

  async drainBounded(maxBytes: number): Promise<Uint8Array | null> {
    if (this.discardedFlag) return null
    let total = 0
    for (const c of this.buffer) total += c.byteLength
    try {
      if (total > maxBytes) {
        await this.discard()
        return null
      }
      for (;;) {
        const pending = this.budget.run()
        if (pending !== undefined) await pending
        const result = await this.pull()
        if (result.done === true) break
        this.buffer.push(result.value)
        total += result.value.byteLength
        if (total > maxBytes) {
          await this.discard()
          return null
        }
      }
    } catch (error) {
      await this.discard()
      throw error
    } finally {
      this.exhaustedFlag = true
    }
    return concat(this.buffer)
  }

  private async pull(): Promise<IteratorResult<Uint8Array>> {
    this.pulling = true
    try {
      return await this.source.next()
    } finally {
      // Reached only when the pull settled; an abandoned pull leaves the
      // flag set, which is what discard reads.
      this.pulling = false
    }
  }

  // Explicit failure cleanup; no return(), so normal early consumers can still drain.
  async discard(): Promise<void> {
    if (this.discardedFlag) return
    this.discardedFlag = true
    this.exhaustedFlag = true
    this.buffer.length = 0
    const closing = this.source.return?.(undefined)
    if (closing === undefined) return
    // A return queued behind a pull that never settles would hang the
    // cleanup that called this, and with it the abort or timeout it is
    // cleaning up after. Behind an outstanding pull it is not awaited;
    // the producer closes when the pull settles, if it ever does.
    if (this.pulling) {
      void closing.catch(() => undefined)
      return
    }
    try {
      await closing
    } catch {
      // Failed content is already discarded; preserve the consumer's error.
    }
  }
}

export function concat(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0
  for (const c of chunks) total += c.byteLength
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}
