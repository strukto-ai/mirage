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
import type { JsonValue } from '../types.ts'
import { decodeBase64 } from '../utils/base64.ts'
import { StreamRefusal } from './errors.ts'

interface Exports {
  readonly memory: WebAssembly.Memory
  mirage_rs_args(len: number): number
  mirage_rs_error(handle: number): number
  mirage_rs_error_len(handle: number): number
  mirage_rs_nfs_open(configLen: number): number
  mirage_rs_nfs_buffer(handle: number, len: number): number
  mirage_rs_nfs_feed(handle: number, conn: number, len: number): number
  mirage_rs_nfs_requests(handle: number): number
  mirage_rs_nfs_complete(handle: number, id: number, replyLen: number, dataLen: number): number
  mirage_rs_nfs_output(handle: number): number
  mirage_rs_nfs_output_len(handle: number): number
  mirage_rs_nfs_error(handle: number): number
  mirage_rs_nfs_error_len(handle: number): number
  mirage_rs_nfs_disconnect(handle: number, conn: number): void
  mirage_rs_nfs_close(handle: number): void
}

/** A file operation a call waits on, for the host to run on its mount core. */
export interface NFSRequest {
  readonly id: number
  readonly op: 'getattr' | 'readdir' | 'read' | 'readlink'
  readonly path: string
  readonly offset?: number
  readonly size?: number
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * The mirage-rs NFSv3 server, which does no I/O of its own: the host feeds
 * it each connection's bytes, runs the file operations `requests` names,
 * and hands each result back through `complete`. It runs on a wasm
 * instance of its own, so a long-lived server never holds the one streams
 * share. Mirrors Python's NFSEngine.
 */
export class NFSEngine {
  private constructor(
    private readonly exports: Exports,
    private readonly handle: number,
  ) {}

  /**
   * Open a server: `exportPath` is the path a client mounts, `generation` is
   * stamped into every file handle (one from another generation is stale),
   * and `port` is the port the host listens on.
   */
  static async open(exportPath: string, generation: number, port: number): Promise<NFSEngine> {
    const module = await WebAssembly.compile(decodeBase64(MIRAGE_RS_WASM) as BufferSource)
    const exports = new WebAssembly.Instance(module, {}).exports as unknown as Exports
    const config = encoder.encode(JSON.stringify({ export: exportPath, generation, port }))
    const ptr = exports.mirage_rs_args(config.length)
    new Uint8Array(exports.memory.buffer, ptr, config.length).set(config)
    const handle = exports.mirage_rs_nfs_open(config.length)
    if (handle === 0) {
      const ptr = exports.mirage_rs_error(0)
      const message = decoder.decode(
        new Uint8Array(exports.memory.buffer, ptr, exports.mirage_rs_error_len(0)),
      )
      throw new StreamRefusal(message, new Uint8Array())
    }
    return new NFSEngine(exports, handle)
  }

  /** Take what connection `conn` sent; returns the replies it answers at once. */
  feed(conn: number, data: Uint8Array): Uint8Array {
    this.put([data])
    if (this.exports.mirage_rs_nfs_feed(this.handle, conn, data.length) !== 0) throw this.refusal()
    return this.output()
  }

  /** The file operations calls wait on, each with its `id`. */
  requests(): NFSRequest[] {
    this.exports.mirage_rs_nfs_requests(this.handle)
    return JSON.parse(decoder.decode(this.output())) as NFSRequest[]
  }

  /**
   * Hand back one request's result: `{error: 'ENOENT'}`, or what it asked for
   * (`attrs`, `entries`, `target`), and the bytes a read returned. Returns the
   * call's connection (null once it has closed) and its reply once it has one.
   */
  complete(
    id: number,
    reply: Record<string, JsonValue>,
    data: Uint8Array = new Uint8Array(),
  ): [number | null, Uint8Array] {
    const json = encoder.encode(JSON.stringify(reply))
    this.put([json, data])
    const conn = this.exports.mirage_rs_nfs_complete(this.handle, id, json.length, data.length)
    if (conn === -2) throw this.refusal()
    return [conn === -1 ? null : conn, this.output()]
  }

  /** Forget connection `conn` and the calls it has out. */
  close(conn: number): void {
    this.exports.mirage_rs_nfs_disconnect(this.handle, conn)
  }

  /** Free the server. */
  dispose(): void {
    this.exports.mirage_rs_nfs_close(this.handle)
  }

  private put(parts: Uint8Array[]): void {
    const len = parts.reduce((sum, part) => sum + part.length, 0)
    const ptr = this.exports.mirage_rs_nfs_buffer(this.handle, len)
    const view = new Uint8Array(this.exports.memory.buffer, ptr, len)
    let at = 0
    for (const part of parts) {
      view.set(part, at)
      at += part.length
    }
  }

  private output(): Uint8Array {
    const ptr = this.exports.mirage_rs_nfs_output(this.handle)
    const len = this.exports.mirage_rs_nfs_output_len(this.handle)
    return new Uint8Array(this.exports.memory.buffer, ptr, len).slice()
  }

  private refusal(): StreamRefusal {
    const ptr = this.exports.mirage_rs_nfs_error(this.handle)
    const len = this.exports.mirage_rs_nfs_error_len(this.handle)
    return new StreamRefusal(
      decoder.decode(new Uint8Array(this.exports.memory.buffer, ptr, len)),
      new Uint8Array(),
    )
  }
}
