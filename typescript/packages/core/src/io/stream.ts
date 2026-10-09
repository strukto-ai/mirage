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
import { SharedInput } from './async_line_iterator.ts'
import { CachableAsyncIterator } from './cachable_iterator.ts'
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

export function wrapCachableStreams(
  stdout: ByteSource | null,
  io: IOResult,
): [ByteSource | null, IOResult] {
  for (const path of io.cache) {
    const source = io.reads[path] ?? io.writes[path]
    if (
      source !== undefined &&
      !(source instanceof Uint8Array) &&
      !(source instanceof CachableAsyncIterator)
    ) {
      const ci = new CachableAsyncIterator(source)
      if (path in io.reads) {
        io.reads[path] = ci
      } else if (path in io.writes) {
        io.writes[path] = ci
      }
      if (stdout === source) stdout = ci
    }
  }
  return [stdout, io]
}

export async function* exitOnEmpty(
  stream: AsyncIterable<Uint8Array>,
  io: IOResult,
): AsyncIterable<Uint8Array> {
  let yielded = false
  for await (const chunk of stream) {
    yielded = true
    yield chunk
  }
  if (!yielded) io.exitCode = 1
}

export async function drain(stream: ByteSource | null): Promise<void> {
  if (stream === null || stream instanceof Uint8Array) return
  if (stream instanceof CachableAsyncIterator) {
    await stream.drain()
    return
  }
  for await (const _chunk of stream) {
    void _chunk
  }
}

export async function closeQuietly(stream: ByteSource | null): Promise<void> {
  if (stream === null || stream instanceof Uint8Array) return
  const closer = (stream as { return?: () => Promise<unknown> }).return
  if (typeof closer !== 'function') return
  try {
    await closer.call(stream)
  } catch {
    // best-effort
  }
}

/** Own producer cleanup even when its byte iterator was never started. */
export class OutputStream implements AsyncIterableIterator<Uint8Array> {
  constructor(
    private readonly source: AsyncIterator<Uint8Array>,
    private readonly close: () => Promise<void>,
  ) {}

  [Symbol.asyncIterator](): AsyncIterableIterator<Uint8Array> {
    return this
  }
  next(): Promise<IteratorResult<Uint8Array>> {
    return this.source.next()
  }
  async return(): Promise<IteratorResult<Uint8Array>> {
    await this.close()
    return (await this.source.return?.()) ?? { done: true, value: undefined }
  }
}

/** Discard failed reads without changing normal early-consumer close semantics. */
export async function discardStreams(...streams: (ByteSource | null)[]): Promise<void> {
  for (const stream of new Set(streams)) {
    if (stream instanceof CachableAsyncIterator || stream instanceof SharedInput) {
      await stream.discard()
    } else {
      await closeQuietly(stream)
    }
  }
}

export async function discardIo(io: IOResult): Promise<void> {
  await discardStreams(
    ...Object.values(io.reads),
    ...Object.values(io.writes),
    io.stdout,
    io.stderr,
  )
}

export async function* asyncChain(streams: Iterable<ByteSource | null>): AsyncIterable<Uint8Array> {
  for (const stream of streams) {
    if (stream === null) continue
    if (stream instanceof Uint8Array) {
      if (stream.byteLength > 0) yield stream
      continue
    }
    for await (const chunk of stream) yield chunk
  }
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
