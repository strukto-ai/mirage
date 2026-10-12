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

import type { EvaluationContext } from '../evaluation.ts'
import type { SessionState } from '../session/session.ts'
import type { ExecutionScope } from '../execution.ts'
import type { ByteSource, IOResult } from '../../io/types.ts'
import type { TSNodeLike } from '../../shell/types.ts'
import type { HandOff } from '../../policy/types.ts'
import type { JobConsole } from '../../shell/console/index.ts'
import type { CallStack } from '../../shell/call_stack.ts'
import type { JobTable } from '../../shell/job_table/index.ts'
/**
 * One stretch of an expanded word.
 *
 * `text` carries a glob character quoting made literal under its mark.
 * `split` says whether field splitting reads it, which is true only of
 * text an unquoted expansion produced. Literal and quoted text never
 * splits, and quoted text opens a field even when it is empty (`""`).
 */
export interface Piece {
  readonly kind: 'piece'
  readonly text: string
  readonly split: boolean
}

/**
 * The boundary between two elements of a splat (`$@`, `$*`). `joiner`
 * is what it reads as where no field splitting happens (an assignment,
 * a `case` word): a space between `$@` elements, the first character of
 * IFS between `$*` ones.
 */
export interface FieldBreak {
  readonly kind: 'break'
  readonly joiner: string
}

export type Chunk = Piece | FieldBreak

export function piece(text: string, split = false): Piece {
  return { kind: 'piece', text, split }
}

export function fieldBreak(joiner: string): FieldBreak {
  return { kind: 'break', joiner }
}

/**
 * The executor's entry point for a nested line. `node` is the node whose text
 * the line is: the command running it (bound by the dispatcher for
 * every word that runs a line) or the substitution being expanded,
 * which names itself. The inner line's commands stand under it, where
 * the judging pass placed them. `handed` is the hand-off of the subtree
 * that runs the evaluation, bound by the walker (`withHandOff`): the
 * line's own for a command in the foreground, a job's own for a command
 * inside a background job. The inner line runs on a hand-off made under
 * it, so a line a job evaluates after the typed line has ended still
 * stands under the hand-off holding the job's grants.
 */
export type ExecuteFn = (
  command: string,
  opts: {
    sessionId: string
    executionScope?: ExecutionScope
    context?: EvaluationContext
    session?: SessionState
    stdin?: ByteSource | null
    signal?: AbortSignal
    node?: TSNodeLike
    span?: readonly [number, number]
    handed?: HandOff
    substitution?: boolean
    sink?: JobConsole
    callStack?: CallStack
    jobTable?: JobTable
  },
) => Promise<IOResult>

export type ProcessSubLine = (
  text: string,
  options?: {
    stdin?: ByteSource | null
    sink?: JobConsole
    signal?: AbortSignal
  },
) => Promise<IOResult>
