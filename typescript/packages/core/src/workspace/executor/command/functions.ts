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

import type { EvaluationContext } from '../../evaluation.ts'
import { parseFunction } from '../../../shell/helpers.ts'
import type { ParseScope } from '../../../shell/parse/scope.ts'

import type { ShellVar } from '../../../shell/variable.ts'
import type { ByteSource } from '../../../io/types.ts'
import { IOResult } from '../../../io/types.ts'
import { CallStack } from '../../../shell/call_stack.ts'
import type { JobConsole } from '../../../shell/console/index.ts'
import type { PathSpec } from '../../../types.ts'
import { wordText } from '../../../types.ts'

import { restoreLocals } from '../../session/state.ts'
import { ExecutionNode } from '../../types.ts'
import { share } from '../../../io/async_line_iterator.ts'
import type { ExecuteNodeFn } from './types.ts'
import type { JobTable } from '../../../shell/job_table/index.ts'

import type { HandOff } from '../../../policy/types.ts'
import type { Decisions } from '../../../policy/decisions.ts'
import { ExitSignal, ReturnSignal } from '../../../shell/errors.ts'
import { executeBody, returning } from '../control.ts'
import { liftFunctionTraps, restoreFunctionTraps } from '../traps.ts'
import type { ExecuteStringFn } from '../builtins/types.ts'
import { runAsShell } from '../../../context/session_context.ts'
import type { Result } from './types.ts'

export async function executeShellFunction(
  executeNode: ExecuteNodeFn,
  cmdName: string,
  source: string,
  parser: ParseScope,
  restParts: readonly (string | PathSpec)[],
  context: EvaluationContext,
  stdin: ByteSource | null,
  callStack: CallStack | null,
  jobTable: JobTable | null = null,
  agentId: string | null = null,
  handed: HandOff | null = null,
  decisions: Decisions | null = null,
  // Where each statement writes as it finishes, undefined to return the
  // body's output.
  sink?: JobConsole,
  // Runs a trap action as a line of the shell; null where nothing can.
  executeFn: ExecuteStringFn | null = null,
): Promise<Result> {
  const session = context.session
  // The body's statements read the caller's stdin in turn.
  const scope = parser.fork()
  let body
  try {
    body = parseFunction(source, (line) => scope.parse(line))
  } catch (error) {
    scope.release()
    throw error
  }
  const bodyStdin = share(stdin)
  const cs = callStack ?? new CallStack()
  // Positional args carry the word as typed ($1 stays sub/a.txt).
  const textArgs = restParts.map(wordText)
  cs.push(textArgs, cmdName)
  let lifted = liftFunctionTraps(session)
  const outerNames = session.functionNames
  if (outerNames !== null) session.functionNames = cs.functionNames()
  // One stack: a local shadows the whole record, so the caller's value
  // and attributes are saved and put back together.
  const savedLocals = new Map<string, ShellVar | null>()
  // The caller's frame is kept and put back: a function that calls
  // another and then declares a `local` is still inside a function, and
  // its own shadows must keep being recorded on its own frame.
  const outerLocals = session.localVars
  session.localVars = savedLocals
  session.localFrames.push(savedLocals)
  // The body is parsed again from its source, so its rows restart at 0;
  // it expands the aliases its definition saw, or reads them as a parse of
  // its own when it came from a stored session. It was read apart from the
  // alias that may have called it, whose guards do not reach it (`alias a=f`
  // still lets `f`'s body run its own `a`).
  const outerParse: [number, number] = [session.parseCurrent, session.parseRow]
  const outerView = session.aliasView
  const outerExpansion = session.aliasExpansion
  session.aliasExpansion = null
  let site = session.functionSites.get(cmdName)
  if (site !== undefined && site.source !== source) site = undefined
  if (site === undefined) {
    session.parseSeq += 1
    ;[session.parseCurrent, session.parseRow] = [session.parseSeq, 0]
  } else {
    ;[session.parseCurrent, session.parseRow] = site.mark
  }
  session.aliasView = site?.aliases ?? null
  // Its commands stand under the definition's place, on a hand-off of
  // their own as every re-parse does, so two definitions of one text each
  // need a nod and a second call runs on the first's.
  const origin = site?.origin ?? null
  const nested: HandOff | null =
    handed !== null && origin !== null ? { claimed: [], parent: handed, origin } : null
  const bodyHanded = nested ?? handed

  const run: ExecuteNodeFn =
    sink === undefined && nested === null
      ? executeNode
      : (n, s, i, c, opts) =>
          executeNode(n, s, i, c, {
            ...(sink === undefined ? {} : { sink }),
            ...(nested === null ? {} : { handed: nested }),
            ...opts,
          })

  try {
    // The body is shell code: the builtins it runs are the shell's,
    // whatever `xargs` or `env` marked the line that called it.
    return await runAsShell(async (): Promise<Result> => {
      let stdout: ByteSource | null
      let io: IOResult
      let lastExec: ExecutionNode
      try {
        ;[stdout, io, lastExec] = await executeBody(
          run,
          body,
          context,
          bodyStdin,
          cs,
          jobTable,
          agentId,
          bodyHanded,
          decisions,
          executeFn,
          sink ?? null,
        )
      } catch (err) {
        if (!(err instanceof ReturnSignal)) throw err
        stdout = err.stdout
        io = new IOResult({
          stderr: err.stderr.byteLength > 0 ? err.stderr : null,
          exitCode: err.exitCode,
        })
        lastExec = new ExecutionNode({ command: cmdName })
      }
      ;[stdout, io] = await returning(executeFn, session, bodyStdin, cs, stdout, io, sink ?? null)
      lastExec.exitCode = io.exitCode
      return [stdout, io, lastExec]
    })
  } catch (err) {
    // An `exec` replaced the shell: the actions went with it, so the ones
    // the body took from its caller do not come back.
    if (err instanceof ExitSignal && err.replaced !== null) lifted = [null, null]
    throw err
  } finally {
    ;[session.parseCurrent, session.parseRow] = outerParse
    session.aliasView = outerView
    session.aliasExpansion = outerExpansion
    if (nested !== null && decisions !== null) decisions.handUp(session.sessionId, nested)
    scope.release()
    cs.pop()
    if (session.functionNames !== null) session.functionNames = outerNames
    restoreFunctionTraps(session, lifted)
    restoreLocals(session, savedLocals)
    session.localFrames.pop()
    session.localVars = outerLocals
  }
}
