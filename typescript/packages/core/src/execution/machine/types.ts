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

import type { MachineId } from '../types.ts'

/**
 * How far Mirage reaches a machine, as its last check found it. Mirrors
 * Python's `MachineState`.
 *
 * - `managed`: the check reached it, and Mirage sees and stops every
 *   process its programs start there: it has `/proc` and the `sh`, `tr`
 *   and `grep` the scan runs, or it is the workspace's own host.
 * - `reachable`: the check reached it, but Mirage sees and stops only what
 *   it started itself.
 * - `unreachable`: the last check failed.
 */
export type MachineState = 'managed' | 'reachable' | 'unreachable'

/**
 * One machine a workspace runs programs on, as its last check found it:
 * `checkedAt` is when that check ran. Mirrors Python's `Machine`.
 */
export interface Machine {
  readonly id: MachineId
  readonly state: MachineState
  readonly checkedAt: number
}

/**
 * One process a scan found that a workspace's run started: `tag` is the
 * Mirage process the run is, `pid` and `ppid` its own and its parent's pid
 * on the machine, `started` when it started (clock ticks after boot on a
 * machine, epoch seconds on the host), which tells it apart from a later
 * process given the same pid, `args` its arguments, space separated, `state`
 * the letter `ps` shows for it, and `program` the pid of the program its run
 * reported, absent while it has reported none. Mirrors Python's
 * `MachineProcess`.
 */
export interface MachineProcess {
  readonly tag: string
  readonly pid: number
  readonly ppid: number
  readonly started: number
  readonly args: string
  readonly state?: string
  readonly program?: number | null
}
