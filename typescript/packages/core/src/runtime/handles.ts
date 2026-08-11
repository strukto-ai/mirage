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

export type FlushKind = 'append' | 'write'

// The lowest offset a handle has written at, before it writes anything.
// A sentinel rather than a null because every write takes the minimum of
// it and the new offset, and "nothing yet" has to lose that comparison.
export const NO_WRITE = Number.MAX_SAFE_INTEGER

/**
 * Decide what a closing whole-file buffer owes the mount.
 *
 * Every encoder buffers a whole file and has to answer the same
 * question at close: did this handle only add to the end, or did it
 * rewrite what was already there? Only the first can travel as a
 * delta, and answering "write" always is what makes an append loop
 * quadratic.
 *
 * Args:
 *   baseLen: length the file had when the handle opened.
 *   lowWrite: lowest offset this handle wrote at, or the NO_WRITE
 *     sentinel when it never wrote.
 *   buf: the handle's whole buffer.
 *
 * Returns:
 *   ['append', tail] when the handle only extended the file, else
 *   ['write', whole buffer].
 */
export function planFlush(
  baseLen: number,
  lowWrite: number,
  buf: Uint8Array,
): [FlushKind, Uint8Array] {
  if (baseLen > 0 && lowWrite >= baseLen && buf.length >= baseLen) {
    return ['append', buf.slice(baseLen)]
  }
  return ['write', buf.slice()]
}

/**
 * What an fopen-style mode string says about a handle.
 *
 * One vocabulary for every dialect that opens by mode: quickjs's
 * `std.open` passes these strings verbatim, and Python's preview1
 * oflags/rights/fdflags translate onto the same five facts.
 */
export interface OpenMode {
  /** The handle may mutate its buffer (w, a, x, +). */
  writable: boolean
  /** Opening discards existing content (w). */
  truncate: boolean
  /** The position starts at the end (a). */
  append: boolean
  /** A missing file is created (w, a, x). */
  create: boolean
  /** An existing file refuses the open (x). */
  exclusive: boolean
}

/**
 * Read an fopen-style mode string into its five facts.
 *
 * Args:
 *   mode: the mode as the guest spelled it (`r`, `w+b`, `a`, ...);
 *     unknown letters are ignored, matching fopen.
 */
export function parseMode(mode: string): OpenMode {
  return {
    writable: /[wax+]/.test(mode),
    truncate: mode.includes('w'),
    append: mode.includes('a'),
    create: /[wax]/.test(mode),
    exclusive: mode.includes('x'),
  }
}

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

/**
 * Open handles by integer id.
 *
 * The table every encoder used to hand-roll beside its handle type:
 * ids are dense from `firstId` upward and never reused within a run.
 * Generic because the entries differ (a FUSE core holds its
 * kernel-dialect handle beside prefetched data), while the bookkeeping
 * never does. Mirrors Python's `FileTable`.
 */
export class FileTable<T> {
  private nextId: number
  private readonly entries = new Map<number, T>()

  constructor(firstId = 1) {
    this.nextId = firstId
  }

  /** Track an entry under a fresh id and return the id. */
  add(entry: T): number {
    const fd = this.nextId++
    this.entries.set(fd, entry)
    return fd
  }

  /** The entry under `fd`, or undefined. */
  get(fd: number): T | undefined {
    return this.entries.get(fd)
  }

  /** Remove and return the entry under `fd`, or undefined. */
  pop(fd: number): T | undefined {
    const entry = this.entries.get(fd)
    this.entries.delete(fd)
    return entry
  }

  /** Place an entry under an explicit id. */
  set(fd: number, entry: T): void {
    this.entries.set(fd, entry)
  }

  /** Every tracked entry. */
  values(): IterableIterator<T> {
    return this.entries.values()
  }

  /** Whether an entry sits under `fd`. */
  has(fd: number): boolean {
    return this.entries.has(fd)
  }
}
