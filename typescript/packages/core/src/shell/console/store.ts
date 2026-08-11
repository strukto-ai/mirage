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

import type { Channel, ConsoleChunk, ReadResult } from './config.ts'

/**
 * Storage for one job's console.
 *
 * The role this contract fills is a stream: ordered append, read from a
 * position, and block until there is more. Memory satisfies it with an
 * array, Redis Streams with XADD/XRANGE/XREAD BLOCK. A home qualifies by
 * offering those primitives, never by brand.
 *
 * The store knows nothing about jobs ending. Termination is an ordinary
 * CONTROL chunk, so a blocked reader is woken by it like any other
 * append, and every home can express it.
 */
export interface ConsoleStore {
  /** Add a chunk and return it with its assigned seq. */
  append(channel: Channel, data: Uint8Array): Promise<ConsoleChunk>

  /**
   * Read chunks at or after a cursor.
   *
   * Returns the chunks, the cursor to pass next time, and whether the
   * requested cursor had already been dropped by retention. A reader
   * that fell behind resumes at the oldest retained chunk and is told
   * so, rather than silently losing bytes.
   */
  readFrom(seq: number, limit?: number): Promise<ReadResult>

  /**
   * Whether `close` has run.
   *
   * Readers loop, so releasing them once is not enough to end a follow:
   * they re-read, find no CONTROL chunk, and wait again. They check this
   * to tell "more may arrive" from "this console is discarded".
   */
  readonly closed: boolean

  /**
   * Resolve once the console holds a chunk after `seq`.
   *
   * Resolves immediately on a closed store, which is what keeps a reader
   * that re-arms from parking on a console nobody will write to again.
   */
  wait(seq: number): Promise<void>

  /**
   * Release the store's resources.
   *
   * This is not "the job ended": that is the CONTROL chunk. Closing
   * releases any blocked reader so nothing hangs on a discarded console.
   */
  close(): Promise<void>
}
