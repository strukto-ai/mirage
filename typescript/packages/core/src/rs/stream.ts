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

import MIRAGE_RS_WASM from '../generated/mirage_rs.ts'
import { chunks } from '../io/cooperative.ts'
import type { JsonValue } from '../types.ts'
import { concat } from '../utils/bytes.ts'
import { decodeBase64 } from '../utils/base64.ts'
import { StreamRefusal } from './errors.ts'

interface Exports {
  readonly memory: WebAssembly.Memory
  mirage_rs_args(len: number): number
  mirage_rs_open(kindLen: number, configLen: number): number
  mirage_rs_input_capacity(): number
  mirage_rs_input(handle: number): number
  mirage_rs_feed(handle: number, len: number): number
  mirage_rs_finish(handle: number): number
  mirage_rs_wants(handle: number): number
  mirage_rs_busy(handle: number): number
  mirage_rs_drain(handle: number): number
  mirage_rs_feed_input(handle: number, index: number, len: number): number
  mirage_rs_end_input(handle: number, index: number): number
  mirage_rs_begin(handle: number, len: number): number
  mirage_rs_done(handle: number): number
  mirage_rs_status(handle: number): number
  mirage_rs_take_stderr(handle: number): number
  mirage_rs_output(handle: number): number
  mirage_rs_output_len(handle: number): number
  mirage_rs_error(handle: number): number
  mirage_rs_error_len(handle: number): number
  mirage_rs_close(handle: number): void
  mirage_rs_open_count(): number
}

// Linear memory only grows, so an instance a large stream (a big sort) grew
// is dropped once no stream is open and the next stream gets a fresh one.
const RECYCLE_BYTES = 32 * 1024 * 1024

const encoder = new TextEncoder()
const decoder = new TextDecoder()
let compiled: Promise<WebAssembly.Module> | undefined
let compiledSync: WebAssembly.Module | undefined
let current: Promise<Exports> | undefined
let synchronous: Exports | undefined

async function instance(): Promise<Exports> {
  if (synchronous !== undefined) return synchronous
  compiled ??= WebAssembly.compile(decodeBase64(MIRAGE_RS_WASM) as BufferSource)
  current ??= compiled.then((module) => {
    compiledSync = module
    synchronous ??= new WebAssembly.Instance(module, {}).exports as unknown as Exports
    return synchronous
  })
  return current
}

function bytesAt(exports: Exports, ptr: number, len: number): Uint8Array {
  return new Uint8Array(exports.memory.buffer, ptr, len).slice()
}

/** One mirage-rs stream: chunks go in, the bytes they produce come out. Mirrors Python's OpenStream. */
export class OpenStream {
  private readonly exports: Exports
  private handle: number
  private readonly capacity: number

  constructor(exports: Exports, handle: number) {
    this.exports = exports
    this.handle = handle
    this.capacity = exports.mirage_rs_input_capacity()
  }

  /** Push one chunk and return what it produced. */
  feed(chunk: Uint8Array): Uint8Array {
    return this.guard(() =>
      this.push(chunk, (len) => this.exports.mirage_rs_feed(this.handle, len)),
    )
  }

  /** End the input and return what the stream held back. */
  finish(): Uint8Array {
    return this.guard(() => this.collect(this.exports.mirage_rs_finish(this.handle), []))
  }

  /** Whether `drain` has work or output left. */
  busy(): boolean {
    return this.guard(() => this.exports.mirage_rs_busy(this.handle) === 1)
  }

  /** One bounded step of the work `busy` reports, and its output. */
  drain(): Uint8Array {
    return this.guard(() => this.collect(this.exports.mirage_rs_drain(this.handle), []))
  }

  /** The input a multi-input stream needs next, null for none. */
  wants(): number | null {
    const index = this.guard(() => this.exports.mirage_rs_wants(this.handle))
    return index < 0 ? null : index
  }

  /** Push one chunk of input `index` to a multi-input stream. */
  feedInput(index: number, chunk: Uint8Array): Uint8Array {
    return this.guard(() =>
      this.push(chunk, (len) => this.exports.mirage_rs_feed_input(this.handle, index, len)),
    )
  }

  /** End input `index` of a multi-input stream. */
  endInput(index: number): Uint8Array {
    return this.guard(() => this.collect(this.exports.mirage_rs_end_input(this.handle, index), []))
  }

  /** Start the next input of a stream that reads one after another. */
  begin(config: Readonly<Record<string, JsonValue>>): void {
    const bytes = encoder.encode(JSON.stringify(config))
    if (bytes.byteLength > this.capacity)
      throw new StreamRefusal('stream input configuration too large', new Uint8Array())
    this.guard(() => {
      const window = this.exports.mirage_rs_input(this.handle)
      new Uint8Array(this.exports.memory.buffer, window, bytes.byteLength).set(bytes)
      this.collect(this.exports.mirage_rs_begin(this.handle, bytes.byteLength), [])
    })
  }

  /** Whether the stream wants no more of the current input. */
  done(): boolean {
    return this.guard(() => this.exports.mirage_rs_done(this.handle) === 1)
  }

  /** The command's exit status for the input so far. */
  status(): number {
    return this.guard(() => this.exports.mirage_rs_status(this.handle))
  }

  /** What the stream wrote to stderr since the last call. */
  takeStderr(): Uint8Array {
    return this.guard(() => this.collect(this.exports.mirage_rs_take_stderr(this.handle), []))
  }

  close(): void {
    if (this.handle === 0) return
    this.exports.mirage_rs_close(this.handle)
    this.handle = 0
    if (
      this.exports.mirage_rs_open_count() === 0 &&
      this.exports.memory.buffer.byteLength > RECYCLE_BYTES
    ) {
      current = undefined
      if (synchronous === this.exports) synchronous = undefined
    }
  }

  // A trap (a Rust panic) stops the instance mid-call with its state still
  // borrowed, so every later call on it would trap too: this stream is
  // done, and the next stream gets a fresh instance.
  private guard<T>(call: () => T): T {
    try {
      return call()
    } catch (err) {
      if (err instanceof WebAssembly.RuntimeError) {
        this.handle = 0
        current = undefined
        if (synchronous === this.exports) synchronous = undefined
      }
      throw err
    }
  }

  private push(chunk: Uint8Array, feed: (len: number) => number): Uint8Array {
    // An empty chunk still reaches the stream: a sort starts a buffered run.
    if (chunk.byteLength === 0) return this.collect(feed(0), [])
    const parts: Uint8Array[] = []
    for (let offset = 0; offset < chunk.byteLength; offset += this.capacity) {
      const piece = chunk.subarray(offset, offset + this.capacity)
      const window = this.exports.mirage_rs_input(this.handle)
      new Uint8Array(this.exports.memory.buffer, window, piece.byteLength).set(piece)
      parts.push(this.collect(feed(piece.byteLength), parts))
    }
    const [only] = parts
    return parts.length === 1 && only !== undefined ? only : concat(parts)
  }

  private collect(status: number, before: readonly Uint8Array[]): Uint8Array {
    const { exports, handle } = this
    const output = bytesAt(
      exports,
      exports.mirage_rs_output(handle),
      exports.mirage_rs_output_len(handle),
    )
    if (status === 0) return output
    const message = decoder.decode(
      bytesAt(exports, exports.mirage_rs_error(handle), exports.mirage_rs_error_len(handle)),
    )
    throw new StreamRefusal(message, concat([...before, output]))
  }
}

/** Open the mirage-rs stream `kind`. Mirrors Python's open_stream. */
export async function openStream(
  kind: string,
  config: Readonly<Record<string, JsonValue>>,
): Promise<OpenStream> {
  const exports = await instance()
  return open(exports, kind, config)
}

/** Open a stream for synchronous pure utilities, initializing Wasm on first use. */
export function openStreamSync(
  kind: string,
  config: Readonly<Record<string, JsonValue>>,
): OpenStream {
  compiledSync ??= new WebAssembly.Module(decodeBase64(MIRAGE_RS_WASM) as BufferSource)
  compiled ??= Promise.resolve(compiledSync)
  synchronous ??= new WebAssembly.Instance(compiledSync, {}).exports as unknown as Exports
  return open(synchronous, kind, config)
}

function open(
  exports: Exports,
  kind: string,
  config: Readonly<Record<string, JsonValue>>,
): OpenStream {
  const kindBytes = encoder.encode(kind)
  const configBytes = encoder.encode(JSON.stringify(config))
  const args = exports.mirage_rs_args(kindBytes.byteLength + configBytes.byteLength)
  const view = new Uint8Array(
    exports.memory.buffer,
    args,
    kindBytes.byteLength + configBytes.byteLength,
  )
  view.set(kindBytes)
  view.set(configBytes, kindBytes.byteLength)
  const handle = exports.mirage_rs_open(kindBytes.byteLength, configBytes.byteLength)
  if (handle === 0) {
    const message = decoder.decode(
      bytesAt(exports, exports.mirage_rs_error(0), exports.mirage_rs_error_len(0)),
    )
    throw new StreamRefusal(message, new Uint8Array())
  }
  return new OpenStream(exports, handle)
}

/**
 * Stream `source` through `kind`, one bounded chunk at a time. A refusal
 * throws StreamRefusal holding the output written before it, so the caller
 * records the failure before it passes that output on: a reader that stops
 * at the output would otherwise never see it. Mirrors Python's run_stream.
 */
export async function* runStream(
  kind: string,
  config: Readonly<Record<string, JsonValue>>,
  source: Uint8Array | AsyncIterable<Uint8Array>,
  signal?: AbortSignal,
): AsyncIterable<Uint8Array> {
  const stream = await openStream(kind, config)
  try {
    for await (const chunk of chunks(source, signal)) {
      const output = stream.feed(chunk)
      if (output.byteLength > 0) yield output
    }
    const tail = stream.finish()
    if (tail.byteLength > 0) yield tail
  } finally {
    stream.close()
  }
}
