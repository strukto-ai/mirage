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

import { HISTORY_MAX_RECORDS, HISTORY_SECONDS } from '../constants.ts'
import type { LineId } from '../types.ts'
import { SystemClock, type Clock } from '../../utils/clock.ts'
import type { LineHandle } from './handle.ts'
import type { Line } from './types.ts'

/**
 * The lines a workspace's sessions read, each from its reading on: the ones
 * running, and the newest ended ones, `HISTORY_MAX_RECORDS` of them for
 * `HISTORY_SECONDS` at most.
 *
 * Only a line its session's shell reads is one; what a line evaluates in
 * turn (`$( )`, `eval`, `source`) runs within it. Mirrors Python's
 * `LineTable`.
 */
export class LineTable {
  private readonly handles = new Map<string, LineHandle>()

  /**
   * @param clock the workspace clock ended lines age on.
   * @param note told each line's record as it is read and each time it
   *   changes, as the workspace's store keeps it.
   */
  constructor(
    readonly clock: Clock = new SystemClock(),
    private readonly note: ((record: Line) => void) | null = null,
  ) {}

  /** Track a line from its reading on. */
  start(line: LineHandle): void {
    this.prune()
    this.handles.set(line.id.value, line)
    if (this.note !== null) {
      line.noted = this.note
      this.note(line.record)
    }
  }

  /** A line's record, while the table keeps it. */
  get(id: LineId): Line | null {
    this.prune()
    return this.handles.get(id.value)?.record ?? null
  }

  /** The records the table keeps, oldest first, a session's when one is named. */
  lines(sessionId?: string): Line[] {
    this.prune()
    return [...this.handles.values()]
      .map((line) => line.record)
      .filter((line) => sessionId === undefined || line.sessionId === sessionId)
  }

  private prune(): void {
    const ended = [...this.handles.values()]
      .filter((line) => line.record.endedAt !== null)
      .sort((a, b) => (a.record.endedAt ?? 0) - (b.record.endedAt ?? 0))
    const cutoff = this.clock.now() - HISTORY_SECONDS
    const excess = ended.length - HISTORY_MAX_RECORDS
    for (const [index, line] of ended.entries()) {
      if (index >= excess && (line.record.endedAt ?? 0) > cutoff) break
      this.handles.delete(line.id.value)
    }
  }
}
