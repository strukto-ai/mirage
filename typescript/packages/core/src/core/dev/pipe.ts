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

import { BytePipe } from '../../io/pipe.ts'
import { ebadf } from '../../errors/fs.ts'
import type { PathSpec } from '../../types.ts'
import { concat } from '../../utils/bytes.ts'

/** One directional virtual descriptor, with bounded producer backpressure. */
export class DevicePipe {
  readonly pipe = new BytePipe()
  private source: AsyncIterator<Uint8Array> | undefined
  private pending: Uint8Array = new Uint8Array()

  constructor(readonly readable: boolean) {}

  async write(data: Uint8Array, path: PathSpec): Promise<void> {
    if (this.readable) throw ebadf(path)
    await this.pipe.write(data)
  }

  async read(path: PathSpec, size: number | null = null): Promise<Uint8Array> {
    if (!this.readable) throw ebadf(path)
    this.source ??= this.pipe.stream()[Symbol.asyncIterator]()
    const chunks: Uint8Array[] = []
    let remaining = size
    while (remaining === null || remaining > 0) {
      if (this.pending.byteLength === 0) {
        const next = await this.source.next()
        if (next.done === true) break
        this.pending = next.value
      }
      const count =
        remaining === null ? this.pending.byteLength : Math.min(remaining, this.pending.byteLength)
      chunks.push(this.pending.subarray(0, count))
      this.pending = this.pending.subarray(count)
      if (remaining !== null) remaining -= count
    }
    return concat(chunks)
  }

  async *stream(path: PathSpec): AsyncGenerator<Uint8Array> {
    if (!this.readable) throw ebadf(path)
    this.source ??= this.pipe.stream()[Symbol.asyncIterator]()
    try {
      if (this.pending.byteLength > 0) {
        const pending = this.pending
        this.pending = new Uint8Array()
        yield pending
      }
      for (;;) {
        const next = await this.source.next()
        if (next.done === true) return
        yield next.value
      }
    } finally {
      this.pipe.release()
    }
  }
}
