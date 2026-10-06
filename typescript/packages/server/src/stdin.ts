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
 * How many received chunks an upload may run ahead of the line reading
 * it before the server stops reading the request body.
 */
export const MAX_CHUNKS = 16

/**
 * An HTTP upload's stdin part, a few chunks ahead of the line.
 *
 * The request reader feeds each chunk as it arrives and waits while
 * `MAX_CHUNKS` are unread, so a slow line slows the upload instead of
 * filling memory. Once the line is done the rest is discarded, so the
 * upload can finish and the caller can read the answer.
 */
export class UploadStdin implements AsyncIterable<Uint8Array> {
  private readonly queue: Uint8Array[] = []
  private ended = false
  private discarding = false
  private wakeReader: (() => void) | null = null
  private wakeFeeder: (() => void) | null = null

  /**
   * Queue a copy of a chunk of the upload, as a plain `Uint8Array`
   * (pyodide refuses a Node Buffer as stdin); empty chunks are skipped.
   */
  async feed(data: Uint8Array): Promise<void> {
    if (data.byteLength === 0) return
    while (this.queue.length >= MAX_CHUNKS && !this.discarding) {
      await new Promise<void>((resolve) => {
        this.wakeFeeder = resolve
      })
    }
    if (this.discarding) return
    this.queue.push(new Uint8Array(data))
    this.wake()
  }

  /** Mark the end of the upload. */
  close(): void {
    this.ended = true
    this.wake()
  }

  /**
   * Drop what is queued and everything still to come. A reader waiting
   * for the next chunk gets the end instead.
   */
  discard(): void {
    this.discarding = true
    this.queue.length = 0
    this.wake()
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
    for (;;) {
      if (this.discarding) return
      const data = this.queue.shift()
      if (data !== undefined) {
        this.wake()
        yield data
        continue
      }
      if (this.ended) return
      await new Promise<void>((resolve) => {
        this.wakeReader = resolve
      })
    }
  }

  private wake(): void {
    const reader = this.wakeReader
    const feeder = this.wakeFeeder
    this.wakeReader = null
    this.wakeFeeder = null
    reader?.()
    feeder?.()
  }
}
