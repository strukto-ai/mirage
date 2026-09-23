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

import type { SessionState } from '../../../session/session.ts'
import { ExecutionNode } from '../../../types.ts'
import type { BuiltinCall, ExecuteStringFn, Result } from '../types.ts'

export async function handleEval(
  executeFn: ExecuteStringFn,
  args: string[],
  session: SessionState,
): Promise<Result> {
  const script = args.join(' ')
  const io = await executeFn(script, { sessionId: session.sessionId })
  return [io.stdout, io, new ExecutionNode({ command: 'eval', exitCode: io.exitCode })]
}

/** The `eval` arm. */
export async function evalBuiltin(call: BuiltinCall): Promise<Result> {
  return handleEval(call.executeFn, [...call.argv.args], call.session)
}
