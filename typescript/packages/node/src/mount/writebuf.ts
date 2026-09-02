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

/**
 * Pending writes per file id, merged and stored on drain.
 *
 * Two facts force this buffer. The server answers every WRITE as
 * already durable and never forwards a COMMIT, so the adapter gets no
 * signal about when a client is done; and a mirage backend stores
 * whole objects, so writing each arriving chunk straight through
 * would read and rewrite the entire file per chunk. Buffering turns a
 * file copy from quadratic into one store.
 *
 * Writes are kept in arrival order and merged only on drain, which is
 * what makes an out-of-order or overlapping sequence come out right:
 * a later write to the same region wins because it is applied last.
 * That case is not hypothetical -- a kernel client copying a megabyte
 * through a mount was observed issuing writes that do not extend the
 * file, which silently corrupts any implementation assuming
 * append-only order.
 *
 * The cost is a window: a client is told its write is durable while
 * the bytes are still here. The window is bounded by the idle sweep
 * and by teardown, and it is the price of the server's fixed
 * stability answer.
 *
 * Like IdTable, every method is synchronous and await-free, so the
 * event loop cannot interleave two of them and no lock is needed.
 */
export class WriteBuffer {
  private readonly writes = new Map<number, [number, Buffer][]>()
  private readonly sizes = new Map<number, number>()
  private readonly touched = new Map<number, number>()

  /** Apply writes onto base in arrival order, zero-filling any gap. */
  static merge(base: Buffer, writes: [number, Buffer][]): Buffer {
    let end = base.length
    for (const [offset, payload] of writes) end = Math.max(end, offset + payload.length)
    const merged = Buffer.alloc(end)
    base.copy(merged)
    for (const [offset, payload] of writes) payload.copy(merged, offset)
    return merged
  }

  /**
   * Buffer one write.
   *
   * @returns true when the handle has reached maxBytes and the caller
   * should drain it.
   */
  append(fileid: number, offset: number, data: Buffer, maxBytes?: number, now?: number): boolean {
    const pending = this.writes.get(fileid) ?? []
    pending.push([offset, Buffer.from(data)])
    this.writes.set(fileid, pending)
    const buffered = (this.sizes.get(fileid) ?? 0) + data.length
    this.sizes.set(fileid, buffered)
    this.touched.set(fileid, now ?? Date.now() / 1000)
    return maxBytes !== undefined && buffered >= maxBytes
  }

  /** Whether a file id holds unstored writes. */
  hasPending(fileid: number): boolean {
    const pending = this.writes.get(fileid)
    return pending !== undefined && pending.length > 0
  }

  /** Every file id currently holding writes. */
  pendingIds(): number[] {
    return [...this.writes.entries()].filter(([, w]) => w.length > 0).map(([id]) => id)
  }

  /** File ids untouched for longer than olderThan seconds. */
  idleIds(olderThan: number, now?: number): number[] {
    const moment = now ?? Date.now() / 1000
    const out: number[] = []
    for (const [fileid, at] of this.touched) {
      if (this.hasPending(fileid) && moment - at > olderThan) out.push(fileid)
    }
    return out
  }

  /**
   * The size a client should see, counting unstored writes.
   *
   * A write that extends a file has already been acknowledged, so
   * reporting the stored size would show the client a file that did
   * not grow -- which reads as a failed write rather than a pending
   * one.
   */
  pendingSize(fileid: number, baseSize: number): number {
    const pending = this.writes.get(fileid)
    if (pending === undefined || pending.length === 0) return baseSize
    let furthest = 0
    for (const [offset, data] of pending) furthest = Math.max(furthest, offset + data.length)
    return Math.max(baseSize, furthest)
  }

  /**
   * Read through pending writes.
   *
   * Without this, a read inside the flush window answers from stored
   * content and misses writes the client has already been told
   * succeeded.
   */
  overlay(fileid: number, base: Buffer, offset: number, size: number): Buffer {
    const pending = this.writes.get(fileid)
    if (pending === undefined || pending.length === 0) {
      return base.subarray(offset, offset + size)
    }
    return WriteBuffer.merge(base, pending).subarray(offset, offset + size)
  }

  /**
   * Trim pending writes to a new file length.
   *
   * Called before a truncate. Left alone, a buffered write past the
   * new end would be merged back in by the next drain and undo the
   * truncate.
   */
  clip(fileid: number, length: number): void {
    const pending = this.writes.get(fileid)
    if (pending === undefined || pending.length === 0) return
    const clipped: [number, Buffer][] = []
    let total = 0
    for (const [offset, data] of pending) {
      if (offset >= length) continue
      const kept = data.subarray(0, length - offset)
      clipped.push([offset, kept])
      total += kept.length
    }
    if (clipped.length > 0) {
      this.writes.set(fileid, clipped)
      this.sizes.set(fileid, total)
      return
    }
    this.forget(fileid)
  }

  /**
   * Discard pending writes without storing them. What a removed file
   * needs: storing the bytes would bring it back.
   */
  drop(fileid: number): void {
    this.forget(fileid)
  }

  /**
   * Remove and return a file's pending writes.
   *
   * The caller stores them, so the buffer hands them over rather than
   * storing through a callback: the store is async and this class
   * stays synchronous, which is what keeps it await-free.
   */
  take(fileid: number): [number, Buffer][] {
    const pending = this.writes.get(fileid) ?? []
    this.forget(fileid)
    return pending
  }

  /**
   * Put a taken batch back after its store failed.
   *
   * The client was told these writes were durable -- this server
   * answers FILE_SYNC on every WRITE and is never sent a COMMIT -- so
   * a store that threw must not lose them. They go in *front* of
   * anything buffered since: the buffer is arrival-ordered and
   * later-wins, so appending an older batch would let it overwrite the
   * newer bytes it is supposed to sit under.
   */
  /**
   * Bytes buffered across every file.
   *
   * The per-file ceiling bounds one handle; nothing bounded their sum,
   * so N files written at once cost N times it. A caller that wants a
   * global bound needs this number to compare against.
   */
  totalBytes(): number {
    let total = 0
    for (const size of this.sizes.values()) total += size
    return total
  }

  /**
   * Buffered files, largest first. The order a caller draining to a
   * global ceiling wants: flushing the biggest buffer first reaches the
   * ceiling in the fewest stores.
   */
  heaviestIds(): number[] {
    return [...this.sizes.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id)
  }

  requeue(fileid: number, writes: [number, Buffer][]): void {
    if (writes.length === 0) return
    const restored = [...writes, ...(this.writes.get(fileid) ?? [])]
    this.writes.set(fileid, restored)
    this.sizes.set(
      fileid,
      restored.reduce((total, [, data]) => total + data.byteLength, 0),
    )
    // Only when nothing has been written since: a write that landed
    // during the failed store already stamped a newer time, and moving
    // it backwards would delay the retry.
    if (!this.touched.has(fileid)) this.touched.set(fileid, Date.now())
  }

  private forget(fileid: number): void {
    this.writes.delete(fileid)
    this.sizes.delete(fileid)
    this.touched.delete(fileid)
  }
}
