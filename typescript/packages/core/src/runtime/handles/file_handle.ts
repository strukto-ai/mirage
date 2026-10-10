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

import { concat } from '../../utils/bytes.ts'
import { spliceWindow } from '../../utils/ranges.ts'
import { ChunkedHandle } from './chunked.ts'
import { READ_CHUNK } from './constants.ts'
import { planFlush } from './flush.ts'
import type { FileFetch, FlushStep } from './types.ts'

const LINE_SCAN = 4096

/**
 * One open file: its stored bytes fetched as read, its writes kept.
 *
 * Nothing moves at open. The stored bytes sit behind a `ChunkedHandle`
 * over the file adapter's read, and what the handle wrote is kept as byte ranges
 * laid over them. A close owes the mount only those ranges (`flushPlan`),
 * so another writer's bytes between them survive, which a copy of the
 * whole file taken at open and written back at close would undo. An
 * append-mode handle writes at the end every time. Mirrors Python's
 * `FileHandle`.
 *
 * A guest that reads synchronously (quickjs) asks `lacks` or `lacksLine`
 * first and awaits `fill` until it answers false; `read`, `pread` and
 * `readLine` then answer from what is held without a fetch.
 */
export class FileHandle {
  readonly path: string
  readonly writable: boolean
  readonly append: boolean
  pos = 0
  baseLen: number
  private base: ChunkedHandle | null
  private runs: { start: number; buf: Uint8Array; length: number }[] = []
  private cut: number | null = null
  private extent = 0
  private truncated = false

  private constructor(
    path: string,
    base: ChunkedHandle | null,
    mode: { writable: boolean; append: boolean },
    baseLen: number,
  ) {
    this.path = path
    this.base = base
    this.writable = mode.writable
    this.append = mode.append
    this.baseLen = baseLen
  }

  /**
   * A handle over a file, positioned by the open mode.
   *
   * A file that fits in one chunk is fetched whole on its first read,
   * since whole is what the file cache keeps; a larger one a chunk at a
   * time.
   *
   * Args:
   *   path: guest-absolute virtual path.
   *   fetch: the file adapter's read, or null when the open created or emptied
   *     the file.
   *   opts: the file's length as the open saw it, whether writes are
   *     accepted, and whether every write lands at the end (the position
   *     then starts there).
   */
  static opened(
    path: string,
    fetch: FileFetch | null,
    opts: { size: number; writable: boolean; append: boolean },
  ): FileHandle {
    const size = opts.size
    const base =
      fetch === null
        ? null
        : new ChunkedHandle(path, size, (offset, asked) =>
            offset === 0 && size <= READ_CHUNK ? fetch(0, null) : fetch(offset, asked),
          )
    const handle = new FileHandle(path, base, opts, base === null ? 0 : size)
    if (opts.append) handle.pos = handle.size
    return handle
  }

  /** The file's length as this handle holds it. */
  get size(): number {
    return Math.max(this.storedEnd(), this.runsEnd(), this.extent)
  }

  /** Whether the handle owes the mount anything at close. */
  get dirty(): boolean {
    return this.runs.length > 0 || this.truncated
  }

  /**
   * True once the position sits at or past the end. Over stored bytes
   * whose end no read has reached yet it answers false, as C's `feof`
   * does before a read finds the end.
   */
  get eof(): boolean {
    if (this.pos < this.size) return false
    if (this.base === null || (this.cut !== null && this.pos >= this.cut)) return true
    this.base.pos = this.pos
    return this.base.eof
  }

  /** Whether reading `size` bytes at the position (a negative size: the rest) needs a fetch first. */
  lacks(size: number): boolean {
    const want = this.storedWant(size)
    if (this.base === null || want === 0) return false
    this.base.pos = this.pos
    return this.base.lacks(want)
  }

  /**
   * Whether the line at the position needs a fetch first.
   *
   * Asked of what `readLine` reads, the stored bytes with the written
   * ranges over them: a write can cover a stored newline, so the line
   * may run past the window the stored bytes alone would end it in.
   */
  lacksLine(): boolean {
    let at = this.pos
    for (;;) {
      if (this.lacksAt(at, LINE_SCAN)) return true
      const chunk = this.pread(at, LINE_SCAN)
      if (chunk.length === 0 || chunk.includes(0x0a)) return false
      at += chunk.length
    }
  }

  /** Fetch what a read of `size` bytes at the position lacks; any other size, one more chunk. */
  async fill(size: number): Promise<void> {
    if (this.base === null || (this.cut !== null && this.pos >= this.cut)) return
    this.base.pos = this.pos
    await this.base.fill(this.storedWant(size))
  }

  /**
   * Read at an explicit offset without moving the position; the stored
   * bytes must be held (`lacks`). The stored bytes come first, as far as
   * they reach (a truncate hides what lies past its cut); the handle's
   * own ranges are laid over them, and a gap the handle grew the file
   * across reads as zeros.
   */
  pread(offset: number, size: number): Uint8Array {
    if (size <= 0) return new Uint8Array()
    let stored: Uint8Array = new Uint8Array()
    if (this.base !== null && (this.cut === null || offset < this.cut)) {
      const want = this.cut === null ? size : Math.min(size, this.cut - offset)
      stored = this.base.peek(offset, want)
    }
    const reach = Math.min(offset + size, Math.max(this.runsEnd(), this.extent))
    const out = new Uint8Array(Math.max(stored.length, reach - offset))
    out.set(stored)
    for (const run of this.runs) {
      const low = Math.max(run.start, offset)
      const high = Math.min(run.start + run.length, offset + out.length)
      if (low < high) out.set(run.buf.subarray(low - run.start, high - run.start), low - offset)
    }
    return out
  }

  /** Read from the position, advancing it; null or a negative size reads to the end. */
  read(size: number | null): Uint8Array {
    const budget = size === null || size < 0 ? Math.max(0, this.size - this.pos) : size
    const chunk = this.pread(this.pos, budget)
    this.pos += chunk.length
    return chunk
  }

  /** The line at the position without its newline, or null at the end; `lacksLine` first. */
  readLine(): Uint8Array | null {
    const parts: Uint8Array[] = []
    let at = this.pos
    for (;;) {
      const chunk = this.pread(at, LINE_SCAN)
      if (chunk.length === 0) break
      const newline = chunk.indexOf(0x0a)
      if (newline >= 0) {
        parts.push(chunk.subarray(0, newline))
        this.pos = at + newline + 1
        return concat(parts)
      }
      parts.push(chunk)
      at += chunk.length
    }
    if (at === this.pos) return null
    this.pos = at
    return concat(parts)
  }

  /**
   * Write bytes at an offset without moving the position.
   *
   * The write joins the ranges it overlaps or touches, so a stream of
   * writes stays one range, grown with doubling capacity, and a later
   * write wins where it overlaps.
   */
  pwrite(offset: number, data: Uint8Array): void {
    if (data.length === 0) return
    const end = offset + data.length
    const last = this.runs.at(-1)
    if (last !== undefined && last.start <= offset && offset <= last.start + last.length) {
      const need = end - last.start
      if (need > last.buf.length) {
        const grown = new Uint8Array(Math.max(need, last.buf.length * 2, 4096))
        grown.set(last.buf.subarray(0, last.length))
        last.buf = grown
      }
      last.buf.set(data, offset - last.start)
      last.length = Math.max(last.length, need)
      return
    }
    let start = offset
    let stop = end
    const keep: typeof this.runs = []
    const joined: typeof this.runs = []
    for (const run of this.runs) {
      if (run.start + run.length < offset || run.start > end) keep.push(run)
      else {
        joined.push(run)
        start = Math.min(start, run.start)
        stop = Math.max(stop, run.start + run.length)
      }
    }
    const merged = new Uint8Array(stop - start)
    for (const run of joined) merged.set(run.buf.subarray(0, run.length), run.start - start)
    merged.set(data, offset - start)
    keep.push({ start, buf: merged, length: merged.length })
    keep.sort((a, b) => a.start - b.start)
    this.runs = keep
  }

  /** Write at the position (the end, in append mode), advancing it. */
  write(data: Uint8Array): void {
    if (this.append) this.pos = this.size
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
    const base = whence === 0 ? 0 : whence === 1 ? this.pos : whence === 2 ? this.size : null
    if (base === null || base + offset < 0) return null
    this.pos = base + offset
    return this.pos
  }

  /** Set the file's length: a shrink drops bytes, growth reads zeros. */
  truncate(size: number): void {
    // ftruncate(2) sets the length outright, so a cut to the length this
    // handle holds still drops what another writer appended since the open.
    if (this.base !== null && size <= this.size) {
      this.cut = this.cut === null ? size : Math.min(this.cut, size)
    }
    if (size < this.size) {
      this.runs = this.runs
        .filter((run) => run.start < size)
        .map((run) => ({ ...run, length: Math.min(run.length, size - run.start) }))
    }
    this.extent = size
    this.truncated = true
  }

  /**
   * Take what was just flushed as the stored bytes, owing nothing. After a
   * flush the mount holds what the handle held, so the handle reads it back
   * from there and keeps writing over it; a second flush then owes only
   * what came after the first. Mirrors Python's `FileHandle.settle`.
   */
  settle(fetch: FileFetch): void {
    const size = this.size
    this.base = new ChunkedHandle(this.path, size, (offset, asked) => fetch(offset, asked))
    this.baseLen = size
    this.runs = []
    this.cut = null
    this.extent = 0
    this.truncated = false
  }

  /** The ops this handle owes the mount at close. */
  flushPlan(): FlushStep[] {
    if (!this.dirty) return []
    return planFlush({
      baseLen: this.baseLen,
      runs: this.runs.map((run): [number, Uint8Array] => [run.start, run.buf.slice(0, run.length)]),
      cut: this.cut,
      size: this.size,
      appending: this.append,
    })
  }

  private storedEnd(): number {
    if (this.base === null) return 0
    return this.cut === null ? this.base.size : Math.min(this.base.size, this.cut)
  }

  private runsEnd(): number {
    const last = this.runs.at(-1)
    return last === undefined ? 0 : last.start + last.length
  }

  private lacksAt(offset: number, size: number): boolean {
    if (this.base === null || (this.cut !== null && offset >= this.cut)) return false
    this.base.pos = offset
    return this.base.lacks(this.cut === null ? size : Math.min(size, this.cut - offset))
  }

  private storedWant(size: number): number {
    if (this.cut === null) return size
    if (this.pos >= this.cut) return 0
    return size < 0 ? this.cut - this.pos : Math.min(size, this.cut - this.pos)
  }
}

/**
 * Buffered (offset, payload) writes as the fewest pwrites that leave a file
 * as the writes did, in arrival order.
 *
 * The kernel adapters buffer each write on its handle and owe the mount the
 * lot at flush. A write that starts inside the last run, or right at its
 * end, folds into it, so a sequential stream is one run. Any other starts a
 * run of its own; the runs apply in order, so a later run still overwrites
 * what it overlaps of an earlier one.
 *
 * Args:
 *   writes: the buffered writes, in arrival order.
 */
export function writeRuns(writes: readonly [number, Uint8Array][]): [number, Uint8Array][] {
  const runs: { start: number; parts: Uint8Array[]; length: number }[] = []
  for (const [offset, chunk] of writes) {
    const last = runs.at(-1)
    if (last !== undefined && last.start <= offset && offset <= last.start + last.length) {
      const at = offset - last.start
      if (at === last.length) {
        last.parts.push(chunk.slice())
        last.length += chunk.byteLength
        continue
      }
      const merged = spliceWindow(concat(last.parts), at, chunk)
      last.parts = [merged]
      last.length = merged.byteLength
      continue
    }
    runs.push({ start: offset, parts: [chunk.slice()], length: chunk.byteLength })
  }
  return runs.map((run): [number, Uint8Array] => [run.start, concat(run.parts)])
}

/**
 * A read window with a handle's buffered writes laid over it.
 *
 * The kernel adapters keep a handle's writes until flush; a read through that
 * handle sees them, as a read after write(2) does. They apply in arrival
 * order, so a later write wins where it overlaps, and a gap a write grew the
 * file across reads as zeros. Mirrors Python's `overlaid`.
 *
 * Args:
 *   stored: the stored bytes from `offset`, short where the stored file ends.
 *   offset: where the window starts.
 *   size: the window's length.
 *   writes: the buffered writes, in arrival order.
 */
export function overlaid(
  stored: Uint8Array,
  offset: number,
  size: number,
  writes: readonly [number, Uint8Array][],
): Uint8Array {
  let reach = offset + stored.byteLength
  for (const [start, data] of writes) reach = Math.max(reach, start + data.byteLength)
  const end = Math.min(offset + size, reach)
  if (end <= offset) return new Uint8Array()
  const out = new Uint8Array(end - offset)
  out.set(stored.subarray(0, end - offset))
  for (const [start, data] of writes) {
    const low = Math.max(start, offset)
    const high = Math.min(start + data.byteLength, end)
    if (low < high) out.set(data.subarray(low - start, high - start), low - offset)
  }
  return out
}
