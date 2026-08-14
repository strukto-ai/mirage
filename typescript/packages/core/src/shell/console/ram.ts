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

import { Channel, type ConsoleChunk, type ReadResult } from './types.ts'
import type { ConsoleStore } from './store.ts'

interface Waiter {
  seq: number
  resolve: () => void
}

/**
 * In-memory console storage, the default in every topology.
 *
 * Simpler than its Python counterpart for one reason: JavaScript runs
 * this on a single event loop, so a waiter is just a pending promise
 * resolver. Python has to park futures per loop and wake them through
 * call_soon_threadsafe, because its callers arrive on pool threads with
 * their own loops.
 */
export class RAMConsoleStore implements ConsoleStore {
  private chunks: ConsoleChunk[]
  private baseSeq: number
  private nextSeq: number
  private bytes: number
  private readonly maxBytes: number | null
  private waiters: Waiter[] = []
  private isClosed = false

  get closed(): boolean {
    return this.isClosed
  }

  /**
   * @param maxBytes retention budget. When set, the oldest chunks are
   *   dropped once the total exceeds it, and a reader whose cursor was
   *   dropped is told rather than shorted.
   * @param chunks pre-existing chunks, used to rebuild a finished job's
   *   console from a snapshot.
   */
  constructor(maxBytes: number | null = null, chunks: ConsoleChunk[] | null = null) {
    this.chunks = chunks === null ? [] : [...chunks]
    const first = this.chunks[0]
    const last = this.chunks[this.chunks.length - 1]
    this.baseSeq = first === undefined ? 0 : first.seq
    this.nextSeq = last === undefined ? 0 : last.seq + 1
    this.bytes = this.chunks.reduce((sum, c) => sum + c.data.byteLength, 0)
    this.maxBytes = maxBytes
  }

  append(channel: Channel, data: Uint8Array): Promise<ConsoleChunk> {
    const chunk: ConsoleChunk = {
      seq: this.nextSeq,
      ts: Date.now() / 1000,
      channel,
      data,
    }
    this.chunks.push(chunk)
    this.nextSeq += 1
    this.bytes += data.byteLength
    this.trim()
    this.wake()
    return Promise.resolve(chunk)
  }

  readFrom(seq: number, limit?: number): Promise<ReadResult> {
    const truncated = seq < this.baseSeq
    const start = truncated ? 0 : Math.min(seq - this.baseSeq, this.chunks.length)
    const window =
      limit === undefined ? this.chunks.slice(start) : this.chunks.slice(start, start + limit)
    return Promise.resolve([window, this.baseSeq + start + window.length, truncated])
  }

  wait(seq: number): Promise<void> {
    // A closed store is checked here too, so a reader that re-arms after
    // close() released it resolves instead of parking forever.
    if (this.isClosed || this.nextSeq > seq) return Promise.resolve()
    return new Promise<void>((resolve) => {
      this.waiters.push({ seq, resolve })
    })
  }

  close(): Promise<void> {
    this.isClosed = true
    const waiters = this.waiters
    this.waiters = []
    for (const w of waiters) w.resolve()
    return Promise.resolve()
  }

  private trim(): void {
    if (this.maxBytes === null) return
    while (this.bytes > this.maxBytes) {
      const head = this.chunks[0]
      // The terminal chunk is what releases waitFinished() and ends
      // follow(); dropping it would leave both blocked forever, so it
      // outranks the byte budget.
      if (head === undefined || head.channel === Channel.CONTROL) break
      this.chunks.shift()
      this.bytes -= head.data.byteLength
      this.baseSeq += 1
    }
  }

  private wake(): void {
    const matured = this.waiters.filter((w) => w.seq < this.nextSeq)
    if (matured.length === 0) return
    this.waiters = this.waiters.filter((w) => w.seq >= this.nextSeq)
    for (const w of matured) w.resolve()
  }
}
