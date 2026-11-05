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

import { RAM_LOG_BYTES } from './constants.ts'

/**
 * Storage seam for the hidden recorder.
 *
 * A store holds the recorder's JSONL files keyed by path
 * (`/<day>/<session>.jsonl`). Implementations are infra adapters
 * (RAM, disk, opfs); everything above this seam (the Observer queries,
 * the /.bash_history view, the history builtin) is storage-agnostic.
 */
export interface ObserverStore {
  /** Append bytes to the file at path, creating it if missing. */
  append(path: string, data: Uint8Array): Promise<void>
  /** Overwrite the file at path (snapshot restore). */
  write(path: string, data: Uint8Array): Promise<void>
  /** Read every stored file, keyed by file path. */
  readAll(): Promise<Map<string, Uint8Array>>
  /** Read only the files whose key ends with `suffix`. */
  readMatching(suffix: string): Promise<Map<string, Uint8Array>>
  /** Delete every stored file (snapshot-restore rewind). */
  clear(): Promise<void>
  /** Release any held connections or handles. */
  close(): Promise<void>
}

/**
 * Shared ObserverStore behavior.
 *
 * Implementations only provide `append`/`write`/`readMatching`/`clear`;
 * `readAll` is reading with the empty suffix (every key matches), and
 * `close` defaults to a no-op for stores that hold no connections.
 * Mirrors Python `ObserverStoreBase`.
 */
export abstract class ObserverStoreBase implements ObserverStore {
  abstract append(path: string, data: Uint8Array): Promise<void>
  abstract write(path: string, data: Uint8Array): Promise<void>
  abstract readMatching(suffix: string): Promise<Map<string, Uint8Array>>
  abstract clear(): Promise<void>

  readAll(): Promise<Map<string, Uint8Array>> {
    return this.readMatching('')
  }

  close(): Promise<void> {
    return Promise.resolve()
  }
}

/** In-memory ObserverStore backed by a Map (the default). */
export class RAMObserverStore extends ObserverStoreBase {
  readonly files = new Map<string, Uint8Array>()
  // Each file's buffer with room to grow: `files` holds the written prefix
  // of it, so an append copies only its own bytes, as Python's bytearray
  // does. Copying the whole log on every append made a long session's
  // ops quadratic.
  private readonly room = new Map<string, Uint8Array>()
  private size = 0

  /**
   * @param maxBytes - the most it holds: past it the oldest lines go first,
   *   from the file made first (one session's day), down to three quarters
   *   of it. Mirrors Python's `RAMObserverStore`.
   */
  constructor(readonly maxBytes: number = RAM_LOG_BYTES) {
    super()
  }

  append(path: string, data: Uint8Array): Promise<void> {
    const existing = this.files.get(path) ?? new Uint8Array(0)
    const size = existing.byteLength + data.byteLength
    let room = this.room.get(path)
    // A file set through `write` or `files` is not the prefix of its room.
    const prefix = room?.buffer === existing.buffer && existing.byteOffset === 0
    if (room === undefined || !prefix || room.byteLength < size) {
      const grown = new Uint8Array(Math.max(size, 2 * existing.byteLength))
      grown.set(existing)
      room = grown
      this.room.set(path, room)
    }
    room.set(data, existing.byteLength)
    this.files.set(path, room.subarray(0, size))
    this.size += data.byteLength
    this.trim()
    return Promise.resolve()
  }

  write(path: string, data: Uint8Array): Promise<void> {
    this.size += data.byteLength - (this.files.get(path)?.byteLength ?? 0)
    this.files.set(path, data)
    this.room.delete(path)
    this.trim()
    return Promise.resolve()
  }

  private trim(): void {
    if (this.size <= this.maxBytes) return
    let excess = this.size - Math.floor((this.maxBytes * 3) / 4)
    for (const [path, data] of this.files) {
      if (excess <= 0) break
      let cut = data.byteLength
      if (cut > excess) cut = data.indexOf(0x0a, excess - 1) + 1 || cut
      this.room.delete(path)
      if (cut === data.byteLength) this.files.delete(path)
      else this.files.set(path, data.slice(cut))
      this.size -= cut
      excess -= cut
    }
  }

  readMatching(suffix: string): Promise<Map<string, Uint8Array>> {
    const out = new Map<string, Uint8Array>()
    for (const [k, v] of this.files) {
      if (k.endsWith(suffix)) out.set(k, v)
    }
    return Promise.resolve(out)
  }

  clear(): Promise<void> {
    this.files.clear()
    this.room.clear()
    this.size = 0
    return Promise.resolve()
  }
}
