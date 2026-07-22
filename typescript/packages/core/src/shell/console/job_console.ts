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

import { Channel, type ConsoleChunk, type ReadResult } from './config.ts'
import { RAMConsoleStore } from './ram.ts'
import type { ConsoleStore } from './store.ts'

function join(chunks: ConsoleChunk[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.data.byteLength, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c.data, at)
    at += c.data.byteLength
  }
  return out
}

/**
 * Everything one job has printed, readable from any position.
 *
 * A job writes here as it runs, and any number of readers consume at
 * their own pace. A reader's whole state is one number, so readers cost
 * nothing, may join late, and may disappear without the console
 * noticing.
 */
export class JobConsole {
  private readonly store: ConsoleStore
  private finishedFlag: boolean

  /**
   * @param store where chunks live. Defaults to memory, which is the
   *   right home whenever the job and its readers share a process.
   * @param finished whether the job has already ended, set when
   *   rebuilding a finished console from a snapshot.
   */
  constructor(store: ConsoleStore | null = null, finished = false) {
    this.store = store ?? new RAMConsoleStore()
    this.finishedFlag = finished
  }

  /** Whether this process has seen the job end. */
  get finished(): boolean {
    return this.finishedFlag
  }

  /**
   * Append output produced by the job.
   *
   * Ignored once the job has ended, so a runner still unwinding after a
   * kill cannot append past the ending chunk and strand readers that
   * already stopped following.
   */
  async emit(channel: Channel, data: Uint8Array): Promise<void> {
    if (this.finishedFlag) return
    await this.store.append(channel, data)
  }

  /**
   * Record how the job ended and release every waiting reader.
   *
   * Idempotent, so a job killed while it was already exiting does not
   * get two endings.
   */
  async finish(outcome: string): Promise<void> {
    if (this.finishedFlag) return
    this.finishedFlag = true
    await this.store.append(Channel.CONTROL, new TextEncoder().encode(outcome))
  }

  /** Read chunks at or after a cursor. */
  readFrom(seq: number, limit?: number): Promise<ReadResult> {
    return this.store.readFrom(seq, limit)
  }

  /** Yield chunks as they arrive, ending when the job does. */
  async *follow(seq = 0): AsyncGenerator<ConsoleChunk> {
    let cursor = seq
    for (;;) {
      const [chunks, next] = await this.store.readFrom(cursor)
      cursor = next
      for (const chunk of chunks) {
        yield chunk
        if (chunk.channel === Channel.CONTROL) return
      }
      await this.store.wait(cursor)
    }
  }

  /** Resolve once the job has ended. */
  async waitFinished(): Promise<void> {
    let cursor = 0
    for (;;) {
      const [chunks, next] = await this.store.readFrom(cursor)
      cursor = next
      if (chunks.some((c) => c.channel === Channel.CONTROL)) return
      await this.store.wait(cursor)
    }
  }

  /**
   * Join everything the job has printed so far.
   *
   * With no channel, joins stdout and stderr in the order they were
   * produced and omits the CONTROL chunk, which is status not output.
   */
  async snapshot(channel: Channel | null = null): Promise<Uint8Array> {
    const [chunks] = await this.store.readFrom(0)
    if (channel === null) {
      return join(chunks.filter((c) => c.channel !== Channel.CONTROL))
    }
    return join(chunks.filter((c) => c.channel === channel))
  }

  /** Release the underlying store. */
  close(): Promise<void> {
    return this.store.close()
  }
}
