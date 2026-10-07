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

import { type ByteSource, IOResult } from '../../../../io/types.ts'
import { Channel, type JobConsole } from '../../../../shell/console/index.ts'
import { concat } from '../../../../io/cachable_iterator.ts'
import { asyncChain } from '../../../../io/stream.ts'
import { runReturnTrap } from '../../traps.ts'
import type { PathSpec } from '../../../../types.ts'
import { fsStrerror } from '../../../../errors/fs.ts'
import { CallStack } from '../../../../shell/call_stack.ts'
import { ReturnSignal } from '../../../../shell/errors.ts'
import type { SessionState } from '../../../session/session.ts'
import { positionalParams, setPositionalParams } from '../../../session/state.ts'
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
  stdin: ByteSource | null = null,
  callStack: CallStack | null = null,
  sink?: JobConsole,
  // The builtin as typed, `source` or `.`.
  name = 'source',
): Promise<Result> {
  const raw = scopePath(path)
  if (wordText(path) === '') {
    // The empty name is a filename bash tries to open, not a missing
    // argument, so it fails like any file that is not there.
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
    // bash blames a file it cannot read on itself, not the builtin.
    return scriptError('bash', `${raw}: ${strerror}`, 1, `source ${raw}`)
  }
  // The file is the caller, run in a frame of its own: `return` ends it,
  // `FUNCNAME` names it `source`, and it runs in the caller's loops, so a
  // `break` in it ends one of theirs. Its arguments are its parameters
  // while it runs; without any it has the caller's, and a `shift` in it
  // shifts them.
  const cs = callStack ?? new CallStack()
  cs.push(args.length > 0 ? args : [...positionalParams(session, cs)], 'source', true)
  const outerNames = session.functionNames
  if (outerNames !== null) session.functionNames = cs.functionNames()
  let io: IOResult
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
      io = new IOResult({
        stdout: err.stdout,
        stderr: err.stderr.byteLength > 0 ? err.stderr : null,
        exitCode: err.exitCode,
      })
    }
    // The RETURN action runs as the file returns, in its frame.
    const returned = await runReturnTrap(executeFn, session, stdin, cs)
    if (returned.length > 0) {
      const out = concat(returned.filter(([c]) => c === Channel.STDOUT).map(([, d]) => d))
      const err = concat(returned.filter(([c]) => c === Channel.STDERR).map(([, d]) => d))
      const stderr = concat([await io.materializeStderr(), err])
      io = new IOResult({
        stdout: asyncChain([io.stdout, out]),
        stderr: stderr.byteLength > 0 ? stderr : null,
        exitCode: io.exitCode,
        reads: io.reads,
        writes: io.writes,
        cache: io.cache,
        refusal: io.refusal,
      })
    }
  } finally {
    const frame = cs.pop()
    if (session.functionNames !== null) session.functionNames = outerNames
    if (args.length === 0) setPositionalParams(session, cs, frame.positional)
  }
  return [io.stdout, io, new ExecutionNode({ command: `source ${raw}`, exitCode: io.exitCode })]
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
