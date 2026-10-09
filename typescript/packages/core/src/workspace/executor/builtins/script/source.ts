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

import type { ByteSource, IOResult } from '../../../../io/types.ts'
import type { JobConsole } from '../../../../shell/console/index.ts'
import { ended, returning } from '../../control.ts'
import type { PathSpec } from '../../../../types.ts'
import { fsStrerror } from '../../../../errors/fs.ts'
import { CallStack } from '../../../../shell/call_stack.ts'
import { ExitSignal, ReturnSignal } from '../../../../shell/errors.ts'
import type { SessionState } from '../../../session/session.ts'
import { positionalParams, setPositionalParams } from '../../../session/state.ts'
import { ExecutionNode } from '../../../types.ts'
import type { DispatchFn } from '../../../../runtime/types.ts'
import { scopePath } from '../scope.ts'
import { SOURCE_USAGE } from './constants.ts'
import { readScriptText, scriptError } from './script.ts'
import type { BuiltinCall, ExecuteStringFn, Result } from '../types.ts'
import { wordText } from '../../../../types.ts'

/**
 * Read a script file and execute it in the calling shell, `name` (`source`
 * or `.`) as typed. A sourced file is the caller, so whatever it sets stays
 * set; only the positional parameters come back, which `args` replaces
 * while it runs. It runs in a frame of its own, which `return` ends,
 * `FUNCNAME` names `source` and the RETURN action runs in as it returns; a
 * `break` in it ends a caller's loop. An empty name fails as a missing file
 * does, and bash blames a file it cannot read on itself, not the builtin.
 */
export async function handleSource(
  dispatch: DispatchFn,
  executeFn: ExecuteStringFn,
  path: string | PathSpec,
  session: SessionState,
  args: string[] = [],
  stdin: ByteSource | null = null,
  callStack: CallStack | null = null,
  sink?: JobConsole,
  name = 'source',
): Promise<Result> {
  const raw = scopePath(path)
  if (wordText(path) === '') {
    return scriptError('bash', ': No such file or directory', 1, 'source ')
  }
  let script: string
  try {
    script = await readScriptText(dispatch, raw, session.cwd)
  } catch (err) {
    const strerror = fsStrerror(err)
    if (strerror === null) throw err
    if ((err as { code?: unknown }).code === 'EISDIR') {
      return scriptError(`bash: ${name}`, `${raw}: is a directory`, 1, `source ${raw}`)
    }
    return scriptError('bash', `${raw}: ${strerror}`, 1, `source ${raw}`)
  }
  const cs = callStack ?? new CallStack()
  cs.push(args.length > 0 ? args : [...positionalParams(session, cs)], 'source', true)
  const outerNames = session.functionNames
  if (outerNames !== null) session.functionNames = cs.functionNames()
  let io: IOResult
  let stdout: ByteSource | null
  try {
    try {
      io = await executeFn(script, {
        sessionId: session.sessionId,
        stdin,
        callStack: cs,
        ...(sink === undefined ? {} : { sink }),
      })
    } catch (err) {
      if (!(err instanceof ReturnSignal)) throw err
      io = ended(err)
    }
    ;[stdout, io] = await returning(executeFn, session, stdin, cs, io.stdout, io)
  } catch (err) {
    if (err instanceof ExitSignal) err.sourced = true
    throw err
  } finally {
    const frame = cs.pop()
    if (session.functionNames !== null) session.functionNames = outerNames
    if (args.length === 0) setPositionalParams(session, cs, frame.positional)
  }
  return [stdout, io, new ExecutionNode({ command: `source ${raw}`, exitCode: io.exitCode })]
}

/**
 * The `source` / `.` arm. Positional parameters keep the words as typed,
 * so a path operand contributes its spelling, not its resolved mount path.
 */
export async function sourceBuiltin(call: BuiltinCall): Promise<Result> {
  const operands = [...call.argv.operands]
  const target = operands[0]
  const name = call.argv.name
  if (target === undefined) {
    return scriptError(`bash: ${name}`, SOURCE_USAGE.replaceAll('{name}', name), 2, name)
  }
  const sourceArgs = operands.slice(1).map((o) => wordText(o))
  return handleSource(
    call.dispatch,
    call.executeFn,
    target,
    call.context.session,
    sourceArgs,
    call.stdin,
    call.callStack,
    call.sink,
    name,
  )
}
