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

import type { KeyHold } from '../../cache/lock.ts'
import { ensureStream } from '../../io/stream.ts'
import type { ByteSource, OpReport } from '../../io/types.ts'
import { VFSName } from '../../types.ts'
import { concat } from '../../utils/bytes.ts'

/**
 * Stamp the caller's report: memory answered, no backend ran.
 *
 * Fires at the moment a warm file-cache hit or a synthetic namespace
 * answer is in hand, before the post gate and any output cap, so
 * whatever those throw cannot erase the fact. The value is
 * `VFSName.RAM`, which is how a record says "this never crossed
 * the network": `OpRecord.isCache` is defined as that string, and
 * every network/cache total derives from it.
 */
export function memoryAnswered(report: OpReport | undefined, moved: number | null = null): void {
  report?.served(VFSName.RAM, moved)
}

/**
 * Stamp the caller's report: the owning mount answered. A report memory
 * already stamped (a namespace answer for a missing path) keeps that.
 * Mirrors Python's `_served`.
 */
export function served(
  report: OpReport | undefined,
  result: unknown,
  moved: number | null = null,
): void {
  if (report?.completed === true) return
  report?.served(null, moved ?? (result instanceof Uint8Array ? result.byteLength : null))
}

/**
 * Pull a stream's first chunk now and answer the stream from there, so a read
 * that fails at its start fails at the call, where the dispatcher handles it, rather
 * than in the hands of whoever pulls it later. A live pipe's first byte may wait
 * on the very reader about to ask for it, so its read is framed unpulled
 * (`pull` false). Mirrors Python's `_primed`.
 */
export async function primed(
  stream: AsyncIterable<Uint8Array>,
  report: OpReport | undefined,
  pull = true,
): Promise<AsyncIterable<Uint8Array>> {
  const iterator = stream[Symbol.asyncIterator]()
  let head: Uint8Array[] = []
  if (pull) {
    let first: IteratorResult<Uint8Array>
    try {
      first = await iterator.next()
    } catch (err) {
      await iterator.return?.()
      throw err
    }
    if (first.done !== true) head = [first.value]
  }
  const rest = resumed(head, iterator, report)
  await rest.next()
  return rest
}

/**
 * The chunks already pulled, then the rest of the stream. `primed` runs it to
 * its empty first step, inside the `try`, so a caller that closes it before
 * pulling still closes the stream. The stream completes when its last chunk is
 * pulled or it is closed, so that is when the caller's report is stamped, with
 * the bytes the store moved.
 */
async function* resumed(
  head: readonly Uint8Array[],
  iterator: AsyncIterator<Uint8Array>,
  report: OpReport | undefined,
): AsyncGenerator<Uint8Array> {
  let moved = head.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  try {
    yield new Uint8Array()
    yield* head
    for (;;) {
      const next = await iterator.next()
      if (next.done === true) return
      moved += next.value.byteLength
      yield next.value
    }
  } finally {
    await iterator.return?.()
    report?.served(null, moved)
  }
}

/**
 * A streamed write's bytes, pulled with its names let go. The producer may
 * wait on another writer of the same name (`tee -a f | tee -a f`, a loop
 * appending to the file it pipes into), so the write holds the name only
 * while the store takes a chunk, and writers interleave between chunks as
 * two descriptors of one file do: a replacement landing there leaves the
 * stream's later chunks at its own offset, as Linux does. What the store
 * took is kept while it fits the cache's drain budget, so the next read is
 * served what was written, as a whole write's is. Mirrors Python's
 * `_LentPayload`.
 */
export class LentPayload {
  moved = 0
  private kept: Uint8Array[] | null = []

  constructor(
    private readonly source: ByteSource,
    private readonly holds: readonly KeyHold[],
    private readonly budget: number,
  ) {}

  whole(): Uint8Array | null {
    return this.kept === null ? null : concat(this.kept)
  }

  async *chunks(): AsyncGenerator<Uint8Array> {
    const iterator = ensureStream(this.source)[Symbol.asyncIterator]()
    const pull = this.holds.reduce<() => Promise<IteratorResult<Uint8Array>>>(
      (inner, hold) => () => hold.released(inner),
      () => iterator.next(),
    )
    try {
      for (;;) {
        const next = await pull()
        if (next.done === true) return
        this.moved += next.value.byteLength
        if (this.kept !== null && this.moved > this.budget) this.kept = null
        this.kept?.push(next.value.slice())
        yield next.value
      }
    } finally {
      await iterator.return?.()
    }
  }
}
