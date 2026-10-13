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
import type { PipeStream } from '../../io/types.ts'
import { ebadf } from '../../errors/fs.ts'
import type { PathSpec } from '../../types.ts'
import { concat } from '../../utils/bytes.ts'

/**
 * One directional virtual descriptor, with bounded producer backpressure.
 *
 * The read end belongs to the scope that opened the descriptor, which
 * closes it with `pipe.closeReader()` when its command ends, unless a
 * descriptor the shell still holds reads the rest first, and closes the
 * streams readers opened on it that are still open (`readers`, held
 * weakly); no reader closes it, so a function can read one substitution
 * twice. Readers take turns, one chunk each, so concurrent readers split the
 * stream between them and a ranged read leaves the rest of its chunk to the
 * next reader. Mirrors Python's DevicePipe.
 */
export class DevicePipe {
  readonly pipe = new BytePipe()
  readonly readers = new Set<WeakRef<PipeStream>>()
  private source: AsyncIterator<Uint8Array> | undefined
  private pending: Uint8Array = new Uint8Array()
  private turn: Promise<unknown> = Promise.resolve()

  constructor(readonly readable: boolean) {}

  async write(data: Uint8Array, path: PathSpec): Promise<void> {
    if (this.readable) throw ebadf(path)
    await this.pipe.write(data)
  }

  async read(path: PathSpec, size: number | null = null): Promise<Uint8Array> {
    if (!this.readable) throw ebadf(path)
    const chunks: Uint8Array[] = []
    let remaining = size
    while (remaining === null || remaining > 0) {
      const chunk = await this.take(remaining)
      if (chunk.byteLength === 0) break
      chunks.push(chunk)
      if (remaining !== null) remaining -= chunk.byteLength
    }
    return concat(chunks)
  }

  async *stream(path: PathSpec): AsyncGenerator<Uint8Array> {
    if (!this.readable) throw ebadf(path)
    for (;;) {
      const chunk = await this.take(null)
      if (chunk.byteLength === 0) return
      yield chunk
    }
  }

  /** One reader's turn: the next bytes of the stream, at most `size`, empty at its end. */
  private take(size: number | null): Promise<Uint8Array> {
    const taken = this.turn.then(() => this.next(size))
    this.turn = taken.then(
      () => undefined,
      () => undefined,
    )
    return taken
  }

  private async next(size: number | null): Promise<Uint8Array> {
    if (this.pending.byteLength === 0) {
      this.source ??= this.pipe.stream()[Symbol.asyncIterator]()
      const step = await this.source.next()
      if (step.done === true) return new Uint8Array()
      this.pending = step.value
    }
    const count = size === null ? this.pending.byteLength : Math.min(size, this.pending.byteLength)
    const taken = this.pending.subarray(0, count)
    this.pending = this.pending.subarray(count)
    return taken
  }
}
