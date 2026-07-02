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

import { CachableAsyncIterator } from './cachable_iterator.ts'
import { type ByteSource, type IOResult, materialize } from './types.ts'

export async function* mergeStdoutStderr(
  stdout: ByteSource | null,
  io: IOResult,
): AsyncIterable<Uint8Array> {
  const stderrBytes = await materialize(io.stderr)
  if (stderrBytes.byteLength > 0) yield stderrBytes
  io.stderr = null
  if (stdout === null) return
  if (stdout instanceof Uint8Array) {
    if (stdout.byteLength > 0) yield stdout
    return
  }
  for await (const chunk of stdout) yield chunk
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

export async function* asyncChain(...streams: (ByteSource | null)[]): AsyncIterable<Uint8Array> {
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

// eslint-disable-next-line require-yield -- mirrors Python's unreachable `yield b""` for generator contract
export async function* quietMatch(
  stream: AsyncIterable<Uint8Array>,
  io: IOResult,
): AsyncIterable<Uint8Array> {
  for await (const _chunk of stream) {
    void _chunk
    io.exitCode = 0
    return
  }
  io.exitCode = 1
}
