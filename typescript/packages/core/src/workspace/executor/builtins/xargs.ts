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

import { materialize } from '../../../io/types.ts'
import type { ByteSource } from '../../../io/types.ts'
import { shellJoin } from '../../../shell/join.ts'
import type { Session } from '../../session/session.ts'
import { ExecutionNode } from '../../types.ts'
import type { Result, ExecuteStringFn } from './scope.ts'

/**
 * Run a command with words read from stdin appended (GNU xargs).
 *
 * GNU xargs execs the command directly, so every input word must reach
 * it as exactly one argv token. The inner line is built with shellJoin:
 * a plain join would be re-parsed by the shell, splitting words with
 * whitespace and executing $(...) found in input.
 */
export async function handleXargs(
  executeFn: ExecuteStringFn,
  args: readonly string[],
  session: Session,
  stdin: ByteSource | null,
): Promise<Result> {
  const data = await materialize(stdin)
  const inputArgs = new TextDecoder()
    .decode(data)
    .split(/\s+/)
    .filter((s) => s !== '')
  const command = args.length > 0 ? args : ['echo']
  const inner = shellJoin([...command, ...inputArgs])
  const io = await executeFn(inner, { sessionId: session.sessionId })
  return [io.stdout, io, new ExecutionNode({ command: 'xargs', exitCode: io.exitCode })]
}
