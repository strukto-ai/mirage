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

import type { PipeWriter } from '../runtime/types.ts'

/**
 * How a machine sees the workspace: `ssh` serves every prefix from the
 * host over SFTP, `fuse` leaves them to the machine's own mirage, and
 * `both` serves from the host what the machine does not mount itself.
 */
/**
 * What a run has reported on its machine (`RUN_WRAPPER`): its program's pid
 * and start in clock ticks, null until it starts, and its exit status, null
 * until it exits. Mirrors Python's `RunStatus`.
 */
export interface RunStatus {
  readonly pid: number | null
  readonly started: number | null
  readonly exitCode: number | null
}

export type MountType = 'ssh' | 'fuse' | 'both'

/** A command a machine runs with its stdin and stdout held open. */
export interface MachinePipe {
  /** What the command writes. */
  readonly reader: ReadableStream<Uint8Array>
  /** What the command reads. */
  readonly writer: PipeWriter
  /** Ends the command. */
  stop(): Promise<void>
  /** Bounded startup diagnostics, when available. */
  diagnostic?(): Promise<string>
}
