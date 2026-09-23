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

import type { PathSpec } from '../../../../types.ts'
import { fsStrerror } from '../../../../utils/errors.ts'
import type { SessionState } from '../../../session/session.ts'
import { ExecutionNode } from '../../../types.ts'
import type { DispatchFn } from '../../../../runtime/types.ts'
import { scopePath } from '../scope.ts'
import { SOURCE_USAGE } from './constants.ts'
import { readScriptText, scriptError } from './script.ts'
import type { BuiltinCall, ExecuteStringFn, Result } from '../types.ts'
import { wordText } from '../../../../types.ts'

export async function handleSource(
  dispatch: DispatchFn,
  executeFn: ExecuteStringFn,
  path: string | PathSpec,
  session: SessionState,
  args: string[] = [],
): Promise<Result> {
  const raw = scopePath(path)
  if (raw === '') return scriptError('source', SOURCE_USAGE, 2)
  let script: string
  try {
    script = await readScriptText(dispatch, raw, session.cwd)
  } catch (err) {
    const strerror = fsStrerror(err)
    if (strerror === null) throw err
    return scriptError('source', `${raw}: ${strerror}`, 1, `source ${raw}`)
  }
  let savedPositional: string[] | null = null
  if (args.length > 0) {
    savedPositional = session.positionalArgs
    session.positionalArgs = args
  }
  session.sourceDepth += 1
  try {
    const io = await executeFn(script, { sessionId: session.sessionId })
    return [io.stdout, io, new ExecutionNode({ command: `source ${raw}`, exitCode: io.exitCode })]
  } finally {
    session.sourceDepth -= 1
    if (savedPositional !== null) session.positionalArgs = savedPositional
  }
}

/**
 * The `source` / `.` arm. Positional parameters keep the words as typed,
 * so a path operand contributes its spelling, not its resolved mount path.
 */
export async function sourceBuiltin(call: BuiltinCall): Promise<Result> {
  const operands = [...call.argv.operands]
  const target = operands[0] ?? ''
  const sourceArgs = operands.slice(1).map((o) => wordText(o))
  return handleSource(call.dispatch, call.executeFn, target, call.session, sourceArgs)
}
