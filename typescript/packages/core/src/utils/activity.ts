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

import { KeyLock } from '../cache/lock.ts'
import type { ByteSource } from '../io/types.ts'

/** Work in flight on one resource, awaited before it is released. */
export class Activity {
  private count = 0
  private waiters: (() => void)[] = []

  acquire(): () => void {
    this.count++
    let released = false
    return () => {
      if (released) return
      released = true
      this.count--
      if (this.count === 0) {
        for (const resolve of this.waiters.splice(0)) resolve()
      }
    }
  }

  wait(): Promise<void> {
    if (this.count === 0) return Promise.resolve()
    return new Promise((resolve) => {
      this.waiters.push(resolve)
    })
  }

  /** Count `source` in flight until it ends or is closed. */
  hold(source: ByteSource): ByteSource {
    if (source instanceof Uint8Array) return source
    return new ActivityStream(source, this.acquire())
  }
}

/** Explicit return releases even a stream that was never pulled. */
class ActivityStream implements AsyncIterableIterator<Uint8Array> {
  private readonly source: AsyncIterator<Uint8Array>
  private readonly pullLock = new KeyLock()
  private closing: Promise<IteratorResult<Uint8Array>> | undefined
  constructor(
    source: AsyncIterable<Uint8Array>,
    private readonly release: () => void,
  ) {
    this.source = source[Symbol.asyncIterator]()
  }
  [Symbol.asyncIterator](): AsyncIterableIterator<Uint8Array> {
    return this
  }
  private isClosing(): boolean {
    return this.closing !== undefined
  }
  next(): Promise<IteratorResult<Uint8Array>> {
    return this.pullLock.withLock('', async () => {
      if (this.isClosing()) return { done: true, value: undefined }
      try {
        const step = await this.source.next()
        if (step.done === true && this.closing === undefined) this.release()
        return step
      } catch (error) {
        if (this.closing === undefined) this.release()
        throw error
      }
    })
  }
  return(): Promise<IteratorResult<Uint8Array>> {
    this.closing ??= this.finish()
    return this.closing
  }
  private async finish(): Promise<IteratorResult<Uint8Array>> {
    // A pull can wait on a source that only yields when something lands (a
    // follow), so the source is told to close before the pull ends, not
    // after: its own close is what ends that wait.
    const closing = Promise.resolve().then(() => this.source.return?.())
    // Handled here so a failed close is not unhandled while the pull ends;
    // awaiting it below still hands the failure to the caller.
    void closing.catch(() => undefined)
    return this.pullLock.withLock('', async () => {
      try {
        await closing
        return { done: true, value: undefined }
      } finally {
        this.release()
      }
    })
  }
}
