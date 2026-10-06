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
import { fd0Binding, finishStatement } from '../statement.ts'
import { CallStack } from '../../../shell/call_stack.ts'
import type { JobConsole } from '../../../shell/console/index.ts'
import { ERREXIT_EXEMPT_TYPES } from '../../../shell/constants.ts'
import type { PathSpec } from '../../../types.ts'
import { wordText } from '../../../types.ts'

import { restoreLocals } from '../../session/state.ts'
import { ExecutionNode } from '../../types.ts'
import { share } from '../../../io/async_line_iterator.ts'
import { asyncChain } from '../../../io/stream.ts'
import { runStatement } from '../jobs.ts'
import type { ExecuteNodeFn } from './types.ts'
import type { JobTable } from '../../../shell/job_table/index.ts'

import type { HandOff } from '../../../policy/types.ts'
import type { Decisions } from '../../../policy/decisions.ts'
import { ReturnSignal } from '../../../shell/errors.ts'
import { carried, isUnwinding } from '../control.ts'
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
  const allStdout: (ByteSource | null)[] = []
  let mergedIo = new IOResult()
  let lastExec = new ExecutionNode({ command: cmdName, exitCode: 0 })
  const bound = fd0Binding(session)

  try {
    // The body is shell code: the builtins it runs are the shell's,
    // whatever `xargs` or `env` marked the line that called it.
    await runAsShell(async () => {
      for (const cmd of body) {
        try {
          const cmdNode = cmd
          const [rawStdout, io, execNode] = await runStatement(
            sink === undefined
              ? executeNode
              : (n, s, i, c, opts) => executeNode(n, s, i, c, { sink, ...opts }),
            cmdNode,
            context,
            bodyStdin,
            bound,
            cs,
            jobTable,
            agentId,
            handed,
            decisions,
          )
          // $? tracks each statement inside the body, so a bare `return`
          // (and mid-function $?) sees the last command.
          const stdout = await finishStatement(rawStdout, io, session, cmdNode)
          if (stdout !== null) allStdout.push(stdout)
          mergedIo = await mergedIo.merge(io)
          lastExec = execNode
          if (
            io.exitCode !== 0 &&
            session.shellOptions.errexit === true &&
            !ERREXIT_EXEMPT_TYPES.has(cmdNode.type) &&
            !session.errexitImmune
          ) {
            mergedIo.exitCode = io.exitCode
            break
          }
        } catch (err) {
          if (err instanceof ReturnSignal) {
            if (err.stdout !== null) allStdout.push(err.stdout)
            if (err.stderr.length > 0) {
              mergedIo = await mergedIo.merge(new IOResult({ stderr: err.stderr }))
            }
            mergedIo.exitCode = err.exitCode
            break
          }
          if (!isUnwinding(err)) throw err
          throw await carried(err, allStdout.length > 0 ? asyncChain(allStdout) : null, mergedIo)
        }
      }
    })
  } finally {
    scope.release()
    cs.pop()
    if (session.functionNames !== null) session.functionNames = outerNames
    restoreLocals(session, savedLocals)
    session.localFrames.pop()
    session.localVars = outerLocals
  }

  const combined = allStdout.length > 0 ? asyncChain(allStdout) : null
  lastExec.exitCode = mergedIo.exitCode
  return [combined, mergedIo, lastExec]
}
