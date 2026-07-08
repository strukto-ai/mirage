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

import { IOResult } from '../../../io/types.ts'
import { shellJoin } from '../../../shell/join.ts'
import type { Session } from '../../session/session.ts'
import { ExecutionNode } from '../../types.ts'
import type { Result, ExecuteStringFn } from './scope.ts'

/**
 * Run `timeout DURATION COMMAND [ARG...]`.
 *
 * The inner line is built with shellJoin so already-expanded words
 * survive re-parsing as one token each (GNU timeout execs the command
 * without a shell). The duration is not yet enforced; enforcement
 * lands with the shell-builtin specs work.
 */
export async function handleTimeout(
  executeFn: ExecuteStringFn,
  args: readonly string[],
  session: Session,
): Promise<Result> {
  if (args.length >= 2) {
    const inner = shellJoin(args.slice(1))
    const io = await executeFn(inner, { sessionId: session.sessionId })
    return [io.stdout, io, new ExecutionNode({ command: 'timeout', exitCode: io.exitCode })]
  }
  return [null, new IOResult(), new ExecutionNode({ command: 'timeout', exitCode: 0 })]
}
