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

import { CommandTimeoutError } from '../../commands/errors.ts'
import { UsageError } from '../../commands/errors.ts'
import { ContentDriftError } from '../snapshot/drift.ts'
import { encodeText } from '../../shell/bytes.ts'
import { refusalOf, renderDeny } from '../../policy/policies.ts'
import type { Deny } from '../../policy/types.ts'
import { ExecuteResult } from './types.ts'
import { commandName } from './utils.ts'

/**
 * True for the errors that are the caller's problem, not the line's:
 * an abort it requested and drift it must reconcile. These propagate;
 * everything else folds into the line's result via `failureResult`.
 */
export function isControlFlowError(err: unknown): boolean {
  if (err instanceof ContentDriftError) return true
  return err instanceof DOMException && err.name === 'AbortError'
}

/**
 * The line's result when execution threw. Mirrors the Python
 * `failure_result` in `workspace/failure.py`: a failed line reports
 * like a failed command in bash, a diagnostic on stderr and an exit
 * code, never a throw. Callers re-raise control-flow errors (see
 * `isControlFlowError`) before reaching this.
 */
export function failureResult(err: unknown): { stderr: Uint8Array; exitCode: number } {
  if (err instanceof DOMException && err.name === 'AbortError') {
    return { stderr: encodeText(`${err.message}\n`), exitCode: 130 }
  }
  if (err instanceof CommandTimeoutError) {
    return { stderr: encodeText(`${err.message}\n`), exitCode: 124 }
  }
  if (err instanceof UsageError) {
    return { stderr: encodeText(`${err.message}\n`), exitCode: err.exitCode }
  }
  const msg = err instanceof Error ? err.message : String(err)
  return { stderr: encodeText(`${msg}\n`), exitCode: 1 }
}

/**
 * The line's result when the placement stage refused it. A deny is a
 * policy outcome, not a mistake: it folds into the line's result through
 * the outcome table admission renders with, never a throw. The denied
 * party is the command, so the message carries its name like every
 * per-command error, in bash's voice; the reason rides `refusal`. Mirrors
 * Python's `placement_refused`.
 */
export function placementRefused(deny: Deny, command: string): ExecuteResult {
  const [stderr, exitCode] = renderDeny(commandName(command) || command, deny)
  return new ExecuteResult(new Uint8Array(), stderr, exitCode, refusalOf(deny))
}
