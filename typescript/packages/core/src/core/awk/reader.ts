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

import { byteView } from '../../shell/bytes.ts'
import { takeRecord } from './builtins.ts'
import { chunks } from '../../io/cooperative.ts'
import { YieldBudget } from '../../io/yield_budget.ts'

/**
 * Cut one input stream into records with the RS in force at each read.
 * RS is read again before every record, so an action that assigns it
 * changes how the next record is cut, as in every awk. The stream is
 * pulled only as far as the next record needs, so a reader that is closed
 * early leaves the rest of a shared input unread.
 */
export class RecordReader {
  private readonly pulled: AsyncIterator<Uint8Array>
  private readonly separator: () => string
  private readonly budget = new YieldBudget()
  private buffer = ''
  private start = 0
  private final = false

  constructor(source: Uint8Array | AsyncIterable<Uint8Array>, separator: () => string) {
    this.pulled = chunks(source)
    this.separator = separator
  }

  /** The next record, or null once the input is exhausted. */
  async next(): Promise<string | null> {
    for (;;) {
      const pending = this.budget.run()
      if (pending !== undefined) await pending
      const [record, after] = takeRecord(this.buffer, this.start, this.separator(), this.final)
      this.start = after
      if (record !== null) return record
      if (this.final) return null
      const next = await this.pulled.next()
      this.final = next.done === true
      const decoded = next.done === true ? '' : byteView(next.value)
      this.buffer = this.buffer.slice(this.start) + decoded
      this.start = 0
    }
  }

  /** Stop reading, releasing the stream. */
  async close(): Promise<void> {
    await this.pulled.return?.()
  }
}
