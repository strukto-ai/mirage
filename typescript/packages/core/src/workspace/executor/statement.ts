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

import type { ByteSource, IOResult } from '../../io/types.ts'
import { applyBarrier, BarrierPolicy } from '../../shell/barrier.ts'
import type { Session } from '../session/session.ts'

/**
 * Finalize a completed statement and seed $? for the next one.
 *
 * Every statement boundary must do the same dance: apply a VALUE
 * barrier so lazily finalized exit codes (grep's exitOnEmpty) are
 * concrete, then record the status the next statement's $? expands
 * to. Statement-list loops (program, subshell, brace group, if/loop/
 * case bodies, function bodies, && / || / ; lists) call this instead
 * of hand-rolling the triple, so a new construct cannot forget it.
 */
export async function finishStatement(
  stdout: ByteSource | null,
  io: IOResult,
  session: Session,
): Promise<ByteSource | null> {
  const result = await applyBarrier(stdout, io, BarrierPolicy.VALUE)
  session.lastExitCode = io.exitCode
  return result
}

/**
 * Exit status of an assignment-only statement.
 *
 * Bash: an assignment statement exits 0 unless expanding it ran
 * command substitutions, in which case the status of the last
 * substitution performed becomes the statement's own.
 */
export function assignmentStatus(session: Session, seqBefore: number): number {
  if (session.cmdsubSeq !== seqBefore) return session.cmdsubStatus
  return 0
}
