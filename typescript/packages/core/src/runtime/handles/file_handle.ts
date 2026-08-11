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

import { NO_WRITE, planFlush, type FlushKind } from './flush.ts'

/**
 * One buffered whole-file handle.
 *
 * The shape every encoder used to hand-roll: open snapshots the file
 * into a growable buffer, byte-level calls touch only that buffer, and
 * close asks `flushPlan` whether the mount is owed a tail or the whole
 * file. `lowWrite` and `dirty` exist purely to answer that closing
 * question. Mirrors Python's `FileHandle`.
 */
export class FileHandle {
  readonly path: string
  buf: Uint8Array
  pos = 0
  readonly writable: boolean
  readonly baseLen: number
  lowWrite = NO_WRITE
  dirty = false

  constructor(path: string, buf: Uint8Array, writable = false) {
    this.path = path
    this.buf = buf
    this.writable = writable
    this.baseLen = buf.length
  }

  /**
   * A handle over `data`, positioned by the open mode.
   *
   * Args:
   *   path: guest-absolute virtual path.
   *   data: the file's content at open (empty when the open created
   *     or truncated it).
   *   mode: whether writes are accepted, and whether the position
   *     starts at the end.
   */
  static opened(
    path: string,
    data: Uint8Array,
    mode: { writable: boolean; append: boolean },
  ): FileHandle {
    const handle = new FileHandle(path, data, mode.writable)
    if (mode.append) handle.pos = data.length
    return handle
  }

  /**
   * Read from the position, advancing it by what was read.
   *
   * Args:
   *   size: byte budget; null or negative reads to the end. A
   *     position past the end reads empty and stays.
   */
  read(size: number | null): Uint8Array {
    const end =
      size === null || size < 0 ? this.buf.length : Math.min(this.buf.length, this.pos + size)
    const chunk = this.buf.slice(this.pos, end)
    this.pos += chunk.length
    return chunk
  }

  /** Read at an explicit offset without moving the position. */
  pread(offset: number, size: number): Uint8Array {
    return this.buf.slice(offset, offset + size)
  }

  /**
   * Splice bytes in at an offset without moving the position.
   *
   * Grows the buffer through a zero fill when the offset lies past the
   * end, and keeps the two facts the closing flush plan reads: the
   * lowest offset written and that anything was written at all.
   */
  pwrite(offset: number, data: Uint8Array): void {
    const end = offset + data.length
    if (end > this.buf.length) {
      const grown = new Uint8Array(end)
      grown.set(this.buf)
      this.buf = grown
    }
    this.lowWrite = Math.min(this.lowWrite, offset)
    this.buf.set(data, offset)
    this.dirty = true
  }

  /** Write at the position, advancing it past the payload. */
  write(data: Uint8Array): void {
    this.pwrite(this.pos, data)
    this.pos += data.length
  }

  /**
   * Move the position, POSIX whence numbering (0 start, 1 position,
   * 2 end). Answers the new position, or null when the whence is
   * unknown or the target would be negative (the position is then
   * untouched).
   */
  seek(offset: number, whence: number): number | null {
    const base = whence === 0 ? 0 : whence === 1 ? this.pos : whence === 2 ? this.buf.length : null
    if (base === null || base + offset < 0) return null
    this.pos = base + offset
    return this.pos
  }

  /**
   * Resize the buffer, zero-filling growth. Either direction rewrites
   * what the file already held (a shrink drops bytes, a zero fill
   * fabricates them), which no tail can express, so the close ships
   * the whole buffer.
   */
  truncate(size: number): void {
    if (size < this.buf.length) {
      this.buf = this.buf.slice(0, size)
    } else {
      const grown = new Uint8Array(size)
      grown.set(this.buf)
      this.buf = grown
    }
    this.dirty = true
    this.lowWrite = 0
  }

  /** True when the position sits at or past the end. */
  get eof(): boolean {
    return this.pos >= this.buf.length
  }

  /** What this handle owes the mount at close. */
  flushPlan(): [FlushKind, Uint8Array] {
    return planFlush(this.baseLen, this.lowWrite, this.buf)
  }
}

/**
 * Apply buffered (offset, payload) writes over a base file.
 *
 * The batch form of the pwrite splice, for the kernel adapters: FUSE
 * buffers each write as an (offset, payload) pair on its handle and
 * owes the mount one merged body at flush, which is exactly a sequence
 * of pwrites over what the file held.
 *
 * Args:
 *   base: the file's content before this handle's writes.
 *   writes: the buffered writes, in arrival order.
 */
export function mergeWrites(base: Uint8Array, writes: [number, Uint8Array][]): Uint8Array {
  const handle = new FileHandle('', base.slice(), true)
  for (const [offset, chunk] of writes) {
    handle.pwrite(offset, chunk)
  }
  return handle.buf
}
