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

import type { JobId, LineId } from '../types.ts'

export type JobState = 'running' | 'stopping' | 'exited'

/**
 * One background job, as every daemon on its store reads it: what a
 * `cmd &` started, numbered `%N` in its session's list.
 *
 * A job a `kill` reached is `stopping` until its runner stops. `line` is
 * the line that started it and `group` the process group its process runs
 * in, null for a job restored from a snapshot. `endedAt` is set exactly when
 * `state` is final, with `exit` the status `wait` answers and `signal` the
 * signal a kill or a hangup ended it with, if one did.
 */
export interface Job {
  readonly id: JobId
  readonly number: number
  readonly sessionId: string
  readonly command: string
  readonly cwd: string
  readonly startedAt: number
  readonly line: LineId | null
  readonly group: number | null
  readonly state: JobState
  readonly endedAt: number | null
  readonly exit: number | null
  readonly signal: number | null
}
