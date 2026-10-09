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

import { READ_CHUNK } from './constants.ts'

/**
 * A read-only handle that fetches its file a chunk at a time.
 *
 * The read-side twin of `FileHandle`, for a read-only open of a file larger
 * than one chunk; a smaller file is read whole, since whole is what the file
 * cache keeps. Nothing moves at open: a read fetches the chunk it lands in
 * through the file adapter's ranged read, and that chunk is kept so a sequential
 * read of small pieces costs one request per chunk. The file ends where a
 * fetch comes back short, not at the size the open saw: a rendering need
 * not be as long as the stored bytes a stat measured, so that size answers
 * only until the end has been seen. Mirrors Python's `ChunkedHandle`.
 *
 * A guest that reads synchronously (quickjs) asks `lacks` or `lacksLine`
 * first and awaits `fill` until it answers false; `read` and `readLine` then answer from the
 * kept bytes without a fetch.
 */
export class ChunkedHandle {
  readonly path: string
  size: number
  pos = 0
  private readonly fetch: (offset: number, size: number) => Promise<Uint8Array>
  private start = 0
  private kept: Uint8Array = new Uint8Array()
  private end: number | null = null
  private generation = 0

  constructor(
    path: string,
    size: number,
    fetch: (offset: number, size: number) => Promise<Uint8Array>,
  ) {
    this.path = path
    this.size = size
    this.fetch = fetch
  }

  /** Read at an explicit offset without moving the position. */
  async pread(offset: number, size: number): Promise<Uint8Array> {
    if (size <= 0 || this.atEnd(offset)) return new Uint8Array()
    if (this.covers(offset, size)) return this.slice(offset, size)
    return (await this.load(offset, size)).slice(0, size)
  }

  /** Whether reading `size` bytes at the position (a negative size: the rest) needs a fetch first. */
  lacks(size: number): boolean {
    if (size === 0 || this.atEnd(this.pos)) return false
    if (!this.covers(this.pos, Math.max(size, 1))) return true
    return size < 0 && !this.keptToEnd()
  }

  /** Whether the line at the position needs a fetch first. */
  lacksLine(): boolean {
    if (this.lacks(1)) return true
    return !this.atEnd(this.pos) && this.newlineAt() < 0 && !this.keptToEnd()
  }

  /** Fetch what a read of `size` bytes at the position lacks; any other size, one more chunk. */
  async fill(size: number): Promise<void> {
    await this.load(this.pos, Math.max(size, 0))
  }

  /** Read from the position, advancing it; the kept bytes must answer it (`lacks`). */
  read(size: number | null): Uint8Array {
    const budget = size === null || size < 0 ? this.start + this.kept.length - this.pos : size
    const chunk = this.slice(this.pos, budget)
    this.pos += chunk.length
    return chunk
  }

  /** The line at the position without its newline, or null at the end. */
  readLine(): Uint8Array | null {
    if (this.atEnd(this.pos) || !this.covers(this.pos, 1)) return null
    const newline = this.newlineAt()
    const stop = newline < 0 ? this.start + this.kept.length : newline
    const line = this.slice(this.pos, stop - this.pos)
    this.pos = newline < 0 ? stop : stop + 1
    return line
  }

  /** The kept bytes from `offset`, at most `size` of them; empty when none are kept there. */
  peek(offset: number, size: number): Uint8Array {
    const keptEnd = this.start + this.kept.length
    if (size <= 0 || offset < this.start || offset >= keptEnd) return new Uint8Array()
    return this.slice(offset, Math.min(size, keptEnd - offset))
  }

  /** True once the position sits at or past where the file is known to end. */
  get eof(): boolean {
    return this.atEnd(this.pos)
  }

  /** Forget the kept bytes: the next read fetches the file anew. */
  drop(): void {
    this.generation += 1
    this.kept = new Uint8Array()
    this.end = null
  }

  private atEnd(offset: number): boolean {
    return this.end !== null && offset >= this.end
  }

  private keptToEnd(): boolean {
    return this.end !== null && this.start + this.kept.length >= this.end
  }

  private covers(offset: number, size: number): boolean {
    const keptEnd = this.start + this.kept.length
    return (
      this.start <= offset && offset < keptEnd && (offset + size <= keptEnd || keptEnd === this.end)
    )
  }

  private newlineAt(): number {
    const index = this.kept.indexOf(0x0a, this.pos - this.start)
    return index < 0 ? -1 : this.start + index
  }

  private slice(offset: number, size: number): Uint8Array {
    const low = offset - this.start
    return this.kept.slice(low, low + Math.max(0, size))
  }

  /**
   * Fetch so a read at `offset` of `size` is answerable, and answer the
   * bytes from `offset` on. A fetch that continues the kept bytes is joined
   * onto what they hold from `offset` on, so a line can run across two
   * chunks. Reads may overlap (FUSE issues them concurrently), so the state
   * is read before the fetch and each read answers from its own bytes; a
   * `drop` while the fetch was out keeps them from being installed.
   */
  private async load(offset: number, size: number): Promise<Uint8Array> {
    const { start, kept, generation } = this
    const keptEnd = start + kept.length
    const from = kept.length > 0 && start <= offset && offset <= keptEnd ? keptEnd : offset
    const asked = Math.max(offset + size - from, READ_CHUNK)
    const bytes = await this.fetch(from, asked)
    let joined = bytes
    if (from !== offset) {
      const held = kept.subarray(offset - start)
      joined = new Uint8Array(held.length + bytes.length)
      joined.set(held)
      joined.set(bytes, held.length)
    }
    if (generation === this.generation) {
      if (bytes.length < asked) {
        this.end = from + bytes.length
        this.size = this.end
      }
      this.start = offset
      this.kept = joined
    }
    return joined
  }
}
