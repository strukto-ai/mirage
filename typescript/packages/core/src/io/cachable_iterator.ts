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

import { Checkpoint } from './cooperative.ts'

export class CachableAsyncIterator implements AsyncIterableIterator<Uint8Array> {
  private source: AsyncIterator<Uint8Array>
  private readonly buffer: Uint8Array[] = []
  private exhaustedFlag = false
  private readonly checkpoint = new Checkpoint()

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
    try {
      const pending = this.checkpoint.run()
      if (pending !== undefined) await pending
      const result = await this.source.next()
      if (result.done === true) {
        this.exhaustedFlag = true
        return { done: true, value: undefined }
      }
      this.buffer.push(result.value)
      return { done: false, value: result.value }
    } catch (err) {
      this.exhaustedFlag = true
      throw err
    }
  }

  async drain(): Promise<Uint8Array> {
    try {
      for (;;) {
        const pending = this.checkpoint.run()
        if (pending !== undefined) await pending
        const result = await this.source.next()
        if (result.done === true) break
        this.buffer.push(result.value)
      }
    } catch (error) {
      await this.closeAndDiscard()
      throw error
    } finally {
      this.exhaustedFlag = true
    }
    return concat(this.buffer)
  }

  async drainBounded(maxBytes: number): Promise<Uint8Array | null> {
    let total = 0
    for (const c of this.buffer) total += c.byteLength
    try {
      if (total > maxBytes) {
        await this.closeAndDiscard()
        return null
      }
      for (;;) {
        const pending = this.checkpoint.run()
        if (pending !== undefined) await pending
        const result = await this.source.next()
        if (result.done === true) break
        this.buffer.push(result.value)
        total += result.value.byteLength
        if (total > maxBytes) {
          await this.closeAndDiscard()
          return null
        }
      }
    } catch (error) {
      await this.closeAndDiscard()
      throw error
    } finally {
      this.exhaustedFlag = true
    }
    return concat(this.buffer)
  }

  private async closeAndDiscard(): Promise<void> {
    this.buffer.length = 0
    await this.source.return?.(undefined)
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
