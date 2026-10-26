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
import { Channel, type ConsoleChunk, type OwnedStream, type ReadResult } from './types.ts'
import { END_OF_CONSOLE } from './constants.ts'
import { RAMConsoleStore } from './ram.ts'
import type { ConsoleStore } from './store.ts'
import { decodeText, encodeText } from '../bytes.ts'

function join(chunks: ConsoleChunk[]): Uint8Array {
  return concat(chunks.map((c) => c.data))
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
  private readonly backing: ConsoleStore
  private finishedFlag: boolean
  private execution: string | null = null

  get executionId(): string | null {
    return this.execution
  }

  /** Associate this job's output with its one managed execution. */
  bindExecution(executionId: string): void {
    if (this.execution !== null && this.execution !== executionId)
      throw new Error('console already belongs to another execution')
    this.execution = executionId
  }

  /**
   * @param store where chunks live. Defaults to memory, which is the
   *   right home whenever the job and its readers share a process.
   * @param finished whether the job has already ended, set when
   *   rebuilding a finished console from a snapshot.
   */
  constructor(store: ConsoleStore | null = null, finished = false) {
    this.backing = store ?? new RAMConsoleStore()
    this.finishedFlag = finished
  }

  /**
   * Where this console's chunks live. A job's console is the one its job
   * store names, which every workspace on that store reads and ends.
   */
  get store(): ConsoleStore {
    return this.backing
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
   * already stopped following. Ignored too once the store is closed: the
   * console was discarded, and a Redis store written after close would
   * open a client that nothing quits.
   */
  async emit(channel: Channel, data: Uint8Array): Promise<void> {
    if (this.finishedFlag || this.backing.closed) return
    await this.backing.append(channel, data)
  }

  /** Append output written to a stream a level owns; this console keeps it on its channel. */
  async emitTo(stream: OwnedStream, data: Uint8Array): Promise<void> {
    await this.emit(stream.channel, data)
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
    if (this.backing.closed) return
    await this.backing.append(Channel.CONTROL, encodeText(outcome))
  }

  /** Read chunks at or after a cursor. */
  readFrom(seq: number, limit?: number): Promise<ReadResult> {
    return this.backing.readFrom(seq, limit)
  }

  /** Yield chunks as they arrive, ending when the job does. */
  async *follow(seq = 0): AsyncGenerator<ConsoleChunk> {
    let cursor = seq
    for (;;) {
      const [chunks, next] = await this.backing.readFrom(cursor)
      cursor = next
      for (const chunk of chunks) {
        yield chunk
        if (chunk.channel === Channel.CONTROL) return
      }
      await this.backing.wait(cursor)
      // A discarded console will never produce an ending chunk, and
      // releasing once would only send this loop back to waiting.
      if (this.backing.closed) return
    }
  }

  /**
   * Resolve once the job has ended.
   *
   * Resolves on a closed store too, so a console discarded while someone
   * was joining on it does not strand them, and once `signal` aborts, so
   * an abandoned join stops reading.
   *
   * @param signal ends the wait early
   */
  async waitFinished(signal?: AbortSignal): Promise<void> {
    let cursor = 0
    while (signal?.aborted !== true) {
      const [chunks, next] = await this.backing.readFrom(cursor)
      cursor = next
      if (chunks.some((c) => c.channel === Channel.CONTROL)) return
      await this.backing.wait(cursor, signal)
      if (this.backing.closed) return
    }
  }

  /**
   * How the job ended, or null while no ending is stored.
   *
   * Reads only the last chunk, wherever the store keeps it: a read past
   * the end answers the console's length, and the ending is always the
   * last chunk. This is how a workspace learns how another one's job
   * ended.
   */
  async outcome(): Promise<string | null> {
    const [, end] = await this.backing.readFrom(END_OF_CONSOLE)
    if (end === 0) return null
    const [chunks] = await this.backing.readFrom(end - 1, 1)
    const last = chunks[chunks.length - 1]
    if (last?.channel !== Channel.CONTROL) return null
    return decodeText(last.data)
  }

  /**
   * Join everything the job has printed so far.
   *
   * With no channel, joins stdout and stderr in the order they were
   * produced and omits the CONTROL chunk, which is status not output.
   */
  async snapshot(channel: Channel | null = null): Promise<Uint8Array> {
    const [chunks] = await this.backing.readFrom(0)
    if (channel === null) {
      return join(chunks.filter((c) => c.channel !== Channel.CONTROL))
    }
    return join(chunks.filter((c) => c.channel === channel))
  }

  /** Release the underlying store. */
  close(): Promise<void> {
    return this.backing.close()
  }
}
