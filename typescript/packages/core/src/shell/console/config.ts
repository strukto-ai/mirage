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

export const KILLED_OUTCOME = 'killed'

export const Channel = Object.freeze({
  STDOUT: 'stdout',
  STDERR: 'stderr',
  CONTROL: 'control',
} as const)

export type Channel = (typeof Channel)[keyof typeof Channel]

/**
 * One piece of a job's output, at a fixed position in its console.
 *
 * Chunks never change once appended, so a reader holding one keeps a
 * stable view no matter what the job does next.
 */
export interface ConsoleChunk {
  /** Position in the console, assigned by the store. Readers use it as their cursor. */
  readonly seq: number
  /** Epoch seconds when the chunk was appended. */
  readonly ts: number
  /** Which stream the bytes came from, or CONTROL for the terminating chunk. */
  readonly channel: Channel
  /** The payload. For a CONTROL chunk this is the outcome text. */
  readonly data: Uint8Array
}

/** Chunks read, the cursor to pass next time, and whether retention dropped the old one. */
export type ReadResult = [ConsoleChunk[], number, boolean]

/** Outcome text for a job that ran to completion. */
export function exitOutcome(exitCode: number): string {
  return `exit:${exitCode.toString()}`
}
