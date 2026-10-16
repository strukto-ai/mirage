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
import { concat } from '../utils/bytes.ts'
import { SharedInput } from './async_line_iterator.ts'
import type { ByteSource, IOResult } from './types.ts'

/**
 * One lazy byte cursor shared by commands inheriting an input descriptor.
 * Serializing reads prevents concurrent consumers from replaying bytes or
 * pulling the source simultaneously. A consumer stopping early leaves the
 * cursor open; byte-sized pulls preserve the unread suffix for its successor.
 */
export class SharedStdin implements AsyncIterable<Uint8Array> {
  private chunks: AsyncIterator<Uint8Array> | null
  private buffer: Uint8Array = new Uint8Array()
  private pos = 0
  private readonly lock = new KeyLock()

  constructor(source: ByteSource) {
    this.chunks = ensureStream(source)[Symbol.asyncIterator]()
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array, undefined> {
    return {
      next: () =>
        this.lock.withLock('read', async () => {
          while (this.pos >= this.buffer.byteLength) {
            if (this.chunks === null) return { done: true, value: undefined }
            const step = await this.chunks.next()
            if (step.done === true) {
              this.chunks = null
              return { done: true, value: undefined }
            }
            this.buffer = step.value
            this.pos = 0
          }
          const chunk = this.buffer.subarray(this.pos, this.pos + 1)
          this.pos += 1
          return { done: false, value: chunk }
        }),
    }
  }
}

export async function drain(stream: ByteSource | null): Promise<void> {
  if (stream === null || stream instanceof Uint8Array) return
  for await (const _chunk of stream) {
    void _chunk
  }
}

export async function closeQuietly<T>(stream: Uint8Array | AsyncIterable<T> | null): Promise<void> {
  if (stream === null || stream instanceof Uint8Array) return
  const closer = (stream as { return?: () => Promise<unknown> }).return
  if (typeof closer !== 'function') return
  try {
    await closer.call(stream)
  } catch (err) {
    console.debug('stream closer failed:', err)
  }
}

/** Own producer cleanup even when its byte iterator was never started. */
export class OutputStream implements AsyncIterableIterator<Uint8Array> {
  private closing: Promise<IteratorResult<Uint8Array>> | null = null
  constructor(
    private readonly source: AsyncIterator<Uint8Array>,
    private readonly close: () => Promise<void>,
  ) {}

  [Symbol.asyncIterator](): AsyncIterableIterator<Uint8Array> {
    return this
  }
  async next(): Promise<IteratorResult<Uint8Array>> {
    if (this.closing !== null) return { done: true, value: undefined }
    try {
      const next = await this.source.next()
      if (next.done === true) await this.return()
      return next
    } catch (error) {
      await this.return()
      throw error
    }
  }
  return(): Promise<IteratorResult<Uint8Array>> {
    this.closing ??= this.finish()
    return this.closing
  }
  private async finish(): Promise<IteratorResult<Uint8Array>> {
    await this.close()
    return (await this.source.return?.()) ?? { done: true, value: undefined }
  }
}

/** Discard failed reads without changing normal early-consumer close semantics. */
export async function discardStreams(...streams: (ByteSource | null)[]): Promise<void> {
  for (const stream of new Set(streams)) {
    if (stream instanceof SharedInput) {
      await stream.discard()
    } else {
      await closeQuietly(stream)
    }
  }
}

export async function discardIo(io: IOResult): Promise<void> {
  await discardStreams(io.stdout, io.stderr)
}

export function asyncChain(streams: Iterable<ByteSource | null>): AsyncIterable<Uint8Array> {
  const sources = [...streams]
  async function* output(): AsyncGenerator<Uint8Array> {
    for (const source of sources) {
      if (source !== null) yield* ensureStream(source)
    }
  }
  return new OutputStream(output(), async () => {
    for (const source of sources) await closeQuietly(source)
  })
}

export async function* yieldBytes(data: Uint8Array): AsyncIterable<Uint8Array> {
  await Promise.resolve()
  yield data
}

/**
 * Present a byte source as a stream. An iterable is returned as itself, so
 * closing the consumer closes its source; bytes become a one-chunk stream.
 */
export function ensureStream(src: ByteSource): AsyncIterable<Uint8Array> {
  return src instanceof Uint8Array ? yieldBytes(src) : src
}

/** Open a reader before creating its destination; retain ownership before the first pull. */
export async function primeStream(
  source: AsyncIterable<Uint8Array>,
  failed?: (error: unknown) => void,
): Promise<ByteSource> {
  const cursor = source[Symbol.asyncIterator]()
  let first: IteratorResult<Uint8Array>
  try {
    first = await cursor.next()
  } catch (error) {
    await cursor.return?.()
    throw error
  }
  async function* rest(): AsyncGenerator<Uint8Array> {
    try {
      if (first.done !== true) yield first.value
      for (;;) {
        const step = await cursor.next()
        if (step.done === true) return
        yield step.value
      }
    } catch (error) {
      failed?.(error)
      throw error
    } finally {
      await cursor.return?.()
    }
  }
  return new OutputStream(rest(), async () => {
    await cursor.return?.()
  })
}

/** Take a byte window without materializing its prefix or suffix. */
export function sliceStream(
  source: ByteSource,
  offset = 0,
  size: number | null = null,
): OutputStream {
  if (offset < 0 || (size !== null && size < 0))
    throw new RangeError('stream window must be nonnegative')
  async function* window(): AsyncGenerator<Uint8Array> {
    let skipped = offset
    let remaining = size
    if (remaining === 0) return
    for await (let part of ensureStream(source)) {
      const cut = Math.min(skipped, part.length)
      skipped -= cut
      part = part.subarray(cut)
      if (remaining !== null) {
        part = part.subarray(0, remaining)
        remaining -= part.length
      }
      if (part.length > 0) yield part
      if (remaining === 0) return
    }
  }
  return new OutputStream(window(), () => closeQuietly(source))
}

/**
 * Re-cut a stream into parts of up to `size` bytes, joining short ones, so a
 * consumer pays once per block rather than once per record. Mirrors Python's
 * rechunk.
 */
export function rechunk(source: ByteSource, size: number): OutputStream {
  async function* parts(): AsyncGenerator<Uint8Array> {
    let pending: Uint8Array[] = []
    let held = 0
    for await (let part of ensureStream(source)) {
      if (held > 0) {
        const fill = part.subarray(0, size - held)
        pending.push(fill)
        held += fill.byteLength
        part = part.subarray(fill.byteLength)
        if (held < size) continue
        yield concat(pending)
        pending = []
        held = 0
      }
      for (; part.byteLength >= size; part = part.subarray(size)) yield part.subarray(0, size)
      if (part.byteLength > 0) {
        pending = [part]
        held = part.byteLength
      }
    }
    if (held > 0) yield concat(pending)
  }
  return new OutputStream(parts(), () => closeQuietly(source))
}
