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

import type { ByteSource, IOResult } from '../../../io/types.ts'
import type { DispatchFn } from '../../../runtime/types.ts'
import type { CallStack } from '../../../shell/call_stack.ts'
import type { ExecuteFn } from '../../expand/node.ts'
import type { Argv } from '../../expand/argv.ts'
import type { MountRegistry } from '../../mount/registry.ts'
import type { Namespace } from '../../mount/namespace/namespace.ts'
import type { SessionState } from '../../session/session.ts'
import type { ExecutionNode } from '../../types.ts'

export type Result = [ByteSource | null, IOResult, ExecutionNode]

/**
 * Runs a text line in a session, as `eval`, `source`, `bash -c`,
 * `command`, `env`, `mapfile`, `timeout` and `xargs` all need it.
 */
export type ExecuteStringFn = (
  script: string,
  opts: { sessionId: string; stdin?: ByteSource | null; signal?: AbortSignal },
) => Promise<IOResult>

/**
 * One shell-builtin invocation, as the dispatcher hands it to the table.
 *
 * Every executor-run builtin takes exactly this and nothing else, so the
 * table maps a name to a function of one argument and the dispatcher does
 * one lookup instead of one arm per word. A builtin reads the fields it
 * needs and ignores the rest. `row` is the command's line within its
 * parse; only `alias` reads it, so a definition is invisible to a use on
 * the same line, as bash's line reader has it. `signal` fires when the run
 * is being cancelled; `sleep` watches it.
 */
export interface BuiltinCall {
  argv: Argv
  session: SessionState
  stdin: ByteSource | null
  callStack: CallStack | null
  signal: AbortSignal | undefined
  row: number
  dispatch: DispatchFn
  registry: MountRegistry
  namespace: Namespace
  executeFn: ExecuteFn
}

export type BuiltinFn = (call: BuiltinCall) => Promise<Result>
