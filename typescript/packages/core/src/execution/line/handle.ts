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

import type { LineId } from '../types.ts'
import { YieldBudget } from '../../io/yield_budget.ts'
import { makeAbortError } from '../../utils/abort.ts'
import type { Line } from './types.ts'

/**
 * One line as the workspace running it holds it: its record, the yield
 * budget the line and its evaluations share, and its admission.
 *
 * The record moves on as the line does (`start`, `stop`, `end`): a server
 * answers with the line's id before its workspace reads it, and reads the
 * record from the handle. Mirrors Python's `LineHandle`.
 */
export class LineHandle {
  /** Told the record each time it changes, as its table keeps it. */
  noted: ((record: Line) => void) | null = null
  private readonly budget = new YieldBudget()
  private current: Line
  private stopSignal: number | null = null

  /**
   * @param onStart run once the session admits the line, before any
   *   effect; one that throws keeps the line from running.
   * @param now the clock its times are read on, in seconds.
   */
  constructor(
    id: LineId,
    sessionId: string,
    command: string,
    private onStart?: () => Promise<void>,
    private readonly now: () => number = () => Date.now() / 1000,
  ) {
    this.current = {
      id,
      sessionId,
      command,
      startedAt: now(),
      state: 'waiting',
      endedAt: null,
      exit: null,
      signal: null,
      error: null,
    }
  }

  get id(): LineId {
    return this.current.id
  }

  /** The line as its record reads now. */
  get record(): Line {
    return this.current
  }

  /** Publish admission once, after acquiring the session and before effects. */
  async start(): Promise<void> {
    const onStart = this.onStart
    this.onStart = undefined
    await onStart?.()
    if (this.current.state === 'waiting') {
      this.current = { ...this.current, state: 'running' }
      this.tell()
    }
  }

  async checkpoint(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw makeAbortError(signal)
    await this.budget.run()
    if (signal?.aborted) throw makeAbortError(signal)
  }

  /** Mark the line stopping: it ends as stopped by `signal`, however it then ends. */
  stop(signal: number): void {
    if (this.current.endedAt !== null) return
    this.stopSignal = signal
    this.current = { ...this.current, state: 'stopping' }
    this.tell()
  }

  /**
   * End the line, once: a later call changes nothing. `exit` is null when
   * it has no status, `error` why Mirage could not run it, if it could not.
   */
  end(exit: number | null, error: string | null = null): void {
    if (this.current.endedAt !== null) return
    this.current = {
      ...this.current,
      state: 'exited',
      endedAt: this.now(),
      exit,
      signal: this.stopSignal,
      error,
    }
    this.tell()
  }

  /** Tell whoever keeps the record that it changed. */
  private tell(): void {
    this.noted?.(this.current)
  }
}
